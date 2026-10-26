import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { javascriptSourceResolver, javascriptInstalledResolver, captureModuleClosure, javascriptProgram, executeJavascriptProgram } from '../src/module-closure.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'source-closure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packages = [];
  function pkg(directory, manifest, files = {}) {
    const item = { root: join(root, directory), manifest: { type: 'module', version: '1.0.0', ...manifest } };
    mkdirSync(item.root, { recursive: true });
    writeFileSync(join(item.root, 'package.json'), JSON.stringify(item.manifest));
    for (const [name, source] of Object.entries(files)) {
      const file = join(item.root, name); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, source);
    }
    packages.push(item); return item;
  }
  return { root, packages, pkg };
}

function contexts(t) {
  const f = fixture(t);
  const app = f.pkg('app', { name: 'app', dependencies: { left: '1.0.0', right: '1.0.0' } }, {
    'entry.mjs': 'import {read as a} from "left"; import {read as b} from "right"; export const run=()=>[a(),b()];',
  });
  const branches = ['left', 'right'].map(name => f.pkg(name, { name, exports: './index.mjs', dependencies: { shared: '1.0.0' } }, { 'index.mjs': 'export {read} from "shared";' }));
  const shared = ['a', 'b'].map((name, index) => f.pkg('shared-' + name, { name: 'shared', exports: './index.mjs', dependencies: { peer: `${index + 1}.0.0` } }, { 'index.mjs': 'import {value} from "peer"; let n=0; export const read=()=>value+(++n);' }));
  const peers = ['a', 'b'].map((name, index) => f.pkg('peer-' + name, { name: 'peer', version: `${index + 1}.0.0`, exports: './index.mjs' }, { 'index.mjs': `export const value=${JSON.stringify(name)};` }));
  branches.forEach((item, i) => { item.bindings = { shared: shared[i].root }; shared[i].bindings = { peer: peers[i].root }; });
  return { ...f, app, branches, shared, peers, entry: join(app.root, 'entry.mjs') };
}

test('source capture preserves multiple versions, duplicate same-version contexts and relocation identity', async t => {
  const first = contexts(t), relocated = contexts(t);
  const resolve = javascriptSourceResolver(first.packages);
  const program = javascriptProgram(first.entry, 'run', { resolve });
  const other = javascriptProgram(relocated.entry, 'run', { resolve: javascriptSourceResolver(relocated.packages) });
  assert.deepEqual(other, program);
  const closure = captureModuleClosure(first.entry, { resolve });
  assert.equal(Object.keys(closure.body.modules).length, 7);
  assert.ok(closure.body.modules['shared@1.0.0/index.mjs']);
  assert.ok(closure.body.modules['shared@1.0.0~1/index.mjs']);
  assert.ok(closure.body.modules['peer@1.0.0/index.mjs']);
  assert.ok(closure.body.modules['peer@2.0.0/index.mjs']);
  rmSync(first.root, { recursive: true }); rmSync(relocated.root, { recursive: true });
  assert.deepEqual(await executeJavascriptProgram(program), ['a1', 'b1']);
  assert.deepEqual(await executeJavascriptProgram(program), ['a2', 'b2']);
});

test('an unbound duplicate name refuses instead of choosing a matching version or ambient installation', t => {
  const f = contexts(t); delete f.branches[0].bindings;
  assert.throws(() => captureModuleClosure(f.entry, { resolve: javascriptSourceResolver(f.packages) }), /ambiguous source package binding/);
});

test('explicit bindings reject wrong name, wrong version and unadmitted root', t => {
  const f = contexts(t);
  f.shared[0].bindings.peer = f.peers[1].root;
  assert.throws(() => javascriptSourceResolver(f.packages), /wrong declared version/);
  f.shared[0].bindings.peer = f.branches[0].root;
  assert.throws(() => javascriptSourceResolver(f.packages), /wrong package name/);
  f.shared[0].bindings.peer = f.root;
  assert.throws(() => javascriptSourceResolver(f.packages), /unadmitted package root/);
});

