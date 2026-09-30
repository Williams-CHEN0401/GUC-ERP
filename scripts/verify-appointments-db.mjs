import assert from 'node:assert/strict';
import {appointmentsServer} from './appointments-fixture.mjs';
import {callAsService,extraIds} from './department-cross-system-fixture.mjs';
import {ids} from './worklog-save-fixture.mjs';
import {syncOperatorId} from './form-sync-fixture.mjs';
const {db,gatewayHandler,gatewayContext,historical}=await appointmentsServer();
const save=(row={},actor=ids.actor)=>callAsService(db,'upsert_customer_appointment_v1',[row.id||null,row.row_version||null,ids.customer,row.department_id||ids.department,row.appointment_type||'repair','2026-10-01','聯絡人','07-0000000',row.instructions||'預約測試',row.assignee_user_id||syncOperatorId,row.status||'pending','備註',actor,'fixture-admin']);
const read=async id=>(await db.query('select * from work_assignments where id=$1',[id])).rows[0];
try{
 let row=await save();assert.equal(row.assignment_type,'appointment');assert.equal(row.project_id,null);
 await assert.rejects(save({department_id:extraIds.otherDepartment}),/科室/);
 await assert.rejects(save({},syncOperatorId),/管理員/);await assert.rejects(save({},ids.viewer),/管理員/);
 const updated=await save({...row,status:'in_progress'});await assert.rejects(save({...row,status:'cancelled'}),/已被更新/);
 // Existing completion RPC enforces assignee ID independently of UI filtering.
 await assert.rejects(callAsService(db,'complete_work_assignment_v1',[row.id,updated.row_version,ids.scoped,'fixture-scoped']),/責任人/);
 await callAsService(db,'complete_work_assignment_v1',[row.id,updated.row_version,syncOperatorId,'fixture-operator']);assert.equal((await read(row.id)).status,'completed');
 row=await save({...await read(row.id),status:'pending',assignee_user_id:ids.actor});
 gatewayContext.currentUser=async()=>({id:syncOperatorId,username:'fixture-operator',display_name:'B',role:'operator',is_active:true});
 let response=await gatewayHandler(new Request('http://127.0.0.1/inventory-gateway?scope=appointments'));assert.equal(response.status,200);assert.equal((await response.json()).customer_appointments.length,0,'old assignee loses access after reassignment');
 response=await gatewayHandler(new Request('http://127.0.0.1/inventory-gateway',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'upsert_customer_appointment',payload:{...row,status:'cancelled'}})}));assert.notEqual(response.status,201);
 row=await save({...row,status:'cancelled'});await assert.rejects(callAsService(db,'complete_work_assignment_v1',[row.id,row.row_version,ids.actor,'fixture-admin']),/取消/);
 for(const type of ['general','pickup']){
   const created=await callAsService(db,'create_work_assignment_v1',[historical.work_log.project_id,syncOperatorId,type,'既有指派回歸',type==='pickup'?ids.item:null,type==='pickup'?2:null,ids.actor,'fixture-admin']);
   const assignment=created.assignment||created;assert.ok(assignment.id);const result=await callAsService(db,'complete_work_assignment_v1',[assignment.id,assignment.row_version,syncOperatorId,'fixture-operator']);assert.equal(result.assignment.status,'completed');
   if(type==='pickup')assert.equal((await db.query('select count(*)::int n from pickup_records where work_assignment_id=$1',[assignment.id])).rows[0].n,1);
 }
 await db.exec('set role authenticated');await assert.rejects(db.query("select upsert_customer_appointment_v1(null,null,null,null,'repair',current_date,'','','x',null,'pending','',null,'')"),/permission denied/);await db.exec('reset role');
 console.log('PASS appointment DB/Gateway: admin-only mutations, own-assignment visibility, reassignment, wrong department, stale version, non-assignee completion denial, cancellation, service-only ACL; existing general/pickup completion unaffected.');
}finally{await db.close();}
