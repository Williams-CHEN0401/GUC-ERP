import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8').replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const permission=(module,...actions)=>({module,...Object.fromEntries(['view','create','update','delete'].map(action=>['can_'+action,actions.includes(action)]))});
function harness(permissions,scoped=false){let handler;const calls=[];
 const user={id:id(1),username:'test_worker',role:'custom_test',is_active:true,permissions,project_scoped:scoped};
 const context=vm.createContext({AsyncLocalStorage,performance,URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,crypto,console,Deno:{env:{get:()=>''},serve:fn=>handler=fn}});
 vm.runInContext(source,context);context.currentUser=async()=>user;
 context.get=async path=>{calls.push(path);return[];};context.rpc=async(name,args)=>{calls.push({name,args});return{};};
 return {context,calls,user,read:query=>handler(new Request('https://example.test/inventory-gateway?'+query)),write:(operation,payload)=>handler(new Request('https://example.test/inventory-gateway',{method:'POST',body:JSON.stringify({operation,payload})}))};
}

test('product category CRUD uses inventory grants and stale versions reach the atomic RPC',async()=>{
 const payload={id:id(2),row_version:3,name:'New category',code_prefix:'ZZ',is_active:true};
 for(const [operation,action,rpc] of [['create_product_category','create','create_product_category_v1'],['update_product_category','update','update_product_category_v1'],['delete_product_category','delete','delete_product_category_v1']]){
  const denied=harness([permission('inventory','view')]);assert.equal((await denied.write(operation,payload)).status,403);assert.equal(denied.calls.length,0);
  const allowed=harness([permission('inventory','view',action)]);assert.equal((await allowed.write(operation,payload)).status,201);assert.equal(allowed.calls[0].name,rpc);
  if(action!=='create')assert.equal(allowed.calls[0].args.p_row_version,3);
 }
 const h=harness([permission('inventory','view','update')]);assert.equal((await h.write('update_product_category',{...payload,row_version:0})).status,400);assert.equal(h.calls.length,0);
});

test('NAS context uses the existing upload grants and only bounded selected-record queries',async()=>{
 const query=`scope=nas_upload_context&customer_id=${id(2)}&contract_service_type_id=${id(3)}&project_id=${id(4)}`;
 for(const [grants,scoped] of [[[permission('site','view')],false],[[permission('equipment','create')],false],[[permission('site','view'),permission('equipment','create')],true]]){
  const h=harness(grants,scoped);assert.equal((await h.read(query)).status,403);assert.equal(h.calls.length,0);
 }
 const h=harness([permission('site','view'),permission('equipment','create')]);
 h.context.get=async path=>{h.calls.push(path);return path.startsWith('customers?')?[{id:id(2),name:'Customer'}]:path.startsWith('contract_service_types?')?[{id:id(3),name:'Service',is_active:true}]:path.startsWith('customer_contract_services?')?[{customer_id:id(2),service_type_id:id(3),is_active:true}]:[{id:id(4),name:'Project',customer_id:id(2)}];};
 const result=await h.read(query);assert.equal(result.status,200);const data=await result.json();assert.equal(data.customers.length,1);assert.equal(data.projects.length,1);assert.equal(h.calls.length,4);
 assert.ok(h.calls.every(path=>path.includes('limit=1')&&path.includes('=eq.')));
 assert.ok(h.calls.find(path=>path.startsWith('projects?')).includes('customer_id=eq.'+id(2)));
 assert.ok(h.calls.find(path=>path.startsWith('customer_contract_services?')).includes('is_active=eq.true'));
 h.calls.length=0;assert.equal((await h.read(query.replace(id(2),'invalid'))).status,400);assert.equal(h.calls.length,0);
 h.context.get=async()=>[];assert.equal((await h.read(query)).status,404,'Deleted/revoked business relationships fail closed');
});
test('loaded worker permissions reject every unrelated scope and direct entity URL',async()=>{
 const h=harness([permission('worklogs','view','create','update','delete')],true);
 for(const query of ['scope=crm','scope=settings','scope=transactions','scope=dashboard','scope=site_navigation','entity=projects&customer_id='+id(3)])assert.equal((await h.read(query)).status,403,query);
 assert.equal(h.calls.length,0);
 h.context.rpc=async(name,args)=>{assert.equal(name,'work_log_scope_v1');assert.equal(args.p_user_id,id(1));return{projects:[{id:id(2)}],site_work_logs:[]};};
 const response=await h.read('scope=worklogs');assert.equal(response.status,200);assert.equal((await response.json()).projects[0].id,id(2));
});
test('readonly accounting can load purchases and no other transactions, cannot write',async()=>{
 const h=harness([permission('purchases','view')]);
 const response=await h.read('scope=transactions');assert.equal(response.status,200);const body=await response.json();assert.deepEqual(body.pickups,[]);assert.deepEqual(body.projects,[]);
 for(const operation of ['create_stock_receipt_batch','update_stock_receipt','delete_stock_receipts'])assert.equal((await h.write(operation,{id:id(2),row_version:1})).status,403);
 assert.ok(!h.calls.some(c=>typeof c==='object'));
});
test('history create/update permissions inspect the nested event ID independently',async()=>{
 for(const action of ['create','update']){
  const h=harness([permission('site','view'),permission('history','view',action)]);
  for(const existing of [false,true]){
   const result=await h.write('save_equipment_history',{equipment_id:id(2),request_id:id(3),event:{...(existing?{id:id(4),row_version:1}:{}),event_type:'REPAIR',occurred_at:'2026-09-08',description:'repair',result:'done',worker_user_ids:[id(1)]}});
   assert.equal(result.status,existing===(action==='update')?201:403);
  }
 }
});
test('customer service action cannot bypass delete permission using an absent ID',async()=>{
 const h=harness([permission('customers','view','create')]);
 const payload={customer_id:id(2),service_id:id(3),row_version:1,is_active:true};
 assert.equal((await h.write('manage_customer_service',{...payload,action:'delete'})).status,403);
 assert.equal((await h.write('manage_customer_service',{...payload,action:'update'})).status,403);
 assert.equal((await h.write('manage_customer_service',{...payload,action:'create'})).status,201);
});
test('project-scoped project lookup intersects database grants with customer filter',async()=>{
 const h=harness([permission('projects','view')],true);
 h.context.get=async path=>{h.calls.push(path);return path.startsWith('project_workers?')?[{project_id:id(2)}]:[];};
 assert.equal((await h.read('entity=projects&customer_id='+id(9))).status,200);
  const query=h.calls.find(c=>c.startsWith('projects?'));assert.ok(query.includes('id=in.('+id(2)+')'));assert.ok(query.includes('customer_id=eq.'+id(9)));
  assert.equal((await h.read('entity=projects&id='+id(99))).status,403);
});

test('delegated user creation cannot elevate an account to admin',async()=>{
 const h=harness([permission('users','view','create')]);
 const response=await h.write('create_account',{username:'new_admin',display_name:'Test',role:'admin',password:'fixture-password-only'});
 assert.equal(response.status,403);assert.equal(h.calls.length,0);
});
test('site VIEW is required in addition to a module write grant',async()=>{
 const h=harness([permission('phone','view','create')]);
 assert.equal((await h.write('create_phone_terminal_version',{customer_id:id(2),service_id:id(3),name:'V1',effective_date:'2026-09-08'})).status,403);assert.equal(h.calls.length,0);
});
