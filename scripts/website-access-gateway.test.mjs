import {AsyncLocalStorage}from'node:async_hooks';import {readFileSync}from'node:fs';import {stripTypeScriptTypes}from'node:module';import vm from'node:vm';import test from'node:test';import assert from'node:assert/strict';
const source=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8').replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
const access=(denied)=>Object.fromEntries(['erp','accounting','site'].map(name=>[name,{visible:true,login:name!==denied}]));
function harness(denied){let handler;const context=vm.createContext({AsyncLocalStorage,performance,Error,URL,Request,Response,Headers,AbortController,setTimeout,clearTimeout,console,crypto,Deno:{env:{get:()=>''},serve:fn=>handler=fn}});
 vm.runInContext(source,context);context.currentUser=async()=>({id:'10000000-0000-4000-8000-000000000001',username:'fixture',role:'custom',is_active:true,permissions:[],website_access:access(denied)});
 const request=async(query,system)=>{const r=await handler(new Request('https://fixture.invalid/inventory-gateway?'+query,{headers:system?{'x-guc-system':system}:{}}));return {status:r.status,body:await r.json()};};return {request,context};}
test('website revocation rejects every site session before a data read',async()=>{
 for(const [website,system]of [['erp','erp'],['accounting','quotation'],['site','site']]){
  const h=harness(website);h.context.get=async()=>{throw Error('Must not read after denial');};assert.equal((await h.request('scope=session',system)).status,403);
 }
});
test('accounting-only header cannot expose ERP settings or user management',async()=>{
 const h=harness('erp');for(const system of ['quotation','site'])assert.equal((await h.request('scope=settings',system)).status,403);
});
test('financial and performance routes require accounting access even when called directly',async()=>{
 const h=harness('accounting');for(const query of ['scope=finance&module=accounting_ledger','scope=performance&mode=list'])assert.equal((await h.request(query,'erp')).status,403);
});
