import test from 'node:test';
import assert from 'node:assert/strict';
import {assignmentGroupingFixture} from './assignment-grouping-fixture.mjs';

test('persisted request identity survives authorized reads and individual completion',async()=>{
 const f=await assignmentGroupingFixture();
 const request=async(role,operation,payload)=>{
  const response=await f.gatewayHandler(new Request('http://isolated.invalid/inventory-gateway'+(operation?'':'?scope=dashboard'),{
   headers:{authorization:'Bearer isolated-admin-assignment-'+role,'content-type':'application/json'},
   ...(operation?{method:'POST',body:JSON.stringify({operation,payload})}:{})
  }));return {status:response.status,body:await response.json()};
 };
 try{
  const before=await request('admin');assert.equal(before.status,200);
  const assignments=before.body.dashboard.assignments;
  const batch=assignments.all_pending.filter(row=>row.assignment_request_id===f.records.shared.requestId);
  assert.equal(batch.length,2);assert.equal(new Set(batch.map(row=>row.assignee_user_id)).size,2);
  assert.equal(assignments.all_pending.filter(row=>row.instructions===batch[0].instructions).length,3);
  const worker=await request('A');assert.equal(worker.status,200);assert.equal('all_pending' in worker.body.dashboard.assignments,false);
  assert.equal(worker.body.dashboard.assignments.pending.filter(row=>row.assignment_request_id===f.records.shared.requestId).length,1);
  const [other,mine]=f.records.adminShared.rows;
  const denied=await request('B','complete_work_assignment',{id:other.id,row_version:other.row_version});assert.equal(denied.status,400);
  const done=await request('admin','complete_work_assignment',{id:mine.id,row_version:mine.row_version});assert.equal(done.status,201,JSON.stringify(done.body));
  const after=(await request('admin')).body.dashboard.assignments;
  assert.equal(after.all_pending.filter(row=>row.assignment_request_id===f.records.adminShared.requestId).length,1);
  assert.ok(after.all_pending.some(row=>row.id===other.id));assert.ok(!after.all_pending.some(row=>row.id===mine.id));
  assert.ok(after.completed.some(row=>row.id===mine.id&&row.assignment_request_id===f.records.adminShared.requestId));
  const exported=await request('admin','export_data',{resource:'assignments',scope:'all',columns:['project','assignee','creator','notes'],filters:{assignment_scope:'all'}});
  assert.equal(exported.status,200);assert.equal(exported.body.row_count,after.all_pending.length);
 }finally{await f.db.close();}
});
