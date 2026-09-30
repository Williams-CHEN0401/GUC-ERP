// Explicit integration test: real SQL + Gateway, synthetic PGlite only, no secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {workNameReuseServer,workNameReuseMigration} from './work-name-reuse-fixture.mjs';
import {sql,sample,saveLog,ids} from './worklog-save-fixture.mjs';
import {extraIds,callAsService,projectArgs} from './department-cross-system-fixture.mjs';

test('deleted work names can be reused without merging history or weakening active uniqueness',async t=>{
 const {db,gatewayHandler}=await workNameReuseServer({fixed:false});
 const make=(name,extra={})=>({...sample(),project_name:name,log_date:'2026-09-30',maintenance_events:[],...extra});
 const post=async(operation,payload)=>{const r=await gatewayHandler(new Request('http://127.0.0.1/inventory-gateway',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,payload})}));return {status:r.status,...await r.json()};};
 const project=async id=>(await db.query('select * from projects where id=$1',[id])).rows[0];
 const remove=async id=>{const p=await project(id),r=await post('delete_erp_project',{id,row_version:p.row_version});assert.equal(r.status,201,JSON.stringify(r));assert.ok((await project(id)).deleted_at);};
 const named=async name=>(await db.query('select repair_visit_name_v1($1,$2,$3) name',[ids.customer,name,'2026-09-30'])).rows[0].name;
 const acl=async()=>(await db.query("select proname,prosecdef,proconfig,proacl::text from pg_proc where pronamespace='public'::regnamespace and proname in ('repair_visit_name_v1','upsert_customer_project_work_log_v2','upsert_customer_project_work_log_v3','upsert_customer_project_work_log_department_v1','upsert_erp_project_department_v1','create_work_assignment_with_project_v1') order by proname")).rows;
 const history=async id=>({project:await project(id),logs:(await db.query('select * from site_work_logs where project_id=$1 order by id',[id])).rows,workers:(await db.query('select * from project_workers where project_id=$1 order by user_id',[id])).rows});
 let root,deleted,oldHistory,oldAcl;
 try{
  await t.test('reproduce the reported date-name -2 issue before migration',async()=>{
   root=await saveLog(db,make('第四棟&藝能館讀卡機查修'));
   deleted=await saveLog(db,make(root.project.name));assert.equal(deleted.project.name,root.project.name+'260930');
   await remove(deleted.project.id);
   assert.equal(await named(root.project.name),root.project.name+'260930-2');
   await assert.rejects(callAsService(db,'upsert_erp_project_department_v1',projectArgs({name:deleted.project.name})),/unique|重複|duplicate/i);
   oldHistory=await history(deleted.project.id);oldAcl=await acl();
  });
  await t.test('migration is metadata-only and preserves existing security',async()=>{
   const before=(await db.query('select count(*)::int n from projects')).rows[0].n;
   await db.exec(await sql(workNameReuseMigration));
   assert.deepEqual(await history(deleted.project.id),oldHistory);assert.deepEqual(await acl(),oldAcl);
   assert.equal((await db.query('select count(*)::int n from projects')).rows[0].n,before);
   const index=(await db.query("select indexdef from pg_indexes where indexname='projects_customer_normalized_name_uidx'")).rows[0].indexdef;
   assert.match(index,/UNIQUE/);assert.match(index,/WHERE \(deleted_at IS NULL\)/);
  });
  await t.test('Gateway saves the released dated name with a fresh ID; replay/history stay separate',async()=>{
   const request=make(root.project.name),r=await post('upsert_customer_project_work_log',request);
   assert.equal(r.status,201,JSON.stringify(r));const fresh=r.result;
   assert.equal(fresh.project.name,deleted.project.name);assert.notEqual(fresh.project.id,deleted.project.id);
   assert.equal(fresh.work_log.project_id,fresh.project.id);
   assert.deepEqual((await post('upsert_customer_project_work_log',request)).result,fresh);
   assert.deepEqual(await history(deleted.project.id),oldHistory);
   const second=await saveLog(db,make(root.project.name)),third=await saveLog(db,make(root.project.name));
   assert.equal(second.project.name,deleted.project.name+'-2');assert.equal(third.project.name,deleted.project.name+'-3');
   await remove(second.project.id);
   assert.equal((await saveLog(db,make(root.project.name))).project.name,deleted.project.name+'-2');
  });
  await t.test('deleting a base name releases exactly that name, even when input contains a date',async()=>{
   for(const name of ['單獨刪除重建','直接輸入名稱260930']){
    const a=await saveLog(db,make(name));await remove(a.project.id);const b=await saveLog(db,make(name));
    assert.equal(b.project.name,name);assert.notEqual(b.project.id,a.project.id);
    assert.equal((await db.query('select project_id from site_work_logs where id=$1',[a.work_log.id])).rows[0].project_id,a.project.id);
   }
  });
  await t.test('closed work still reserves its name; normalized active duplicates are rejected',async()=>{
   const a=await saveLog(db,make('已結案但未刪除'));await db.query("update projects set status='completed' where id=$1",[a.project.id]);
   assert.equal(await named(a.project.name),a.project.name+'260930');
   await callAsService(db,'upsert_erp_project_department_v1',projectArgs({name:'Case Name'}));
   await assert.rejects(callAsService(db,'upsert_erp_project_department_v1',projectArgs({name:'  case name  '})),/unique|重複|duplicate/i);
   const other=await callAsService(db,'upsert_erp_project_department_v1',projectArgs({name:'Case Name',customer:extraIds.otherCustomer,department:extraIds.otherDepartment}));
   assert.equal(other.project.customer_id,extraIds.otherCustomer);
  });
  await t.test('ordinary log creation does not attach to the deleted project; active matching still reuses',async()=>{
   const p=await saveLog(db,make('施工名稱重用',{work_type:'工程施工'}));await remove(p.project.id);
   const q=await saveLog(db,make('施工名稱重用',{work_type:'工程施工',department_id:extraIds.secondDepartment}));
   assert.notEqual(q.project.id,p.project.id);assert.equal(q.project.name,p.project.name);
   assert.equal(q.project.department_id,extraIds.secondDepartment);
   const again=await saveLog(db,make('施工名稱重用',{work_type:'工程施工',department_id:extraIds.secondDepartment}));assert.equal(again.project.id,q.project.id);
  });
  await t.test('manual project and manual assignment can reuse deleted names across departments',async()=>{
   const {project:a}=await callAsService(db,'upsert_erp_project_department_v1',projectArgs({name:'手動工作名稱重用'}));await remove(a.id);
   const {project:b}=await callAsService(db,'upsert_erp_project_department_v1',projectArgs({name:a.name,department:extraIds.secondDepartment}));assert.notEqual(b.id,a.id);assert.equal(b.name,a.name);
   const c=await saveLog(db,make('指派工作名稱重用'));await remove(c.project.id);
   const payload={project_mode:'manual',project_name:c.project.name,customer_id:ids.customer,department_id:ids.department,project_type:'repair',project_date:'2026-09-30',assignee_user_id:ids.actor,assignment_type:'general',instructions:'隔離測試'};
   const r=await post('create_work_assignment',payload);assert.equal(r.status,201,JSON.stringify(r));assert.notEqual(r.result.project_id,c.project.id);
   assert.notEqual((await post('create_work_assignment',payload)).status,201);
  });
  await t.test('v2/v3 compatibility writers ignore deleted names and v3 can rename to a released name',async()=>{
   for(const version of [2,3]){
    const a=await saveLog(db,make('舊版入口名稱'+version,{work_type:'工程施工'}));await remove(a.project.id);
    const args=[null,null,null,ids.customer,a.project.name,'2026-09-30','工程施工','相容性測試',...(version===3?['上午','in_progress']:[]),[ids.actor],ids.actor,'fixture-admin'];
    await callAsService(db,'upsert_customer_project_work_log_v'+version,args);
    const b=(await db.query('select * from projects where customer_id=$1 and name=$2 and deleted_at is null',[ids.customer,a.project.name])).rows[0];
    assert.ok(b);assert.notEqual(b.id,a.project.id);assert.equal(b.name,a.project.name);
   }
   const target=await saveLog(db,make('可重新命名的名稱'));await remove(target.project.id);
   const current=await saveLog(db,make('待改名的工作',{work_type:'工程施工'}));
   const changed=await saveLog(db,make(target.project.name,{id:current.work_log.id,row_version:current.work_log.row_version,project_id:current.project.id,work_type:'工程施工'}));
   assert.equal(changed.project.id,current.project.id);assert.equal(changed.project.name,target.project.name);
  });
  await t.test('denied roles and stale deletion cannot change records; private helper ACL is retained',async()=>{
   const before=(await db.query('select count(*)::int n from projects')).rows[0].n;
   for(const actor of [ids.viewer,ids.scoped])await assert.rejects(saveLog(db,make('不可越權'),actor),/權限/);
   assert.equal((await db.query('select count(*)::int n from projects')).rows[0].n,before);
   const p=await project(root.project.id);const r=await post('delete_erp_project',{id:p.id,row_version:p.row_version+10});assert.notEqual(r.status,201);assert.equal((await project(p.id)).deleted_at,null);
   const helper=(await db.query("select has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service from pg_proc where proname='repair_visit_name_v1'")).rows[0];
   assert.deepEqual(helper,{anon:false,authenticated:false,service:true});
  });
  await t.test('current dashboard still reads successfully; an unexpected migration baseline rolls back atomically',async()=>{
   const response=await gatewayHandler(new Request('http://127.0.0.1/inventory-gateway?scope=dashboard'));
   assert.equal(response.status,200,await response.text());
   const before=(await db.query("select indexname,indexdef from pg_indexes where tablename='projects' order by indexname")).rows;
   // Reapplying already-patched functions is an unexpected baseline, never a silent partial update.
   await assert.rejects(db.exec(await sql(workNameReuseMigration)),/Unexpected work-name lookup baseline/);
   await db.exec('rollback');
   assert.deepEqual((await db.query("select indexname,indexdef from pg_indexes where tablename='projects' order by indexname")).rows,before);
   assert.deepEqual(await acl(),oldAcl);assert.deepEqual(await history(deleted.project.id),oldHistory);
  });
 }finally{await db.close();}
});
