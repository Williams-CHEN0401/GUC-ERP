import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=process.env.GATEWAY_IMPORT_TEST_SOURCE||new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url);
const compiled=stripTypeScriptTypes(readFileSync(source,'utf8').replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const row=(i=0)=>({source_row:i+2,device_name:`Camera ${i}`,ip_address:`192.0.2.${i+1}`,device_type:'camera',device_brand:'Test',device_model:'Cam',cabinet:'',details:'',network_cable_no:'',manual_url:'',http_port:80,login_username:'test-admin',login_password:'synthetic-password'});
const payload=(rows=[row()])=>({customer_id:id(2),file_name:'cameras.xlsx',sheet_name:'Sheet1',file_hash:'a'.repeat(64),rows});
function harness({role='admin',linked=true}={}){
 let handler;const calls=[],reads=[];
 const context=vm.createContext({AsyncLocalStorage,performance,Deno:{env:{get:name=>name==='GUC_DEVICE_CREDENTIAL_KEY_V1'?Buffer.alloc(32,7).toString('base64'):''},serve:fn=>handler=fn},URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,console,crypto,TextEncoder,btoa,atob});
 vm.runInContext(compiled,context);context.currentUser=async()=>role?{id:id(1),username:'tester',role,is_active:true}:null;
 context.get=async path=>{reads.push(path);if(path.startsWith('contract_service_types?'))return[{id:id(3)}];if(path.startsWith('customer_contract_services?'))return linked?[{customer_id:id(2)}]:[];return[];};
 context.rpc=async(name,args)=>{calls.push({name,args});return{updated:args.p_rows?.length||1};};
 const send=(p,preview=false,operation='batch_update_monitoring_devices')=>handler(new Request('https://example.test/inventory-gateway'+(preview?'-preview-test':''),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,payload:p})}));
  return{send,calls,reads};
}
test('batch edits send only selected fields and verified identity to one RPC',async()=>{
 const h=harness({role:'operator'}),p={customer_id:id(2),rows:[{id:id(4),row_version:2},{id:id(5),row_version:3}],patch:{cabinet:'',network_cable_no:'',http_port:'8080'},actor_user_id:id(99)};
 const r=await h.send(p);assert.equal(r.status,201,JSON.stringify(await r.clone().json()));assert.equal(h.calls.length,1);const call=h.calls[0];assert.equal(call.name,'batch_update_monitoring_devices_v1');assert.equal(call.args.p_actor_user_id,id(1));assert.deepEqual(JSON.parse(JSON.stringify(call.args.p_patch)),{cabinet:null,network_cable_no:null,http_port:8080});
});
test('single device save uses customer scope and accepts blank optional fields without resolution/FPS',async()=>{
 const h=harness({role:'operator'}),r=await h.send({...row(),customer_id:id(2),id:id(4),row_version:1,login_username:undefined,login_password:undefined,supports_audio:'false',resolution_width:999,fps:240},false,'upsert_monitoring_device');assert.equal(r.status,201,JSON.stringify(await r.clone().json()));
 const call=h.calls[0];assert.equal(call.name,'save_monitoring_device_v4');assert.equal(call.args.p_customer_id,id(2));assert.equal(call.args.p_values.cabinet,null);assert.equal(call.args.p_values.network_cable_no,null);assert.equal(call.args.p_values.supports_audio,false);assert.equal(call.args.p_values.http_port,80);assert.ok(!('fps'in call.args.p_values));assert.ok(!('resolution_width'in call.args.p_values));
});
test('invalid batch patches and selections are rejected before writes',async()=>{
 const valid={customer_id:id(2),rows:[{id:id(4),row_version:1}],patch:{cabinet:'A'}};
 for(const p of [{...valid,rows:[]},{...valid,rows:[null]},{...valid,rows:Array(201).fill(valid.rows[0])},{...valid,rows:[valid.rows[0],valid.rows[0]]},{...valid,rows:[{id:id(4),row_version:0}]},... [{},{fps:30},{resolution_width:1920},{ip_address:'192.0.2.1'},{login_password:'test'},{device_brand:''},{http_port:0},{supports_audio:'unknown'},{cabinet:'a'.repeat(161)}].map(patch=>({...valid,patch}))]){const h=harness();const r=await h.send(p);assert.ok(r.status>=400);assert.equal(h.calls.length,0);}
});
test('viewer, unauthenticated and preview bulk writes remain forbidden',async()=>{
 for(const [role,preview]of[['viewer',false],[null,false],['admin',true]]){const h=harness({role}),r=await h.send({customer_id:id(2),rows:[{id:id(4),row_version:1}],patch:{cabinet:'x'}},preview);assert.ok(r.status>=400);assert.equal(h.calls.length,0);}
});