test('unsupported dependency ranges are refused rather than solved or guessed', t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app', dependencies: { peer: '^1.0.0' } }, { 'entry.mjs': 'import "peer";' });
  const peer = f.pkg('peer', { name: 'peer', exports: './index.mjs' }, { 'index.mjs': '' });
  app.bindings = { peer: peer.root };
  assert.throws(() => javascriptSourceResolver(f.packages), /unsupported nonexact declaration/);
});

test('unique flat catalogues retain their original resolution without installation', t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': 'export {value} from "peer";' });
  const peer = f.pkg('peer', { name: 'peer', exports: './index.mjs' }, { 'index.mjs': 'export const value=1;' });
  const resolve = javascriptSourceResolver(f.packages);
  assert.deepEqual(resolve('peer', join(app.root, 'entry.mjs')), { file: join(peer.root, 'index.mjs') });
  assert.equal(Object.keys(captureModuleClosure(join(app.root, 'entry.mjs'), { resolve }).body.modules).length, 2);
});

test('self exports and private imports use the actual importer manifest, not another same-name package', async t => {
  const f = fixture(t);
  const one = f.pkg('one', { name: 'same', exports: { './value': './one.mjs' }, imports: { '#alias': 'same/value' } }, {
    'entry.mjs': 'export {value as run} from "#alias";', 'one.mjs': 'export const value=()=>1;',
  });
  f.pkg('two', { name: 'same', version: '2.0.0', exports: { './value': './two.mjs' } }, { 'two.mjs': 'export const value=()=>2;' });
  const program = javascriptProgram(join(one.root, 'entry.mjs'), 'run', { resolve: javascriptSourceResolver(f.packages) });
  assert.equal(await executeJavascriptProgram(program), 1);
});

test('source conditional exports retain authored order and most-specific pattern', async t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': 'export {run} from "peer/value/specific/one";' });
  f.pkg('peer', { name: 'peer', exports: { './value/*': './wrong.mjs', './value/specific/*': { browser: './wrong.mjs', default: './right.mjs', import: './wrong.mjs' } } }, {
    'right.mjs': 'export const run=()=>"selected";', 'wrong.mjs': 'export const run=()=>"wrong";',
  });
  assert.equal(await executeJavascriptProgram(javascriptProgram(join(app.root, 'entry.mjs'), 'run', { resolve: javascriptSourceResolver(f.packages) })), 'selected');
});

test('source resolver refuses require explicitly; capture forwards modes to the installed resolver', async t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.cjs': 'exports.run=()=>require("./peer.cjs").value;', 'peer.cjs': 'exports.value=3;' });
  const entry = join(app.root, 'entry.cjs'), source = javascriptSourceResolver(f.packages);
  assert.throws(() => source('./peer.cjs', entry, 'require'), /import mode only/);
  assert.throws(() => captureModuleClosure(entry, { resolve: source }), /import mode only/);
  const modes = [], installed = javascriptInstalledResolver();
  const program = javascriptProgram(entry, 'run', { resolve: (...args) => { modes.push(args[2]); return installed(...args); } });
  assert.deepEqual(modes, ['require']); assert.equal(await executeJavascriptProgram(program), 3);
  assert.equal(await executeJavascriptProgram(javascriptProgram(entry, 'run')), 3);
});

test('source builtin imports are explicit environmental effects and do not become package bindings', async t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app', imports: { '#path': 'path' } }, { 'entry.mjs': 'import {basename} from "#path"; import {test} from "node:test"; export const run=()=>[basename("/a/b"),typeof test];' });
  const resolve = javascriptSourceResolver(f.packages), closure = captureModuleClosure(join(app.root, 'entry.mjs'), { resolve });
  assert.deepEqual(Object.values(closure.body.modules[closure.body.entry].imports), ['node:path', 'node:test']);
  assert.deepEqual(await executeJavascriptProgram(javascriptProgram(join(app.root, 'entry.mjs'), 'run', { resolve })), ['b', 'function']);
});

