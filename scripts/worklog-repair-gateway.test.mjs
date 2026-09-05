import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';

const source=readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8');
const compiled=stripTypeScriptTypes(source,{mode:'strip'});
const user={id:randomUUID(),username:'test',display_name:'測試員',role:'operator',is_active:true};
const category=randomUUID(),item=randomUUID(),customer=randomUUID(),service=randomUUID();
const event=()=>({service_id:service,event_type:'REPAIR',occurred_at:'2026-09-05',description:'工作內容',result:'處理結果',notes:'備註',equipment_ids:[],worker_user_ids:[],inventory_category_id:category,inventory_item_id:item});
const payload=()=>({request_id:randomUUID(),customer_id:customer,project_name:'測試專案',log_date:'2026-09-05',work_type:'維修紀錄',summary:'工作內容',time_period:'',status:'in_progress',worker_user_ids:[user.id],maintenance_events:[event()]});
function harness(role='operator'){
  let handler;const calls=[];
  const context=vm.createContext({Deno:{env:{get:()=>''},serve:callback=>{handler=callback;}},URL,Request,Response,Headers,AbortController,setTimeout,clearTimeout,console,crypto});
  vm.runInContext(compiled,context);
  context.currentUser=async()=>role?{...user,role}:null;
  context.rpc=async(name,parameters)=>{calls.push({name,parameters});return{work_log:{id:customer},maintenance_event_ids:[item],created_repair_item_ids:[category]};};
  const request=async(data=payload(),path='inventory-gateway')=>{
    const response=await handler(new Request('https://example.test/functions/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'upsert_customer_project_work_log',payload:data})}));
    return{status:response.status,body:await response.json()};
  };
  return{request,calls,context};
}
test('實際 Edge handler 將品項與空設備送入單一具重送保護的 RPC，保留回應結構',async()=>{
  const h=harness(),data=payload(),result=await h.request(data);
  assert.equal(result.status,201);assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].name,'upsert_customer_project_work_log_with_maintenance_v2');
  assert.equal(h.calls[0].parameters.p_request_id,data.request_id);
  assert.equal(h.calls[0].parameters.p_maintenance_events[0].inventory_item_id,item);
  assert.equal(h.calls[0].parameters.p_maintenance_events[0].equipment_ids.length,0);
  assert.deepEqual(result.body.result.created_repair_item_ids,[category]);
});
test('舊前端省略新欄位仍走相容 RPC，不將省略值變成清除指令',async()=>{
  const h=harness(),data=payload();delete data.request_id;delete data.maintenance_events[0].inventory_category_id;delete data.maintenance_events[0].inventory_item_id;
  assert.equal((await h.request(data)).status,201);
  assert.equal(h.calls[0].name,'upsert_customer_project_work_log_with_maintenance_v1');
  assert.equal(Object.hasOwn(h.calls[0].parameters.p_maintenance_events[0],'inventory_item_id'),false);
});
test('API 拒絕不合法品項、種類、識別碼與非陣列設備，不呼叫寫入 RPC',async()=>{
  for(const patch of [
    {inventory_item_id:'bad'}, {inventory_category_id:33}, {inventory_category_id:null},
    {equipment_ids:{}}, {worker_user_ids:'invalid'}
  ]){
    const h=harness(),data=payload();Object.assign(data.maintenance_events[0],patch);
    assert.equal((await h.request(data)).status,400);assert.equal(h.calls.length,0);
  }
  const h=harness();assert.equal((await h.request({...payload(),request_id:12})).status,400);assert.equal(h.calls.length,0);
});
test('新流程維持 viewer、未登入及 Preview 禁止寫入',async()=>{
  for(const [role,status,path] of [['viewer',403,'inventory-gateway'],[null,401,'inventory-gateway'],['operator',403,'inventory-gateway-preview']]){
    const h=harness(role);assert.equal((await h.request(payload(),path)).status,status);assert.equal(h.calls.length,0);
  }
});
test('資料庫同步錯誤回傳失敗，不另開非原子補寫',async()=>{
  const h=harness();h.context.rpc=async()=>{throw vm.runInContext('new Error("同步失敗")',h.context);};
  const result=await h.request();assert.equal(result.status,400);assert.equal(result.body.error,'同步失敗');
});
test('手動維修品流程仍要求收件日期、數量、狀態與故障內容',async()=>{
  const h=harness();
  await assert.rejects(h.context.change('upsert_repair_item',{customer_id:customer,inventory_item_id:item},user),/維修品|收件/);
  assert.equal(h.calls.length,0);
});

