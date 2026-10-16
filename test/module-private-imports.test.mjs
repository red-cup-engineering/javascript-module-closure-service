import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {captureModuleClosure,javascriptProgram,executeJavascriptProgram,moduleClosureDigest} from '../src/module-closure.mjs';

function fixture(imports, files) {
 const root=mkdtempSync(join(tmpdir(),'private-imports-'));
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'private-import-fixture',version:'1',type:'module',imports}));
 for(const [name,source] of Object.entries(files)){const file=join(root,name);mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,source);}
 return root;
}

test('private import maps retain Node conditional import/require choices and exact bytes after withdrawal',async()=>{
 const root=fixture({'#util':{types:'./absent.d.ts',browser:'./absent.mjs',node:{import:'./util.mjs',require:'./util.cjs'},default:'./absent.mjs'}},{
  'entry.mjs':'import {value} from "#util"; import {value as required} from "./bridge.cjs"; export const run=()=>[value,required];',
  'util.mjs':'export const value="import";', 'util.cjs':'exports.value="require";', 'bridge.cjs':'exports.value=require("#util").value;'
 });
 try {
  const expected=(await import(pathToFileURL(join(root,'entry.mjs')))).run();
  assert.deepEqual(expected,['import','require']);
  const programme=javascriptProgram(join(root,'entry.mjs'),'run');
  const digest=moduleClosureDigest([join(root,'entry.mjs')]);assert.ok(digest);
  rmSync(root,{recursive:true});assert.deepEqual(await executeJavascriptProgram(programme),expected);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('private wildcard and external package targets follow the declaring package',async()=>{
 const root=fixture({'#value/*':'./values/*.mjs','#peer':'peer'}, {
  'entry.mjs':'import {value} from "#value/one"; import {value as peer} from "#peer"; export const run=()=>[value,peer];',
  'values/one.mjs':'export const value=1;',
  'node_modules/peer/package.json':JSON.stringify({name:'peer',version:'1',type:'module',exports:'./index.mjs'}),
  'node_modules/peer/index.mjs':'export const value=2;'
 });
 try {const expected=(await import(pathToFileURL(join(root,'entry.mjs')))).run();const programme=javascriptProgram(join(root,'entry.mjs'),'run');assert.deepEqual(await executeJavascriptProgram(programme),expected);}finally{rmSync(root,{recursive:true,force:true});}
});

test('a private builtin alias retains the admitted builtin rather than ambient package code',async()=>{
 const root=fixture({'#path':'path'},{'entry.mjs':'import {basename} from "#path"; export const run=()=>basename("/one/two");'});
 try {const programme=javascriptProgram(join(root,'entry.mjs'),'run');assert.equal(await executeJavascriptProgram(programme),(await import(pathToFileURL(join(root,'entry.mjs')))).run());}finally{rmSync(root,{recursive:true,force:true});}
});

for(const [label,target] of [['blocked',null],['URI target','node:path'],['blocked active condition',{node:null,default:'./value.mjs'}],['unmapped',undefined],['parent escape','../escape.mjs'],['embedded parent','./child/../value.mjs'],['encoded parent','./%2e%2e/escape.mjs'],['nested installation','./node_modules/peer/index.mjs']]){
 test(`private import refuses ${label} like Node`,async()=>{
  const root=fixture(target===undefined?{}:{'#value':target},{'entry.mjs':'import {value} from "#value"; export const run=()=>value;','value.mjs':'export const value="must not be admitted";'});
  try {await assert.rejects(import(pathToFileURL(join(root,'entry.mjs'))));assert.throws(()=>captureModuleClosure(join(root,'entry.mjs')),/cannot admit/);}finally{rmSync(root,{recursive:true,force:true});}
 });
}

test('a dependency cannot borrow a private import from its parent package',async()=>{
 const root=fixture({'#value':'./value.mjs'},{'entry.mjs':'export {run} from "peer";','value.mjs':'export const value=42;','node_modules/peer/package.json':JSON.stringify({name:'peer',version:'1',type:'module',exports:'./index.mjs'}),'node_modules/peer/index.mjs':'import {value} from "#value"; export const run=()=>value;'});
 try {await assert.rejects(import(pathToFileURL(join(root,'entry.mjs'))));assert.throws(()=>captureModuleClosure(join(root,'entry.mjs')),/cannot admit/);}finally{rmSync(root,{recursive:true,force:true});}
});

const wildcardCases = [
 ['more-specific prefix before broad',{'#values/branch/*':'./specific.mjs','#values/*':'./broad.mjs'},false],
 ['more-specific prefix after broad',{'#values/*':'./broad.mjs','#values/branch/*':'./specific.mjs'},false],
 ['longer suffix after broad',{'#values/*':'./broad.mjs','#values/*.js':'./specific.mjs'},false],
 ['exact key overrides wildcard',{'#values/*':'./broad.mjs','#values/branch/item.js':'./specific.mjs'},false],
 ['null winning wildcard blocks broad',{'#values/*':'./broad.mjs','#values/branch/*':null},true],
 ['conditional-null winning wildcard blocks broad',{'#values/*':'./broad.mjs','#values/branch/*':{node:null,default:'./specific.mjs'}},true],
 ['condition-absent winning wildcard blocks broad',{'#values/*':'./broad.mjs','#values/branch/*':{browser:'./specific.mjs'}},true],
 ['condition-absent exact key blocks wildcard',{'#values/*':'./broad.mjs','#values/branch/item.js':{browser:'./specific.mjs'}},true],
 ['inactive nested condition reaches default',{'#values/branch/item.js':{node:{browser:'./broad.mjs'},default:'./specific.mjs'}},false],
 ['array fallback skips null',{'#values/branch/item.js':[null,'./specific.mjs']},false],
];
for(const [label,imports,rejected] of wildcardCases) test(`private map matches Node for ${label}`,async()=>{
 const root=fixture(imports,{'entry.mjs':'import {value} from "#values/branch/item.js"; export const run=()=>value;','broad.mjs':'export const value="broad";','specific.mjs':'export const value="specific";'});
 try {
  if(rejected){await assert.rejects(import(pathToFileURL(join(root,'entry.mjs'))));assert.throws(()=>captureModuleClosure(join(root,'entry.mjs')),/cannot admit/);}
  else {const expected=(await import(pathToFileURL(join(root,'entry.mjs')))).run();assert.equal(expected,'specific');const programme=javascriptProgram(join(root,'entry.mjs'),'run');assert.equal(await executeJavascriptProgram(programme),expected);}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('private relative URL decoding cannot select a different present source file than Node',async()=>{
 const root=fixture({'#value':'./%76alue.mjs'},{'entry.mjs':'import {value} from "#value"; export const run=()=>value;','value.mjs':'export const value="decoded";','%76alue.mjs':'export const value="literal-wrong-source";'});
 try {const expected=(await import(pathToFileURL(join(root,'entry.mjs')))).run();const programme=javascriptProgram(join(root,'entry.mjs'),'run');assert.equal(await executeJavascriptProgram(programme),expected);}finally{rmSync(root,{recursive:true,force:true});}
});

for(const [label,imports,specifier] of [
 ['bare private marker',{'#':'./value.mjs'},'#'],
 ['trailing slash request',{'#value/':'./value.mjs'},'#value/'],
 ['case-insensitive forbidden installation segment',{'#value':'./NODE_MODULES/value.mjs'},'#value'],
]) test(`private map refuses ${label} like Node`,async()=>{
 const root=fixture(imports,{'entry.mjs':`import {value} from ${JSON.stringify(specifier)}; export const run=()=>value;`,'value.mjs':'export const value=1;','NODE_MODULES/value.mjs':'export const value=2;'});
 try {await assert.rejects(import(pathToFileURL(join(root,'entry.mjs'))));assert.throws(()=>captureModuleClosure(join(root,'entry.mjs')),/cannot admit/);}finally{rmSync(root,{recursive:true,force:true});}
});

// The supported Node runtime admits an exact #/ key; do not invent a stricter grammar.
test('an exact private slash key follows the genuine Node importer',async()=>{
 const root=fixture({'#/value':'./value.mjs'},{'entry.mjs':'import {value} from "#/value"; export const run=()=>value;','value.mjs':'export const value=7;'});
 try {const expected=(await import(pathToFileURL(join(root,'entry.mjs')))).run();const programme=javascriptProgram(join(root,'entry.mjs'),'run');assert.equal(await executeJavascriptProgram(programme),expected);}finally{rmSync(root,{recursive:true,force:true});}
});

for (const order of ['default', 'import']) test(`private digest follows Node ${order}-before-node condition order`, async () => {
 const root=fixture({'#value':{[order]:'./selected.mjs',node:'./unselected.mjs'}},{'entry.mjs':'import {value} from "#value"; export const run=()=>value;','selected.mjs':'export const value="selected";','unselected.mjs':'export const value="wrong";'});
 try {
  const entry=join(root,'entry.mjs'); const expected=(await import(pathToFileURL(entry))).run(); assert.equal(expected,'selected');
  assert.equal(await executeJavascriptProgram(javascriptProgram(entry,'run')),expected);
  const before=moduleClosureDigest([entry]);
  writeFileSync(join(root,'unselected.mjs'),'export const value="other unselected bytes";');
  assert.deepEqual(moduleClosureDigest([entry]),before);
  writeFileSync(join(root,'selected.mjs'),'export const value="changed selected bytes";');
  assert.notEqual(moduleClosureDigest([entry]).digest,before.digest);
 } finally {rmSync(root,{recursive:true,force:true});}
});

for(const [pattern,specifier] of [['#v*','#v'],['#v*.mjs','#v.mjs'],['#foobar*bar','#foobar']]) test(`private wildcard refuses empty or overlapping match ${pattern}`,async()=>{
 const root=fixture({[pattern]:'./value.mjs'},{'entry.mjs':`import {value} from ${JSON.stringify(specifier)}; export const run=()=>value;`,'value.mjs':'export const value=1;'});
 try {await assert.rejects(import(pathToFileURL(join(root,'entry.mjs'))));assert.throws(()=>captureModuleClosure(join(root,'entry.mjs')),/cannot admit/);}finally{rmSync(root,{recursive:true,force:true});}
});

test('private condition objects refuse numeric keys like Node',async()=>{
 const root=fixture({'#value':{'0':'./other.mjs',default:'./value.mjs'}},{'entry.mjs':'import {value} from "#value"; export const run=()=>value;','value.mjs':'export const value=1;','other.mjs':'export const value=2;'});
 try {await assert.rejects(import(pathToFileURL(join(root,'entry.mjs'))));assert.throws(()=>captureModuleClosure(join(root,'entry.mjs')),/cannot admit/);}finally{rmSync(root,{recursive:true,force:true});}
});

for(const segment of ['..','%2e%2e','node_modules','%6eode_modules','.']) test(`private wildcard refuses forbidden request segment ${segment} even with a constant target`,async()=>{
 const root=fixture({'#value/*':'./value.mjs'},{'entry.mjs':`import {value} from ${JSON.stringify('#value/'+segment+'/other')}; export const run=()=>value;`,'value.mjs':'export const value=1;'});
 try {await assert.rejects(import(pathToFileURL(join(root,'entry.mjs'))));assert.throws(()=>captureModuleClosure(join(root,'entry.mjs')),/cannot admit/);}finally{rmSync(root,{recursive:true,force:true});}
});

test('a constant private wildcard target preserves Node acceptance of an encoded separator in the unused match',async()=>{
 const root=fixture({'#value/*':'./value.mjs'},{'entry.mjs':'import {value} from "#value/%2fother"; export const run=()=>value;','value.mjs':'export const value=1;'});
 try {const expected=(await import(pathToFileURL(join(root,'entry.mjs')))).run();assert.equal(await executeJavascriptProgram(javascriptProgram(join(root,'entry.mjs'),'run')),expected);}finally{rmSync(root,{recursive:true,force:true});}
});

for(const [label,target] of [
 ['numeric object after an already selected array target',['./value.mjs',{'0':'./other.mjs'}]],
 ['numeric object under an inactive condition',{browser:{'0':'./other.mjs'},default:'./value.mjs'}],
]) test(`private condition selection does not evaluate ${label}`,async()=>{
 const root=fixture({'#value':target},{'entry.mjs':'import {value} from "#value"; export const run=()=>value;','value.mjs':'export const value=1;','other.mjs':'export const value=2;'});
 try {const expected=(await import(pathToFileURL(join(root,'entry.mjs')))).run();assert.equal(await executeJavascriptProgram(javascriptProgram(join(root,'entry.mjs'),'run')),expected);}finally{rmSync(root,{recursive:true,force:true});}
});

for(const target of ['@bad','%bad']) test(`private external alias refuses invalid package name ${target} even when that installation exists`,async()=>{
 const root=fixture({'#value':target},{'entry.mjs':'import {value} from "#value"; export const run=()=>value;',
  [`node_modules/${target}/package.json`]:JSON.stringify({name:target,version:'1',type:'module',exports:'./index.mjs'}),
  [`node_modules/${target}/index.mjs`]:'export const value=1;'});
 try {await assert.rejects(import(pathToFileURL(join(root,'entry.mjs'))));assert.throws(()=>captureModuleClosure(join(root,'entry.mjs')),/cannot admit/);}finally{rmSync(root,{recursive:true,force:true});}
});

for(const [key,rejected] of [['#value**',true],['#value*',false]]) test(`private literal-star request retains pattern semantics for ${key}`,async()=>{
 const root=fixture({[key]:'./value.mjs'},{'entry.mjs':`import {value} from ${JSON.stringify(key)}; export const run=()=>value;`,'value.mjs':'export const value=1;'});
 try {
  if(rejected){await assert.rejects(import(pathToFileURL(join(root,'entry.mjs'))));assert.throws(()=>captureModuleClosure(join(root,'entry.mjs')),/cannot admit/);}
  else {const expected=(await import(pathToFileURL(join(root,'entry.mjs')))).run();assert.equal(await executeJavascriptProgram(javascriptProgram(join(root,'entry.mjs'),'run')),expected);}
 }finally{rmSync(root,{recursive:true,force:true});}
});

for(const [label,target] of [['active false target',{node:false,default:'./value.mjs'}],['active numeric target',{node:42,default:'./value.mjs'}],['numeric fractional condition key',{'1.5':'./other.mjs',default:'./value.mjs'}]]) test(`private condition refuses ${label} like Node`,async()=>{
 const root=fixture({'#value':target},{'entry.mjs':'import {value} from "#value"; export const run=()=>value;','value.mjs':'export const value=1;','other.mjs':'export const value=2;'});
 try {await assert.rejects(import(pathToFileURL(join(root,'entry.mjs'))));assert.throws(()=>captureModuleClosure(join(root,'entry.mjs')),/cannot admit/);}finally{rmSync(root,{recursive:true,force:true});}
});

for(const suffix of ['?one','#one']) test(`private file URL ${suffix} identity explicitly refuses instead of coalescing distinct Node instances`,async()=>{
 const root=fixture({'#first':'./counter.mjs'+suffix,'#second':'./counter.mjs'+suffix.replace('one','two')},{'entry.mjs':'import {next as a} from "#first"; import {next as b} from "#second"; export const run=()=>[a(),b()];','counter.mjs':'let n=0; export const next=()=>++n;'});
 try {assert.deepEqual((await import(pathToFileURL(join(root,'entry.mjs')))).run(),[1,1]);assert.throws(()=>captureModuleClosure(join(root,'entry.mjs')),/unsupported-import-url-identity/);}finally{rmSync(root,{recursive:true,force:true});}
});
for(const [encoded,literal] of [['%3f','?'],['%23','#']]) test(`private encoded filename ${encoded} remains a file rather than a URL identity`,async()=>{
 const root=fixture({'#value':'./value'+encoded+'.mjs'},{'entry.mjs':'import {value} from "#value"; export const run=()=>value;',['value'+literal+'.mjs']:'export const value=1;'});
 try {const expected=(await import(pathToFileURL(join(root,'entry.mjs')))).run();assert.equal(await executeJavascriptProgram(javascriptProgram(join(root,'entry.mjs'),'run')),expected);}finally{rmSync(root,{recursive:true,force:true});}
});

for(const target of [' node:path','\tnode:path']) test(`private external alias refuses parseable URI ${JSON.stringify(target)} despite a matching installation`,async()=>{
 const root=fixture({'#value':target},{'entry.mjs':'import {value} from "#value"; export const run=()=>value;',
  [`node_modules/${target}/package.json`]:JSON.stringify({name:target,version:'1',type:'module',exports:'./index.mjs'}),
  [`node_modules/${target}/index.mjs`]:'export const value=1;'});
 try {await assert.rejects(import(pathToFileURL(join(root,'entry.mjs'))));assert.throws(()=>captureModuleClosure(join(root,'entry.mjs')),/cannot admit/);}finally{rmSync(root,{recursive:true,force:true});}
});
