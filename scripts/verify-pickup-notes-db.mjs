import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pickupNotesServer,secondItem} from './pickup-notes-fixture.mjs';
import {ids} from './worklog-save-fixture.mjs';
const {server,db,seed,oldRows,currentUser,calls}=await pickupNotesServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port+'/api/inventory';
const send=async(operation,payload)=>{
 const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,payload})});
 return {status:res.status,body:await res.json()};
};
const rows=async()=>(await (await fetch(url+'?scope=transactions')).json()).pickups;
const quantity=async()=>Number((await db.query('select sum(quantity) n from pickup_records')).rows[0].n);
const auditCount=async()=>Number((await db.query('select count(*) n from audit_logs')).rows[0].n);
const read=async id=>(await rows()).find(x=>x.id===id);
const edit=row=>({id:row.id,row_version:row.row_version,pickup_date:row.pickup_date,project_id:row.project_id,inventory_item_id:row.inventory_item_id,quantity:Number(row.quantity)});
try{
 for(const row of (await db.query('select * from pickup_records order by id')).rows){
  const {note,...original}=row;assert.equal(note,null);assert.deepEqual(original,oldRows.find(x=>x.id===row.id));
 }
 const history=(await db.query('select * from site_work_logs order by id')).rows;
 const row={customer_id:ids.customer,pickup_date:'2026-09-24',project_id:seed.project.id,inventory_item_id:ids.item,quantity:2,note:'  第一列 <測試> & "引號"  '};
 const payload={request_id:randomUUID(),rows:[row,{...row,inventory_item_id:secondItem,quantity:3,note:'第二列備註'}]};
 const saved=await send('create_pickup_batch',payload);assert.equal(saved.status,201,JSON.stringify(saved.body));
 const batch=(await rows()).filter(x=>x.request_id===payload.request_id).sort((a,b)=>a.request_row-b.request_row);
 assert.deepEqual(batch.map(x=>x.note),['第一列 <測試> & "引號"','第二列備註']);assert.equal(await quantity(),6);
 const replayAudit=await auditCount();
 assert.equal((await send('create_pickup_batch',payload)).status,201);assert.equal(await quantity(),6);assert.equal(await auditCount(),replayAudit);
 assert.ok((await send('create_pickup_batch',{...payload,rows:[{...row,note:'不同備註'},payload.rows[1]]})).status>=400);
 assert.equal(await quantity(),6);
 const beforeAudit=await auditCount(),sibling=await read(batch[1].id);
 const changed=await send('update_pickup',{...edit(batch[0]),note:'修改後備註'});
 assert.equal(changed.status,201,JSON.stringify(changed.body));
 let updated=await read(batch[0].id);
 assert.equal(updated.note,'修改後備註');assert.equal(updated.row_version,batch[0].row_version+1);
 assert.equal(await auditCount(),beforeAudit+1);assert.equal(await quantity(),6);assert.deepEqual(await read(sibling.id),sibling);
 assert.ok((await send('update_pickup',{...edit(batch[0]),note:'過期版本'})).status>=400);
 assert.equal((await send('update_pickup',edit(updated))).status,201);
 updated=await read(updated.id);assert.equal(updated.note,'修改後備註');
 assert.equal((await send('update_pickup',{...edit(updated),note:'   '})).status,201);
 assert.equal((await read(updated.id)).note,null);
 const linked={work_log_id:seed.work_log.id,request_id:randomUUID(),rows:[{...row,note:'工作日誌取貨備註'}]};
 assert.equal((await send('create_pickup_batch',linked)).status,201);
 const linkedRow=(await rows()).find(x=>x.request_id===linked.request_id);
 assert.equal(linkedRow.work_log_id,seed.work_log.id);assert.equal(linkedRow.note,'工作日誌取貨備註');
 assert.deepEqual((await db.query('select * from site_work_logs order by id')).rows,history);
 const {note:_,...legacyRow}=row;
 const legacy={request_id:randomUUID(),rows:[legacyRow]};
 assert.equal((await send('create_pickup_batch',legacy)).status,201);
 assert.equal((await rows()).find(x=>x.request_id===legacy.request_id).note,null);
 const snapshot=await rows(),beforeInvalidQuantity=await quantity();
 for(const note of ['字'.repeat(501),{unexpected:true},123]){
  assert.ok((await send('create_pickup_batch',{request_id:randomUUID(),rows:[{...row,note}]})).status>=400);
  assert.ok((await send('update_pickup',{...edit(linkedRow),note})).status>=400);
 }
 assert.ok((await send('create_pickup_batch',{request_id:randomUUID(),rows:[row,{...row,note:'不同備註也不可重複同品項'}]})).status>=400);
 currentUser.role='viewer';const called=calls.length;
 assert.equal((await send('create_pickup_batch',{request_id:randomUUID(),rows:[row]})).status,403);
 assert.equal((await send('update_pickup',{...edit(linkedRow),note:'不可寫'})).status,403);
 assert.equal(calls.length,called);currentUser.role='admin';
 assert.deepEqual(await rows(),snapshot);assert.equal(await quantity(),beforeInvalidQuantity);
 await assert.rejects(db.query("select create_pickup_records_batch_v2($1,$2,'fixture-admin',null,$3,'fixture-admin')",[JSON.stringify([{...row,note:'字'.repeat(501)}]),ids.actor,randomUUID()]),/500/);
 await assert.rejects(db.query("select create_pickup_records_batch_v2($1,$2,'fixture-admin',null,$3,'fixture-admin')",[JSON.stringify([{...row,note:{bad:true}}]),ids.actor,randomUUID()]),/文字/);
 await assert.rejects(db.query("update pickup_records set note=$2 where id=$1",[linkedRow.id,'字'.repeat(501)]),/pickup_records_note_length/);
 const acls=(await db.query("select proname,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') authenticated,has_function_privilege('service_role',oid,'execute') service,proconfig from pg_proc where pronamespace='public'::regnamespace and proname in ('update_pickup_record','update_pickup_record_v2','create_pickup_records_batch_v2')")).rows;
 assert.equal(acls.length,3);
 for(const acl of acls){assert.equal(acl.anon,false);assert.equal(acl.authenticated,false);assert.equal(acl.service,true);assert.ok(acl.proconfig.includes('search_path=""'));}
 console.log('PASS: old rows; Gateway -> SQL -> reread; multi-row notes; linked pickup; old clients; edit/clear; stock/version/audit; replay; duplicate/length/type/role guards; service-only ACL.');
}finally{await new Promise(resolve=>server.close(resolve));await db.close();}
