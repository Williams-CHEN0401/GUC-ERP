import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
import {seedIndependent} from './independent-work-fixture.mjs';
const {server,db,calls,currentUser}=await createWorklogTestServer({independent:true});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port+'/api/inventory';
const send=async(operation,payload)=>{
 const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,payload})});
 return{status:res.status,body:await res.json()};
};
try{
 const {a,b,base}=await seedIndependent(db);
 const all=async()=>await(await fetch(url+'?scope=worklogs')).json();
 let data=await all();const pickup=data.pickups.find(x=>x.work_log_id===a.work_log.id);
 const edit={id:pickup.id,row_version:pickup.row_version,pickup_date:pickup.pickup_date,project_id:b.project.id,inventory_item_id:pickup.inventory_item_id,quantity:pickup.quantity};
 const deniedCount=calls.length;currentUser.role='viewer';
 assert.equal((await send('update_pickup',edit)).status,403);assert.equal(calls.length,deniedCount);
 currentUser.role='admin';
 const edited=await send('update_pickup',edit);assert.equal(edited.status,201,JSON.stringify(edited.body));
 data=await all();const savedPickup=data.pickups.find(x=>x.id===pickup.id);
 assert.equal(savedPickup.project_id,b.project.id);assert.equal(savedPickup.work_log_id,null);
 assert.equal(data.site_work_logs.find(x=>x.id===a.work_log.id).project_id,a.project.id);
 assert.ok((await send('update_pickup',edit)).status>=400,'stale request rejected');
 const moved=await send('upsert_customer_project_work_log',{...base,id:a.work_log.id,row_version:a.work_log.row_version,request_id:randomUUID(),project_id:b.project.id,project_name:b.project.name});
 assert.equal(moved.status,201,JSON.stringify(moved.body));
 data=await all();assert.equal(data.site_work_logs.find(x=>x.id===a.work_log.id).project_id,b.project.id);
 assert.equal(data.site_work_logs.find(x=>x.id===a.work_log.id).work_type,'工程施工');
 assert.equal(data.pickups.filter(x=>x.work_log_id===a.work_log.id).length,0);
 assert.equal(data.pickups.filter(x=>x.project_id===a.project.id).length,2);
 assert.equal(data.pickups.reduce((n,x)=>n+Number(x.quantity),0),6);
 const history={logs:data.site_work_logs,pickups:data.pickups};
 const deletion={id:a.project.id,row_version:data.projects.find(x=>x.id===a.project.id).row_version};
 currentUser.role='viewer';assert.equal((await send('delete_erp_project',deletion)).status,403);currentUser.role='admin';
 assert.ok((await send('delete_erp_project',{...deletion,row_version:999})).status>=400);
 const deleted=await send('delete_erp_project',deletion);assert.equal(deleted.status,201,JSON.stringify(deleted.body));
 const active=await(await fetch(url+'?scope=crm')).json();assert.ok(!active.projects.some(x=>x.id===a.project.id));
 data=await all();assert.deepEqual({logs:data.site_work_logs,pickups:data.pickups},history,'deletion preserves historical readback');
 console.log('PASS: real Gateway -> SQL -> scoped reread, both independent moves; denied-role/stale rejects; total stock and daily type unchanged.');
 console.log('PASS: real Gateway soft delete -> active list absent, history retained; role/stale rejects.');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{await new Promise(resolve=>server.close(resolve));await db.close();}
