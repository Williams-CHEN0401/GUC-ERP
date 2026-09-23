import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {formSyncDatabase,equipmentTypeMigration} from './form-sync-fixture.mjs';
import {sample,saveLog,sql,ids} from './worklog-save-fixture.mjs';
const db=await formSyncDatabase({fixed:false});
try {
 const equipment=randomUUID();
 await db.query("insert into equipment_registry(id,customer_id,service_id) values($1,$2,$3)",[equipment,ids.customer,ids.service]);
 const base=sample();base.project_name='設備測試隔離工作';
 base.maintenance_events[0].event_type='EQUIPMENT_TEST';base.maintenance_events[0].equipment_ids=[equipment];
 const metadata=()=>db.query("select proacl::text,prosecdef,proconfig,pg_get_function_identity_arguments(oid) args from pg_proc where pronamespace='public'::regnamespace and proname='upsert_customer_project_work_log_with_maintenance_v1'");
 const before=(await metadata()).rows;
 await assert.rejects(saveLog(db,base),/類型|constraint/i);
 assert.equal((await db.query('select count(*)::int n from maintenance_events')).rows[0].n,0);
 await db.exec(await sql(equipmentTypeMigration));await db.exec(await sql(equipmentTypeMigration));
 assert.deepEqual((await metadata()).rows,before,'signature, ACL and search_path unchanged');
 const created=await saveLog(db,base);
 assert.equal(created.work_log.work_type,'維修紀錄');assert.equal(created.project.project_type,'repair');
 let event=(await db.query('select * from maintenance_events where work_log_id=$1',[created.work_log.id])).rows[0];
 assert.equal(event.event_type,'EQUIPMENT_TEST');assert.equal(event.inventory_item_id,null);
 assert.equal(event.handling_process,base.maintenance_events[0].handling_process);
 assert.equal((await db.query('select equipment_id from maintenance_event_equipment where event_id=$1',[event.id])).rows[0].equipment_id,equipment);
 assert.equal((await db.query('select count(*)::int n from repair_items')).rows[0].n,0,'testing does not create repair stock');
 const edit={...base,request_id:randomUUID(),id:created.work_log.id,row_version:created.work_log.row_version,project_id:created.project.id,maintenance_events:[{...base.maintenance_events[0],id:event.id,row_version:event.row_version,handling_process:'完成線路與影像測試',inventory_category_id:null,inventory_item_id:null}]};
 await saveLog(db,edit);
 event=(await db.query('select * from maintenance_events where id=$1',[event.id])).rows[0];
 assert.equal(event.handling_process,'完成線路與影像測試');
 await assert.rejects(saveLog(db,{...edit,request_id:randomUUID()}),/更新|修改|版本/);
 for(const event_type of ['SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','REPAIR','REPLACEMENT']){
  const payload=sample();payload.project_name='舊事件 '+event_type;payload.maintenance_events[0].event_type=event_type;
  const result=await saveLog(db,payload);
  assert.equal((await db.query('select event_type from maintenance_events where work_log_id=$1',[result.work_log.id])).rows[0].event_type,event_type);
 }
 assert.equal((await db.query('select count(*)::int n from repair_items')).rows[0].n,2,'original repair/replacement rules retained');
 for(const work_type of ['工程施工','維修紀錄','維護保養','送貨','文書作業','場勘'])assert.equal((await saveLog(db,{...base,request_id:randomUUID(),project_name:'舊類型 '+work_type,work_type,maintenance_events:[]})).work_log.work_type,work_type);
 await assert.rejects(saveLog(db,{...base,request_id:randomUUID(),work_type:'設備測試'}),/類型|constraint/i);
 await assert.rejects(saveLog(db,{...base,request_id:randomUUID(),maintenance_events:[{...base.maintenance_events[0],event_type:'OTHER'}]}),/事件類型/);
 await assert.rejects(saveLog(db,{...base,request_id:randomUUID()},ids.viewer),/權限/);
 assert.equal((await db.query('select * from erp_work_content_types_v1()')).rows.length,6);
 console.log('PASS: baseline rejection, event create/edit/equipment link/readback, no repair stock side effect; 6 work types, 5 prior events, ACL, replay-safe migration, denied role/invalid/legacy/stale writes.');
}finally{await db.close();}
