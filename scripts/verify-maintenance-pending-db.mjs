import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {maintenancePendingServer,pendingPayload,pendingSave,pendingList} from './maintenance-pending-fixture.mjs';
import {sample,ids} from './worklog-save-fixture.mjs';
import {extraIds,callAsService} from './department-cross-system-fixture.mjs';
const f=await maintenancePendingServer(),db=f.db,pid=f.first.work_log.project_id;
const row=async(id)=>(await db.query('select * from maintenance_events where id=$1',[id])).rows[0];
const counts=async()=>(await db.query('select (select count(*) from site_work_logs) logs,(select count(*) from maintenance_events) events,(select count(*) from repair_items) repairs,(select count(*) from work_log_save_requests) requests')).rows[0];
const followup=(items,changes={})=>{
 const key=randomUUID(),day='2026-10-06';
 return pendingPayload({project_id:pid,project_name:f.first.work_log.title,log_date:day,
  maintenance_events:[{...sample().maintenance_events[0],client_key:key,occurred_at:day,inventory_category_id:null,inventory_item_id:null,pending_content:'回訪後仍須測試錄音'}],
  resolved_maintenance_items:items.map(i=>({source_log_id:i.source_log_id,source_event_id:i.source_event_id,row_version:i.row_version,log_row_version:i.log_row_version,pending_text:i.pending_text,target_client_key:key})),...changes});
};
try{
 let items=(await pendingList(db,pid)).items;assert.equal(items.length,3);
 assert.equal((await pendingList(db,pid,'2026-10-04')).items.length,0);
 assert.equal((await pendingList(db,pid,'2026-10-05',f.first.work_log.id)).items.length,0);
 assert.equal((await pendingList(db,pid,'2026-10-05')).items.length,3,'same-day previous visit');
 const sourceId=items[0].source_event_id,before=await row(sourceId),beforeCounts=await counts();
 const invalid=followup([items[0]]);invalid.maintenance_events[0].service_id=randomUUID();
 await assert.rejects(pendingSave(db,invalid),/承攬項目/);assert.deepEqual(await counts(),beforeCounts);
 const payload=followup(items.slice(0,2));
 const saved=await pendingSave(db,payload);assert.notEqual(saved.work_log.project_id,pid,'new repair visit');
 assert.equal((await db.query('select repair_root_project_id from projects where id=$1',[saved.work_log.project_id])).rows[0].repair_root_project_id,pid);
 const after=await row(sourceId);assert.equal(after.notes,before.notes);assert.equal(after.pending_completions.length,2);assert.equal(after.pending_content,items[2].pending_text);
 const target=await row(saved.maintenance_event_ids[0]);assert.equal(target.pending_sources.length,2);assert.equal(target.pending_content,'回訪後仍須測試錄音');assert.equal(target.service_id,before.service_id);assert.equal(target.event_type,before.event_type);
 assert.equal((await counts()).repairs,beforeCounts.repairs,'follow-up does not create inventory repair without selecting an item');
 const committed=await counts();assert.deepEqual(await pendingSave(db,payload),saved);assert.deepEqual(await counts(),committed,'replay no duplicates');
 await assert.rejects(pendingSave(db,followup([items[2]])),/已更新/);assert.deepEqual(await counts(),committed,'stale source atomic rollback');
 const remaining=(await pendingList(db,saved.work_log.project_id)).items;assert.equal(remaining.length,2);assert.ok(remaining.some(i=>i.source_event_id===sourceId)&&remaining.some(i=>i.source_event_id===target.id));
 const rootLookup=(await pendingList(db,pid)).items;assert.equal(rootLookup.length,2);
 assert.equal((await pendingList(db,pid,'2026-10-30',f.first.work_log.id)).items.length,0,'existing earlier log cannot consume its descendants');
 await assert.rejects(db.query("update maintenance_events set status='voided' where id=$1",[sourceId]),/結清關聯/);
 await assert.rejects(db.query("update site_work_logs set deleted_at=now() where id=$1",[saved.work_log.id]),/結清關聯/);
 await assert.rejects(db.query('update maintenance_events set pending_content=$1 where id=$2',[items[0].pending_text,sourceId]),/已結清/);
 await assert.rejects(db.query('update projects set department_id=null where id=$1',[pid]),/回訪關聯/);
 await assert.rejects(pendingSave(db,followup([remaining[0]]),ids.viewer),/權限/);
 await assert.rejects(pendingList(db,pid,'2026-10-30',null,ids.scoped),/權限/);
 // A read-only project grant may see items but may not settle them.
 await db.query('insert into project_workers(project_id,user_id,can_view,can_create_work_log,can_update_work_log,can_delete_work_log,is_assignee) values($1,$2,true,false,false,false,false)',[pid,ids.scoped]);
 const readonly=(await pendingList(db,pid,'2026-10-30',null,ids.scoped)).items;assert.equal(readonly.length,1);assert.equal(readonly[0].can_complete,false);
 await db.query('update contract_service_types set is_active=false where id=$1',[ids.service]);
 assert.ok((await pendingList(db,pid)).items.every(i=>!i.can_complete&&i.reason.includes('停用')));
 await db.query('update contract_service_types set is_active=true where id=$1',[ids.service]);
 // Omitted notes in the modern repair form retain the exact original text.
 const log=(await db.query('select * from site_work_logs where id=$1',[f.first.work_log.id])).rows[0],fresh=await row(sourceId);
 const edit=pendingPayload({id:log.id,row_version:log.row_version,project_id:pid,project_name:log.title,log_date:'2026-10-05',maintenance_events:[{...sample().maintenance_events[0],id:fresh.id,row_version:fresh.row_version,occurred_at:'2026-10-05',pending_content:fresh.pending_content,client_key:randomUUID()}]});
 await pendingSave(db,edit);assert.equal((await row(sourceId)).notes,before.notes);assert.equal((await row(sourceId)).pending_completions.length,2);
 // Same text in distinct source events must keep separate destination cards.
 const pair=await pendingSave(db,pendingPayload({project_name:'多事件待辦（隔離）',log_date:'2026-10-01',maintenance_events:[0,1].map(()=>({...sample().maintenance_events[0],inventory_category_id:null,inventory_item_id:null,pending_content:'相同文字',client_key:randomUUID()}))}));
 const pairItems=(await pendingList(db,pair.work_log.project_id)).items;assert.equal(pairItems.length,2);assert.notEqual(pairItems[0].source_event_id,pairItems[1].source_event_id);
 const merged=followup(pairItems,{project_id:pair.work_log.project_id,project_name:pair.work_log.title});await assert.rejects(pendingSave(db,merged),/不同來源不可合併/);
 const separated=followup([],{project_id:pair.work_log.project_id,project_name:pair.work_log.title});separated.maintenance_events=pairItems.map(()=>({...separated.maintenance_events[0],client_key:randomUUID()}));separated.resolved_maintenance_items=pairItems.map((i,n)=>({...i,target_client_key:separated.maintenance_events[n].client_key}));
 const pairResult=await pendingSave(db,separated);assert.equal(pairResult.maintenance_event_ids.length,2);
 // Different customer/department roots never admit a forged source, even if the text matches.
 const other=await pendingSave(db,pendingPayload({department_id:extraIds.secondDepartment,project_name:'不同科室（隔離）',log_date:'2026-10-01',maintenance_events:[{...sample().maintenance_events[0],inventory_category_id:null,inventory_item_id:null,pending_content:'相同文字'}]}));
 assert.equal((await pendingList(db,other.work_log.project_id)).items.length,1);
 const forged=followup([(await pendingList(db,pid)).items[0]],{project_id:other.work_log.project_id,project_name:other.work_log.title,department_id:extraIds.secondDepartment});await assert.rejects(pendingSave(db,forged),/沒有修改權限/);
 await db.query('insert into customer_contract_services(customer_id,service_type_id,is_active) values($1,$2,true) on conflict do nothing',[extraIds.otherCustomer,ids.service]);
 const customer=await pendingSave(db,pendingPayload({customer_id:extraIds.otherCustomer,department_id:extraIds.otherDepartment,project_name:'不同客戶（隔離）',log_date:'2026-10-01',maintenance_events:[{...sample().maintenance_events[0],inventory_category_id:null,inventory_item_id:null,pending_content:'相同文字'}]}));
 const cross=followup([(await pendingList(db,pid)).items[0]],{project_id:customer.work_log.project_id,project_name:customer.work_log.title,customer_id:extraIds.otherCustomer,department_id:extraIds.otherDepartment});await assert.rejects(pendingSave(db,cross),/沒有修改權限/);
 const unlinkedEvent=other.maintenance_event_ids[0];await db.query("update maintenance_events set status='voided' where id=$1",[unlinkedEvent]);assert.equal((await pendingList(db,other.work_log.project_id)).items.length,0);
 await db.query("update maintenance_events set status='active',event_type='OTHER' where id=$1",[unlinkedEvent]);assert.equal((await pendingList(db,other.work_log.project_id)).items[0].can_complete,false);
 // Preserved notes include original whitespace, with no old-note backfill.
 const historical=await pendingSave(db,pendingPayload({project_name:'只有歷史備註（隔離）',log_date:'2026-10-01',maintenance_events:[{...sample().maintenance_events[0],inventory_category_id:null,inventory_item_id:null,notes:'一般說明'}]}));
 assert.equal((await pendingList(db,historical.work_log.project_id)).items.length,0);
 await db.query('update maintenance_events set notes=$1 where id=$2',['  原始備註\n ',historical.maintenance_event_ids[0]]);
 const old=await row(historical.maintenance_event_ids[0]);await pendingSave(db,pendingPayload({id:historical.work_log.id,row_version:historical.work_log.row_version,project_id:historical.work_log.project_id,project_name:historical.work_log.title,log_date:'2026-10-01',maintenance_events:[{...sample().maintenance_events[0],id:old.id,row_version:old.row_version,inventory_category_id:null,inventory_item_id:null,pending_content:'新填的事項'}]}));
 assert.equal((await row(old.id)).notes,'  原始備註\n ');assert.equal((await pendingList(db,historical.work_log.project_id)).items.length,1);
 // Existing construction pending resolver still uses the unchanged implementation.
 const constructionPayload=pendingPayload({project_name:'工程施工待辦回歸（隔離）',work_type:'工程施工',log_date:'2026-10-01',summary:'已配線\n待測試',completed_content:'已配線',pending_content:'待測試',maintenance_events:[]});
 const construction=await pendingSave(db,constructionPayload),constructionItems=(await callAsService(db,'pending_work_log_items_v1',[ids.actor,construction.work_log.project_id,'2026-10-02',null])).items;assert.equal(constructionItems.length,1);
 await pendingSave(db,{...constructionPayload,request_id:randomUUID(),project_id:construction.work_log.project_id,log_date:'2026-10-02',summary:'完成測試',completed_content:'完成測試',pending_content:'',resolved_pending_items:[constructionItems[0]]});
 assert.equal((await callAsService(db,'pending_work_log_items_v1',[ids.actor,construction.work_log.project_id,'2026-10-03',null])).items.length,0);
 const acl=(await db.query("select has_function_privilege('anon','pending_maintenance_items_v1(uuid,uuid,date,uuid)','execute') a,has_function_privilege('authenticated','save_work_log_workforce_v1(uuid,jsonb)','execute') b")).rows[0];assert.deepEqual(acl,{a:false,b:false});
 console.log('PASS maintenance pending: fields, historical notes, same-day/future/self, lineage, grouped completion/history, replay, stale rollback, permission denial/read-only, inactive service, linked deletion/revival guards, no unintended repair records, ACL.');
}catch(e){console.error(e.message);if(e.where)console.error(e.where);process.exitCode=1;}finally{await db.close();}
