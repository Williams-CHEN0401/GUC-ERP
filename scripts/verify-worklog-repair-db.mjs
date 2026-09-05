// Isolated PostgreSQL-WASM test; never connects to a remote database.
// Install @electric-sql/pglite@0.3.14 in a temporary directory and set PGLITE_MODULE
// to its dist/index.js file URL, or install that exact version in your test environment.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
try {
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create table customers(id uuid primary key);
create table suppliers(id uuid primary key);
create table product_categories(id uuid primary key,is_active boolean);
create table inventory_items(id uuid primary key,category_id uuid references product_categories);
create table site_work_logs(id uuid primary key,summary text);
create table maintenance_events(id uuid primary key default gen_random_uuid(),work_log_id uuid not null references site_work_logs,
service_id uuid not null,event_type text,occurred_at date,description text,cause text,result text,notes text,
created_by uuid,updated_by uuid,created_at timestamptz default now(),updated_at timestamptz default now(),row_version integer default 1,status text default 'active');
create table maintenance_event_equipment(event_id uuid references maintenance_events,equipment_id uuid,primary key(event_id,equipment_id));
create table maintenance_event_workers(event_id uuid references maintenance_events,user_id uuid,primary key(event_id,user_id));
create table customer_contract_services(customer_id uuid,service_type_id uuid);
create table equipment_registry(id uuid primary key,customer_id uuid,service_id uuid,status text,source_table text,source_id uuid);
create table app_users(id uuid primary key,is_active boolean,display_name text);
create table audit_logs(entity_type text,entity_id uuid,action text,before_data jsonb,after_data jsonb,source text,actor text);
-- Only the pre-existing project/work-log writer is stubbed. All changed SQL and repair RPCs are real.
create function public.upsert_customer_project_work_log_v3(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,text)
returns jsonb language plpgsql as $$ declare v_id uuid:=coalesce($1,gen_random_uuid()); begin
insert into public.site_work_logs values(v_id,$8) on conflict(id) do update set summary=excluded.summary;
return jsonb_build_object('work_log',jsonb_build_object('id',v_id)); end; $$;
create function public.test_event_version() returns trigger language plpgsql as $$
begin new.row_version=old.row_version+1; return new; end; $$;
create trigger test_event_version before update on maintenance_events for each row execute function public.test_event_version();
`);
const readMigration=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
await db.exec(await readMigration('20260903090000_repair_item_management.sql'));
await db.exec(await readMigration('20260905072428_optional_worklog_equipment.sql'));
const customer=randomUUID(),service=randomUUID(),actor=randomUUID(),equipment=randomUUID(),category=randomUUID(),otherCategory=randomUUID(),item=randomUUID();
await db.query('insert into customers values($1)',[customer]);
await db.query('insert into product_categories values($1,true),($2,true)',[category,otherCategory]);
await db.query('insert into inventory_items values($1,$2)',[item,category]);
await db.query('insert into customer_contract_services values($1,$2)',[customer,service]);
await db.query("insert into app_users values($1,true,'測試員')",[actor]);
await db.query("insert into equipment_registry values($1,$2,$3,'active','site_devices',$1)",[equipment,customer,service]);
const statement=`select public.upsert_customer_project_work_log_with_maintenance_v2($4,null,null,$1,'測試','2026-09-05','維修紀錄',$6,'','in_progress',array[$2::uuid],$2,$3::jsonb,'test',$5) result`;
const event=(equipmentIds=[],withItem=false)=>({event_type:'REPAIR',service_id:service,occurred_at:'2026-09-05',description:'檢查',result:'完成檢查',notes:'測試備註',equipment_ids:equipmentIds,worker_user_ids:[],inventory_category_id:withItem?category:null,inventory_item_id:withItem?item:null});
const save=async(events,{id=null,key=randomUUID(),summary='檢查'}={})=>(await db.query(statement,[customer,actor,JSON.stringify(events),id,key,summary])).rows[0].result;
const rows=async table=>(await db.query('select * from '+table)).rows;
const counts=async()=>Object.fromEntries(await Promise.all(['site_work_logs','maintenance_events','maintenance_event_equipment','maintenance_event_workers','repair_items','audit_logs','work_log_save_requests'].map(async table=>[table,(await rows(table)).length])));
const unchangedAfterFailure=async(work,error)=>{
  const before=await counts();await assert.rejects(work(),error);assert.deepEqual(await counts(),before);
};
// Seed all deprecated classifications using the previously released RPC.
await db.exec("alter table maintenance_events add constraint maintenance_events_type_check check(event_type in ('INSTALLATION','MAINTENANCE','REPAIR','REPLACEMENT','SOFTWARE_CONFIG','PROGRAM_CONFIG','INSPECTION','OTHER'))");
const oldTypes=['INSTALLATION','MAINTENANCE','PROGRAM_CONFIG','INSPECTION','OTHER'];
const oldEvents=[];
for(const type of oldTypes){
  const saved=await save([{...event(),event_type:type}]);
  oldEvents.push({type,id:saved.maintenance_event_ids[0],logId:saved.work_log.id});
}
const beforeTypeMigration=await rows('maintenance_events');
await db.exec(await readMigration('20260905081650_maintenance_event_types.sql'));
assert.deepEqual(await rows('maintenance_events'),beforeTypeMigration,'migration must not rewrite existing events');
for(const type of ['SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','REPAIR','REPLACEMENT']){
  const saved=await save([{...event([equipment]),event_type:type}]);
  assert.equal((await rows('maintenance_events')).find(row=>row.id===saved.maintenance_event_ids[0]).event_type,type);
}
for(const old of oldEvents){
  await save([{...event(),event_type:old.type,id:old.id,row_version:1}],{id:old.logId});
  assert.equal((await rows('maintenance_events')).find(row=>row.id===old.id).event_type,old.type);
  const differentOld=oldTypes.find(type=>type!==old.type);
  await unchangedAfterFailure(()=>save([{...event(),event_type:differentOld,id:old.id,row_version:2}],{id:old.logId}),/舊分類僅可保留/);
  await save([{...event(),event_type:'LINE_REPAIR',id:old.id,row_version:2}],{id:old.logId});
  await unchangedAfterFailure(()=>save([{...event(),event_type:old.type,id:old.id,row_version:3}],{id:old.logId}),/舊分類僅可保留/);
}
for(const type of oldTypes)await unchangedAfterFailure(()=>save([{...event(),event_type:type}]),/舊分類僅可保留/);
await unchangedAfterFailure(()=>save([{...event(),event_type:'UNKNOWN'}]),/類型/);
await assert.rejects(db.query("update maintenance_events set event_type='UNKNOWN' where id=$1",[oldEvents[0].id]),/maintenance_events_type_check/);
console.log('PASS five event types, migration preserves historical data, legacy retained only on original event, invalid writes roll back');
const noEvents=await save([]);
assert.equal(noEvents.maintenance_event_count,0);
for(const withEquipment of [false,true]){
  for(const withItem of [false,true]){
    const before=await counts(),saved=await save([event(withEquipment?[equipment]:[],withItem)]),after=await counts();
    assert.equal(after.site_work_logs-before.site_work_logs,1);
    assert.equal(after.maintenance_events-before.maintenance_events,1);
    assert.equal(after.maintenance_event_equipment-before.maintenance_event_equipment,Number(withEquipment));
    assert.equal(after.repair_items-before.repair_items,Number(withItem));
    assert.equal(saved.created_repair_item_ids.length,Number(withItem));
    if(withItem){
      const repair=(await rows('repair_items')).find(row=>row.id===saved.created_repair_item_ids[0]);
      assert.equal(repair.customer_id,customer);assert.equal(repair.inventory_item_id,item);assert.equal(repair.notes,'測試備註');
      for(const field of ['received_on','quantity','status','issue_description','supplier_id','serial_number','sent_to_supplier_on','returned_from_supplier_on','returned_to_customer_on','supplier_reference'])assert.equal(repair[field],null,field);
    }
  }
}
console.log('PASS four independent equipment/item branches, no-event log, known mapping and unknown NULLs');
const categoryOnly=await save([{...event(),inventory_category_id:category}]);
assert.deepEqual(categoryOnly.created_repair_item_ids,[]);
await unchangedAfterFailure(()=>save([{...event([],true),inventory_category_id:otherCategory}]),/不屬於所選設備種類/);
await unchangedAfterFailure(()=>save([{...event([],true),inventory_category_id:null}]),/不屬於所選設備種類/);
await unchangedAfterFailure(()=>save([event([randomUUID()],true)]),/不屬於所選客戶/);
await unchangedAfterFailure(()=>save([{...event([],true),worker_user_ids:[randomUUID()]}]),/處理人員不存在/);
// Inject an actual late failure after the log/event writes, then retry the same request after fixing it.
await db.exec("create function public.test_repair_failure() returns trigger language plpgsql as $$ begin raise exception 'injected repair failure'; end; $$; create trigger test_repair_failure before insert on repair_items for each row execute function public.test_repair_failure();");
const retryKey=randomUUID();
await unchangedAfterFailure(()=>save([event([],true)],{key:retryKey}),/injected repair failure/);
await db.exec('drop trigger test_repair_failure on repair_items');
const retryResult=await save([event([],true)],{key:retryKey}),beforeRepeat=await counts();
assert.deepEqual(await save([event([],true)],{key:retryKey}),retryResult);
assert.deepEqual(await counts(),beforeRepeat);
await unchangedAfterFailure(()=>save([event([],true)],{key:retryKey,summary:'不同內容'}),/識別碼已使用/);
console.log('PASS invalid category/equipment/worker rollback, injected late failure rollback, identical retry deduplication');

// Completing an auto-created repair uses the unchanged existing manual repair RPC.
const repairId=retryResult.created_repair_item_ids[0],eventId=retryResult.maintenance_event_ids[0],logId=retryResult.work_log.id;
await db.query(`select public.upsert_repair_item_v1($1,1,'2026-09-05',$2,$3,2,'序號','人工故障說明',null,null,null,null,'received',null,'人工備註','test')`,[repairId,customer,item]);
const completed=(await rows('repair_items')).find(row=>row.id===repairId);
assert.equal(completed.quantity,2);assert.equal(completed.row_version,2);
await save([{...event([],true),id:eventId,row_version:1,notes:'日誌備註修改'}],{id:logId});
assert.deepEqual((await rows('repair_items')).find(row=>row.id===repairId),completed,'log edits must not overwrite repairs');
// Older clients omit new keys and still preserve source selections.
const legacy={...event(),id:eventId,row_version:2};delete legacy.inventory_category_id;delete legacy.inventory_item_id;
await save([legacy],{id:logId});
assert.equal((await rows('maintenance_events')).find(row=>row.id===eventId).inventory_item_id,item);
await unchangedAfterFailure(()=>save([{...event(),id:eventId,row_version:3}],{id:logId}),/已登錄維修品/);
// Deleting a repair in its existing flow must not resurrect it on future work-log saves.
await db.query("select public.delete_repair_item_v1($1,2,'test')",[repairId]);
await save([{...event([],true),id:eventId,row_version:3}],{id:logId});
assert.equal((await rows('repair_items')).some(row=>row.source_maintenance_event_id===eventId),false);
await unchangedAfterFailure(()=>save([{...event([],true),id:eventId,row_version:1}],{id:logId}),/其他使用者更新/);
// A previously item-less event can be registered later, exactly once.
const laterEvent=(await rows('maintenance_events')).find(row=>row.work_log_id===categoryOnly.work_log.id);
const later=await save([{...event([],true),id:laterEvent.id,row_version:1}],{id:laterEvent.work_log_id});
assert.equal(later.created_repair_item_ids.length,1);
console.log('PASS existing manual completion, edit preservation, legacy compatibility, stale-version rollback and no resurrection');

// Missing mandatory fields stay forbidden for ordinary manually-created repairs.
await assert.rejects(db.query("select public.upsert_repair_item_v1(null,null,null,$1,$2,null,null,null,null,null,null,null,null,null,null,'test')",[customer,item]),/完整填寫/);
await assert.rejects(db.query("insert into repair_items(customer_id,inventory_item_id,received_on,quantity,status,issue_description,updated_by) values($1,$2,null,null,null,null,'test')",[customer,item]),/repair_items_manual_required_fields/);
for(const role of ['anon','authenticated']){
  for(const signature of [
    'upsert_customer_project_work_log_with_maintenance_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text)',
    'upsert_customer_project_work_log_with_maintenance_v2(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid)'
  ])assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,'public.'+signature])).rows[0].allowed,false);
  for(const table of ['repair_items','work_log_save_requests']){
    assert.equal((await db.query("select has_table_privilege($1,$2,'SELECT') allowed",[role,'public.'+table])).rows[0].allowed,false);
  }
}
assert.equal((await db.query("select relrowsecurity and relforcerowsecurity secured from pg_class where oid='public.work_log_save_requests'::regclass")).rows[0].secured,true);
console.log('PASS normal repair validation, RPC/table least privilege and forced RLS');
// Run the actual shared equipment-history query, with its existing registry lookup function.
const historyMigration=await readMigration('20260904120000_equipment_maintenance_history.sql');
const historySql=historyMigration.slice(historyMigration.indexOf('create or replace function public.get_equipment_history_v1'),historyMigration.indexOf('revoke all on function public.get_equipment_history_v1'));
await db.exec(historySql);
const history=(await db.query("select public.get_equipment_history_v1('site_devices',$1) result",[equipment])).rows[0].result;
const serialized=JSON.stringify(history);
for(const row of await rows('maintenance_events')){
  if(!(await rows('maintenance_event_equipment')).some(link=>link.event_id===row.id))assert.equal(serialized.includes(row.id),false);
}
assert.ok(serialized.includes(equipment));
console.log('PASS actual equipment-history RPC excludes all unlinked events');
} catch(error) {
  console.error(error.message, error.detail||'', error.where||'');
  process.exitCode=1;
} finally {await db.close();}
