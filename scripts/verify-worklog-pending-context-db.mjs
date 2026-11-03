import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pendingContextServer,createProject,ids,extraIds,pendingSave,pendingPayload,historyPayload,contextMigration,optionalDepartmentMigration} from './worklog-pending-context-fixture.mjs';
import {sql,sample} from './worklog-save-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';

const f=await pendingContextServer({applyMigration:false}),db=f.db,checks=[];
const ok=name=>{checks.push(name);console.log('PASS',name);};
const day=value=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
const log=async id=>(await db.query('select * from site_work_logs where id=$1',[id])).rows[0];
const event=async id=>(await db.query('select * from maintenance_events where id=$1',[id])).rows[0];
const events=async id=>(await db.query("select * from maintenance_events where work_log_id=$1 and status='active' order by id",[id])).rows;
const counts=async()=>(await db.query('select (select count(*) from projects) projects,(select count(*) from site_work_logs) logs,(select count(*) from maintenance_events) events,(select count(*) from audit_logs) audits,(select count(*) from work_log_save_requests) requests')).rows[0];
const list=(project,repair=true,date='2026-11-03',exclude=null,actor=ids.actor)=>callAsService(db,repair?'pending_maintenance_items_v1':'pending_work_log_items_v1',[actor,project,date,exclude]);
async function editPayload(id,changes={}){
 const row=await log(id),project=(await db.query('select * from projects where id=$1',[row.project_id])).rows[0];
 return pendingPayload({id,row_version:row.row_version,project_id:row.project_id,project_name:row.title,
  customer_id:project.customer_id,department_id:row.department_id||project.department_id,
  log_date:day(row.log_date),work_type:row.work_type,status:row.status,summary:row.summary,
  completed_content:row.completed_content,pending_content:row.pending_content,
  maintenance_events:(await events(id)).map(e=>({...sample().maintenance_events[0],id:e.id,row_version:e.row_version,
   service_id:e.service_id,event_type:e.event_type,occurred_at:day(e.occurred_at),description:e.description,
   cause:e.cause,handling_process:e.handling_process,result:e.result,notes:e.notes,
   inventory_category_id:e.inventory_category_id,inventory_item_id:e.inventory_item_id,pending_content:e.pending_content})),...changes});
}
const edit=async(id,changes={},actor=ids.actor)=>pendingSave(db,await editPayload(id,changes),actor);
try{
 const sourceId=f.contextCases.repairSourceId,destination=f.contextCases.destination,sourceBefore=await log(sourceId),siblingBefore=await log(f.contextCases.siblingId),eventsBefore=await events(sourceId);
 const parentBefore=(await db.query('select * from projects where id=$1',[sourceBefore.project_id])).rows[0];
 const moved={project_id:destination.id,project_name:destination.name,department_id:destination.department_id};
 const beforeFailure=await counts();
 await assert.rejects(edit(sourceId,moved),/不可刪除或變更工作/);
 await assert.rejects(createProject(db),/請選擇科室/);
 assert.deepEqual(await counts(),beforeFailure);ok('both reported failures reproduce before migrations; rejected writes are atomic');
 const catalogBefore=(await db.query("select oid,proname,proacl,prosecdef,proconfig from pg_proc where proname in ('guard_maintenance_pending_log_v1','guard_work_log_pending_history_v1','upsert_erp_project_department_v1') order by oid")).rows;
 await db.exec(await sql(contextMigration));await db.exec(await sql(optionalDepartmentMigration));
 assert.deepEqual((await db.query("select oid,proname,proacl,prosecdef,proconfig from pg_proc where proname in ('guard_maintenance_pending_log_v1','guard_work_log_pending_history_v1','upsert_erp_project_department_v1') order by oid")).rows,catalogBefore);
 ok('same function identities, ACLs, security modes and search paths retained');

 const payload=await editPayload(sourceId,moved),saved=await pendingSave(db,payload),afterMove=await log(sourceId);
 assert.equal(saved.work_log.id,sourceId);assert.equal(afterMove.project_id,destination.id);assert.equal(day(afterMove.log_date),day(sourceBefore.log_date));
 assert.deepEqual((await events(sourceId)).map(e=>[e.id,e.pending_content,e.pending_completions,e.pending_sources]),eventsBefore.map(e=>[e.id,e.pending_content,e.pending_completions,e.pending_sources]));
 assert.deepEqual(await log(f.contextCases.siblingId),siblingBefore);
 assert.deepEqual((await db.query('select * from projects where id=$1',[sourceBefore.project_id])).rows[0],parentBefore);
 assert.equal((await list(sourceBefore.project_id)).items.filter(i=>i.source_log_id===sourceId).length,0);
 const movedItems=(await list(destination.id)).items;
 assert.equal(movedItems.filter(i=>i.source_log_id===sourceId).length,3);
 assert.ok(movedItems.every(i=>i.project_name===destination.name&&i.log_date==='2026-10-05'));
 const replayBefore=await counts();assert.deepEqual(await pendingSave(db,payload),saved);assert.deepEqual(await counts(),replayBefore);
 ok('repair pending follows single-log department/work move; origin date, event IDs, sibling, original project and replay preserved');
 await assert.rejects(pendingSave(db,{...payload,request_id:randomUUID()}),/其他使用者更新|已更新/);
 await edit(sourceId,{project_name:'修改名稱後的維修工作（合成）'});
 const renamed=(await list(destination.id)).items;assert.ok(renamed.every(i=>i.project_name==='修改名稱後的維修工作（合成）'));
 ok('rename is reflected in reloaded pending options; stale edit remains rejected');

 const item=renamed[0],key=randomUUID(),complete=await pendingSave(db,pendingPayload({project_id:destination.id,project_name:'修改名稱後的維修工作（合成）',department_id:destination.department_id,
  log_date:'2026-10-28',maintenance_events:[{...sample().maintenance_events[0],client_key:key,occurred_at:'2026-10-28',inventory_category_id:null,inventory_item_id:null,pending_content:''}],resolved_maintenance_items:[{...item,target_client_key:key}]}));
 const originalEvent=await event(item.source_event_id),completionEvent=await event(complete.maintenance_event_ids[0]);
 assert.deepEqual(originalEvent.pending_completions,completionEvent.pending_sources);
 const historical=structuredClone(originalEvent.pending_completions),returnTarget=await createProject(db,{name:'再調整科室後工作（合成）',department_id:ids.department});
 await edit(sourceId,{project_id:returnTarget.project.id,project_name:returnTarget.project.name,department_id:ids.department});
 assert.deepEqual((await event(item.source_event_id)).pending_completions,historical);
 assert.deepEqual(await event(completionEvent.id),completionEvent);
 assert.ok((await event(item.source_event_id)).pending_content.includes(`${item.pending_text}(10-28已完成)`));
 assert.equal((await list(returnTarget.project.id)).items.filter(i=>i.source_log_id===sourceId).length,2);
 assert.equal((await list(destination.id)).items.filter(i=>i.source_log_id===sourceId).length,0);
 assert.equal(historical[0].source_log_date,'2026-10-05');assert.equal(historical[0].completed_date,'2026-10-28');
 await edit(complete.work_log.id,{project_id:returnTarget.project.id,project_name:returnTarget.project.name,department_id:ids.department});
 assert.deepEqual((await event(completionEvent.id)).pending_sources,historical);
 ok('partly resolved repair origin and completion log can move; reciprocal IDs, dates and completed labels survive without copying other logs');

 const construction=f.cases.showcase,cs=await log(construction.sourceId),ct=await log(construction.targetId),genericDestination=await createProject(db,{name:'更改科室後施工工作（合成）',project_type:'construction',department_id:extraIds.secondDepartment});
 const genericMove=await edit(construction.sourceId,{project_id:genericDestination.project.id,project_name:genericDestination.project.name,department_id:extraIds.secondDepartment});
 assert.equal(genericMove.work_log.id,cs.id);assert.deepEqual((await log(cs.id)).pending_completions,cs.pending_completions);assert.deepEqual(await log(ct.id),ct);
 assert.equal((await log(cs.id)).pending_content,cs.pending_content);assert.equal((await list(genericDestination.project.id,false)).items.filter(i=>i.source_log_id===cs.id).length,1);
 assert.equal((await list(cs.project_id,false)).items.filter(i=>i.source_log_id===cs.id).length,0);
 await edit(ct.id,{project_id:genericDestination.project.id,project_name:genericDestination.project.name,department_id:extraIds.secondDepartment});
 assert.deepEqual((await log(ct.id)).pending_sources,ct.pending_sources);assert.equal((await log(ct.id)).completed_content,ct.completed_content);
 ok('construction/general pending history follows current log scope and keeps source/completion history and text intact');

 const protectedBefore=await counts();
 await assert.rejects(edit(sourceId,{log_date:'2026-10-04'}),/日期與類型/);
 await assert.rejects(edit(sourceId,{work_type:'送貨',maintenance_events:[]}),/日期與類型/);
 await assert.rejects(db.query('update site_work_logs set deleted_at=now() where id=$1',[sourceId]),/不可刪除/);
 await assert.rejects(edit(cs.id,{log_date:'2026-10-15'}),/結清關聯/);
 await assert.rejects(edit(cs.id,{pending_content:'刪去已完成履歷'}),/須保留/);
 await assert.rejects(db.query("update maintenance_events set pending_completions='[]' where id=$1",[item.source_event_id]),/不可修改或移除/);
 await assert.rejects(edit(ct.id,{completed_content:'刪去完成履歷'}),/不可移除/);
 assert.deepEqual(await counts(),protectedBefore);ok('deletion, date/type changes, removed completion labels and tampered history still fail atomically');

 const foreign=await createProject(db,{name:'其他客戶工作（合成）',customer_id:extraIds.otherCustomer,department_id:extraIds.otherDepartment});
 await assert.rejects(edit(cs.id,{project_id:foreign.project.id,project_name:foreign.project.name,customer_id:extraIds.otherCustomer,department_id:extraIds.otherDepartment}),/其他客戶/);
 await assert.rejects(edit(sourceId,{},ids.viewer),/權限/);
 await db.query('insert into project_workers(project_id,user_id,can_view,can_create_work_log,can_update_work_log,can_delete_work_log,is_assignee) values($1,$2,true,true,true,false,false)',[returnTarget.project.id,ids.scoped]);
 await assert.rejects(edit(sourceId,{project_id:destination.id,project_name:'修改名稱後的維修工作（合成）',department_id:destination.department_id},ids.scoped),/權限/);
 ok('cross-customer historical reassignment, viewer writes and unauthorized scoped moves remain denied');

 const optional=await createProject(db),project=optional.project;
 assert.equal(project.department_id,null);assert.equal(project.customer_id,ids.customer);
 assert.ok(project.project_code);assert.equal((await db.query('select * from projects where id=$1',[project.id])).rows[0].department_id,null);
 const changed=await createProject(db,{id:project.id,row_version:project.row_version,name:project.name+'改名',department_id:null});
 assert.equal(changed.project.id,project.id);assert.equal(changed.project.department_id,null);
 const withDepartment=await createProject(db,{name:'有科室工作（合成）',department_id:ids.department});assert.equal(withDepartment.project.department_id,ids.department);
 await assert.rejects(createProject(db,{name:'跨客戶科室拒絕（合成）',department_id:extraIds.otherDepartment}),/不屬於/);
 await db.query('update customer_departments set is_active=false where id=$1',[extraIds.secondDepartment]);
 await assert.rejects(createProject(db,{name:'停用科室拒絕（合成）',department_id:extraIds.secondDepartment}),/已停用/);
 await assert.rejects(createProject(db,{name:'不存在客戶拒絕（合成）',customer_id:randomUUID()}),/客戶|foreign key/);
 await assert.rejects(createProject(db,{name:project.name+'改名',department_id:null}),/同名|相同|duplicate key/);
 // Global validators remain strict for unrelated document workflows.
 await assert.rejects(callAsService(db,'assert_customer_department_v1',[ids.customer,null,null,false]),/請選擇科室/);
 ok('work-content create/edit accepts omitted department; numbering, reread, selected-room ownership/activity, customer validation and duplicate-name guards remain');
 const acl=(await db.query("select has_function_privilege('anon','upsert_erp_project_department_v1(uuid,integer,text,uuid,text,text,text,numeric,text,uuid[],text,date,text,uuid,boolean)','execute') anon,has_function_privilege('authenticated','save_work_log_workforce_v1(uuid,jsonb)','execute') authenticated")).rows[0];
 assert.deepEqual(acl,{anon:false,authenticated:false});
 ok('service-only RPC ACL retained; no public/authenticated direct write entrypoints');
 console.log(JSON.stringify({checks:checks.length,passed:true}));
}finally{f.server.close();await db.close();}
