import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8').replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
const id='10000000-0000-4000-8000-000000000001';
function harness(actions=[],module='customers'){
 let handler;const calls=[];
 const context=vm.createContext({AsyncLocalStorage,performance,URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,crypto,console,Deno:{env:{get:()=>''},serve:fn=>handler=fn}});
 vm.runInContext(source,context);
 context.currentUser=async()=>({id,username:'fixture',role:'custom',is_active:true,permissions:[{module,can_view:actions.includes('view'),can_create:actions.includes('create'),can_update:actions.includes('update'),can_delete:actions.includes('delete')}]});
 context.get=context.getAll=async path=>{calls.push(path);return [];};
 context.rpc=async(name,args)=>{calls.push({name,args});return {};};
 return {calls,context,read:scope=>handler(new Request('https://example.test/inventory-gateway?scope='+scope)),write:(operation,payload)=>handler(new Request('https://example.test/inventory-gateway',{method:'POST',body:JSON.stringify({operation,payload})}))};
}
for(const action of ['create','update','delete']){
 test('customer classification '+action+' enforces the existing customer grant',async()=>{
  const payload={id,row_version:2,name:'企業'};
  for(const h of [harness(['view']),harness(['view',action],'inventory')]){
   assert.equal((await h.write(action+'_customer_category',payload)).status,403);assert.equal(h.calls.length,0);
  }
  const h=harness(['view',action]);assert.equal((await h.write(action+'_customer_category',payload)).status,201);
  assert.equal(h.calls[0].name,'manage_customer_category_v1');assert.equal(h.calls[0].args.p_action,action);
  assert.equal(h.calls[0].args.p_row_version,action==='create'?null:2);
 });
}
test('classification malformed input and anonymous writes never reach the database',async()=>{
 for(const [action,payload]of [['create',{name:' '}],['create',{name:'x'.repeat(81)}],['update',{id,row_version:0,name:'分類'}],['delete',{id:'invalid',row_version:1}]]){
  const h=harness(['view','create','update','delete']);assert.equal((await h.write(action+'_customer_category',payload)).status,400);assert.equal(h.calls.length,0);
 }
 const h=harness();h.context.currentUser=async()=>null;assert.equal((await h.write('create_customer_category',{name:'分類'})).status,401);assert.equal(h.calls.length,0);
});
test('CRM classification lookup follows view permissions, including delegated users',async()=>{
 const denied=harness();assert.equal((await denied.read('crm')).status,403);assert.equal(denied.calls.length,0);
 const allowed=harness(['view']);assert.equal((await allowed.read('crm')).status,200);
 assert.ok(allowed.calls.some(p=>typeof p==='string'&&p.startsWith('customer_categories?')));
 assert.ok(!allowed.calls.some(p=>typeof p==='string'&&p.startsWith('suppliers?')));
 const supplier=harness(['view'],'suppliers');assert.equal((await supplier.read('crm')).status,200);assert.ok(!supplier.calls.some(p=>typeof p==='string'&&p.startsWith('customer_categories?')));
});
test('customer save accepts new category codes and leaves membership to the foreign key',async()=>{
 const h=harness(['view','create']);const response=await h.write('create_customer',{customer_category:'custom_123',name:'測試企業',contract_service_codes:[]});
 assert.equal(response.status,201);assert.equal(h.calls[0].name,'create_customer_with_contracts_v1');assert.equal(h.calls[0].args.p_customer_category,'custom_123');
});
