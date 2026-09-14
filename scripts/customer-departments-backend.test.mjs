import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8').replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
const id='10000000-0000-4000-8000-000000000001',department='10000000-0000-4000-8000-000000000002',other='10000000-0000-4000-8000-000000000003';
function harness(actions=['view','create','update','delete'],module='customers',scoped=false){
 let handler;const calls=[];
 const context=vm.createContext({AsyncLocalStorage,performance,URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,crypto,console,Deno:{env:{get:()=>''},serve:fn=>handler=fn}});
 vm.runInContext(source,context);
 context.currentUser=async()=>({id,username:'fixture',role:'custom',is_active:true,project_scoped:scoped,permissions:[{module,can_view:actions.includes('view'),can_create:actions.includes('create'),can_update:actions.includes('update'),can_delete:actions.includes('delete')}]});
 context.get=context.getAll=async path=>{calls.push(path);return path.startsWith('customers?')?[{id}]:[];};
 context.rpc=async(name,args)=>{calls.push({name,args});return name==='work_log_scope_v1'?{customers:[{id}],projects:[{id,customer_id:id,department_id:department}]}:{};};
 return {calls,context,read:scope=>handler(new Request('https://example.test/inventory-gateway?scope='+scope)),write:(operation,payload)=>handler(new Request('https://example.test/inventory-gateway',{method:'POST',body:JSON.stringify({operation,payload})}))};
}
for(const [op,action] of [['create','create'],['update','update'],['deactivate','delete']]){
 test('department '+op+' follows individual customers RBAC and version contract',async()=>{
  const payload={customer_id:id,name:'資訊室',...(op==='create'?{}:{id:department,row_version:3}),is_active:true};
  for(const h of [harness(['view']),harness(['view',action],'inventory')]){assert.equal((await h.write(op+'_customer_department',payload)).status,403);assert.equal(h.calls.length,0);}
  const h=harness(['view',action]);assert.equal((await h.write(op+'_customer_department',payload)).status,201);
  assert.equal(h.calls[0].name,'manage_customer_department_v1');assert.equal(h.calls[0].args.p_action,op);assert.equal(h.calls[0].args.p_customer_id,id);
  assert.equal(h.calls[0].args.p_row_version,op==='create'?null:3);assert.equal(h.calls[0].args.p_is_active,op!=='deactivate');
 });
}
test('department input/anonymous errors never reach a write and names cannot shift customers',async()=>{
 for(const payload of [{customer_id:'bad',name:'科室'},{customer_id:id,name:'x'.repeat(121)},{customer_id:id,name:' '},{customer_id:id,name:'科室',is_active:'yes'},{customer_id:id,name:'科室',row_version:4}]){
  const h=harness();assert.equal((await h.write('create_customer_department',payload)).status,400);assert.equal(h.calls.length,0);
 }
 const h=harness();h.context.currentUser=async()=>null;assert.equal((await h.write('create_customer_department',{customer_id:id,name:'科室'})).status,401);
});
test('project and repair writes use one atomic department RPC while omitted field retains legacy RPC',async()=>{
 const project={customer_id:id,name:'工程',project_type:'construction',status:'in_progress',project_date:'2026-09-14',estimated_cost:0,worker_user_ids:[],construction_category:'tender'};
 const repair={customer_id:id,received_on:'2026-09-14',inventory_item_id:other,quantity:1,issue_description:'故障',status:'received'};
 for(const [module,operation,payload,newRPC,legacyRPC] of [['projects','create_erp_project',project,'upsert_erp_project_department_v1','upsert_erp_project_with_workers_v4'],['repairs','upsert_repair_item',repair,'upsert_repair_item_department_v1','upsert_repair_item_v1']]){
  for(const dept of [undefined,null,department]){
   const h=harness(undefined,module);assert.equal((await h.write(operation,{...payload,...(dept===undefined?{}:{department_id:dept})})).status,201);
   assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,dept===undefined?legacyRPC:newRPC);
   if(dept!==undefined)assert.equal(h.calls[0].args.p_department_id,dept);
  }
  const h=harness(undefined,module);assert.equal((await h.write(operation,{...payload,department_id:'bad'})).status,400);assert.equal(h.calls.length,0);
 }
});
test('department work log preserves request id and handling_process in one database transaction',async()=>{
 const h=harness(undefined,'worklogs');
 const payload={customer_id:id,department_id:department,project_name:'工程',log_date:'2026-09-14',work_type:'維修紀錄',summary:'摘要',time_period:'上午',status:'in_progress',worker_user_ids:[],request_id:other,maintenance_events:[{service_id:id,event_type:'REPAIR',occurred_at:'2026-09-14',description:'摘要',handling_process:'壓接測試',result:'成功',equipment_ids:[],worker_user_ids:[]}]};
 assert.equal((await h.write('upsert_customer_project_work_log',payload)).status,201);assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].name,'upsert_customer_project_work_log_department_v1');assert.equal(h.calls[0].args.p_department_id,department);assert.equal(h.calls[0].args.p_request_id,other);
 assert.equal(h.calls[0].args.p_maintenance_events[0].handling_process,'壓接測試');
 const denied=harness(['view'],'worklogs');assert.equal((await denied.write('upsert_customer_project_work_log',payload)).status,403);assert.equal(denied.calls.length,0);
});
test('department project update distinguishes omitted construction classification from explicit null',async()=>{
 const payload={id:other,row_version:5,customer_id:id,department_id:department,name:'工程',project_type:'construction',status:'in_progress',project_date:'2026-09-14',estimated_cost:0,worker_user_ids:[]};
 for(const [extra,provided] of [[{},false],[{construction_category:null},true],[{construction_category:'tender'},true]]){
  const h=harness(undefined,'projects');assert.equal((await h.write('update_erp_project',{...payload,...extra})).status,201);
  assert.equal(h.calls[0].name,'upsert_erp_project_department_v1');assert.equal(h.calls[0].args.p_construction_category_provided,provided);
  assert.equal(h.calls[0].args.p_construction_category,extra.construction_category??null);assert.equal(h.calls[0].args.p_row_version,5);
 }
});
test('new department wrappers consistently lock customer before business row and retain versioned legacy calls',()=>{
 const migration=readFileSync(new URL('../supabase/migrations/20260914120540_customer_department_selection.sql',import.meta.url),'utf8');
 for(const [name,table] of [['upsert_erp_project_department_v1','projects'],['upsert_repair_item_department_v1','repair_items'],['upsert_customer_project_work_log_department_v1','projects']]){
  const body=migration.split('create function public.'+name+'(')[1].split('end $$;')[0];
  const customerLock=body.indexOf('from public.customers where id=p_customer_id for update');
  const businessLock=body.search(new RegExp('from public\\.'+table+' where id=(?:p_id|v_project_id) for update'));
  assert.ok(customerLock>=0&&businessLock>customerLock,name+' must lock customer before business row');
  assert.match(body,/p_id,p_row_version/,'legacy RPC still receives expected version');
 }
});
test('multi-customer receipts require exact mapping and preserve both customers atomically',async()=>{
 const payload={rows:[{receipt_date:'2026-09-14',inventory_item_id:id,quantity:1,supplier_id:id}],customer_ids:[id,other],customer_departments:[{customer_id:id,department_id:department},{customer_id:other,department_id:null}]};
 const h=harness(undefined,'purchases');assert.equal((await h.write('create_stock_receipt_batch',payload)).status,201);assert.equal(h.calls[0].name,'create_stock_receipts_department_v1');assert.equal(h.calls[0].args.p_customer_departments.length,2);
 for(const mappings of [[payload.customer_departments[0]],[payload.customer_departments[0],payload.customer_departments[0]],[{customer_id:id,department_id:'bad'},payload.customer_departments[1]],[{customer_id:id},payload.customer_departments[1]]]){
  const bad=harness(undefined,'purchases');assert.equal((await bad.write('create_stock_receipt_batch',{...payload,customer_departments:mappings})).status,400);assert.equal(bad.calls.length,0);
 }
 const update=harness(undefined,'purchases');assert.equal((await update.write('update_stock_receipt',{...payload.rows[0],...payload,id,row_version:1})).status,201);assert.equal(update.calls[0].name,'update_stock_receipt_department_v1');
});
test('department snapshots are restricted to visible customers and no-department grants remain read-only',async()=>{
 const scoped=harness(['view'],'worklogs',true);assert.equal((await scoped.read('worklogs')).status,200);
 const reads=scoped.calls.filter(x=>typeof x==='string'&&x.startsWith('customer_departments?'));
 assert.equal(reads.length,1);assert.ok(reads[0].includes('&customer_id=in.('+id+')'));assert.ok(!reads[0].includes(other));
 const purchases=harness(['view'],'purchases');assert.equal((await purchases.read('transactions')).status,200);assert.ok(purchases.calls.some(x=>typeof x==='string'&&x.startsWith('customer_departments?')&&x.includes('&customer_id=in.('+id+')')));
 const supplier=harness(['view'],'suppliers');assert.equal((await supplier.read('crm')).status,200);assert.ok(!supplier.calls.some(x=>typeof x==='string'&&x.startsWith('customer_departments?')));
 const denied=harness([]);assert.equal((await denied.read('crm')).status,403);
});
