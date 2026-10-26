import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { javascriptProgram, executeJavascriptProgram, moduleClosureMaterial } from '../src/module-closure.mjs';

function fixture(t, name, files) {
  const root = mkdtempSync(join(tmpdir(), 'addressed-reentry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module' }));
  for (const [name, source] of Object.entries(files)) {
    const path = join(root, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, source);
  }
  return { root, entry: join(root, 'entry.mjs') };
}
function addressed(programme, entry) {
  const url = pathToFileURL(entry);
  url.searchParams.set('__561_programme', programme.closure);
  url.searchParams.set('__561_module', programme.module);
  return url;
}

test('captured original executor re-enters its same closure through same-module re-export and retains lifetime', async t => {
  const implementation = new URL('../src/module-closure.mjs', import.meta.url).href;
  const f = fixture(t, 'captured-executor-fixture', {
    'entry.mjs': `import {javascriptProgram,executeJavascriptProgram} from ${JSON.stringify(implementation)};
      export {body} from './body.mjs';
      export const factory=()=>javascriptProgram(import.meta.url,'body');
      export const nested=input=>executeJavascriptProgram(factory(),input);`,
    'body.mjs': 'let count=0; export const body=input=>({input,count:++count});',
  });
  const nested = javascriptProgram(f.entry, 'nested');
  const factory = { ...nested, export: 'factory' };
  const body = await executeJavascriptProgram(factory);
  assert.equal(body.closure, nested.closure); assert.equal(body.module, nested.module); assert.equal(body.export, 'body');
  assert.deepEqual(await executeJavascriptProgram(nested, 'first'), { input: 'first', count: 1 });
  assert.deepEqual(await executeJavascriptProgram(body, 'second'), { input: 'second', count: 2 });
  assert.deepEqual(await executeJavascriptProgram(nested, 'third'), { input: 'third', count: 3 });
  const material = moduleClosureMaterial(nested.closure);
  // The portable receiving process admits only retained bytes: no origin map and
  // no surviving fixture file can rescue an accidental filesystem recapture.
  rmSync(f.root, { recursive: true });
  const source = `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
    import {admitModuleClosure,executeJavascriptProgram} from ${JSON.stringify(implementation)};
    const {nested,material}=JSON.parse(readFileSync(0,'utf8'));
    admitModuleClosure(nested.closure,material);
    const body=await executeJavascriptProgram({...nested,export:'factory'});
    assert.equal(body.closure,nested.closure); assert.equal(body.module,nested.module);
    const first=await executeJavascriptProgram(nested,'portable');
    const next=await executeJavascriptProgram(body,'same lifetime');
    assert.deepEqual(first,{input:'portable',count:1}); assert.deepEqual(next,{input:'same lifetime',count:2});
    process.stdout.write('received');`;
  const child = spawnSync(process.execPath, ['--max-old-space-size=384', '--input-type=module', '--eval', source], {
    env: { PATH: process.env.PATH }, input: JSON.stringify({ nested, material }), encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 ** 2,
  });
  assert.ifError(child.error); assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null); assert.equal(child.stdout, 'received');
});

test('only the exact same-closure addressed selector re-enters; ordinary and forged imports still refuse', async t => {
  const f = fixture(t, 'addressed-selector-fixture', {
    'entry.mjs': 'let count=0; export const next=()=>++count; export const run=async specifier=>(await import(specifier)).next();',
    'ambient.mjs': 'export const next=()=>"ambient";',
  });
  const program = javascriptProgram(f.entry, 'run'), canonical = addressed(program, f.entry);
  assert.equal(await executeJavascriptProgram(program, canonical.href), 1);
  assert.equal(await executeJavascriptProgram(program, canonical.href), 2);
  const other = fixture(t, 'different-admitted-closure', { 'entry.mjs': 'export const next=()=>"other closure";' });
  const otherProgram = javascriptProgram(other.entry, 'next');
  assert.equal(await executeJavascriptProgram(otherProgram), 'other closure');
  const differentClosure = addressed(otherProgram, other.entry);
  const forgedOrigin = new URL(canonical); forgedOrigin.pathname = '/forged/origin.mjs';
  const extraQuery = new URL(canonical); extraQuery.searchParams.set('extra', 'instance');
  const fragment = new URL(canonical); fragment.hash = 'instance';
  const unknownKey = new URL(canonical); unknownKey.searchParams.set('__561_module', 'unknown@1.0.0/entry.mjs');
  const unknownClosure = new URL(canonical); unknownClosure.searchParams.set('__561_programme', 'ni:///sha-256;' + 'A'.repeat(43));
  for (const selector of [
    differentClosure.href, forgedOrigin.href, extraQuery.href, fragment.href, unknownKey.href, unknownClosure.href,
    './ambient.mjs', 'unrecorded-package', pathToFileURL(join(f.root, 'ambient.mjs')).href, 'node:fs',
  ]) await assert.rejects(executeJavascriptProgram(program, selector), /no admitted import|Unadmitted JavaScript programme module/);
  assert.equal(await executeJavascriptProgram(program, canonical.href), 3);
});
