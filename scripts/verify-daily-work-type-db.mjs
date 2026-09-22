import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {dailyTypeDatabase,dailyTypeMigration} from './daily-work-type-fixture.mjs';
import {sample,saveLog,sql,ids} from './worklog-save-fixture.mjs';
import {callAsService,projectArgs} from './department-cross-system-fixture.mjs';
const db=await dailyTypeDatabase({fixed:false});
const rows=async()=> (await db.query('select id,project_id,title,work_type,status,row_version from site_work_logs order by log_date')).rows;
try {
 const first={...sample(),project_name:'跨日施工（隔離測試）',work_type:'工程施工',maintenance_events:[]};
 const initial=await saveLog(db,first),projectId=initial.work_log.project_id;
 const second={...first,request_id:randomUUID(),project_id:projectId,log_date:'2026-09-16',work_type:'場勘'};
 await saveLog(db,second);
 assert.deepEqual((await rows()).map(x=>x.work_type),['場勘','場勘'],'reproduce old overwrite');
 assert.equal((await db.query('select project_type from projects where id=$1',[projectId])).rows[0].project_type,'site_survey');
 await db.exec(await sql(dailyTypeMigration));
 await db.exec(await sql(dailyTypeMigration));
 // Restore only this synthetic baseline, then exercise saving from scratch.
 const fixedFirst={...first,request_id:randomUUID(),project_name:'每日類型獨立（隔離測試）'};
 const created=await saveLog(db,fixedFirst),pid=created.work_log.project_id;
 for(const [index,type] of ['場勘','送貨','文書作業','維修紀錄','維護保養'].entries()){
  await saveLog(db,{...fixedFirst,request_id:randomUUID(),project_id:pid,log_date:'2026-09-'+(16+index),work_type:type});
 }
 const values=()=>db.query('select * from site_work_logs where project_id=$1 order by log_date',[pid]);
 const expected=['工程施工','場勘','送貨','文書作業','維修紀錄','維護保養'];
 assert.deepEqual((await values()).rows.map(x=>x.work_type),expected);
 assert.equal((await db.query('select project_type from projects where id=$1',[pid])).rows[0].project_type,'construction');
 // Existing-name resolution (no explicit project ID) must also preserve the original type.
 const byName=await saveLog(db,{...fixedFirst,request_id:randomUUID(),work_type:'送貨',log_date:'2026-09-21'});
 assert.equal(byName.work_log.project_id,pid);
 assert.equal((await db.query('select project_type from projects where id=$1',[pid])).rows[0].project_type,'construction');
 // Editing a daily type affects only that log. Shared status and rename still work.
 const log=(await values()).rows[1];
 await saveLog(db,{...fixedFirst,id:log.id,row_version:log.row_version,project_id:pid,request_id:randomUUID(),log_date:'2026-09-16',work_type:'文書作業',status:'completed'});
 const after=(await values()).rows;
 assert.deepEqual(after.map(x=>x.work_type),['工程施工','文書作業',...expected.slice(2),'送貨']);
 assert.ok(after.every(x=>x.status==='completed'));
 const project=(await db.query('select * from projects where id=$1',[pid])).rows[0];
 await callAsService(db,'upsert_erp_project_department_v1',projectArgs({id:pid,version:project.row_version,name:'改名仍保留每日類型',type:'maintenance'}));
 const renamed=(await values()).rows;
 assert.deepEqual(renamed.map(x=>x.work_type),after.map(x=>x.work_type));
 assert.ok(renamed.every(x=>x.title==='改名仍保留每日類型'&&x.status==='in_progress'));
 await assert.rejects(saveLog(db,{...fixedFirst,project_id:pid,project_name:'改名仍保留每日類型',request_id:randomUUID()},ids.viewer),/權限/);
 const acl=(await db.query("select has_function_privilege('anon','public.upsert_erp_project_with_workers_v2(uuid,integer,text,uuid,text,text,text,numeric,text,uuid[],text)','execute') allowed")).rows[0];
 assert.equal(acl.allowed,false);
 console.log('PASS: old bug reproduced; migration replay; new project initialized once; all six daily types; same-name reuse; edit; shared status/name; project editor; denied role and preserved ACL.');
} finally {await db.close();}
