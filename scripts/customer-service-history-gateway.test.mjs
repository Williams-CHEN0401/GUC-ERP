import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const compiled=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8').replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function harness(role='admin'){let handler;const calls=[];const user={id:id(1),username:'tester',display_name:'測試員',role,is_active:true};const context=vm.createContext({AsyncLocalStorage,performance,Deno:{env:{get:()=>''},serve:fn=>handler=fn},URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,console,crypto});vm.runInContext(compiled,context);context.currentUser=async()=>user;context.get=async path=>{calls.push(path);return[];};context.rpc=async(name,args)=>{calls.push({name,args});return{};};return{context,calls,handler,user};}
test('site navigation reads three master datasets without loading equipment or history',async()=>{
  const h=harness();const response=await h.handler(new Request('https://example.test/inventory-gateway?scope=site_navigation'));assert.equal(response.status,200);
  assert.equal(h.calls.length,3);assert.deepEqual(h.calls.map(p=>p.split('?')[0]).sort(),['contract_service_types','customer_contract_services','customers']);
});
test('selected customer phone request scopes every equipment read and never fetches monitoring/history',async()=>{
  const h=harness();h.context.get=async path=>{h.calls.push(path);if(path.startsWith('customer_contract_services'))return[{customer_id:id(2)}];if(path.startsWith('contract_service_types'))return[{code:'phone_system'}];return[];};
  const response=await h.handler(new Request(`https://example.test/inventory-gateway-preview-features?scope=site_customer&customer_id=${id(2)}&service_id=${id(3)}`));assert.equal(response.status,200);assert.equal((await response.json()).preview_readonly,true);
  for(const p of h.calls.filter(p=>p.startsWith('phone_'))){assert.ok(p.includes('customer_id=eq.'+id(2)));assert.ok(p.includes('contract_service_type_id=eq.'+id(3)));}
  assert.ok(h.calls.every(p=>!p.startsWith('site_devices')&&!p.startsWith('maintenance_events')));
});
test('customer CRUD is admin only and actor identity comes from verified session',async()=>{
  const body={operation:'manage_customer_service',payload:{customer_id:id(2),service_id:id(3),action:'create',is_active:true,notes:'test',actor_user_id:id(99)}};
  for(const role of ['admin','operator','viewer']){const h=harness(role);const response=await h.handler(new Request('https://example.test/inventory-gateway',{method:'POST',body:JSON.stringify(body)}));assert.equal(response.status,role==='admin'?201:403);if(role==='admin'){assert.equal(h.calls[0].name,'manage_customer_service_v1');assert.equal(h.calls[0].args.p_actor_user_id,id(1));}else assert.equal(h.calls.length,0);}
});
test('history writers keep authenticated identity; viewers and preview cannot mutate',async()=>{
  const body={operation:'save_equipment_history',payload:{equipment_id:id(2),request_id:id(3),event:{event_type:'REPAIR',occurred_at:'2026-09-07',description:'壓接',result:'正常',worker_user_ids:[id(1)]}}};
  for(const [role,preview] of [['admin',false],['operator',false],['viewer',false],['admin',true]]){const h=harness(role);const response=await h.handler(new Request('https://example.test/inventory-gateway'+(preview?'-preview-features':''),{method:'POST',body:JSON.stringify(body)}));assert.equal(response.status,role==='viewer'||preview?403:201);if(response.status===201)assert.equal(h.calls[0].args.p_actor_user_id,id(1));else assert.equal(h.calls.length,0);}
});
