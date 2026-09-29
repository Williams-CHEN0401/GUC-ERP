import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {independentRepairsServer,independentRepairsMigration} from './independent-repairs-fixture.mjs';
import {ids,sql,sample} from './worklog-save-fixture.mjs';
import {extraIds} from './department-cross-system-fixture.mjs';
import {secondItem} from './pickup-notes-fixture.mjs';
const {server,db,snapshot,currentUser,calls,failures,historical,historicalPayload}=await independentRepairsServer({fixed:false});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port+'/api/inventory';
const send=async(operation,payload)=>{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,payload})});return {status:r.status,body:await r.json()};};
const save=p=>send('upsert_customer_project_work_log',p);
const valid=r=>{assert.equal(r.status,201,JSON.stringify({body:r.body,lastSqlFailure:failures.at(-1)}));return r.body;};
const row=async(table,id)=>(await db.query('select * from '+table+' where id=$1',[id])).rows[0];
const state=async()=>JSON.stringify((await db.query("select jsonb_build_object('logs',(select jsonb_agg(t order by id) from site_work_logs t),'projects',(select jsonb_agg(t order by id) from projects t),'repairs',(select jsonb_agg(t order by id) from repair_items t),'events',(select jsonb_agg(t order by id) from maintenance_events t),'audit',(select jsonb_agg(t order by id) from audit_logs t),'requests',(select jsonb_agg(t order by request_id) from work_log_save_requests t)) s")).rows[0].s);
const security=async()=>(await db.query("select oid,proname,prosecdef,proconfig,proacl,pg_get_function_identity_arguments(oid) args from pg_proc where proname in ('upsert_customer_project_work_log_v3','upsert_work_log_with_department_v1','upsert_customer_project_work_log_with_maintenance_v1') order by proname")).rows;
const rejected=async(operation,payload)=>{const before=await state();assert.ok((await send(operation,payload)).status>=400);assert.equal(await state(),before,'rejection must be atomic');};
try{
  let snap=await snapshot('worklogs');
  const initialEvent=snap.maintenance_events.find(e=>e.work_log_id===historical.work_log.id);
  const initialRepair=snap.repair_items.find(r=>r.source_maintenance_event_id===initialEvent.id);
  assert.ok(initialRepair);
  const edit=async(patch={})=>{const s=await snapshot('worklogs'),log=s.site_work_logs.find(l=>l.id===historical.work_log.id),project=s.projects.find(p=>p.id===log.project_id),event=s.maintenance_events.find(e=>e.id===initialEvent.id);return {...historicalPayload,id:log.id,row_version:log.row_version,project_id:project.id,project_name:project.name,customer_id:project.customer_id,department_id:log.department_id||project.department_id,log_date:log.log_date,request_id:randomUUID(),maintenance_events:[{...historicalPayload.maintenance_events[0],...event}],...patch};};
  // Reproduce the actual old rejection before applying the exact new migration.
  const move=await edit({project_id:null,customer_id:extraIds.otherCustomer,department_id:extraIds.otherDepartment,project_name:'獨立修改後的工作'});
  const broken=await save(move);assert.ok(broken.status>=400);assert.match(failures.at(-1)?.message||JSON.stringify(broken.body),/維修品/);
  const beforeMigration=await state(),acl=await security();
  await db.exec(await sql(independentRepairsMigration));
  assert.equal(await state(),beforeMigration,'migration must not rewrite existing records');assert.deepEqual(await security(),acl);
  const sourceBefore=await row('projects',historical.project.id),repairBefore=await row('repair_items',initialRepair.id);
  valid(await save(move));
  assert.deepEqual(await row('repair_items',initialRepair.id),repairBefore,'log customer move must not touch repair');
  assert.deepEqual(await row('projects',historical.project.id),sourceBefore,'original work remains unchanged');
  const replay=await state();valid(await save(move));assert.equal(await state(),replay);await rejected('upsert_customer_project_work_log',{...move,project_name:'changed payload'});
  await rejected('upsert_customer_project_work_log',{...move,request_id:randomUUID()});
  // Maintenance department path used to compare against the source repair too.
  const department=await edit({work_type:'維護保養'});valid(await save(department));
  const itemEdit=await edit({log_date:'2026-09-29'});itemEdit.maintenance_events[0]={...itemEdit.maintenance_events[0],inventory_item_id:secondItem,occurred_at:'2026-09-29',cause:'獨立故障內容',handling_process:'獨立處理流程',notes:'日誌自己的備註'};
  valid(await save(itemEdit));assert.deepEqual(await row('repair_items',initialRepair.id),repairBefore,'date/item/content must not overwrite repair');
  const eventAfter=await row('maintenance_events',initialEvent.id);assert.equal(eventAfter.inventory_item_id,secondItem);assert.equal(eventAfter.handling_process,'獨立處理流程');
  const logBefore=await row('site_work_logs',historical.work_log.id),projectsBefore=(await db.query('select * from projects order by id')).rows;
  const repairPayload={id:initialRepair.id,row_version:initialRepair.row_version,received_on:'2026-09-20',customer_id:ids.customer,department_id:extraIds.secondDepartment,inventory_item_id:secondItem,quantity:2,serial_number:'ISOLATED-SERIAL',issue_description:'維修品獨立故障',status:'received',notes:'維修品自己的備註'};
  valid(await send('upsert_repair_item',repairPayload));
  const repaired=await row('repair_items',initialRepair.id);assert.equal(repaired.source_maintenance_event_id,initialEvent.id);assert.equal(repaired.department_id,extraIds.secondDepartment);assert.equal(Number(repaired.quantity),2);assert.equal(repaired.notes,repairPayload.notes);
  assert.deepEqual(await row('site_work_logs',historical.work_log.id),logBefore);assert.deepEqual(await row('maintenance_events',initialEvent.id),eventAfter);assert.deepEqual((await db.query('select * from projects order by id')).rows,projectsBefore);
  // Ordinary saves must still succeed AFTER repair ownership diverges.
  valid(await save(await edit({work_type:'維護保養'})));assert.deepEqual(await row('repair_items',initialRepair.id),repaired);
  const dateOnly=await edit({log_date:'2026-09-30',maintenance_events:[]});valid(await save(dateOnly));assert.deepEqual(await row('repair_items',initialRepair.id),repaired);
  // Two departments on the same customer must be independent too.
  valid(await save(await edit({project_id:null,customer_id:ids.customer,department_id:ids.department,project_name:'科室獨立工作',work_type:'維護保養'})));
  const sameCustomer=await edit({department_id:extraIds.secondDepartment,work_type:'維護保養'});valid(await save(sameCustomer));assert.deepEqual(await row('repair_items',initialRepair.id),repaired);
  await rejected('upsert_customer_project_work_log',await edit({department_id:extraIds.otherDepartment}));
  await rejected('upsert_repair_item',{...repairPayload,row_version:repaired.row_version,department_id:extraIds.otherDepartment});
  await rejected('upsert_repair_item',repairPayload);
  const badItem=await edit();badItem.maintenance_events[0].inventory_category_id=randomUUID();await rejected('upsert_customer_project_work_log',badItem);
  const badEvent=await edit();badEvent.maintenance_events[0].row_version=1;await rejected('upsert_customer_project_work_log',badEvent);
  currentUser.role='viewer';const called=calls.length;assert.equal((await save(await edit())).status,403);assert.equal((await send('upsert_repair_item',{...repairPayload,row_version:repaired.row_version})).status,403);assert.equal(calls.length,called);currentUser.role='admin';
  // Verify actual equipment and attachment ownership protections remain intact.
  const equipment=randomUUID();await db.query("insert into equipment_registry(id,customer_id,service_id,status) values($1,$2,$3,'active')",[equipment,ids.customer,ids.service]);
  await db.query('insert into maintenance_event_equipment(event_id,equipment_id) values($1,$2)',[initialEvent.id,equipment]);
  const blocked=await save(await edit({project_id:null,customer_id:extraIds.otherCustomer,department_id:extraIds.otherDepartment,project_name:'禁止移動設備'}));assert.ok(blocked.status>=400);
  await db.query('delete from maintenance_event_equipment where event_id=$1',[initialEvent.id]);
  await db.query('insert into site_assets(id,project_id,work_log_id) values($1,$2,$3)',[randomUUID(),(await row('site_work_logs',historical.work_log.id)).project_id,historical.work_log.id]);
  await rejected('upsert_customer_project_work_log',await edit({project_id:null,customer_id:extraIds.otherCustomer,department_id:extraIds.otherDepartment,project_name:'禁止移動附件'}));
  const repairCount=(await db.query('select count(*) n from repair_items')).rows[0].n;valid(await save({...sample(),project_name:'新日誌不自動建立維修品'}));assert.equal((await db.query('select count(*) n from repair_items')).rows[0].n,repairCount);
  console.log('PASS: reproduced legacy failure; migration data/ACL/OID preservation; customer/department/item/date/content independence both directions; source link retained; replay/stale/atomic rejection; viewer denied; equipment/attachment guards; no automatic repair creation.');
}finally{await new Promise(resolve=>server.close(resolve));await db.close();}
