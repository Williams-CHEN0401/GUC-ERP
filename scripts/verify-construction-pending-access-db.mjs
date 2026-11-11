// Real released SQL and authorization chain, synthetic in-memory PostgreSQL.
// No .env, network database, Auth session, NAS or production writes.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pendingHistoryServer,historyPayload} from './pending-history-fixture.mjs';
import {sql,definition,ids} from './worklog-save-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';

const f=await pendingHistoryServer({legacy:false,showcase:false}),{db}=f;
const rpc=(name,args)=>callAsService(db,name,args);
const migration='20261105095107_construction_pending_assignee_access.sql';
let checks=0;const pass=name=>console.log('PASS '+(++checks)+': '+name);
try{
 await db.exec(await sql('20261008000701_construction_progress.sql'));
 await db.exec('alter trigger log_project_link on site_work_logs rename to site_work_logs_project_link_v1');
 await db.exec(await sql('20261012093253_construction_checklist_gantt.sql'));
 const weights=await sql('20261015050624_construction_completion_weights.sql');
 await db.exec(weights.slice(0,weights.indexOf('CREATE OR REPLACE FUNCTION public.work_content_report_v1'))+'commit;');
 await db.exec(await sql('20261016102818_worklog_plan_assignment.sql'));
 await db.exec('alter table projects add column if not exists contract_start_date date,add column if not exists contract_end_date date;alter table construction_plans add column if not exists warning_work_days integer,add column if not exists warning_min_progress numeric;');
 const monitor=await sql('20261025062408_construction_contract_monitoring.sql');
 for(const name of ['construction_completion_totals_v1','construction_progress_alert_v1'])await db.exec(definition(monitor,name));
 await db.exec(await sql('20261104002756_construction_role_permissions.sql'));
 for(const [module,view,create,update]of [['construction_plans',true,false,false],['construction_logs',true,true,true],['construction_logs_all',true,false,false]])
  await db.query('insert into role_permissions(role_code,module,can_view,can_create,can_update,can_delete)values($1,$2,$3,$4,$5,false)',['scoped',module,view,create,update]);
 const project=f.source.project,itemId=randomUUID();
 const plan=await rpc('save_construction_plan_v1',[ids.actor,JSON.stringify({id:randomUUID(),project_id:project.id,construction_date:'2026-11-04',content:'指派施工人員待辦（合成）',status:'in_progress',planned_days:7,assignee_user_ids:[ids.scoped,ids.viewer],items:[{id:itemId,title:'資料設定',start_day:1,planned_days:7}]}),false]);
 const payload=(changes={})=>historyPayload({project_id:project.id,project_name:project.name,customer_id:project.customer_id,department_id:project.department_id,construction_plan_id:plan.id,construction_item_id:itemId,log_date:'2026-11-04',completed_content:'原作者完成事項',pending_content:'待辦A\n待辦B',summary:'原作者完成事項\n待辦A\n待辦B',worker_user_ids:[ids.actor],...changes});
 const source=(await rpc('save_work_log_workforce_v1',[ids.actor,JSON.stringify(payload())])).work_log;
 const list=actor=>rpc('pending_work_log_items_v1',[actor,project.id,'2026-11-05',null]);
 assert.equal((await list(ids.scoped)).items.find(x=>x.source_log_id===source.id).can_complete,false);
 await db.exec(await sql(migration));
 const selected=(await list(ids.scoped)).items.find(x=>x.source_log_id===source.id);assert.equal(selected.can_complete,true);
 pass('reproduces other-author restriction; assigned worker gains pending completion after migration');
 await assert.rejects(rpc('assert_work_log_access_v1',[ids.scoped,project.id,source.id,'UPDATE']),/權限/);
 const current=(await db.query('select * from site_work_logs where id=$1',[source.id])).rows[0];
 const result=await rpc('save_work_log_workforce_v1',[ids.scoped,JSON.stringify(payload({request_id:randomUUID(),log_date:'2026-11-05',completed_content:'今日完成',pending_content:'',summary:'今日完成',worker_user_ids:[ids.scoped],resolved_pending_items:[selected]}))]);
 const after=(await db.query('select * from site_work_logs where id=$1',[source.id])).rows[0];
 assert.equal(after.completed_content,current.completed_content);assert.equal(after.access_creator_user_id,current.access_creator_user_id);
 assert(after.pending_content.includes(selected.pending_text+'(11-05已完成)'));assert.equal(after.status,'in_progress');
 assert(result.work_log.completed_content.includes(selected.pending_text+'(11-05已完成)'));assert.equal(result.work_log.pending_sources[0].source_log_id,source.id);
 pass('completion preserves original author/content and records both dated history links');
 await db.query('delete from construction_plan_assignees where construction_plan_id=$1 and user_id=$2',[plan.id,ids.scoped]);
 await assert.rejects(rpc('save_work_log_workforce_v1',[ids.scoped,JSON.stringify(payload({log_date:'2026-11-05',worker_user_ids:[ids.scoped],resolved_pending_items:[selected]}))]),/指派|權限/);
 pass('revoked assignee cannot submit a previously offered item');
 const helper=(await db.query("select not prosecdef invoker,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated from pg_proc where oid='public.construction_pending_completion_allowed_v1(uuid,public.site_work_logs)'::regprocedure")).rows[0];
 assert(helper.invoker&&!helper.anon&&!helper.authenticated);
 pass('helper uses existing service-only SECURITY INVOKER boundary');
 console.log('RESULT '+checks+' construction pending authorization groups passed; production writes 0');
}finally{f.server.close();await db.close();}