for (const target of ['../other/escape.mjs', './%2e%2e/other/escape.mjs', './node_modules/escape.mjs', './index.mjs?instance', './index.mjs#instance']) {
  test(`source exports refuse escaped or unrepresented identity ${target}`, t => {
    const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': 'import "peer";' });
    f.pkg('peer', { name: 'peer', exports: target }, { 'index.mjs': '' });
    f.pkg('other', { name: 'other' }, { 'escape.mjs': '' });
    assert.throws(() => captureModuleClosure(join(app.root, 'entry.mjs'), { resolve: javascriptSourceResolver(f.packages) }), /cannot admit/);
  });
}

test('symlink exports and relative paths cannot escape into another admitted source package', t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': 'import "peer";' });
  const peer = f.pkg('peer', { name: 'peer', exports: './index.mjs' });
  const other = f.pkg('other', { name: 'other' }, { 'escape.mjs': '' });
  symlinkSync(join(other.root, 'escape.mjs'), join(peer.root, 'index.mjs'));
  const resolve = javascriptSourceResolver(f.packages);
  assert.throws(() => captureModuleClosure(join(app.root, 'entry.mjs'), { resolve }), /leaves its selected package root/);
  assert.throws(() => resolve('../other/escape.mjs', join(app.root, 'entry.mjs')), /leaves its selected package root/);
});

test('exact missing generated targets remain resolvable, but source directories and URL instances refuse', t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': '', 'directory/index.js': '' });
  const resolve = javascriptSourceResolver(f.packages), from = join(app.root, 'entry.mjs');
  assert.deepEqual(resolve('./generated/absent.mjs', from), { file: join(app.root, 'generated/absent.mjs') });
  assert.match(resolve('./directory', from).external, /import-directory/);
  assert.match(resolve('./entry.mjs?other', from).external, /unsupported-import-url-identity/);
});

test('catalogue manifest drift and duplicate roots refuse; caller mutation cannot replace source declarations', t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': '' });
  const peer = f.pkg('peer', { name: 'peer', exports: './index.mjs' }, { 'index.mjs': '' });
  assert.throws(() => javascriptSourceResolver([...f.packages, peer]), /distinct named package roots/);
  const resolve = javascriptSourceResolver(f.packages);
  peer.manifest.exports = './wrong.mjs';
  assert.deepEqual(resolve('peer', join(app.root, 'entry.mjs')), { file: join(peer.root, 'index.mjs') });
  writeFileSync(join(peer.root, 'package.json'), JSON.stringify(peer.manifest));
  assert.throws(() => resolve('peer', join(app.root, 'entry.mjs')), /catalogue differs/);
});

test('captured source bytes, not catalogue labels or resolver identity, determine the programme', t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': 'export const run=()=>1;' });
  const entry = join(app.root, 'entry.mjs'), resolve = javascriptSourceResolver(f.packages);
  const first = captureModuleClosure(entry, { resolve });
  assert.equal(captureModuleClosure(entry, { resolve: (...args) => resolve(...args) }).id, first.id);
  writeFileSync(entry, readFileSync(entry, 'utf8').replace('()=>1', '()=>2'));
  assert.notEqual(captureModuleClosure(entry, { resolve }).id, first.id);
  assert.throws(() => captureModuleClosure(entry, { resolve: 'trusted-source' }), /requires a module resolver/);
});


test('an explicit importer binding map is closed even when another instance has a unique catalogue name', t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': 'import "peer";' });
  f.pkg('peer', { name: 'peer', exports: './index.mjs' }, { 'index.mjs': '' });
  app.bindings = {};
  assert.throws(() => captureModuleClosure(join(app.root, 'entry.mjs'), { resolve: javascriptSourceResolver(f.packages) }), /unresolved:peer/);
});

for (const name of ['node:fs', 'path']) test(`source require mode cannot bypass the resolver through builtin ${name}`, async t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.cjs': `exports.run=()=>typeof require(${JSON.stringify(name)});` });
  const entry = join(app.root, 'entry.cjs');
  assert.throws(() => captureModuleClosure(entry, { resolve: javascriptSourceResolver(f.packages) }), /import mode only/);
  assert.equal(await executeJavascriptProgram(javascriptProgram(entry, 'run')), 'object');
});

