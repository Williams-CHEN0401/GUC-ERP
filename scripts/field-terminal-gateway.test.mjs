import {AsyncLocalStorage} from 'node:async_hooks';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';

const source=readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8');
const compiled=stripTypeScriptTypes(source.replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function harness(role='operator') {
  let handler;const calls=[];
  const context=vm.createContext({AsyncLocalStorage,performance,Deno:{env:{get:()=>''},serve:fn=>handler=fn},URL,Request,Response,Headers,AbortController,setTimeout,clearTimeout,console,crypto});
  vm.runInContext(compiled,context);
  context.currentUser=async()=>role?{id:id(1),role,username:'test',is_active:true}:null;
  context.ensurePhoneContract=async()=>{};
  context.rpc=async(name,args)=>{calls.push({name,args});return {total:args.p_rows.length,inserted:args.p_rows.length,failed:0,flagged:1,empty_slots:1};};
  return {calls,request:async(payload,path='inventory-gateway')=>{
    const response=await handler(new Request(`https://test.local/functions/v1/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'import_phone_terminal_rows',payload})}));
    return {status:response.status,body:await response.json()};
  }};
}
const row=slot=>({preview_status:'new',preview_message:'保留槽位',frame_name:'A棟 2樓 現場端',board:'1-1',slot:String(slot),terminal_position:'',terminal_type:'',extension_number:'9999',building:'A棟',floor:'2樓',installation_location:'',phone_type:'unknown',source_sheet:'Sheet1',source_row:3,source_column:slot+1,raw:{}});
const payload=()=>({customer_id:id(2),contract_service_type_id:id(3),file_name:'A棟2樓_現場端端子資料.xlsx',import_type:'field',rows:[row(1),{...row(2),extension_number:''},row(3)]});
test('field API sends blank and duplicate numbers to the canonical database matcher',async()=>{
  const h=harness(),response=await h.request(payload());assert.equal(response.status,201);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'import_phone_field_rows_v1');
  assert.equal(h.calls[0].args.p_rows.length,3);assert.equal(h.calls[0].args.p_rows[1].extension_number,null);
  assert.equal(response.body.result.flagged,1);assert.equal(response.body.result.empty_slots,1);
});
test('field API keeps existing viewer, unauthenticated and preview restrictions',async()=>{
  for(const [role,path,status] of [['viewer','inventory-gateway',403],[null,'inventory-gateway',401],['operator','inventory-gateway-preview',403]]) {
    const h=harness(role),response=await h.request(payload(),path);assert.equal(response.status,status);assert.equal(h.calls.length,0);
  }
});
test('system import retains duplicate-number rejection',async()=>{
  const h=harness(),p=payload();p.import_type='system';
  assert.equal((await h.request(p)).status,400);assert.equal(h.calls.length,0);
});
test('field API rejects malformed location data before calling the database',async()=>{
  const h=harness(),p=payload();p.rows[0].slot='0';
  assert.equal((await h.request(p)).status,400);assert.equal(h.calls.length,0);
});
