import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {workflowIdentityServer} from './workflow-identity-fixture.mjs';
import {pendingPayload,pendingSave,pendingList} from './maintenance-pending-fixture.mjs';
import {ids} from './worklog-save-fixture.mjs';
const f=await workflowIdentityServer(),{db}=f;
try{
 const name=f.seed.project.name,original=f.seed.work_log.project_id;
 const before=(await db.query('select id,name from projects order by id')).rows;
 const chosen=await pendingSave(db,pendingPayload({project_id:original,project_name:name,log_date:'2026-12-05'}));
 assert.equal(chosen.work_log.project_id,original,'selected existing ID is retained even months later');
 assert.deepEqual((await db.query('select id,name from projects order by id')).rows,before,'no new project or historical rename');
 const manual=pendingPayload({project_name:name,log_date:'2026-09-02'});
 const created=await pendingSave(db,manual);
 assert.notEqual(created.work_log.project_id,original);
 assert.equal(created.project.name,name+'260902','suffix is the log date, not today');
 assert.deepEqual(await pendingSave(db,manual),created,'request replay is stable');
 const duplicate=await pendingSave(db,{...manual,request_id:randomUUID()});
 assert.equal(duplicate.project.name,name+'260902-2');
 assert.equal((await pendingList(db,created.project.id,'2026-12-05')).items.length,0,'same base name has no pending crossover');
 // Historical root links also must not merge distinct cases.
 await db.query('update projects set repair_root_project_id=$1 where id=$2',[original,created.project.id]);
 assert.equal((await pendingList(db,created.project.id,'2026-12-05')).items.length,0);
 const pending=await pendingList(db,original,'2026-12-05');assert.equal(pending.items.length,3);
 assert.equal(new Set(pending.items.map(i=>i.source_event_id+':'+i.pending_text)).size,3);
 const item=pending.items[0],key=randomUUID();
 const follow=pendingPayload({project_id:original,project_name:name,log_date:'2026-12-05',resolved_maintenance_items:[{...item,target_client_key:key}],maintenance_events:[{...pendingPayload().maintenance_events[0],client_key:key,pending_content:'',service_id:item.service_id,event_type:item.event_type}]});
 await assert.rejects(()=>pendingSave(db,{...follow,project_id:created.project.id,project_name:created.project.name}),/待辦已更新|沒有修改權限/);
 const completed=await pendingSave(db,follow);assert.equal(completed.work_log.project_id,original);
 assert.equal((await pendingList(db,original,'2026-12-06')).items.length,2,'completed source disappears');
 for(const type of ['工程施工','送貨','文書作業','場勘','維護保養']){
  const result=await pendingSave(db,pendingPayload({project_name:name,log_date:'2026-10-01',work_type:type,maintenance_events:[]}));
  assert.notEqual(result.project.id,original);assert.match(result.project.name,/261001/);
 }
 await assert.rejects(()=>pendingSave(db,pendingPayload({project_name:'viewer must not create'}),ids.viewer),/權限/);
 await assert.rejects(()=>pendingSave(db,pendingPayload({project_name:'scoped must not create'}),ids.scoped),/權限|選擇/);
 console.log('PASS: selected ID, manual date naming/all work types, replay, historical name/root isolation, pending completion, cross-case denial, viewer/scoped denial');
}finally{f.server.close();await db.close();}
