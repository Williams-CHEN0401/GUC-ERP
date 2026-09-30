import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {receiptDocumentServer} from './receipt-document-fixture.mjs';
import {callAsService,extraIds} from './department-cross-system-fixture.mjs';
import {ids} from './worklog-save-fixture.mjs';
const {db}=await receiptDocumentServer();
const read=async id=>(await db.query('select * from stock_receipts where receipt_document_id=$1 order by receipt_line_no',[id])).rows;
const line=(note,quantity=1,id=null)=>({id,inventory_item_id:ids.item,note,quantity});
const save=(doc,create,existing,rows,actor=ids.actor,supplier=extraIds.supplier)=>callAsService(db,'save_stock_receipt_document_v1',[doc,create,JSON.stringify(existing),'2026-09-30',supplier,JSON.stringify(rows),[ids.customer],JSON.stringify([{customer_id:ids.customer,department_id:ids.department}]),actor]);
const versions=rows=>rows.map(r=>({id:r.id,row_version:r.row_version}));
try{
 const id=randomUUID();await save(id,true,[],[line('one',3),line('two',4)]);const before=await read(id);assert.equal(before.length,2);
 await assert.rejects(save(id,true,[],[line('duplicate')]),/已被更新/);assert.deepEqual(await read(id),before);
 await save(id,false,versions(before),before.map((r,i)=>line('changed'+i,5+i,r.id)));const after=await read(id);assert.equal(after.reduce((sum,r)=>sum+Number(r.quantity),0),11);assert.deepEqual(after.map(r=>r.id),before.map(r=>r.id));
 await assert.rejects(save(id,false,versions(before),before.map((r,i)=>line('stale'+i,9,r.id))),/已被更新/);assert.deepEqual(await read(id),after);
 const bad=after.map((r,i)=>line('must roll back'+i,8,r.id));bad.push({...line('invalid FK'),inventory_item_id:randomUUID()});await assert.rejects(save(id,false,versions(after),bad));assert.deepEqual(await read(id),after,'late invalid line rolls back earlier edits');
 await assert.rejects(save(id,false,versions(after),[line('missing other line',1,after[0].id)]),/已被更新/);
 const foreign=randomUUID();await save(foreign,true,[],[line('other document')]);const foreignRow=(await read(foreign))[0];await assert.rejects(save(id,false,versions(after),[...after.map(r=>line(r.note,1,r.id)),line('foreign',1,foreignRow.id)]),/已被更新/);
 await assert.rejects(save(randomUUID(),true,[],[line('denied')],ids.viewer),/權限/);
 await assert.rejects(save(id,false,versions(after),after.map(r=>line(r.note,1,r.id)),ids.viewer),/權限/);
 const old=await callAsService(db,'create_stock_receipts_department_v1',[JSON.stringify([{receipt_date:'2026-09-30',supplier_id:extraIds.supplier,inventory_item_id:ids.item,quantity:2,note:'legacy'}]),[],JSON.stringify([]),ids.actor]);
 const legacy=(await db.query('select * from stock_receipts where id=$1',[old.ids[0]])).rows[0];assert.equal(legacy.receipt_document_id,null);
 await save(legacy.id,false,versions([legacy]),[line('legacy edited',2,legacy.id)]);assert.equal((await read(legacy.id))[0].id,legacy.id);assert.equal((await read(foreign)).length,1);
 await db.exec('set role authenticated');await assert.rejects(db.query('select save_stock_receipt_document_v1(null,true,\'[]\',current_date,null,\'[]\',\'{}\',\'[]\',null)'),/permission denied/);await db.exec('reset role');
 console.log('PASS receipt SQL: grouped create/edit, stable line IDs, duplicate submit, stale/full-set guards, foreign row rejection, all-or-nothing rollback, RBAC/ACL, legacy singleton edit; stock receipt sum 7 -> 11.');
}finally{await db.close();}
