// Real migration/functions in disposable in-memory PGlite. No Docker or production access.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pendingHistoryServer,pendingHistoryMigration,pendingPayload,pendingSave,pendingList,historyPayload,historyText,historyDisplay,otherPendingText,ids} from './pending-history-fixture.mjs';
import {sample,sql} from './worklog-save-fixture.mjs';
import {callAsService,extraIds} from './department-cross-system-fixture.mjs';

let f;let passed=0;
const ok=name=>{passed++;console.log(`PASS ${passed}: ${name}`);};
const day=value=>new Date(value).toISOString().slice(0,10);
const lines=value=>String(value??'').split(/\r?\n/);
async function addConstructionFixture(db){
 await db.exec(await sql('20261008000701_construction_progress.sql'));
 // The old minimal fixture uses this shorter trigger name. Its function is the real one.
 await db.exec('alter trigger log_project_link on site_work_logs rename to site_work_logs_project_link_v1');
 await db.exec(await sql('20261012093253_construction_checklist_gantt.sql'));
 const weights=await sql('20261015050624_construction_completion_weights.sql');
 await db.exec(weights.slice(0,weights.indexOf('CREATE OR REPLACE FUNCTION public.work_content_report_v1'))+'commit;');
 await db.exec(await sql('20261016102818_worklog_plan_assignment.sql'));
}
async function planFixture(db,projectId){
 await db.query("update projects set construction_category='small_purchase' where id=$1",[projectId]);
 const item=randomUUID(),plan=await callAsService(db,'save_construction_plan_v1',[ids.actor,JSON.stringify({id:randomUUID(),project_id:projectId,construction_date:'2026-10-16',content:'合成施工規劃',status:'pending',planned_days:7,assignee_user_ids:[ids.actor],items:[{id:item,title:'接線與測試',sort_order:0,start_day:1,planned_days:7}]}),false]);
 const project=(await db.query('select * from projects where id=$1',[projectId])).rows[0];
 const body=changes=>historyPayload({project_id:projectId,project_name:project.name,customer_id:project.customer_id,department_id:project.department_id,construction_plan_id:plan.id,construction_item_id:item,pending_content:'施工規劃未完成事項',completed_content:'已完成配線',...changes});
 return {plan,item,body};
}
try{
 f=await pendingHistoryServer();const db=f.db;
 const log=async id=>(await db.query('select * from site_work_logs where id=$1',[id])).rows[0];
 const event=async id=>(await db.query('select * from maintenance_events where id=$1',[id])).rows[0];
 const counts=async()=>(await db.query('select (select count(*) from site_work_logs) logs,(select count(*) from maintenance_events) events,(select count(*) from work_log_save_requests) requests,(select count(*) from audit_logs) audits')).rows[0];
 const edit=async(id,changes={},actor=ids.actor)=>{const r=await log(id);return pendingSave(db,historyPayload({id,row_version:r.row_version,project_id:r.project_id,project_name:r.title,log_date:day(r.log_date),summary:r.summary,completed_content:r.completed_content,pending_content:r.pending_content,status:r.status,...changes}),actor);};
 const resolve=(source,items,changes={})=>pendingSave(db,historyPayload({project_id:source.project_id,project_name:source.title,log_date:'2026-10-28',completed_content:'本次測試',pending_content:'',resolved_pending_items:items,...changes}));

 const legacySource=await log(f.cases.legacy.sourceId),legacyTarget=await log(f.cases.legacy.targetId);
 assert.equal(legacySource.pending_content,historyDisplay());assert.equal(legacySource.completed_content,'10/16原有完成事項（合成）');
 assert.equal(legacySource.pending_completions.length,1);assert.deepEqual(legacySource.pending_completions,legacyTarget.pending_sources);
 assert.equal(legacySource.pending_completions[0].source_log_date,'2026-10-16');assert.equal(legacySource.pending_completions[0].completed_date,'2026-10-28');
 assert.ok(legacySource.pending_completions[0].recovered_from_audit_id);assert.equal(lines(legacyTarget.completed_content).filter(x=>x===historyDisplay()).length,1);
 assert.equal((await pendingList(db,legacySource.project_id)).items.length,0);ok('unique request + audit + current source/target marker recovers original section/date only');
 for(const before of f.cases.ambiguous.before){const after=await log(before.id);for(const key of ['summary','completed_content','pending_content','row_version'])assert.equal(after[key],before[key]);assert.deepEqual(after.pending_completions,[]);assert.deepEqual(after.pending_sources,[]);}ok('hand-edited target is skipped; request does not recreate deleted content');

 const source=await log(f.source.work_log.id),items=(await pendingList(db,source.project_id)).items,item=items.find(i=>i.pending_text===historyText);
 assert.equal(items.length,2);assert.equal((await pendingList(db,source.project_id,'2026-10-16')).items.length,0);
 const before=await counts();const payload=historyPayload({project_id:source.project_id,project_name:source.title,log_date:'2026-10-28',completed_content:`本次測試\n${historyDisplay()}`,pending_content:'',resolved_pending_items:[item]});
 const target=await pendingSave(db,payload),after=await log(source.id),targetLog=await log(target.work_log.id);
 assert.equal(after.completed_content,source.completed_content);assert.equal(after.pending_content,`${historyDisplay()}\n${otherPendingText}`);assert.equal(after.status,'in_progress');
 assert.equal(day(after.log_date),'2026-10-16');assert.equal(day(targetLog.log_date),'2026-10-28');assert.deepEqual(after.pending_completions,targetLog.pending_sources);
 assert.equal(after.pending_completions[0].pending_text,historyText);assert.equal(after.pending_completions[0].display_text,historyDisplay());
 assert.equal(lines(targetLog.completed_content).filter(x=>x===historyDisplay()).length,1);assert.equal(targetLog.pending_content,'');
 assert.equal((await counts()).logs,before.logs+1);ok('10/16 origin retains annotated pending; only 10/28 destination gets completed; full dates/IDs match');
 const committed=await counts();assert.deepEqual(await pendingSave(db,payload),target);assert.deepEqual(await counts(),committed);ok('idempotent replay has no duplicate logs, history or audit');
 await assert.rejects(resolve(source,[item]),/已更新|已完成/);assert.deepEqual(await counts(),committed);
 const currentItems=(await pendingList(db,source.project_id,'2026-10-29')).items;assert.deepEqual(currentItems.map(x=>x.pending_text),[otherPendingText]);
 await assert.rejects(resolve(await log(source.id),[{...item,row_version:(await log(source.id)).row_version}],{log_date:'2026-10-29'}),/已完成/);ok('stale and repeated consumption rejected; other pending item remains selectable');
 const sameBefore=await log(f.sameName.work_log.id);assert.equal(sameBefore.pending_content,historyText);
 await assert.rejects(resolve(sameBefore,[currentItems[0]],{customer_id:extraIds.otherCustomer,department_id:extraIds.otherDepartment}),/不屬於/);
 assert.deepEqual(await log(f.sameName.work_log.id),sameBefore);ok('identical project names/text do not cross distinct project IDs or customers');

 await assert.rejects(edit(source.id,{log_date:'2026-10-15'}),/結清關聯/);
 await assert.rejects(edit(targetLog.id,{log_date:'2026-10-29'}),/結清關聯/);
 await assert.rejects(db.query('update site_work_logs set deleted_at=now() where id=$1',[source.id]),/結清關聯/);
 await assert.rejects(db.query('delete from site_work_logs where id=$1',[targetLog.id]),/結清關聯|foreign key/);
 await assert.rejects(db.query('update projects set department_id=$1 where id=$2',[extraIds.secondDepartment,source.project_id]),/結清關聯/);
 await assert.rejects(db.query('update projects set customer_id=$1 where id=$2',[extraIds.otherCustomer,source.project_id]),/結清關聯|科室/);ok('source/target date, deletion and parent customer/department boundaries protected');
 await assert.rejects(edit(source.id,{pending_content:otherPendingText}),/須保留/);
 await assert.rejects(edit(targetLog.id,{completed_content:'刪掉本次承接內容'}),/不可移除/);
 await assert.rejects(db.query("update site_work_logs set pending_completions='[]' where id=$1",[source.id]),/不可修改或移除/);
 await assert.rejects(db.query("update site_work_logs set summary='舊客戶端覆寫' where id=$1",[source.id]),/須保留|結清履歷/);ok('direct and old-writer paths cannot erase history or return resolved item to open state');
 const edited=await edit(source.id,{completed_content:'原有完成內容可補充',pending_content:`${historyDisplay()}\n其他未完成已補充`});
 assert.equal(edited.work_log.completed_content,'原有完成內容可補充');assert.equal(edited.work_log.pending_completions.length,1);
 await edit(targetLog.id,{completed_content:`${targetLog.completed_content}\n本次完成補充`});ok('ordinary source and destination edits preserving history still save');
 const last=(await pendingList(db,source.project_id,'2026-10-29')).items;
 await resolve(await log(source.id),last,{log_date:'2026-10-29'});
 const finished=await log(source.id);assert.equal(finished.status,'completed');assert.equal(finished.pending_completions.length,2);assert.ok(finished.pending_content.includes(historyDisplay('其他未完成已補充','2026-10-29')));assert.equal((await pendingList(db,source.project_id,'2026-10-30')).items.length,0);ok('all items settled closes source status without deleting either historical pending line');

 const noHistory=await pendingSave(db,historyPayload({project_name:'文字看似完成但沒有履歷',pending_content:'文字(10-28已完成)',completed_content:''}));
 assert.equal((await pendingList(db,noHistory.work_log.project_id)).items[0].pending_text,'文字(10-28已完成)');ok('annotation-looking user text without trusted metadata remains open');
 const over=await pendingSave(db,historyPayload({project_name:'長度限制原子測試',pending_content:'字'.repeat(1995),completed_content:''}));
 const overItem=(await pendingList(db,over.work_log.project_id)).items[0],beforeOver=await counts(),overRow=await log(over.work_log.id);
 await assert.rejects(resolve(overRow,[overItem]),/2000/);assert.deepEqual(await counts(),beforeOver);assert.deepEqual(await log(overRow.id),overRow);ok('annotation overflow rolls back target, source, request and audit with length message');
 const sourceLimit=await pendingSave(db,historyPayload({project_name:'來源合併長度限制',pending_content:'短待辦',completed_content:'字'.repeat(1990)}));
 const sourceLimitRow=await log(sourceLimit.work_log.id),limitItem=(await pendingList(db,sourceLimitRow.project_id)).items[0],beforeLimit=await counts();
 await assert.rejects(resolve(sourceLimitRow,[limitItem]),/來源日誌.*2000/);assert.deepEqual(await counts(),beforeLimit);assert.deepEqual(await log(sourceLimitRow.id),sourceLimitRow);ok('source combined summary overflow also rolls back after target creation');
 const sameA=await pendingSave(db,historyPayload({project_name:'同案件不同來源同文字',pending_content:'重複描述',completed_content:''}));
 const sameB=await pendingSave(db,historyPayload({project_id:sameA.work_log.project_id,project_name:sameA.work_log.title,log_date:'2026-10-17',pending_content:'重複描述',completed_content:''}));
 const sameItems=(await pendingList(db,sameA.work_log.project_id)).items;assert.equal(sameItems.length,2);
 await assert.rejects(resolve(await log(sameA.work_log.id),[sameItems[0],sameItems[0]]),/不可重複/);
 const sameTarget=await resolve(await log(sameA.work_log.id),sameItems,{completed_content:'[重複描述](10-28已完成)'});
 assert.equal(sameTarget.work_log.pending_sources.length,2);assert.equal(sameTarget.work_log.completed_content,'重複描述(10-28已完成)');assert.equal((await log(sameB.work_log.id)).pending_content,'重複描述(10-28已完成)');ok('same text in distinct source logs has two references, one target label; old generated brackets canonicalized');
 const boundary=await pendingSave(db,historyPayload({project_name:'跨年日期',log_date:'2025-12-31',pending_content:'跨年事項',completed_content:''}));
 const boundaryItem=(await pendingList(db,boundary.work_log.project_id,'2026-01-02')).items[0];
 await resolve(await log(boundary.work_log.id),[boundaryItem],{log_date:'2026-01-02'});
 const year=await log(boundary.work_log.id);assert.equal(year.pending_completions[0].source_log_date,'2025-12-31');assert.equal(year.pending_completions[0].completed_date,'2026-01-02');assert.equal(year.pending_content,'跨年事項(01-02已完成)');ok('year boundary preserves full source/completion dates, not inferred MM-DD');

 const acl=(await db.query("select has_function_privilege('anon','pending_work_log_items_v1(uuid,uuid,date,uuid)','execute') a,has_function_privilege('authenticated','save_work_log_workforce_v1(uuid,jsonb)','execute') b,has_function_privilege('anon','work_log_open_pending_lines_v1(text,jsonb)','execute') c")).rows[0];assert.deepEqual(acl,{a:false,b:false,c:false});
 await assert.rejects(pendingList(db,source.project_id,'2026-10-30',null,ids.scoped),/權限/);
 await assert.rejects(edit(source.id,{},ids.viewer),/權限/);ok('RPC ACL and existing scoped/update permissions retained');
 await db.query('insert into project_workers(project_id,user_id,can_view,can_create_work_log,can_update_work_log,can_delete_work_log,is_assignee) values($1,$2,true,false,false,false,false)',[noHistory.work_log.project_id,ids.scoped]);
 const readOnly=(await pendingList(db,noHistory.work_log.project_id,'2026-10-28',null,ids.scoped)).items;assert.equal(readOnly.length,1);assert.equal(readOnly[0].can_complete,false);ok('project read-only grant can list but cannot settle');
 await callAsService(db,'configure_erp_private_access_v1',[ids.actor,ids.actor,[],null]);
 await db.query('update customers set is_private=true where id=$1',[extraIds.otherCustomer]);
 await db.query("update app_users set role='admin' where id=$1",[ids.viewer]);
 const visiblePrivate=(await pendingList(db,sameBefore.project_id)).items;assert.equal(visiblePrivate.length,1);
 assert.equal((await pendingList(db,sameBefore.project_id,'2026-10-28',null,ids.viewer)).items.length,0);
 await assert.rejects(pendingSave(db,historyPayload({project_id:sameBefore.project_id,project_name:sameBefore.title,customer_id:extraIds.otherCustomer,department_id:extraIds.otherDepartment,log_date:'2026-10-28',completed_content:'',pending_content:'',resolved_pending_items:visiblePrivate}),ids.viewer),/私人|權限/);
 await db.query("update app_users set role='viewer' where id=$1",[ids.viewer]);await db.query('update customers set is_private=false where id=$1',[extraIds.otherCustomer]);ok('real private-data owner allowed; unlisted administrator cannot list or settle private source');

 const mList=(project,date='2026-10-28',exclude=null)=>callAsService(db,'pending_maintenance_items_v1',[ids.actor,project,date,exclude]);
 const repairPid=f.first.work_log.project_id,repairItems=(await mList(repairPid)).items,repairItem=repairItems[0],sourceEvent=await event(repairItem.source_event_id),key=randomUUID();
 const repairPayload=pendingPayload({project_id:repairPid,project_name:f.first.work_log.title,log_date:'2026-10-28',maintenance_events:[{...sample().maintenance_events[0],client_key:key,occurred_at:'2026-10-28',inventory_category_id:null,inventory_item_id:null,pending_content:''}],resolved_maintenance_items:[{...repairItem,target_client_key:key}]});
 const repair=await pendingSave(db,repairPayload),repairSource=await event(sourceEvent.id),repairTarget=await event(repair.maintenance_event_ids[0]);
 assert.equal(repairSource.notes,sourceEvent.notes);assert.ok(repairSource.pending_content.includes(historyDisplay(repairItem.pending_text)));assert.equal(repairSource.pending_completions[0].source_log_date,'2026-10-05');assert.deepEqual(repairSource.pending_completions,repairTarget.pending_sources);assert.equal(lines(repairTarget.handling_process).filter(x=>x===historyDisplay(repairItem.pending_text)).length,1);
 assert.equal((await mList(repairPid)).items.length,repairItems.length-1);ok('maintenance preserves original notes and annotated pending with reciprocal dated event references');
 await assert.rejects(db.query('update maintenance_events set pending_content=$1 where id=$2',[sourceEvent.pending_content,sourceEvent.id]),/須保留/);
 await assert.rejects(db.query("update maintenance_events set handling_process='改掉結清行' where id=$1",[repairTarget.id]),/不可移除/);
 await assert.rejects(db.query("update maintenance_events set pending_completions='[]' where id=$1",[sourceEvent.id]),/不可修改或移除/);ok('maintenance resolved text and reciprocal metadata cannot be silently removed');
 const remaining=(await mList(repairPid)).items.filter(i=>i.source_event_id===sourceEvent.id),key2=randomUUID();
 await pendingSave(db,pendingPayload({project_id:repairPid,project_name:f.first.work_log.title,log_date:'2026-10-29',maintenance_events:[{...sample().maintenance_events[0],client_key:key2,occurred_at:'2026-10-29',inventory_category_id:null,inventory_item_id:null,pending_content:''}],resolved_maintenance_items:remaining.map(i=>({...i,target_client_key:key2}))}));
 const originalLog=await log(sourceEvent.work_log_id),allResolved=await event(sourceEvent.id);
 await pendingSave(db,pendingPayload({id:originalLog.id,row_version:originalLog.row_version,project_id:repairPid,project_name:originalLog.title,log_date:day(originalLog.log_date),status:'completed',maintenance_events:[{...sample().maintenance_events[0],id:allResolved.id,row_version:allResolved.row_version,occurred_at:day(originalLog.log_date),inventory_category_id:null,inventory_item_id:null,pending_content:allResolved.pending_content}]}));
 assert.equal((await log(originalLog.id)).status,'completed');ok('maintenance can mark completed when pending field contains only trusted historical labels');
 await addConstructionFixture(db);
 const pc=await planFixture(db,noHistory.work_log.project_id),planSource=await pendingSave(db,pc.body()),planBefore=(await db.query('select * from construction_plans where id=$1',[pc.plan.id])).rows[0],itemBefore=(await db.query('select * from construction_plan_items where id=$1',[pc.item])).rows[0];
 const planItem=(await pendingList(db,planSource.work_log.project_id)).items.find(i=>i.source_log_id===planSource.work_log.id),scope=async()=>callAsService(db,'construction_scope_v1',[ids.actor,planSource.work_log.project_id]);
 const scopeBefore=(await scope()).construction_plans.find(p=>p.id===pc.plan.id);
 const planTarget=await pendingSave(db,pc.body({log_date:'2026-10-28',completed_content:'本次完成測試',pending_content:'',resolved_pending_items:[planItem]}));
 const keptPlanSource=await log(planSource.work_log.id);assert.equal(keptPlanSource.pending_content,'施工規劃未完成事項(10-28已完成)');assert.equal(keptPlanSource.completed_content,'已完成配線');assert.equal(keptPlanSource.construction_plan_id,pc.plan.id);assert.equal(keptPlanSource.construction_item_id,pc.item);assert.equal(planTarget.work_log.construction_item_id,pc.item);
 await pendingSave(db,pc.body({id:keptPlanSource.id,row_version:keptPlanSource.row_version,completed_content:'已完成配線與標示補充',pending_content:keptPlanSource.pending_content,status:keptPlanSource.status}));
 const targetFresh=await log(planTarget.work_log.id);await pendingSave(db,pc.body({id:targetFresh.id,row_version:targetFresh.row_version,log_date:'2026-10-28',completed_content:targetFresh.completed_content+'\n本次補充',pending_content:''}));
 assert.deepEqual((await db.query('select * from construction_plans where id=$1',[pc.plan.id])).rows[0],planBefore);assert.deepEqual((await db.query('select * from construction_plan_items where id=$1',[pc.item])).rows[0],itemBefore);
 const scopeAfter=(await scope()).construction_plans.find(p=>p.id===pc.plan.id);assert.equal(scopeAfter.completion_percent,scopeBefore.completion_percent);assert.equal(scopeAfter.items[0].is_completed,false);assert.equal(scopeAfter.worked_days,2);ok('actual nested construction plan+item writer keeps source section and permits ordinary edits without altering checklist state/weighted progress');
 // A second fresh schema exercises pre-migration maintenance data and CRLF definitions.
 f.server.close();await f.db.close();f=await pendingHistoryServer({applyMigration:false,legacy:false});
 const oldDb=f.db,oldRepairItems=(await callAsService(oldDb,'pending_maintenance_items_v1',[ids.actor,f.first.work_log.project_id,'2026-10-28',null])).items,oldKey=randomUUID();
 const oldRepair=await pendingSave(oldDb,pendingPayload({project_id:f.first.work_log.project_id,project_name:f.first.work_log.title,log_date:'2026-10-28',maintenance_events:[{...sample().maintenance_events[0],client_key:oldKey,occurred_at:'2026-10-28',inventory_category_id:null,inventory_item_id:null,pending_content:'',handling_process:'使用者已修改的原完成說明'}],resolved_maintenance_items:[{...oldRepairItems[0],target_client_key:oldKey}]}));
 const oldSource=(await oldDb.query('select * from maintenance_events where id=$1',[oldRepairItems[0].source_event_id])).rows[0],oldTarget=(await oldDb.query('select * from maintenance_events where id=$1',[oldRepair.maintenance_event_ids[0]])).rows[0];
 await addConstructionFixture(oldDb);
 const legacyPlan=await planFixture(oldDb,f.source.work_log.project_id),oldPlanSource=await pendingSave(oldDb,legacyPlan.body());
 const oldPlanItem=(await pendingList(oldDb,oldPlanSource.work_log.project_id)).items.find(i=>i.source_log_id===oldPlanSource.work_log.id);
 const oldPlanTarget=await pendingSave(oldDb,legacyPlan.body({log_date:'2026-10-28',pending_content:'',completed_content:'本次施工結清',resolved_pending_items:[oldPlanItem]}));
 for(const signature of ['save_work_log_workforce_before_maintenance_v1(uuid,jsonb)','save_work_log_workforce_v1(uuid,jsonb)','pending_maintenance_items_v1(uuid,uuid,date,uuid)']){
  const definition=(await oldDb.query('select pg_get_functiondef($1::regprocedure) definition',[signature])).rows[0].definition;await oldDb.exec(definition.replaceAll('\n','\r\n'));
 }
 await oldDb.exec(await sql(pendingHistoryMigration));
 const restored=(await oldDb.query('select * from maintenance_events where id=$1',[oldSource.id])).rows[0],unchangedTarget=(await oldDb.query('select * from maintenance_events where id=$1',[oldTarget.id])).rows[0];
 assert.ok(restored.pending_content.includes(historyDisplay(oldRepairItems[0].pending_text)));assert.equal(restored.notes,oldSource.notes);assert.equal(unchangedTarget.handling_process,oldTarget.handling_process);assert.deepEqual(restored.pending_completions,unchangedTarget.pending_sources);ok('maintenance legacy reciprocal metadata restores source only; CRLF stored function patch works');
 assert.equal((await callAsService(oldDb,'pending_maintenance_items_v1',[ids.actor,f.first.work_log.project_id,'2026-10-28',null])).items.length,2);ok('restored maintenance label is not offered again');
 const recoveredPlanSource=(await oldDb.query('select * from site_work_logs where id=$1',[oldPlanSource.work_log.id])).rows[0],recoveredPlanTarget=(await oldDb.query('select * from site_work_logs where id=$1',[oldPlanTarget.work_log.id])).rows[0];
 assert.equal(recoveredPlanSource.pending_content,'施工規劃未完成事項(10-28已完成)');assert.equal(recoveredPlanSource.completed_content,'已完成配線');assert.equal(recoveredPlanSource.construction_plan_id,legacyPlan.plan.id);assert.equal(recoveredPlanSource.construction_item_id,legacyPlan.item);assert.deepEqual(recoveredPlanSource.pending_completions,recoveredPlanTarget.pending_sources);ok('audit-backed legacy source with actual construction plan/item safely restores the original pending section');
 console.log(`PASS ${passed} isolated pending-history DB scenarios; no production database or Docker was used. PGlite serializes execution; real PostgreSQL parallel-lock scheduling is not claimed.`);
}catch(e){console.error(e.message);if(e.where)console.error(e.where);process.exitCode=1;}
finally{if(f){f.server.close();await f.db.close();}}
