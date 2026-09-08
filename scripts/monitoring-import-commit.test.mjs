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
 context.rpc=async(name,args)=>{calls.push({name,args});return{inserted:args.p_rows.length,total:args.p_rows.length};};
 const send=(p,preview=false)=>handler(new Request('https://example.test/inventory-gateway'+(preview?'-preview-test':''),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'import_monitoring_devices',payload:p})}));
 return{send,calls,reads};
}
test('117 preview-ready customer rows commit through v3 with real credential encryption and ports',async()=>{
 const h=harness(),res=await h.send(payload(Array.from({length:117},(_,i)=>row(i))));assert.equal(res.status,201,JSON.stringify(await res.clone().json()));assert.equal((await res.json()).result.inserted,117);
 assert.equal(h.calls.length,1);const {name,args}=h.calls[0];assert.equal(name,'import_monitoring_devices_v3');assert.equal(args.p_customer_id,id(2));assert.equal(args.p_actor,'tester');assert.ok(!('p_site_id'in args));
 assert.ok(h.reads.some(p=>p.startsWith('customer_contract_services?is_active=eq.true&customer_id=eq.'+id(2))));
 for(const r of args.p_rows){assert.equal(r.http_port,80);assert.equal(r.cabinet,null);assert.equal(r.details,null);assert.equal(r.status,'active');assert.ok(r.credential.password_ciphertext);assert.ok(!('login_password'in r));assert.ok(!('login_username'in r));assert.ok(!JSON.stringify(r).includes('synthetic-password'));}
});
test('all device types accept optional IP/details and omitted or username-only credentials; obsolete columns are ignored',async()=>{
 const h=harness();const rows=['camera','monitoring_host','hub'].map((device_type,i)=>({...row(i),device_type,ip_address:'',login_password:'',login_username:i?'':'name-only',http_port:i===1?'8080':null,supports_audio:'invalid',resolution_width:'=BAD()',fps:999,status:'inactive',site_id:id(99),customer_id:id(99)}));
 const res=await h.send(payload(rows));assert.equal(res.status,201,JSON.stringify(await res.clone().json()));
 for(const r of h.calls[0].args.p_rows){assert.equal(r.ip_address,'');assert.ok(!('credential'in r));for(const k of ['supports_audio','resolution_width','fps','site_id','customer_id'])assert.ok(!(k in r));assert.equal(r.status,'active');}assert.equal(h.calls[0].args.p_rows[1].http_port,8080);
});
test('bad metadata and invalid rows never call an import RPC',async()=>{
 const cases=[{...payload(),customer_id:undefined,site_id:id(2)},{...payload(),file_hash:'bad'},payload([]),payload(Array(1001).fill(row())),... [{http_port:0},{http_port:65536},{http_port:1.5},{device_brand:''},{source_row:1},{ip_address:'not-ip'},{login_username:'',login_password:'password'},{login_username:'a'.repeat(257),login_password:''}].map(p=>payload([{...row(),...p}]))];
 for(const p of cases){const h=harness();const res=await h.send(p);assert.ok(res.status>=400);assert.equal(h.calls.length,0);}
});
test('inactive customer relation, operators, viewers, unauthenticated requests and Preview cannot import',async()=>{
 for(const options of [{linked:false},{role:'operator'},{role:'viewer'},{role:null},{preview:true}]){const h=harness(options),res=await h.send(payload(),options.preview);assert.ok(res.status>=400);assert.equal(h.calls.length,0);}
});
