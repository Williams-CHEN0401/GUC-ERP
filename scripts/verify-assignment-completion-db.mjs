// Explicit isolated PostgreSQL tests. Never reads production tokens or writes remote data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {assignmentDatabase,completionMigration} from './work-assignment-fixture.mjs';
import {ids,sql} from './worklog-save-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';
import {createWorklogTestServer} from './worklog-save-preview-server.mjs';

test('production audit constraint reproduces rollback; narrow migration fixes same assignment',async()=>{
 const db=await assignmentDatabase({completionFix:false});
 try{
  const project=(await db.query('select id from projects limit 1')).rows[0].id;
  const a=await callAsService(db,'create_work_assignment_v1',[project,ids.viewer,'pickup','重現正式稽核限制',ids.item,2,ids.actor,'fixture-admin']);
  const count=async table=>(await db.query('select count(*)::int n from '+table)).rows[0].n;
  const before={pickups:await count('pickup_records'),audit:await count('audit_logs')};
  await assert.rejects(()=>callAsService(db,'complete_work_assignment_v1',[a.id,a.row_version,ids.viewer,'fixture-viewer']),e=>e.code==='23514'&&e.message.includes('audit_logs_action_check'));
  const unchanged=(await db.query('select status,row_version,completed_at from work_assignments where id=$1',[a.id])).rows[0];
  assert.deepEqual(unchanged,{status:'pending',row_version:a.row_version,completed_at:null});
  assert.equal(await count('pickup_records'),before.pickups);assert.equal(await count('audit_logs'),before.audit);
  await db.exec(await sql(completionMigration));
  const completed=await callAsService(db,'complete_work_assignment_v1',[a.id,a.row_version,ids.viewer,'fixture-viewer']);
  assert.equal(completed.assignment.status,'completed');assert.equal(completed.pickup.work_assignment_id,a.id);
  assert.equal(await count('pickup_records'),before.pickups+1);assert.equal(await count('audit_logs'),before.audit+1);
  assert.equal((await db.query("select action from audit_logs where entity_id=$1 and after_data->>'status'='completed'",[a.id])).rows[0].action,'update');
  const replay=await callAsService(db,'complete_work_assignment_v1',[a.id,a.row_version,ids.viewer,'fixture-viewer']);
  assert.equal(replay.pickup.id,completed.pickup.id);assert.equal(await count('pickup_records'),before.pickups+1);assert.equal(await count('audit_logs'),before.audit+1);
  const acl=(await db.query("select prosecdef,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service from pg_proc where proname='complete_work_assignment_v1'")).rows[0];
  assert.deepEqual(acl,{prosecdef:true,anon:false,authenticated:false,service:true});
 }finally{await db.close();}
});

test('creator and assignee Gateway -> actual RPC -> creator dashboard -> acknowledgement',async t=>{
 const {server,db,currentUser}=await createWorklogTestServer({assignments:true});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port+'/api/inventory';
 const actAs=(id,role)=>Object.assign(currentUser,{id,role,username:'fixture-'+role,permissions:[{module:'dashboard',can_view:true}]});
 const post=async(operation,payload)=>{const r=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,payload})});return{status:r.status,...await r.json()};};
 const dashboard=async()=>{const r=await fetch(base+'?scope=dashboard');assert.equal(r.status,200);return(await r.json()).dashboard;};
 let a,completed;
 try{
  await t.test('admin creates for another account; assignee sees pending, creator does not',async()=>{
   const project=(await db.query('select id from projects limit 1')).rows[0].id;
   const r=await post('create_work_assignment',{project_id:project,assignee_user_id:ids.viewer,assignment_type:'general',instructions:'雙帳號完成通知'});
   assert.equal(r.status,201,JSON.stringify(r));a=r.result;
   assert.equal((await dashboard()).assignments.pending.length,0);
   actAs(ids.viewer,'viewer');assert.equal((await dashboard()).assignments.pending[0].id,a.id);
  });
  await t.test('unrelated actor, stale version and inactive assignee cannot complete',async()=>{
   actAs(ids.scoped,'scoped');assert.notEqual((await post('complete_work_assignment',{id:a.id,row_version:a.row_version,actor_user_id:ids.actor})).status,201);
   actAs(ids.viewer,'viewer');assert.notEqual((await post('complete_work_assignment',{id:a.id,row_version:999})).status,201);
   await db.query('update app_users set is_active=false where id=$1',[ids.viewer]);
   assert.notEqual((await post('complete_work_assignment',{id:a.id,row_version:a.row_version})).status,201);
   await db.query('update app_users set is_active=true where id=$1',[ids.viewer]);
   assert.equal((await dashboard()).assignments.pending[0].id,a.id);
  });
  await t.test('assignee without project-update permission completes; no general-work pickup created',async()=>{
   const r=await post('complete_work_assignment',{id:a.id,row_version:a.row_version});assert.equal(r.status,201,JSON.stringify(r));completed=r.result.assignment;
   assert.equal(completed.status,'completed');assert.ok(completed.completed_at);assert.equal(r.result.pickup,null);
   assert.equal((await dashboard()).assignments.pending.length,0);assert.equal((await dashboard()).assignments.completed.length,0);
   assert.equal((await db.query('select count(*)::int n from pickup_records')).rows[0].n,0);
  });
  await t.test('creator reread shows completed notice with assignee, timestamp and project; outsider sees none',async()=>{
   actAs(ids.actor,'admin');const notices=(await dashboard()).assignments.completed;
   assert.equal(notices.length,1);assert.equal(notices[0].id,a.id);assert.ok(notices[0].completed_at);assert.ok(notices[0].project);assert.equal(notices[0].assignee,'隔離測試員-viewer');
   actAs(ids.scoped,'scoped');assert.equal((await dashboard()).assignments.completed.length,0);
   assert.notEqual((await post('acknowledge_work_assignment',{id:a.id,row_version:completed.row_version})).status,201);
  });
  await t.test('only creator/admin acknowledges; notice stays gone on repeat reread',async()=>{
   actAs(ids.viewer,'viewer');assert.notEqual((await post('acknowledge_work_assignment',{id:a.id,row_version:completed.row_version})).status,201);
   actAs(ids.actor,'admin');assert.equal((await dashboard()).assignments.completed.length,1);
   assert.equal((await post('acknowledge_work_assignment',{id:a.id,row_version:completed.row_version})).status,201);
   assert.equal((await dashboard()).assignments.completed.length,0);assert.equal((await dashboard()).assignments.completed.length,0);
  });
  await t.test('cancelled assignments remain cancelled',async()=>{
   const r=await post('create_work_assignment',{project_id:a.project_id,assignee_user_id:ids.viewer,assignment_type:'general',instructions:'取消案例'});assert.equal(r.status,201);
   await db.query("update work_assignments set status='cancelled' where id=$1",[r.result.id]);
   actAs(ids.viewer,'viewer');assert.notEqual((await post('complete_work_assignment',{id:r.result.id,row_version:r.result.row_version})).status,201);
   assert.equal((await db.query('select status from work_assignments where id=$1',[r.result.id])).rows[0].status,'cancelled');
  });
 }finally{await new Promise(resolve=>server.close(resolve));await db.close();}
});
