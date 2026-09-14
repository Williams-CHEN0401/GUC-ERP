import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {worklogDatabase,ids,sample,saveLog,sql,migrationName} from './worklog-save-fixture.mjs';
const db=await worklogDatabase({fixed:false});
const one=async(q,p=[])=>(await db.query(q,p)).rows[0];
const counts=()=>one('select (select count(*) from projects)::int projects,(select count(*) from site_work_logs)::int logs,(select count(*) from maintenance_events)::int events,(select count(*) from repair_items)::int repairs');
const acl=()=>db.query("select proname,prosecdef,proacl::text,proconfig from pg_proc where proname in ('upsert_customer_project_work_log_department_v1','upsert_customer_project_work_log_with_maintenance_v1') order by proname");
try{
 const payload=sample(),before=await counts(),security=await acl();
 await assert.rejects(saveLog(db,payload),/permission denied for table work_log_save_requests/);
 await assert.rejects(saveLog(db,{...payload,request_id:null}),/permission denied for table repair_items/);
 assert.deepEqual(await counts(),before,'both failures roll back project/log/event/repair');
 console.log('PASS reproduced both production ACL failures with service_role; no orphan rows');
 await db.exec(await sql(migrationName));await db.exec(await sql(migrationName));
 assert.deepEqual(await acl(),security,'existing security modes and grants unchanged');
 const result=await saveLog(db,payload);
 assert.equal(result.project.department_id,ids.department);assert.equal(result.project.project_type,'repair');
 assert.equal(result.work_log.summary,payload.summary);assert.equal(result.maintenance_event_ids.length,1);assert.equal(result.created_repair_item_ids.length,1);
 assert.equal((await one('select department_id from repair_items where id=$1',[result.created_repair_item_ids[0]])).department_id,ids.department);
 assert.equal((await one('select handling_process from maintenance_events where id=$1',[result.maintenance_event_ids[0]])).handling_process,payload.maintenance_events[0].handling_process);
 assert.deepEqual(await saveLog(db,payload),result,'same request replays exactly');
 assert.deepEqual(await counts(),{projects:1,logs:1,events:1,repairs:1});
 await assert.rejects(saveLog(db,{...payload,summary:'different'}),/識別碼已使用/);
 for(const actor of [ids.viewer,ids.scoped,randomUUID()])await assert.rejects(saveLog(db,{...payload,request_id:randomUUID()},actor),/權限/);
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);
  await assert.rejects(db.query("select upsert_customer_project_work_log_department_v1(null,null,null,$1,'拒絕','2026-09-15','維修紀錄','','上午','in_progress','{}',$2,'[]','fixture',$3,null)",[ids.customer,ids.actor,ids.department]),/permission denied/);
  await db.exec('reset role');
 }
 const snapshot=await counts();
 await assert.rejects(saveLog(db,{...payload,request_id:randomUUID(),project_name:'必須回滾',maintenance_events:[{...payload.maintenance_events[0],service_id:randomUUID()}]}),/不屬於/);
 await assert.rejects(saveLog(db,{...payload,request_id:randomUUID(),department_id:randomUUID()}),/科室/);
 assert.deepEqual(await counts(),snapshot);
 const events=payload.maintenance_events.map(e=>({...e,id:result.maintenance_event_ids[0],row_version:1,handling_process:'修正後再次測試'}));
 const edit={...payload,id:result.work_log.id,row_version:1,project_id:result.project.id,request_id:randomUUID(),maintenance_events:events,status:'completed'};
 const edited=await saveLog(db,edit);assert.equal(edited.created_repair_item_ids.length,0);assert.equal(edited.work_log.status,'completed');
 await assert.rejects(saveLog(db,{...edit,request_id:randomUUID()}),/其他使用者|版本/);
 assert.equal((await counts()).repairs,1);
 for(const [label,type] of [['工程施工','construction'],['維護保養','maintenance'],['送貨','delivery'],['文書作業','clerical'],['場勘','site_survey']]){
  const saved=await saveLog(db,{...sample(),project_name:'測試 '+label,work_type:label,maintenance_events:[]});assert.equal(saved.project.project_type,type);
 }
 // Existing legacy client path still works; optional equipment and cause stay optional.
 const optional=await saveLog(db,{...sample(),request_id:null,project_name:'選填明細測試',maintenance_events:[{...sample().maintenance_events[0],event_type:'SOFTWARE_CONFIG',inventory_category_id:null,inventory_item_id:null,cause:'',handling_process:''}]});
 assert.equal(optional.created_repair_item_ids.length,0);
 const restrictions=await one("select has_table_privilege('service_role','work_log_save_requests','SELECT') cache_read,has_table_privilege('service_role','work_log_save_requests','INSERT') cache_write,has_table_privilege('service_role','repair_items','UPDATE') repair_write");
 assert.deepEqual(restrictions,{cache_read:false,cache_write:false,repair_write:false});
 console.log('PASS 國立高雄大學／應用數學系: create/read/edit, event + repair inheritance, duplicate replay, rollback, stale version, RBAC rejection, six work types; no privilege expansion');
}catch(e){console.error(e.message,e.where||'',e.detail||'');process.exitCode=1;}finally{await db.close();}
