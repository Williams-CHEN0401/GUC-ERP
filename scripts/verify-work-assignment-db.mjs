// Run explicitly with PGLITE_MODULE pointing to the installed isolated runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
import {restRead} from './work-assignment-fixture.mjs';
import {ids} from './worklog-save-fixture.mjs';
import {extraIds,callAsService} from './department-cross-system-fixture.mjs';

test('dashboard and assignment Gateway -> PostgreSQL -> reread',async t=>{
 const {server,db,currentUser,calls}=await createWorklogTestServer({assignments:true});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port+'/api/inventory';
 const post=async(operation,payload)=>{const r=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,payload})});return{status:r.status,...await r.json()};};
 const dashboard=async()=>{const r=await fetch(base+'?scope=dashboard'),data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data.dashboard;};
 const count=async table=>(await db.query('select count(*)::int n from '+table)).rows[0].n;
 const manual=(name,extra={})=>({project_mode:'manual',project_name:name,customer_id:ids.customer,department_id:ids.department,project_type:'repair',project_date:'2026-09-17',assignee_user_id:ids.actor,assignment_type:'general',instructions:'隔離工作指派測試',...extra});
 const sqlArgs=(name,extra={})=>{const p=manual(name,extra);return[p.project_name,p.customer_id,p.department_id,p.project_type,p.project_date,p.assignee_user_id,p.assignment_type,p.instructions,p.inventory_item_id||null,p.pickup_quantity||null,ids.actor,'fixture-admin'];};
 let created;
 try{
  await t.test('reproduces old missing-column failure, corrected dashboard resolves customer and workers',async()=>{
   await assert.rejects(()=>restRead(db,'site_work_logs?select=id,customer_id'),e=>e.code==='42703');
   const d=await dashboard();assert.equal(d.worklogs.length,1);assert.equal(d.worklogs[0].customer,'國立高雄大學');assert.equal(d.worklogs[0].workers,'隔離測試員-admin');
  });
  await t.test('manual input creates one project and one assignment, using shared numbering, department and worker',async()=>{
   const before=await count('projects'),r=await post('create_work_assignment',manual('手動新增查修工作'));
   assert.equal(r.status,201,JSON.stringify(r));created=r.result;
   assert.equal(await count('projects'),before+1);
   const p=(await db.query('select * from projects where id=$1',[created.project_id])).rows[0];
   assert.equal(p.name,'手動新增查修工作');assert.equal(p.customer_id,ids.customer);assert.equal(p.department_id,ids.department);assert.equal(p.project_type,'repair');assert.ok(p.project_code);
   assert.equal((await db.query('select user_id from project_workers where project_id=$1',[p.id])).rows[0].user_id,ids.actor);
   const d=await dashboard();assert.ok(d.assignments.pending.some(a=>a.id===created.id&&a.project===p.name&&a.customer==='國立高雄大學'));
   assert.equal(calls.at(-1).name,'create_work_assignment_with_project_v1');
  });
  await t.test('existing selection reuses new project without creating another',async()=>{
   const before=await count('projects');const r=await post('create_work_assignment',{project_id:created.project_id,assignee_user_id:ids.actor,assignment_type:'general',instructions:'從既有清單再次指派'});
   assert.equal(r.status,201,JSON.stringify(r));assert.equal(r.result.project_id,created.project_id);assert.equal(await count('projects'),before);assert.equal(calls.at(-1).name,'create_work_assignment_v1');
  });
  await t.test('duplicate name cannot silently update an existing project',async()=>{
   const before=await count('work_assignments');assert.notEqual((await post('create_work_assignment',manual(' 手動新增查修工作 '))).status,201);assert.equal(await count('work_assignments'),before);
  });
  await t.test('failed assignment rolls back the newly created project and audit trail',async()=>{
   const p=await count('projects'),a=await count('audit_logs');
   await assert.rejects(()=>callAsService(db,'create_work_assignment_with_project_v1',sqlArgs('必須回復的新工作',{inventory_item_id:ids.item})),/一般工作不可/);
   assert.equal(await count('projects'),p);assert.equal(await count('audit_logs'),a);
  });
  await t.test('cross-customer/missing department and inactive assignee are rejected',async()=>{
   await db.query('update app_users set is_active=false where id=$1',[ids.viewer]);
   const before=await count('projects');assert.notEqual((await post('create_work_assignment',manual('停用人員不可指派',{assignee_user_id:ids.viewer}))).status,201);assert.equal(await count('projects'),before);
   await db.query('update app_users set is_active=true where id=$1',[ids.viewer]);
   for(const extra of [{department_id:extraIds.otherDepartment},{department_id:null},{assignee_user_id:'10000000-0000-4000-8000-000000000099'}]){
    const p=await count('projects');assert.notEqual((await post('create_work_assignment',manual('不得保存',extra))).status,201);assert.equal(await count('projects'),p);
   }
  });
  await t.test('customer without departments can create a manual project',async()=>{
   const r=await post('create_work_assignment',manual('無科室工作',{customer_id:extraIds.emptyCustomer,department_id:null}));assert.equal(r.status,201,JSON.stringify(r));
  });
  await t.test('invalid modes, names, dates and ambiguous project inputs are rejected',async()=>{
   for(const extra of [{project_mode:'other'},{project_name:' '},{project_name:'a'.repeat(121)},{project_date:'bad'},{project_type:'bad'},{project_id:created.project_id}])assert.notEqual((await post('create_work_assignment',manual('無效輸入',extra))).status,201);
  });
  await t.test('general completion still creates no pickup and appears in completion notice',async()=>{
   const before=await count('pickup_records'),r=await post('complete_work_assignment',{id:created.id,row_version:created.row_version});assert.equal(r.status,201,JSON.stringify(r));
   assert.equal(await count('pickup_records'),before);assert.ok((await dashboard()).assignments.completed.some(a=>a.id===created.id));
  });
  await t.test('manual pickup creates one pickup on completion; repeating completion is idempotent',async()=>{
   const r=await post('create_work_assignment',manual('手動取貨工作',{assignment_type:'pickup',inventory_item_id:ids.item,pickup_quantity:2}));assert.equal(r.status,201,JSON.stringify(r));
   const before=await count('pickup_records'),payload={id:r.result.id,row_version:r.result.row_version};
   const completed=await post('complete_work_assignment',payload);assert.equal(completed.status,201,JSON.stringify(completed));
   assert.equal(completed.result.pickup.project_id,r.result.project_id);assert.equal(Number(completed.result.pickup.quantity),2);
   assert.equal((await post('complete_work_assignment',payload)).status,201);assert.equal(await count('pickup_records'),before+1);
  });
  await t.test('viewer cannot create assignment; scoped dashboard only returns allowed project logs',async()=>{
   Object.assign(currentUser,{id:ids.viewer,role:'viewer'});assert.notEqual((await post('create_work_assignment',manual('越權新增'))).status,201);
   Object.assign(currentUser,{id:ids.scoped,role:'scoped',project_scoped:true,permissions:[{module:'dashboard',can_view:true},{module:'worklogs',can_view:true}]});
   assert.equal((await dashboard()).worklogs.length,0);
   const log=(await db.query('select project_id from site_work_logs limit 1')).rows[0];
   await db.query('insert into project_workers(project_id,user_id,can_view,is_assignee) values($1,$2,true,true)',[log.project_id,ids.scoped]);
   assert.equal((await dashboard()).worklogs.length,1);
  });
  await t.test('new RPC remains private to service_role and uses invoker security',async()=>{
   const row=(await db.query("select p.prosecdef,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service from pg_proc p where proname='create_work_assignment_with_project_v1'")).rows[0];
   assert.deepEqual(row,{prosecdef:false,anon:false,authenticated:false,service:true});
  });
 }finally{await new Promise(resolve=>server.close(resolve));await db.close();}
});
