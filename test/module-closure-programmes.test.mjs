import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {captureModuleClosure,javascriptProgram,executeJavascriptProgram,admitModuleClosure,moduleClosureMaterial} from '../src/module-closure.mjs';

test('an executable closure selects retained transitive bytes despite ambient cache, mutation, withdrawal and relocation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'addressed-node-')),a=join(root,'a'),b=join(root,'b');
 try{
  for(const directory of [a,b]){mkdirSync(directory);writeFileSync(join(directory,'package.json'),JSON.stringify({name:'programme-fixture',version:'1',type:'module'}));writeFileSync(join(directory,'entry.mjs'),'import {effect} from "./effect.mjs"; export function run(input, args, context) { return context.output(effect(input)); }\n');writeFileSync(join(directory,'effect.mjs'),'export const effect = input => "original:"+input;\n');}
  const ambient=await import(pathToFileURL(join(a,'entry.mjs')));assert.equal(ambient.run('one',{}, {output:v=>v}),'original:one');
  const programme=javascriptProgram(pathToFileURL(join(a,'entry.mjs')),'run');
  const relocated=javascriptProgram(pathToFileURL(join(b,'entry.mjs')),'run');assert.deepEqual(programme,relocated);
  writeFileSync(join(a,'effect.mjs'),'export const effect = input => "changed:"+input;\n');
  const changed=javascriptProgram(pathToFileURL(join(a,'entry.mjs')),'run');assert.notEqual(changed.closure,programme.closure);
  assert.equal(await executeJavascriptProgram(changed,'two',{}, {output:v=>v}),'changed:two');
  rmSync(join(a,'effect.mjs'));rmSync(join(b,'effect.mjs'));rmSync(join(a,'entry.mjs'));rmSync(join(b,'entry.mjs'));
  assert.equal(await executeJavascriptProgram(programme,'two',{}, {output:v=>v}),'original:two');
  assert.equal(await executeJavascriptProgram(programme,'three',{}, {output:v=>v}),'original:three');
  const material=structuredClone(moduleClosureMaterial(programme.closure));const node=material.modules[material.entry];node.source=Buffer.from('export const run=()=>"substituted"').toString('base64');assert.throws(()=>admitModuleClosure(programme.closure,material),/address mismatch/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('unrecorded dynamic imports and unresolved static imports cannot substitute ambient code',async()=>{
 const root=mkdtempSync(join(tmpdir(),'closed-node-'));
 try{
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'closed-fixture',version:'1',type:'module'}));
  writeFileSync(join(root,'entry.mjs'),'export const run = input => import(input);\n');
  writeFileSync(join(root,'other.mjs'),'export const answer = 42;\n');
  const programme=javascriptProgram(pathToFileURL(join(root,'entry.mjs')),'run');
  await assert.rejects(executeJavascriptProgram(programme,'./other.mjs'),/no admitted import/);
  writeFileSync(join(root,'entry.mjs'),'import "./missing.mjs"; export const run = () => true;\n');
  assert.throws(()=>captureModuleClosure(join(root,'entry.mjs')),/cannot admit/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('literal dynamic imports, JSON and CommonJS libraries retain their actual sources',async()=>{
 const root=mkdtempSync(join(tmpdir(),'libraries-node-'));
 try{
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'libraries-fixture',version:'1',type:'module'}));
  writeFileSync(join(root,'entry.mjs'),'import {value} from "./library.cjs"; import record from "./record.json" with {type:"json"}; export const run = async () => value+(await import("./extra.mjs")).value+record.value;\n');
  writeFileSync(join(root,'library.cjs'),'module.exports.value=require("./nested.cjs").value;\n');
  writeFileSync(join(root,'nested.cjs'),'exports.value=2;\n');writeFileSync(join(root,'record.json'),'{"value":3}');writeFileSync(join(root,'extra.mjs'),'export const value=4;\n');
  const first=javascriptProgram(pathToFileURL(join(root,'entry.mjs')),'run');
  assert.equal(await executeJavascriptProgram(first),9);
  writeFileSync(join(root,'nested.cjs'),'exports.value=20;\n');
  const next=javascriptProgram(pathToFileURL(join(root,'entry.mjs')),'run');assert.notEqual(next.closure,first.closure);
  assert.equal(await executeJavascriptProgram(next),27);
  assert.equal(await executeJavascriptProgram(first),9);
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('byte-identical package instances keep their own dependency context and module state',async()=>{
 const root=mkdtempSync(join(tmpdir(),'package-contexts-'));
 try{
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'contexts-fixture',version:'1',type:'module'}));
  writeFileSync(join(root,'entry.mjs'),'import {read as a} from "./a/entry.mjs"; import {read as b} from "./b/entry.mjs"; export const run=()=>[a(),b()];\n');
  for(const [branch,version] of [['a','1'],['b','2']]){
   const directory=join(root,branch);mkdirSync(join(directory,'node_modules','shared'),{recursive:true});mkdirSync(join(directory,'node_modules','peer'));
   writeFileSync(join(directory,'package.json'),JSON.stringify({name:'branch-'+branch,version:'1',type:'module'}));
   writeFileSync(join(directory,'entry.mjs'),'export {read} from "shared";\n');
   writeFileSync(join(directory,'node_modules','shared','package.json'),JSON.stringify({name:'shared',version:'1',type:'module',exports:'./index.mjs'}));
   writeFileSync(join(directory,'node_modules','shared','index.mjs'),'import {value} from "peer"; let count=0; export const read=()=>value+(++count);\n');
   writeFileSync(join(directory,'node_modules','peer','package.json'),JSON.stringify({name:'peer',version,type:'module',exports:'./index.mjs'}));
   writeFileSync(join(directory,'node_modules','peer','index.mjs'),'export const value='+JSON.stringify(branch)+';\n');
  }
  const programme=javascriptProgram(pathToFileURL(join(root,'entry.mjs')),'run');
  assert.deepEqual(await executeJavascriptProgram(programme),['a1','b1']);assert.deepEqual(await executeJavascriptProgram(programme),['a2','b2']);
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('conditional exports and mixed CommonJS import/require retain the same dependency choices as Node',async()=>{
 const root=mkdtempSync(join(tmpdir(),'programme-modes-'));
 try{
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'modes-fixture',version:'1',type:'module'}));
  mkdirSync(join(root,'node_modules','dual'),{recursive:true});
  writeFileSync(join(root,'node_modules','dual','package.json'),JSON.stringify({name:'dual',version:'1',type:'module',exports:{'.':{require:'./require.cjs',import:'./import.mjs'}}}));
  writeFileSync(join(root,'node_modules','dual','require.cjs'),'exports.value="require";');
  writeFileSync(join(root,'node_modules','dual','import.mjs'),'export const value="import";');
  writeFileSync(join(root,'bridge.cjs'),'const required=require("dual"); exports.read=async()=>[required.value,(await import("dual")).value];');
  writeFileSync(join(root,'entry.mjs'),'import {read} from "./bridge.cjs"; export const run=()=>read();');
  const ambient=await import(pathToFileURL(join(root,'entry.mjs')));assert.deepEqual(await ambient.run(),['require','import']);
  const programme=javascriptProgram(pathToFileURL(join(root,'entry.mjs')),'run');
  rmSync(join(root,'node_modules'),{recursive:true});rmSync(join(root,'bridge.cjs'));rmSync(join(root,'entry.mjs'));
  assert.deepEqual(await executeJavascriptProgram(programme),['require','import']);
  writeFileSync(join(root,'entry.mjs'),'import "./missing"; export const run=()=>true;');writeFileSync(join(root,'missing.js'),'export const value=true;');
  assert.throws(()=>captureModuleClosure(join(root,'entry.mjs')),/cannot admit/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
