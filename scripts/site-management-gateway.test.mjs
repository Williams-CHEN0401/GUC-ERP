import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {randomUUID} from 'node:crypto';

const code=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8'),{mode:'strip'});
const customer=randomUUID(),service=randomUUID(),site=randomUUID(),phone=randomUUID();
function harness(role='operator'){
  let handler;const calls=[],reads=[];
  const context=vm.createContext({URL,Request,Response,Headers,AbortController,setTimeout,clearTimeout,console,crypto,Deno:{env:{get:()=>''},serve:fn=>{handler=fn;}}});
  vm.runInContext(code,context);
  context.currentUser=async()=>role?{id:randomUUID(),username:'fixture',display_name:'測試員',role,is_active:true}:null;
  context.get=async path=>{
    reads.push(path);
    if(path.startsWith('contract_service_types?'))return[{id:service}];
    if(path.startsWith('customer_contract_services?'))return[{customer_id:customer}];
    if(path.startsWith('customers?'))return[{id:customer,customer_code:'C001',name:'測試客戶',customer_category:'school'}];
    if(path.startsWith('monitoring_device_types?'))return[{code:'camera',name:'監控攝影機'}];
    if(path.startsWith('sites?'))return[{id:site,customer_id:customer,contract_service_type_id:service,site_name:'測試案場'}];
    if(path.startsWith('site_devices?'))return[];
    if(path.startsWith('site_device_credentials?'))return[];
    throw new Error('Unexpected query: '+path);
  };
  context.getPage=async path=>{reads.push(path);return{records:[],total:0};};
  context.rpc=async(name,args)=>{calls.push({name,args});return{updated:args.p_rows?.length,ids:args.p_rows?.map(row=>row.id)};};
  const request=async({method='POST',operation='batch_update_phone_extensions',payload,query='',preview=false}={})=>{
    const response=await handler(new Request('https://example.test/functions/v1/inventory-gateway'+(preview?'-preview':'')+query,{method,headers:{'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify({operation,payload:payload||{customer_id:customer,contract_service_type_id:service,rows:[{id:phone,row_version:2}],patch:{floor:'2F'}}})}:{})}));
    return{status:response.status,body:await response.json()};
  };
  return{context,calls,reads,request};
}
test('monitoring options include eligible customers and retain the expected filter contract',async()=>{
  const h=harness(),r=await h.request({method:'GET',query:'?entity=monitoring_device_options'});
  assert.equal(r.status,200);assert.equal(r.body.customers[0].id,customer);
  assert.deepEqual(r.body.filters,{brands:[],models:[],cabinets:[],network_cables:[]});
  assert.ok(h.reads.some(path=>path.includes('service_type_id=eq.'+service)));
  assert.ok(h.reads.some(path=>path.includes('customers?id=in.('+customer+')')));
});
test('monitoring list applies both customer-site scope and legacy site filter',async()=>{
  const h=harness(),r=await h.request({method:'GET',query:'?entity=monitoring_devices&customer_id='+customer+'&site_id='+site});
  assert.equal(r.status,200);
  const query=h.reads.find(path=>path.startsWith('site_devices?'));
  assert.ok(query.includes('site_id=in.('+site+')'));assert.ok(query.includes('site_id=eq.'+site));
});
test('invalid customer or missing monitoring contract never falls back to all devices',async()=>{
  const h=harness();assert.equal((await h.request({method:'GET',query:'?entity=monitoring_devices&customer_id=invalid'})).status,400);
  const get=h.context.get;h.context.get=path=>path.startsWith('customer_contract_services?')?Promise.resolve([]):get(path);
  assert.equal((await h.request({method:'GET',query:'?entity=monitoring_devices&customer_id='+customer})).status,400);
  assert.equal(h.reads.some(path=>path.startsWith('site_devices?')),false);
});
test('monitoring customer with no site gets an empty page without a global query',async()=>{
  const h=harness(),get=h.context.get;h.context.get=path=>path.startsWith('sites?')?Promise.resolve([]):get(path);
  const r=await h.request({method:'GET',query:'?entity=monitoring_devices&customer_id='+customer});
  assert.equal(r.status,200);assert.deepEqual(r.body.records,[]);assert.equal(r.body.pagination.total,0);
  assert.equal(h.reads.some(path=>path.startsWith('site_devices?')),false);
});
test('batch update uses one existing atomic RPC and passes only selected IDs/versions/fields',async()=>{
  const h=harness(),r=await h.request();
  assert.equal(r.status,201);assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].name,'batch_update_phone_extensions_v1');
  assert.equal(JSON.stringify(h.calls[0].args.p_rows),JSON.stringify([{id:phone,row_version:2}]));
  assert.equal(JSON.stringify(h.calls[0].args.p_patch),JSON.stringify({floor:'2F'}));
});
test('batch roles and preview remain enforced; deletion stays admin-only',async()=>{
  for(const [role,operation,preview,expected] of [['viewer','batch_update_phone_extensions',false,403],[null,'batch_update_phone_extensions',false,401],['operator','batch_delete_phone_extensions',false,403],['admin','batch_update_phone_extensions',true,403],['admin','batch_delete_phone_extensions',false,201]]){
    const h=harness(role),r=await h.request({operation,preview});assert.equal(r.status,expected);assert.equal(h.calls.length,expected===201?1:0);
  }
});
test('batch rejects invalid rows, forbidden fields and malformed patch values without a write',async()=>{
  const base={customer_id:customer,contract_service_type_id:service,rows:[{id:phone,row_version:1}],patch:{floor:'2F'}};
  for(const payload of [{...base,rows:[]},{...base,rows:Array(101).fill(base.rows[0])},{...base,rows:[base.rows[0],base.rows[0]]},{...base,rows:[{id:phone,row_version:0}]},...[
    {},{customer_id:customer},{floor:3},{floor:{}},{floor:'a'.repeat(81)},{source_terminal_board:'A'},{source_terminal_group:''}
  ].map(patch=>({...base,patch}))]){
    const h=harness();assert.equal((await h.request({payload})).status,400);assert.equal(h.calls.length,0);
  }
});
test('explicit blank clears only that field, and stale-version RPC failure is not retried as separate writes',async()=>{
  const h=harness();await h.request({payload:{customer_id:customer,contract_service_type_id:service,rows:[{id:phone,row_version:1}],patch:{floor:''}}});
  assert.equal(JSON.stringify(h.calls[0].args.p_patch),'{"floor":null}');
  h.context.rpc=async()=>{throw vm.runInContext('new Error("電話已被其他使用者更新")',h.context);};
  const r=await h.request();assert.equal(r.status,409);assert.match(r.body.error,/其他使用者更新/);
});
