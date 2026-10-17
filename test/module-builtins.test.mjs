import test from 'node:test';
import assert from 'node:assert/strict';
import {builtinModules,isBuiltin} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalJson} from '@red-cup-engineering/json-services-section';
import {captureModuleClosure,javascriptProgram,executeJavascriptProgram,admitModuleClosure,javascriptInstalledResolver,moduleClosureDigest} from '../src/module-closure.mjs';
function fixture(source){
 const root=mkdtempSync(join(tmpdir(),'closure-builtins-'));
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'builtin-fixture',version:'1',type:'module'}));
 writeFileSync(join(root,'entry.mjs'),source);
 return {root,entry:join(root,'entry.mjs')};
}
test('prefix-only and builtin subpath imports capture and execute through the actual Node loader',async()=>{
 const f=fixture('import {test} from "node:test"; import {spec} from "node:test/reporters"; import {basename} from "path/posix"; import {readFile} from "fs/promises"; export const run=()=>[typeof test,typeof spec,basename("/a/b"),typeof readFile];');
 try{
  const closure=captureModuleClosure(f.entry);
  assert.deepEqual(Object.values(closure.body.modules[closure.body.entry].imports).sort(),['node:test','node:test/reporters','node:path/posix','node:fs/promises'].sort());
  const program=javascriptProgram(f.entry,'run');
  assert.deepEqual(await executeJavascriptProgram(program),['function','function','b','function']);
  assert.equal(moduleClosureDigest([f.entry]).modules,1);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('every builtin reported by the supported runtime is retained as an explicit environmental import',()=>{
 for(const name of builtinModules){
  assert.ok(isBuiltin(name));
  const f=fixture(`import ${JSON.stringify(name)}; export const run=()=>true;`);
  try{
   const closure=captureModuleClosure(f.entry),target=Object.values(closure.body.modules[closure.body.entry].imports)[0];
   assert.equal(target,name.startsWith('node:')?name:'node:'+name);
   assert.equal(javascriptInstalledResolver()(name,f.entry),null);
  }finally{rmSync(f.root,{recursive:true,force:true});}
 }
});
for(const name of ['node:no-such-builtin','node:fs/not-a-builtin','fs/not-a-builtin'])test(`unsupported builtin-like import refuses: ${name}`,()=>{
 const f=fixture(`import ${JSON.stringify(name)}; export const run=()=>true;`);
 try{assert.throws(()=>captureModuleClosure(f.entry));assert.notEqual(javascriptInstalledResolver()(name,f.entry),null);}finally{rmSync(f.root,{recursive:true,force:true});}
});
test('bare test remains an ordinary package rather than being coerced into node:test',async()=>{
 const f=fixture('import {value} from "test"; export const run=()=>value;');
 try{
  mkdirSync(join(f.root,'node_modules','test'),{recursive:true});
  writeFileSync(join(f.root,'node_modules','test','package.json'),JSON.stringify({name:'test',version:'1',type:'module',exports:'./index.mjs'}));
  writeFileSync(join(f.root,'node_modules','test','index.mjs'),'export const value="actual package";');
  assert.equal(await executeJavascriptProgram(javascriptProgram(f.entry,'run')),'actual package');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('transported closure cannot smuggle an unknown environmental builtin under a valid content address',()=>{
 const f=fixture('import "node:path"; export const run=()=>true;');
 try{
  const closure=captureModuleClosure(f.entry),body=structuredClone(closure.body);
  body.modules[body.entry].imports['node:path']='node:no-such-builtin';
  const id='ni:///sha-256;'+createHash('sha256').update(canonicalJson(body)).digest('base64url');
  assert.throws(()=>admitModuleClosure(id,body),/leaves its admitted closure/);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
