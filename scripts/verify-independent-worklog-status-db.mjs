import assert from 'node:assert/strict';
import {maintenanceDepartmentDatabase,applyIndependentStatus,seedMeetingRooms} from './maintenance-department-fixture.mjs';
import {sample,saveLog,ids} from './worklog-save-fixture.mjs';
const db=await maintenanceDepartmentDatabase();
const project=async id=>(await db.query('select * from projects where id=$1',[id])).rows[0];
const log=async id=>(await db.query('select * from site_work_logs where id=$1',[id])).rows[0];
async function close(p,l,actor=ids.actor,version=p.row_version){
 await db.exec('set role service_role');
 try{return(await db.query('select close_work_content_from_log_v1($1,$2,$3,$4,$5) result',[p.id,version,l,actor,'fixture-admin'])).rows[0].result;}
 finally{await db.exec('reset role');}
}
try{
 await applyIndependentStatus(db);
 const seed=await seedMeetingRooms(db),p=seed.project;
 const payload={...sample(),project_id:p.id,project_name:p.name,department_id:ids.department,work_type:'維護保養',maintenance_events:[],status:'completed'};
 const a=await saveLog(db,payload);
 assert.equal(a.work_log.status,'completed');assert.equal((await project(p.id)).status,'in_progress');
 assert.equal((await log(seed.work_log.id)).status,'in_progress');
 const before=(await db.query('select * from site_work_logs order by id')).rows;
 await assert.rejects(close(await project(p.id),a.work_log.id,ids.viewer),/權限/);
 await assert.rejects(close(await project(p.id),a.work_log.id,ids.scoped),/權限/);
 await assert.rejects(close(await project(p.id),a.work_log.id,ids.actor,0),/修改/);
 const result=await close(await project(p.id),a.work_log.id);
 assert.equal(result.project.status,'completed');assert.deepEqual((await db.query('select * from site_work_logs order by id')).rows,before);
 assert.equal((await close(await project(p.id),a.work_log.id)).project.status,'completed');
 const edited=await saveLog(db,{...payload,request_id:crypto.randomUUID(),id:a.work_log.id,row_version:(await log(a.work_log.id)).row_version,status:'in_progress'});
 assert.equal(edited.work_log.status,'in_progress');assert.equal((await project(p.id)).status,'completed');
 await db.query("update projects set status='in_progress' where id=$1",[p.id]);
 assert.equal((await log(seed.work_log.id)).status,'in_progress');
 const fresh=await saveLog(db,{...sample(),project_name:'日誌完成但工作未結案',work_type:'文書作業',status:'completed',maintenance_events:[]});
 assert.equal(fresh.work_log.status,'completed');assert.equal(fresh.project.status,'in_progress');
 const moving=await saveLog(db,{...payload,request_id:crypto.randomUUID(),id:edited.work_log.id,row_version:(await log(edited.work_log.id)).row_version,project_id:fresh.project.id,project_name:fresh.project.name,work_type:'文書作業',status:'in_progress'});
 assert.equal(moving.work_log.status,'in_progress');assert.equal(moving.project.id,fresh.project.id);
 const logsBefore=(await db.query('select * from site_work_logs order by id')).rows,fp=await project(fresh.project.id);
 await db.exec('set role service_role');
 try{await db.query("select upsert_erp_project_with_workers_v2($1,$2,$3,$4,$5,'completed',null,null,null,$6,$7)",[fp.id,fp.row_version,fp.name,fp.customer_id,fp.project_type,[ids.actor],'fixture-admin']);}
 finally{await db.exec('reset role');}
 assert.equal((await project(fp.id)).status,'completed');assert.deepEqual((await db.query('select * from site_work_logs order by id')).rows,logsBefore);
 await assert.rejects(close(await project(p.id),fresh.work_log.id),/工作|日誌/);
 const repair=await saveLog(db,{...sample(),project_name:'独立維修',work_type:'維修紀錄',status:'completed'});
 assert.equal(repair.project.status,'in_progress');assert.equal(repair.work_log.status,'completed');
 const acl=(await db.query("select prosecdef,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service from pg_proc where proname='close_work_content_from_log_v1'")).rows[0];
 assert.deepEqual(acl,{prosecdef:false,anon:false,authenticated:false,service:true});
 console.log('PASS: independent project/log status; explicit close only; no sibling mutation; completed log/new project; repair; unchanged closed project on log edit; permission/version/ownership guards; service-only ACL');
}finally{await db.close();}
