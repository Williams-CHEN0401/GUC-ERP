import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {departmentDatabase} from './department-cross-system-fixture.mjs';
import {ids,sql,sample,saveLog} from './worklog-save-fixture.mjs';
const db=await departmentDatabase();
try{
 await db.exec('drop trigger project_sync on projects'); // Fixture name for the existing production trigger.
 await db.exec(await sql('20260915150407_shared_work_types_and_worklog_rename.sql'));
 const p={...sample(),work_type:'文書作業',maintenance_events:[]};
 const first=await saveLog(db,p), projectId=first.work_log.project_id;
 const second=await saveLog(db,{...p,request_id:randomUUID(),project_id:projectId});
 const old=(await db.query('select * from site_work_logs where id=$1',[first.work_log.id])).rows[0];
 const update={...p,id:old.id,row_version:old.row_version,project_id:projectId,project_name:'應數系更新後的共用工作內容',request_id:randomUUID()};
 const changed=await saveLog(db,update);
 assert.equal(changed.work_log.title,update.project_name);
 assert.equal(changed.project.name,update.project_name);
 assert.deepEqual((await db.query('select title from site_work_logs where project_id=$1',[projectId])).rows.map(x=>x.title),[update.project_name,update.project_name]);
 assert.equal((await db.query('select summary from site_work_logs where id=$1',[second.work_log.id])).rows[0].summary,p.summary);
 assert.deepEqual(await saveLog(db,update),changed,'request retry remains idempotent');
 await assert.rejects(saveLog(db,{...update,request_id:randomUUID(),project_name:'過期修改'}),/其他使用者更新/);
 const current=(await db.query('select * from site_work_logs where id=$1',[old.id])).rows[0];
 await assert.rejects(saveLog(db,{...update,row_version:current.row_version,request_id:randomUUID(),project_name:'不可部分儲存',maintenance_events:[{}]}),/維修事件/);
 assert.equal((await db.query('select name from projects where id=$1',[projectId])).rows[0].name,update.project_name,'failed maintenance rolls rename back');
 await db.query('insert into project_workers(project_id,user_id,can_view,can_create_work_log,can_update_work_log) values($1,$2,true,true,true)',[projectId,ids.scoped]);
 await assert.rejects(saveLog(db,{...update,row_version:current.row_version,request_id:randomUUID(),project_name:'越權修改'},ids.scoped),/沒有修改共用工作內容名稱/);
 await assert.rejects(saveLog(db,{...update,row_version:current.row_version,request_id:randomUUID()},ids.viewer),/權限/);
 const types=(await db.query('select * from erp_work_content_types_v1()')).rows;
 assert.equal(types.length,6);assert.deepEqual(types[0].construction_categories.map(x=>x.code),['small_purchase','tender']);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select erp_work_content_types_v1()'),/permission denied/);await db.exec('reset role');}
 console.log('PASS shared rename/reload, related logs, unchanged fields, retry, stale update, rollback, scoped/viewer denials, ERP catalogue ACL');
}finally{await db.close();}
