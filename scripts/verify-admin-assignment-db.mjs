import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAssignmentFixture} from './admin-assignment-fixture.mjs';
import {ids} from './worklog-save-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';

test('administrator assignment visibility: real Gateway -> isolated PostgreSQL -> export and mutation boundaries',async t=>{
 const f=await adminAssignmentFixture(),{users,records}=f;
 const request=async(key,operation,payload,query='?scope=dashboard')=>{
  const response=await f.gatewayHandler(new Request('http://isolated.invalid/inventory-gateway'+(operation?'':query),{
   headers:{authorization:'Bearer isolated-admin-assignment-'+key,'content-type':'application/json'},
   ...(operation?{method:'POST',body:JSON.stringify({operation,payload})}:{})
  }));return {status:response.status,body:await response.json()};
 };
 const dashboard=async key=>{const r=await request(key);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.dashboard.assignments;};
 const exportRows=(key,assignment_scope,scope='filtered')=>request(key,'export_data',{resource:'assignments',scope,columns:['project','assignee','creator','type','status','notes'],filters:{assignment_scope}});
 try{
  await t.test('every admin sees all pending assignments regardless of creator, without changing personal lists or notifications',async()=>{
   for(const key of ['admin','admin2']){
    const data=await dashboard(key);
    assert.equal(data.all_pending.length,7);
    for(const name of ['own','other','otherCreator','pickup'])assert.ok(data.all_pending.some(row=>row.id===records[name].id),name);
    assert.ok(data.all_pending.some(row=>row.assignment_type==='appointment'&&row.instructions==='預約電話設備查修'));
    assert.equal(data.all_pending.some(row=>row.id===records.completed.id||row.id===records.cancelled.id),false);
    assert.equal(data.pending.length,key==='admin'?2:0);
    assert.equal(data.completed.length,key==='admin'?1:0);
    assert.ok(data.all_pending.filter(row=>row.assignment_type!=='construction').every(row=>row.assignee&&row.assignee!=='—'&&row.creator&&row.creator!=='—'));
   }
  });
  await t.test('construction plans retain all assignee names and personal action/ID shape',async()=>{
   const data=await dashboard('admin'),other=data.all_pending.find(row=>row.id==='construction:'+records.plan.id),own=data.pending.find(row=>row.id==='construction:'+records.ownPlan.id);
   assert.ok(other);assert.equal(other.assignee_user_ids.length,2);assert.match(other.assignee,/施工人員 A.*施工人員 B/);assert.ok(other.creator);assert.notEqual(other.creator,'—');
   assert.equal(data.pending.some(row=>row.id===other.id),false);
   assert.ok(own.assignee);assert.notEqual(own.assignee,'—');assert.equal(data.all_pending.find(row=>row.id===own.id).assignee,own.assignee);
  });
  await t.test('ordinary roles see only their own assignments and their existing notifications; username is not an admin exception',async()=>{
   for(const key of ['A','B','viewer']){
    const data=await dashboard(key);assert.equal(Object.hasOwn(data,'all_pending'),false);
    assert.ok(data.pending.every(row=>row.assignment_type==='construction'?row.assignee_user_ids.includes(users[key]):row.assignee_user_id===users[key]));
    assert.equal(data.completed.length,0);
   }
   const viewer=await request('viewer');assert.equal(viewer.body.current_user.username,'williams');assert.equal(viewer.body.current_user.role,'viewer');
   assert.equal((await request('unknown')).status,401);
  });
  await t.test('disabled assignee and creator names survive in authorized construction cards and exports',async()=>{
   await f.db.query('update construction_plans set created_by_user_id=$1 where id=$2',[users.admin2,records.plan.id]);
   await f.db.query('update app_users set is_active=false where id in ($1,$2)',[users.B,users.admin2]);
   try{
    const scope=await callAsService(f.db,'construction_scope_v1',[users.admin,null]);
    assert.equal(scope.site_workers.some(row=>[users.B,users.admin2].includes(row.id)),false);
    const admin=(await dashboard('admin')).all_pending.find(row=>row.id==='construction:'+records.plan.id);
    assert.match(admin.assignee,/施工人員 B/);assert.equal(admin.creator,'第二位管理員（隔離）');
    const mine=(await dashboard('A')).pending.find(row=>row.id===admin.id);assert.equal(mine.assignee,admin.assignee);assert.equal(mine.creator,admin.creator);
    const exported=await exportRows('admin','all');assert.equal(exported.status,200);assert.ok(exported.body.rows.some(row=>row[1]===admin.assignee&&row[2]===admin.creator));
    assert.equal((await dashboard('viewer')).pending.some(row=>row.id===admin.id),false);
    assert.equal((await request('B')).status,401);assert.equal((await request('admin2')).status,401);
   }finally{
    await f.db.query('update app_users set is_active=true where id in ($1,$2)',[users.B,users.admin2]);
    await f.db.query('update construction_plans set created_by_user_id=$1 where id=$2',[users.admin,records.plan.id]);
   }
  });
  await t.test('administrator all/mine export matches each displayed list, including when export scope is all',async()=>{
   for(const scope of ['filtered','all'])for(const [assignmentScope,expected] of [['all',7],['mine',2]]){
    const r=await exportRows('admin',assignmentScope,scope);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.row_count,expected);
    assert.ok(r.body.rows.every(row=>row[4]!=='已完成'));
    if(assignmentScope==='all')assert.ok(r.body.rows.some(row=>row[3]==='施工規劃'&&row[1].includes('施工人員 B')));
   }
   const legacy=await request('admin','export_data',{resource:'assignments',scope:'all',columns:['notes'],filters:{}});assert.equal(legacy.status,200);assert.equal(legacy.body.row_count,3);
  });
  await t.test('forged all scope cannot leak data through export for an ordinary user',async()=>{
   for(const key of ['A','B','viewer'])for(const scope of ['filtered','all'])assert.equal((await exportRows(key,'all',scope)).status,403);
   const mine=await exportRows('A','mine');assert.equal(mine.status,200,JSON.stringify(mine.body));assert.equal(mine.body.row_count,(await dashboard('A')).pending.length);
   const malformed=await exportRows('admin','everyone');assert.equal(malformed.status,400);
  });
  await t.test('opening/exporting all is read only; normal users still cannot complete others or acknowledge another creator notice',async()=>{
   const before=(await f.db.query('select id,status,row_version,completed_at,completion_acknowledged_at from work_assignments order by id')).rows;
   const denied=await request('A','complete_work_assignment',{id:records.otherCreator.id,row_version:records.otherCreator.row_version});assert.notEqual(denied.status,201);
   const completed=(await f.db.query('select row_version from work_assignments where id=$1',[records.completed.id])).rows[0];
   const acknowledgement=await request('B','acknowledge_work_assignment',{id:records.completed.id,row_version:completed.row_version});assert.notEqual(acknowledgement.status,201);
   assert.deepEqual((await f.db.query('select id,status,row_version,completed_at,completion_acknowledged_at from work_assignments order by id')).rows,before);
   const allowed=await request('A','complete_work_assignment',{id:records.other.id,row_version:records.other.row_version});assert.equal(allowed.status,201,JSON.stringify(allowed.body));
   assert.equal((await dashboard('admin')).all_pending.some(row=>row.id===records.other.id),false);
   assert.equal((await dashboard('admin')).completed.some(row=>row.id===records.other.id),true);
  });
  await t.test('admin all is complete beyond the historical 100-row personal cap and remains role limited',async()=>{
   await f.db.query("insert into work_assignments(project_id,assignee_user_id,created_by_user_id,assignment_type,instructions,status) select $1,$2,$3,'general','隔離批次待辦 '||n,'pending' from generate_series(1,105) n",[f.planProjects.repair,users.A,users.admin]);
   const data=await dashboard('admin');assert.equal(data.all_pending.length,111);
   assert.equal((await exportRows('admin','all')).body.row_count,111);
   const ordinary=await dashboard('A');assert.equal(Object.hasOwn(ordinary,'all_pending'),false);assert.equal(ordinary.pending.filter(row=>row.assignment_type!=='construction').length,100);
  });
  await t.test('existing work assignment RLS and direct table grants stay closed',async()=>{
   const row=(await f.db.query("select relrowsecurity as rls,has_table_privilege('anon',oid,'SELECT') anon,has_table_privilege('authenticated',oid,'SELECT') authenticated from pg_class where oid='public.work_assignments'::regclass")).rows[0];
   assert.deepEqual(row,{rls:true,anon:false,authenticated:false});
  });
  await t.test('administrator all view and export still respect existing private-customer access',async()=>{
   await callAsService(f.db,'configure_erp_private_access_v1',[users.admin,users.admin,[],null]);
   const customer=(await f.db.query('select row_version from customers where id=$1',[ids.customer])).rows[0];
   await callAsService(f.db,'set_customer_private_v1',[users.admin,ids.customer,customer.row_version,true]);
   const denied=await dashboard('admin2');assert.equal(denied.all_pending.length,0);
   const exported=await exportRows('admin2','all');assert.equal(exported.status,200,JSON.stringify(exported.body));assert.equal(exported.body.row_count,0);
   assert.equal((await dashboard('admin')).all_pending.length,111);
  });
 }finally{await f.db.close();}
});