for (const [label, exports, expected] of [
  ['null exports retain legacy main', null, 'selected'],
  ['invalid string array fallback', ['bad-target', './index.mjs'], 'selected'],
  ['invalid primitive array fallback', [false, './index.mjs'], 'selected'],
  ['invalid relative array fallback', ['./../outside.mjs', './index.mjs'], 'selected'],
  ['null after invalid array target', ['bad-target', null], null],
  ['mixed export keys', { '.': './index.mjs', node: './wrong.mjs' }, null],
  ['exact trailing slash export', { './value/': './index.mjs' }, null],
]) test(`source export selection matches native Node: ${label}`, async t => {
  // An ordinary native scope fixture is used only as the differential oracle;
  // the source resolver still receives explicit package roots and no installer.
  const f = fixture(t), request = label.includes('trailing slash') ? 'peer/value/' : 'peer';
  const app = f.pkg('app', { name: 'app' }, { 'entry.mjs': `export {run} from ${JSON.stringify(request)};` });
  f.pkg('app/node_modules/peer', { name: 'peer', main: './index.mjs', exports }, { 'index.mjs': 'export const run=()=>"selected";', 'wrong.mjs': 'export const run=()=>"wrong";' });
  const entry = join(app.root, 'entry.mjs'), resolve = javascriptSourceResolver(f.packages);
  if (expected === null) {
    await assert.rejects(import(pathToFileURL(entry)));
    assert.throws(() => javascriptProgram(entry, 'run', { resolve }));
  } else {
    assert.equal((await import(pathToFileURL(entry))).run(), expected);
    assert.equal(await executeJavascriptProgram(javascriptProgram(entry, 'run', { resolve })), expected);
  }
});

test('a valid missing export target does not fall through to a later present file', async t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': 'export {run} from "peer";' });
  f.pkg('app/node_modules/peer', { name: 'peer', exports: ['./absent.mjs', './index.mjs'] }, { 'index.mjs': 'export const run=()=>1;' });
  const entry = join(app.root, 'entry.mjs');
  await assert.rejects(import(pathToFileURL(entry)), /Cannot find module/);
  assert.throws(() => javascriptProgram(entry, 'run', { resolve: javascriptSourceResolver(f.packages) }), /ENOENT/);
});

test('invalid numeric export conditions are not skipped as invalid array targets', async t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': 'export {run} from "peer";' });
  f.pkg('app/node_modules/peer', { name: 'peer', exports: [{ '0': './other.mjs', default: './index.mjs' }, './index.mjs'] }, { 'index.mjs': 'export const run=()=>1;' });
  const entry = join(app.root, 'entry.mjs');
  await assert.rejects(import(pathToFileURL(entry)));
  assert.throws(() => javascriptProgram(entry, 'run', { resolve: javascriptSourceResolver(f.packages) }), /numeric/);
});

for (const suffix of ['?instance', '#instance']) test(`valid export URL identity ${suffix} must refuse rather than fall through`, async t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': 'export {run} from "peer";' });
  f.pkg('app/node_modules/peer', { name: 'peer', exports: ['./first.mjs' + suffix, './second.mjs'] }, { 'first.mjs': 'export const run=()=>"first";', 'second.mjs': 'export const run=()=>"wrong";' });
  const entry = join(app.root, 'entry.mjs');
  assert.equal((await import(pathToFileURL(entry))).run(), 'first');
  assert.throws(() => javascriptProgram(entry, 'run', { resolve: javascriptSourceResolver(f.packages) }), /unsupported-import-url-identity/);
});

for (const target of ['./%2ffirst.mjs', './%malformed.mjs']) test(`invalid export URL ${target} must refuse after selection rather than fall through`, async t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': 'export {run} from "peer";' });
  f.pkg('app/node_modules/peer', { name: 'peer', exports: [target, './second.mjs'] }, { 'second.mjs': 'export const run=()=>"wrong";' });
  const entry = join(app.root, 'entry.mjs');
  await assert.rejects(import(pathToFileURL(entry)));
  assert.throws(() => javascriptProgram(entry, 'run', { resolve: javascriptSourceResolver(f.packages) }), /source-(url|separator)/);
});

