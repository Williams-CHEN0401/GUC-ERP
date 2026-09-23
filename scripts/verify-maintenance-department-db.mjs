import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {maintenanceDepartmentDatabase,seedMeetingRooms,thirdRoom} from './maintenance-department-fixture.mjs';
import {sample,saveLog,ids} from './worklog-save-fixture.mjs';
import {extraIds} from './department-cross-system-fixture.mjs';
const db=await maintenanceDepartmentDatabase();
try{
 const seed=await seedMeetingRooms(db),projectId=seed.project.id;
 const make=dept=>({...sample(),project_id:projectId,project_name:seed.project.name,department_id:dept,work_type:'維護保養',maintenance_events:[],summary:'會議室維護'});
 const a=await saveLog(db,make(ids.department)),request=make(extraIds.secondDepartment),b=await saveLog(db,request);
 assert.equal(a.project.id,projectId);assert.equal(b.project.id,projectId);
 assert.equal(a.work_log.department_id,ids.department);assert.equal(b.work_log.department_id,extraIds.secondDepartment);
 assert.equal(b.project.department_id,thirdRoom);
 assert.equal((await db.query('select count(*)::int n from projects')).rows[0].n,1);
 assert.deepEqual(await saveLog(db,request),b);
 await assert.rejects(saveLog(db,{...request,department_id:ids.department}),/識別碼/);
 const edit={...make(extraIds.secondDepartment),id:a.work_log.id,row_version:a.work_log.row_version};
 // Read the current optimistic version: existing project status sync can advance it.
 edit.row_version=(await db.query('select row_version from site_work_logs where id=$1',[a.work_log.id])).rows[0].row_version;
 const saved=await saveLog(db,edit);assert.equal(saved.work_log.id,a.work_log.id);assert.equal(saved.work_log.department_id,extraIds.secondDepartment);
 assert.equal((await db.query('select department_id from site_work_logs where id=$1',[seed.work_log.id])).rows[0].department_id,thirdRoom);
 await assert.rejects(saveLog(db,{...make(ids.department),work_type:'工程施工'}),/科室/);
 await assert.rejects(saveLog(db,make(extraIds.otherDepartment)),/科室/);
 await assert.rejects(saveLog(db,make(ids.department),ids.viewer),/權限/);
 await db.query('insert into project_workers(project_id,user_id,can_view,can_create_work_log,can_update_work_log) values($1,$2,true,true,true)',[projectId,ids.scoped]);
 const scoped=await saveLog(db,make(ids.department),ids.scoped);assert.equal(scoped.project.id,projectId);
 const before=(await db.query('select count(*)::int n from site_work_logs')).rows[0].n;
 await assert.rejects(saveLog(db,{...make(ids.department),maintenance_events:[{event_type:'INVALID'}]}));
 assert.equal((await db.query('select count(*)::int n from site_work_logs')).rows[0].n,before);
 const repaired=await saveLog(db,{...make(ids.department),maintenance_events:sample().maintenance_events});
 const repair=(await db.query('select * from repair_items where id=$1',[repaired.created_repair_item_ids[0]])).rows[0];
 assert.equal(repair.department_id,ids.department);
 await assert.rejects(saveLog(db,{...make(extraIds.secondDepartment),id:repaired.work_log.id,row_version:repaired.work_log.row_version}),/維修品/);
 const ordinary=await saveLog(db,{...sample(),project_name:'一般文書工作',work_type:'文書作業',maintenance_events:[]});
 assert.equal(ordinary.work_log.department_id,null,'ordinary writes retain project department fallback');
 const permissions=(await db.query("select prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service from pg_proc where proname='upsert_work_log_with_department_v1'")).rows[0];
 assert.equal(permissions.prosecdef,true);assert.equal(permissions.anon,false);assert.equal(permissions.authenticated,false);assert.equal(permissions.service,true);assert.ok(permissions.proconfig.includes('search_path=""'));
 console.log('PASS: 3 rooms / 1 project; persisted independent departments; edit/replay; unchanged project department and sibling; nonmaintenance/cross-customer/role rejection; scoped authorized reuse; rollback; repair inheritance/protection; service-only replay ACL');
}finally{await db.close();}
