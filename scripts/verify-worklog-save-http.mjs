import assert from 'node:assert/strict';
import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
import {sample,ids} from './worklog-save-fixture.mjs';
const {server,db,calls}=await createWorklogTestServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const post=async payload=>{const r=await fetch(base+'/api/inventory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'upsert_customer_project_work_log',payload})});return{status:r.status,body:await r.json()};};
try{
 const p=sample(),first=await post(p);assert.equal(first.status,201,JSON.stringify(first));
 assert.equal(first.body.result.work_log.summary,p.summary);
 const state=await(await fetch(base+'/api/inventory?scope=worklogs')).json();
 assert.equal(state.site_work_logs.length,1);assert.equal(state.site_work_logs[0].log_date,p.log_date);
 assert.equal(state.projects[0].department_id,ids.department);assert.equal(state.maintenance_events[0].handling_process,p.maintenance_events[0].handling_process);
 assert.equal(state.repair_items[0].department_id,ids.department);
 assert.equal((await post(p)).body.result.work_log.id,first.body.result.work_log.id);
 const invalid=await post({...p,request_id:crypto.randomUUID(),department_id:'invalid'});assert.equal(invalid.status,400);
 assert.equal(calls.length,2,'invalid input is rejected before database write');
 const after=await(await fetch(base+'/api/inventory?scope=worklogs')).json();assert.equal(after.site_work_logs.length,1);assert.equal(after.repair_items.length,1);
 console.log('PASS HTTP: actual Gateway validation -> restricted service_role RPC -> PostgreSQL rows -> PostgREST-shaped reload; replay and malformed department rejection');
}finally{await new Promise(resolve=>server.close(resolve));await db.close();}
