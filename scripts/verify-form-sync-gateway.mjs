import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
import {seedIndependent} from './independent-work-fixture.mjs';
import {sample,ids} from './worklog-save-fixture.mjs';
import {syncOperatorId} from './form-sync-fixture.mjs';
const {server,db,failures}=await createWorklogTestServer({formSync:true});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port+'/api/inventory';
const read=async(scope='transactions',optionsOnly=false,user='isolated-operator')=> {
 const response=await fetch(url+'?scope='+scope+(optionsOnly?'&options_only=1':''),{headers:{Authorization:'Bearer '+user}});
 assert.equal(response.status,200);return response.json();
};
const send=async(operation,payload,user='isolated-fixture-only')=>{
 const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+user,'Content-Type':'application/json'},body:JSON.stringify({operation,payload})});
 return {status:response.status,body:await response.json()};
};
try{
 const {a}=await seedIndependent(db);
 const before=await read('transactions',true);
 assert.equal(before.current_user.id,syncOperatorId);
 assert.ok(!Object.hasOwn(before,'pickups'),'option refresh excludes history');
 assert.equal((await send('create_product_category',{name:'無權限種類',code_prefix:'X'},'isolated-operator')).status,403);
 const categoryResult=await send('create_product_category',{name:'同步新增種類',code_prefix:'Q'});
 assert.equal(categoryResult.status,201,JSON.stringify(categoryResult.body));
 const category=(await read('transactions',true)).categories.find(row=>row.name==='同步新增種類');
 assert.ok(category&&!before.categories.some(row=>row.id===category.id));
 const itemResult=await send('create_inventory_item_batch',{rows:[
  {category_id:category.id,item_name:'網路測試器',brand:'SYNC',model:'LAN-0923',unit:'台',opening_quantity:30},
  {category_id:category.id,item_name:'光纖測試器',brand:'SYNC',model:'FIBER-0923',unit:'台',opening_quantity:20}
 ]});
 assert.equal(itemResult.status,201,JSON.stringify(itemResult.body));
 const choices=await read('transactions',true),item=choices.items.find(row=>row.item_name==='光纖測試器');
 assert.ok(item);
 const pickup=await send('create_pickup_batch',{rows:[{customer_id:ids.customer,project_id:a.project.id,pickup_date:'2026-09-23',inventory_item_id:item.id,quantity:4}]},'isolated-operator');
 assert.equal(pickup.status,201,JSON.stringify(pickup.body));
 let after=await read();
 const saved=after.pickups.find(row=>row.inventory_item_id===item.id);
 assert.equal(Number(saved.quantity),4);assert.equal(saved.created_by_user_id,syncOperatorId);assert.equal(saved.project_id,a.project.id);
 const sampleLog=sample();sampleLog.maintenance_events[0].event_type='EQUIPMENT_TEST';
 const logResult=await send('upsert_customer_project_work_log',{...sampleLog,project_name:'跨表單設備測試'});
 assert.equal(logResult.status,201,JSON.stringify(logResult.body));
 after=await read('worklogs');
 const event=after.maintenance_events.find(row=>row.event_type==='EQUIPMENT_TEST');
 assert.ok(event);
 const log=after.site_work_logs.find(row=>row.id===event.work_log_id);
 assert.ok(log);
 const refreshed=await read('transactions',true);
 assert.equal(log.work_type,'維修紀錄');
 assert.ok(refreshed.projects.some(row=>row.id===log.project_id&&row.project_type==='repair'));
 const original=refreshed.projects.find(row=>row.id===a.project.id);
 await db.query("update projects set name='其他使用者已修改' where id=$1",[original.id]);
 const stale=await send('update_erp_project',{id:original.id,row_version:original.row_version,name:'過期草稿',customer_id:ids.customer,department_id:ids.department,project_type:'construction',status:'in_progress',worker_user_ids:[],project_date:'2026-09-23',description:'',note:'',estimated_cost:''});
 assert.ok(stale.status>=400,'stale write cannot overwrite another user');
 assert.equal(failures.at(-1)?.name,'upsert_erp_project_department_v1');
 assert.match(failures.at(-1).message,/修改|版本|更新/,'version conflict reaches SQL rather than unrelated validation');
 assert.equal((await db.query('select name from projects where id=$1',[original.id])).rows[0].name,'其他使用者已修改');
 console.log('PASS: A category/item SQL writes -> B authorized options read -> B pickup SQL save/readback; correct actor, quantity and project.');
 console.log('PASS: equipment-testing Gateway/SQL save -> worklog readback -> cross-form project choices; unauthorized category write/stale project denied.');
}finally{await new Promise(resolve=>server.close(resolve));await db.close();}
