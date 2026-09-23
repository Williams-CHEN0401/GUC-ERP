import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {independentDatabase,seedIndependent,createPickups,updatePickup} from './independent-work-fixture.mjs';
import {saveLog,ids} from './worklog-save-fixture.mjs';
import {extraIds} from './department-cross-system-fixture.mjs';
// Demonstrate both previous guards before testing the fix.
for(const fixed of [false,true]){
 const db=await independentDatabase({fixed});
 const row=async(table,id)=>(await db.query(`select to_jsonb(t) data from ${table} t where id=$1`,[id])).rows[0].data;
 try{
  const {a,b,sibling,base}=await seedIndependent(db);
  const pickups=(await db.query('select to_jsonb(p) data from pickup_records p where work_log_id=$1 order by pickup_date',[a.work_log.id])).rows.map(x=>x.data);
  const [p,q]=pickups;
  const move={...base,id:a.work_log.id,row_version:a.work_log.row_version,project_id:b.project.id,project_name:b.project.name,request_id:randomUUID()};
  if(!fixed){
   await assert.rejects(updatePickup(db,p,b.project.id),/此取貨已關聯工作日誌/);
   await assert.rejects(saveLog(db,{...move,work_type:'場勘'}),/取貨或歷史附件/);
   console.log('REPRODUCED: production pickup and log reassignment guards');continue;
  }
  const beforeProjects=(await db.query('select to_jsonb(p) data from projects p order by id')).rows;
  const otherBefore=await row('site_work_logs',sibling.work_log.id);
  const logBefore=await row('site_work_logs',a.work_log.id);
  const same=await updatePickup(db,p);assert.equal(same.work_log_id,p.work_log_id);
  const moved=await updatePickup(db,same,b.project.id);
  assert.equal(moved.project_id,b.project.id);assert.equal(moved.work_log_id,null);
  for(const key of ['quantity','pickup_date','inventory_item_id','request_id','request_row','created_by_user_id','work_assignment_id'])assert.deepEqual(moved[key],p[key],key+' unchanged');
  assert.deepEqual(await row('site_work_logs',a.work_log.id),logBefore,'pickup move cannot alter log');
  assert.deepEqual(await row('pickup_records',q.id),q,'sibling pickup unchanged');
  await assert.rejects(updatePickup(db,same,a.project.id),/其他使用者更新/);
  await assert.rejects(updatePickup(db,moved,randomUUID()),/找不到指定/);
  await assert.rejects(updatePickup(db,moved,a.project.id,{quantity:0}),/大於 0/);
  assert.deepEqual(await row('pickup_records',p.id),moved,'invalid edit rolled back');
  const beforeQ=await row('pickup_records',q.id);
  await assert.rejects(saveLog(db,{...move,maintenance_events:[{}]}),/維修事件/);
  assert.deepEqual(await row('pickup_records',q.id),beforeQ,'failed maintenance validation rolls detach back');
  assert.deepEqual(await row('site_work_logs',a.work_log.id),logBefore,'failed log save rolled back');
  const saved=await saveLog(db,move);
  assert.equal(saved.work_log.project_id,b.project.id);assert.equal(saved.work_log.work_type,'工程施工','daily type is independent');
  const detached=await row('pickup_records',q.id);
  assert.equal(detached.work_log_id,null);assert.equal(detached.project_id,a.project.id);assert.equal(detached.quantity,q.quantity);assert.equal(detached.row_version,q.row_version+1);
  assert.deepEqual(await row('pickup_records',p.id),moved,'already independent pickup unchanged');
  assert.deepEqual(await row('site_work_logs',sibling.work_log.id),otherBefore,'other log untouched');
  assert.deepEqual((await db.query('select to_jsonb(p) data from projects p order by id')).rows,beforeProjects,'shared projects untouched');
  assert.equal((await db.query('select sum(quantity)::integer n from pickup_records')).rows[0].n,6,'total picked stock unchanged');
  assert.deepEqual(await saveLog(db,move),saved,'log retry is idempotent');
  await assert.rejects(saveLog(db,{...move,request_id:randomUUID()}),/其他使用者更新/);
  await assert.rejects(createPickups(db,a,[2,3],q.request_id),/不相符|識別碼/);
  assert.equal((await db.query('select count(*)::integer n from pickup_records')).rows[0].n,3,'retry cannot duplicate pickups');
  const ordinary={...base,id:sibling.work_log.id,row_version:sibling.work_log.row_version,project_id:a.project.id,project_name:a.project.name,request_id:randomUUID(),summary:'僅修改摘要'};
  await saveLog(db,ordinary);
  assert.equal((await db.query('select work_log_id from pickup_records where work_log_id=$1',[sibling.work_log.id])).rows.length,1,'same-work save retains association');
  await assert.rejects(saveLog(db,{...move,request_id:randomUUID()},ids.viewer),/權限/);
  const fresh=await row('site_work_logs',a.work_log.id),back={...move,request_id:randomUUID(),row_version:fresh.row_version,project_id:a.project.id,project_name:a.project.name};
  await db.query('insert into project_workers(project_id,user_id,can_view,can_create_work_log,can_update_work_log) values($1,$3,true,true,true),($2,$3,true,true,true)',[a.project.id,b.project.id,ids.scoped]);
  await assert.rejects(saveLog(db,back,ids.scoped),/歸屬的權限/);
  const cross=await saveLog(db,{...base,request_id:randomUUID(),project_name:'其他科室',department_id:extraIds.secondDepartment});
  await assert.rejects(saveLog(db,{...back,project_id:cross.project.id,project_name:cross.project.name,department_id:extraIds.secondDepartment}),/同一科室/);
  const asset=randomUUID();await db.query('insert into site_assets(id,project_id,work_log_id) values($1,$2,$3)',[asset,b.project.id,a.work_log.id]);
  await assert.rejects(saveLog(db,back),/歷史附件/);
  assert.equal((await row('site_assets',asset)).project_id,b.project.id);
  assert.ok((await db.query("select 1 from audit_logs where entity_id=$1 and before_data->>'work_log_id' is not null and after_data->>'work_log_id' is null",[q.id])).rows.length,'detach is audited');
  for(const role of ['anon','authenticated'])assert.equal((await db.query("select count(*)::int n from pg_proc where pronamespace='public'::regnamespace and proname in ('update_pickup_record','create_pickup_records_batch_v2','upsert_customer_project_work_log_v3') and has_function_privilege($1,oid,'execute')",[role])).rows[0].n,0);
  console.log('PASS: independent moves in both directions; same-work links; stock/other rows unchanged; daily type; audit/version/rollback/retry/role/department/attachment guards; service-only ACLs.');
 }catch(error){console.error(error.message,error.where||'');process.exitCode=1;}finally{await db.close();}
}
