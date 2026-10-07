import assert from 'node:assert/strict';
import {assignedDateServer} from './appointment-assigned-date-fixture.mjs';
import {ids} from './worklog-save-fixture.mjs';
import {callAsService,extraIds} from './department-cross-system-fixture.mjs';
const f=await assignedDateServer(),{db}=f;
const read=async id=>(await db.query('select to_jsonb(w) result from work_assignments w where id=$1',[id])).rows[0].result;
const save=async payload=>{const r=await f.gatewayHandler(new Request('http://localhost/inventory-gateway',{method:'POST',body:JSON.stringify({operation:'upsert_customer_appointment',payload})}));return {status:r.status,body:await r.json()};};
const reload=async()=>{const r=await f.gatewayHandler(new Request('http://localhost/inventory-gateway?scope=appointments'));assert.equal(r.status,200);return (await r.json()).customer_appointments;};
const base={customer_id:ids.customer,department_id:ids.department,appointment_type:'repair',appointment_date:'2026-10-12',assigned_date:'2026-09-30',instructions:'指派日期隔離測試',assignee_user_id:ids.actor,status:'pending',reminder_days:3};
const good=async payload=>{const result=await save(payload);assert.equal(result.status,201,JSON.stringify(result));};
try{
 const legacy=await read(f.legacyId);assert.equal(legacy.assigned_date,null);assert.equal(legacy.created_at,'2026-10-01T17:30:00+00:00');
 await good(base);
 let row=(await reload()).find(r=>r.instructions===base.instructions);assert.equal(row.assigned_date,'2026-09-30');
 const created=(await read(row.id)).created_at,version=row.row_version;
 await good({...base,id:row.id,row_version:version,assigned_date:'2028-02-29'});
 row=(await reload()).find(r=>r.id===row.id);assert.equal(row.assigned_date,'2028-02-29');assert.equal(row.row_version,version+1);
 assert.equal((await read(row.id)).created_at,created);assert.equal(row.appointment_date,base.appointment_date);assert.equal(row.reminder_days,3);
 const audits=(await db.query('select before_data,after_data from audit_logs where entity_type=\'work_assignment\' and entity_id=$1',[row.id])).rows;
 assert.equal(audits.length,2);assert.equal(audits[1].before_data.assigned_date,'2026-09-30');assert.equal(audits[1].after_data.assigned_date,'2028-02-29');
 console.log('PASS Gateway create → date edit → reload; one version/audit per save; creation timestamp, appointment date and reminder unchanged');
 const before=await read(row.id);
 for(const assigned_date of ['', '2026-02-30','2026-13-01','0000-01-01','10000-01-01','not-a-date']){
  const r=await save({...base,id:row.id,row_version:row.row_version,assigned_date});assert.equal(r.status,400);assert.match(r.body.error,/指派日期/);
 }
 assert.equal((await save({...base,id:row.id,row_version:version})).status,400);
 assert.equal((await save({...base,id:row.id,row_version:row.row_version,department_id:extraIds.otherDepartment})).status,400);
 assert.deepEqual(await read(row.id),before);
 console.log('PASS invalid calendar dates, stale versions and mismatched departments rejected without writing');
 const {assigned_date:omit,...older}=base;
 await good({...older,id:row.id,row_version:row.row_version,status:'in_progress'});
 row=await read(row.id);assert.equal(row.assigned_date,'2028-02-29');
 await good({...older,id:row.id,row_version:row.row_version,assigned_date:null,status:'cancelled'});
 row=await read(row.id);assert.equal(row.assigned_date,'2028-02-29');assert.equal(row.created_at,created);
 await good({...older,id:legacy.id,row_version:legacy.row_version});
 assert.equal((await read(legacy.id)).assigned_date,'2026-10-02');assert.equal((await read(legacy.id)).created_at,legacy.created_at);
 await good({...older,instructions:'舊客戶端新增'});
 const oldNew=(await reload()).find(r=>r.instructions==='舊客戶端新增');
 assert.equal(oldNew.assigned_date,new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
 console.log('PASS legacy NULL/omitted dates and cancellation preserve dates; legacy creation day uses Taiwan time');
 row=await callAsService(db,'upsert_customer_appointment_v1',[row.id,row.row_version,ids.customer,ids.department,'repair',base.appointment_date,'','',base.instructions,ids.actor,'cancelled','',ids.actor,'fixture-admin']);
 assert.equal(row.assigned_date,'2028-02-29');assert.equal(row.created_at,created);assert.equal(row.reminder_days,3);
 let legacyCurrent=await read(legacy.id);
 await assert.rejects(callAsService(db,'complete_work_assignment_v1',[legacyCurrent.id,legacyCurrent.row_version,ids.scoped,'fixture-scoped']),/責任人/);
 await callAsService(db,'complete_work_assignment_v1',[legacyCurrent.id,legacyCurrent.row_version,ids.actor,'fixture-admin']);
 legacyCurrent=await read(legacy.id);assert.equal(legacyCurrent.status,'completed');assert.equal(legacyCurrent.assigned_date,'2026-10-02');
 const project=(await db.query('select id from projects limit 1')).rows[0].id;
 for(const type of ['general','pickup']){
  const created=await callAsService(db,'create_work_assignment_v1',[project,ids.actor,type,'既有工作指派回歸',type==='pickup'?ids.item:null,type==='pickup'?2:null,ids.actor,'fixture-admin']);
  const assignment=created.assignment||created;
  const result=await callAsService(db,'complete_work_assignment_v1',[assignment.id,assignment.row_version,ids.actor,'fixture-admin']);
  assert.equal(result.assignment.status,'completed');assert.equal((await read(assignment.id)).assigned_date,null);
 }
 console.log('PASS v1/v2 backwards compatibility, appointment completion and ordinary/pickup assignments unchanged');
 const args=[row.id,row.row_version,ids.customer,ids.department,'repair',base.appointment_date,'','',base.instructions,ids.actor,'pending','',3,ids.actor,'fixture-admin','2026-10-06'];
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);await assert.rejects(db.query('select upsert_customer_appointment_v3('+args.map((_,i)=>'$'+(i+1)).join(',')+')',args),/permission denied/);await db.exec('reset role');
 }
 await assert.rejects(callAsService(db,'upsert_customer_appointment_v3',[...args.slice(0,13),ids.viewer,'fixture-viewer',args[15]]),/權限/);
 await callAsService(db,'configure_erp_private_access_v1',[ids.actor,ids.actor,[ids.viewer,ids.scoped],null]);
 const customer=(await db.query('select * from customers where id=$1',[ids.customer])).rows[0];
 await callAsService(db,'set_customer_private_v1',[ids.actor,ids.customer,customer.row_version,true]);
 const initialUser=f.gatewayContext.currentUser;
 const outsider='10000000-0000-4000-8000-000000000008';await db.query("insert into app_users(id,username,display_name,role) values($1,'outside-admin','Outside','admin')",[outsider]);
 f.gatewayContext.currentUser=async()=>{const user={id:outsider,username:'outside-admin',role:'admin',is_active:true,permissions:[]};await f.gatewayContext.initializePrivateAccess(user);return user;};
 assert.notEqual((await save({...base,id:row.id,row_version:row.row_version,assigned_date:'2026-10-07'})).status,201);
 f.gatewayContext.currentUser=initialUser;assert.deepEqual(await read(row.id),row);
 const acl=(await db.query("select prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service from pg_proc where proname='upsert_customer_appointment_v3'")).rows[0];
 assert.equal(acl.prosecdef,false);assert.equal(acl.anon,false);assert.equal(acl.authenticated,false);assert.equal(acl.service,true);assert.deepEqual(acl.proconfig,['search_path=""']);
 console.log('PASS service-only invoker/search_path ACL, viewer and private-customer denial; existing permissions unchanged');
 console.log('PASS appointment assigned-date integration suite');
}finally{await db.close();}
