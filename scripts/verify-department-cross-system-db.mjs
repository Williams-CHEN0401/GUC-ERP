import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {departmentDatabase,departmentMigration,callAsService,repairArgs,projectArgs,extraIds} from './department-cross-system-fixture.mjs';
import {ids,sample,saveLog,sql} from './worklog-save-fixture.mjs';
const db=await departmentDatabase({fixed:false});
const row=async(q,args=[])=>(await db.query(q,args)).rows[0];
const counts=()=>row('select (select count(*) from projects)::int projects,(select count(*) from site_work_logs)::int logs,(select count(*) from repair_items)::int repairs,(select count(*) from audit_logs)::int audit');
const security=()=>db.query("select proname,prosecdef,proacl::text,proconfig from pg_proc where pronamespace='public'::regnamespace order by proname");
const repair=(options)=>callAsService(db,'upsert_repair_item_department_v1',repairArgs(options));
const project=(options)=>callAsService(db,'upsert_erp_project_department_v1',projectArgs(options));
try{
 const before=await counts(),permissions=await security();
 await assert.rejects(saveLog(db,sample()),/permission denied for table quotations/);
 await assert.rejects(project(),/permission denied for table quotations/);
 await assert.rejects(repair(),/permission denied for table repair_items/);
 assert.deepEqual(await counts(),before,'failed transactions leave no projects/logs/repairs/audits');
 console.log('PASS reproduced cross-system quotation trigger and repair ACL failures; rollback complete');
 await db.exec(await sql(departmentMigration));await db.exec(await sql(departmentMigration));
 assert.deepEqual(await security(),permissions,'no new function privilege/security-mode changes');
 for(const [label,type] of [['工程施工','construction'],['維修紀錄','repair'],['維護保養','maintenance'],['送貨','delivery'],['文書作業','clerical'],['場勘','site_survey']]){
  for(const department of [ids.department,extraIds.secondDepartment]){
   const input={...sample(),project_name:label+' '+department,work_type:label,department_id:department,maintenance_events:[]};
   const saved=await saveLog(db,input);
   assert.equal(saved.project.department_id,department);assert.equal(saved.project.project_type,type);
   assert.deepEqual(await saveLog(db,input),saved,'same request must replay');
   const edited=await saveLog(db,{...input,id:saved.work_log.id,project_id:saved.project.id,row_version:saved.work_log.row_version,request_id:randomUUID(),summary:'重新讀取後修改'});
   assert.equal(edited.project.department_id,department);assert.equal(edited.work_log.summary,'重新讀取後修改');
  }
 }
 const linked=await project({name:'已有報價關聯'});
 await db.query('insert into quotations(project_id,customer_id) values($1,$2)',[linked.project.id,ids.customer]);
 await assert.rejects(project({id:linked.project.id,version:linked.project.row_version,name:'已有報價關聯',department:extraIds.secondDepartment}),/已有報價/);
 assert.equal((await row('select department_id from projects where id=$1',[linked.project.id])).department_id,ids.department);
 const same=await project({id:linked.project.id,version:linked.project.row_version,name:'已有報價關聯'});assert.equal(same.project.department_id,ids.department);
 const linkedLog=await saveLog(db,{...sample(),project_id:linked.project.id,project_name:linked.project.name,maintenance_events:[]});assert.equal(linkedLog.project.department_id,ids.department);
 const unlinked=await project({name:'可變更科室'});
 const moved=await project({id:unlinked.project.id,version:unlinked.project.row_version,name:'可變更科室',department:extraIds.secondDepartment});assert.equal(moved.project.department_id,extraIds.secondDepartment);
 await assert.rejects(project({id:moved.project.id,version:moved.project.row_version,name:'可變更科室',department:extraIds.otherDepartment}),/不屬於/);
 const repairCreated=await repair();assert.equal(repairCreated.department_id,ids.department);
 const repairChanged=await repair({id:repairCreated.id,version:repairCreated.row_version,department:extraIds.secondDepartment});assert.equal(repairChanged.department_id,extraIds.secondDepartment);
 await assert.rejects(repair({id:repairCreated.id,version:repairCreated.row_version}),/更新/);
 await assert.rejects(repair({department:extraIds.otherDepartment}),/不屬於/);
 assert.equal((await row("select nullif(current_setting('app.repair_department_selection',true),'') value")).value,null,'context cleared after success and failure');
 const legacy=await callAsService(db,'upsert_repair_item_v1',repairArgs({customer:extraIds.emptyCustomer}).slice(0,-1));assert.equal(legacy.department_id,null,'legacy caller has no leaked selection');
 await db.exec('begin');await repair();
 assert.equal((await row("select nullif(current_setting('app.repair_department_selection',true),'') value")).value,null,'context cleared within the SAME transaction');
 const nextLegacy=await callAsService(db,'upsert_repair_item_v1',repairArgs({customer:extraIds.emptyCustomer}).slice(0,-1));assert.equal(nextLegacy.department_id,null);await db.exec('rollback');
 await db.query('update customer_departments set is_active=false where id=$1',[extraIds.secondDepartment]);
 const historical=await repair({id:repairChanged.id,version:repairChanged.row_version,department:extraIds.secondDepartment});assert.equal(historical.department_id,extraIds.secondDepartment);
 await assert.rejects(repair({department:extraIds.secondDepartment}),/已停用/);
 const maintenance=await saveLog(db,{...sample(),project_name:'維修品自動繼承'});
 assert.equal((await row('select department_id from repair_items where id=$1',[maintenance.created_repair_item_ids[0]])).department_id,ids.department);
 const nullDepartment=await saveLog(db,{...sample(),customer_id:extraIds.emptyCustomer,department_id:null,project_name:'尚無科室工作',maintenance_events:[]});assert.equal(nullDepartment.project.department_id,null);
 await db.query('insert into project_workers(project_id,user_id,can_view,can_create_work_log,can_update_work_log) values($1,$2,true,true,true)',[linked.project.id,ids.scoped]);
 const scopedLog=await saveLog(db,{...sample(),project_id:linked.project.id,project_name:linked.project.name,maintenance_events:[]},ids.scoped);assert.equal(scopedLog.project.id,linked.project.id,'assigned scoped worker may create on own work content');
 await assert.rejects(saveLog(db,{...sample(),project_id:unlinked.project.id,project_name:unlinked.project.name,maintenance_events:[]},ids.scoped),/權限/);
 const receiptRows=JSON.stringify([{receipt_date:'2026-09-15',inventory_item_id:ids.item,quantity:1,supplier_id:extraIds.supplier,note:'科室進貨'}]);
 const customers=[ids.customer,extraIds.emptyCustomer],departments=[{customer_id:ids.customer,department_id:ids.department},{customer_id:extraIds.emptyCustomer,department_id:null}];
 const receipt=await callAsService(db,'create_stock_receipts_department_v1',[receiptRows,customers,JSON.stringify(departments),ids.actor]);
 assert.equal((await row('select department_id from stock_receipt_customers where stock_receipt_id=$1 and customer_id=$2',[receipt.ids[0],ids.customer])).department_id,ids.department);
 const receiptVersion=(await row('select row_version from stock_receipts where id=$1',[receipt.ids[0]])).row_version;
 await callAsService(db,'update_stock_receipt_department_v1',[receipt.ids[0],receiptVersion,'2026-09-15',ids.item,2,extraIds.supplier,'修改科室進貨',customers,JSON.stringify(departments),ids.actor]);
 const bad=[{customer_id:ids.customer,department_id:extraIds.otherDepartment}];
 await assert.rejects(callAsService(db,'create_stock_receipts_department_v1',[receiptRows,[ids.customer],JSON.stringify(bad),ids.actor]),/不屬於/);
 for(const actor of [ids.viewer,ids.scoped,randomUUID()])await assert.rejects(saveLog(db,{...sample(),project_name:'拒絕 '+actor},actor),/權限/);
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);await assert.rejects(db.query('select * from quotations'),/permission denied/);await assert.rejects(db.query('select * from repair_items'),/permission denied/);await assert.rejects(db.query('select upsert_repair_item_department_v1('+repairArgs().map((_,i)=>'$'+(i+1)).join(',')+')',repairArgs()),/permission denied/);await db.exec('reset role');
 }
 assert.deepEqual(await row("select has_table_privilege('service_role','quotations','SELECT') quotations,has_table_privilege('service_role','repair_items','UPDATE') repairs,has_table_privilege('service_role','work_log_save_requests','SELECT') replay"),{quotations:false,repairs:false,replay:false});
 console.log('PASS six work types × two departments create/edit/reload/replay; linked quote guard; project and repair CRUD; receipt multi-customer; stale/inactive/cross-customer/RBAC rejection; no privilege expansion');
}catch(error){console.error(error.stack,error.where||'',error.detail||'');process.exitCode=1;}finally{await db.close();}