for (const [label, active, selected] of [
  ['all-inactive nonempty array', [{ browser: './wrong.mjs' }], true],
  ['empty array', [], false],
  ['array ending in null', [{ browser: './wrong.mjs' }, null], false],
]) test(`source export array preserves outer condition fallback: ${label}`, async t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': 'export {run} from "peer";' });
  f.pkg('app/node_modules/peer', { name: 'peer', exports: { node: active, default: './index.mjs' } }, { 'index.mjs': 'export const run=()=>"selected";' });
  const entry = join(app.root, 'entry.mjs'), resolve = javascriptSourceResolver(f.packages);
  if (selected) {
    assert.equal((await import(pathToFileURL(entry))).run(), 'selected');
    assert.equal(await executeJavascriptProgram(javascriptProgram(entry, 'run', { resolve })), 'selected');
  } else {
    await assert.rejects(import(pathToFileURL(entry)));
    assert.throws(() => javascriptProgram(entry, 'run', { resolve }));
  }
});

test('missing generated targets cannot escape through an existing directory symlink or hidden package scope', t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': '' });
  const other = f.pkg('other', { name: 'other' });
  symlinkSync(other.root, join(app.root, 'redirect'), 'dir');
  app.bindings = {};
  const resolve = javascriptSourceResolver(f.packages);
  assert.throws(() => resolve('./redirect/absent.mjs', join(app.root, 'entry.mjs')), /leaves its selected package root/);
  mkdirSync(join(app.root, 'hidden'));
  writeFileSync(join(app.root, 'hidden/package.json'), JSON.stringify({ name: 'unlisted', version: '1.0.0' }));
  assert.throws(() => resolve('./hidden/absent.mjs', join(app.root, 'entry.mjs')), /outside the supplied package catalogue/);
});

for (const suffix of ['?instance', '#instance']) test(`unadmitted capture entry ${suffix} cannot silently coalesce URL module instances`, t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': 'export const run=()=>1;' });
  const url = new URL(pathToFileURL(join(app.root, 'entry.mjs')).href + suffix);
  const resolve = javascriptSourceResolver(f.packages);
  for (const entry of [url, url.href]) {
    assert.throws(() => captureModuleClosure(entry), /unsupported entry URL identity/);
    assert.throws(() => captureModuleClosure(entry, { resolve }), /unsupported entry URL identity/);
    assert.throws(() => javascriptProgram(entry, 'run', { resolve }), /unsupported entry URL identity/);
  }
});


for (const declaration of ['workspace:*', 'file:../peer', 'link:../peer', '^1.0.0', '999.0.0']) {
  test(`legacy unique-name location lookup preserves ${declaration} without solving or approving it`, t => {
    const f = fixture(t), app = f.pkg('app', { name: 'app', dependencies: { peer: declaration } }, { 'entry.mjs': '' });
    const peer = f.pkg('peer', { name: 'peer', exports: './index.mjs' }, { 'index.mjs': '' });
    for (const catalogue of [[peer], f.packages]) {
      assert.deepEqual(javascriptSourceResolver(catalogue)('peer', join(app.root, 'entry.mjs')), { file: join(peer.root, 'index.mjs') });
    }
    app.bindings = { peer: peer.root };
    assert.throws(() => javascriptSourceResolver(f.packages), /wrong declared version|unsupported nonexact declaration/);
  });
}

test('explicit importer-bound catalogues do not inherit legacy external-importer lookup', t => {
  const f = fixture(t), app = f.pkg('app', { name: 'app' }, { 'entry.mjs': '' });
  const peer = f.pkg('peer', { name: 'peer', exports: './index.mjs' }, { 'index.mjs': '' });
  peer.bindings = {};
  assert.throws(() => javascriptSourceResolver([peer])('peer', join(app.root, 'entry.mjs')), /outside the supplied package catalogue/);
});
