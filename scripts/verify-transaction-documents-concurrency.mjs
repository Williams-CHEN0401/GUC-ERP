// Real multi-connection PostgreSQL, fresh synthetic cluster; never production.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,cp} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {useIsolatedDatabaseFactory,ids} from './worklog-save-fixture.mjs';
import {extraIds} from './department-cross-system-fixture.mjs';
import {transactionDocumentServer} from './transaction-document-fixture.mjs';
import {receiptNumberServer} from './receipt-number-fixture.mjs';
const testEditableNumbers=process.argv.includes('--receipt-numbers');
const runtime=fileURLToPath(new URL('../../.tmp/transaction-document-pg/node_modules/',import.meta.url));
const {default:pg}=await import(pathToFileURL(path.join(runtime,'pg/lib/index.js')));
const out=fileURLToPath(new URL('../tmp/transaction-documents/',import.meta.url));await mkdir(out,{recursive:true});
// PostgreSQL Windows tools require an ASCII cluster path with the C locale.
const cluster=await mkdtemp(path.join(tmpdir(),'guc-document-pg-')),data=path.join(cluster,'data'),run=promisify(execFile),port=55438;
await cp(path.join(runtime,'@embedded-postgres/windows-x64/native'),path.join(cluster,'native'),{recursive:true});
const bin=path.join(cluster,'native/bin');
const execute=(name,args)=>run(path.join(bin,name+'.exe'),args,{windowsHide:true,timeout:30000,maxBuffer:1024*1024});
const config={host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:5000};
const connect=async()=>{const c=new pg.Client(config);await c.connect();return c;};
let started=false,base;const clients=[],results=[];
const pass=name=>{results.push({name,status:'PASS'});console.log('PASS '+name);};
try{
 await execute('initdb',['-D',data,'--username=postgres','--auth=trust','--locale=C','--encoding=UTF8']);
 await execute('pg_ctl',['-D',data,'-l',path.join(cluster,'server.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);started=true;
 base=await connect();
 const adapter={exec:async s=>{const result=await base.query(s);return Array.isArray(result)?result:[result];},query:(s,p)=>base.query(s,p),close:async()=>{}};
 useIsolatedDatabaseFactory(async()=>adapter);const f=await (testEditableNumbers?receiptNumberServer():transactionDocumentServer());
 for(let i=0;i<12;i++){const c=await connect();await c.query("set role service_role;set statement_timeout='15s'");clients.push(c);}
 const receiptSql='select save_stock_receipt_document_v1($1,true,$2,$3,$4,$5,$6,$7,$8) result';
 const receiptArgs=id=>[id,'[]','2026-10-09',extraIds.supplier,JSON.stringify(f.items.slice(0,3).map(item=>({inventory_item_id:item,quantity:1}))),[],'[]',ids.actor];
 const pickupSql='select create_pickup_records_batch_v2($1,$2,$3,$4,$5,$6) result';
 const pickupArgs=id=>[JSON.stringify(f.items.slice(0,3).map(item=>({inventory_item_id:item,quantity:1,pickup_date:'2026-10-09',project_id:f.projects[0]}))),ids.actor,'fixture-admin',null,id,'fixture-admin'];
 for(const [kind,statement,args] of [['receipt',receiptSql,receiptArgs],['pickup',pickupSql,pickupArgs]]){
  await Promise.all(clients.map(c=>c.query(statement,args(randomUUID()))));
  const numbers=(await base.query("select sequence_no from stock_transaction_documents where kind=$1 and numbering_date='2026-10-09' order by sequence_no",[kind])).rows.map(r=>r.sequence_no);
  assert.deepEqual(numbers,Array.from({length:12},(_,i)=>i+1));
  const table=kind==='receipt'?'stock_receipts':'pickup_records';
  assert.equal((await base.query(`select count(*)::int n from ${table} where ${kind}_document_id in(select id from stock_transaction_documents where kind=$1 and numbering_date='2026-10-09')`,[kind])).rows[0].n,36);
  pass(kind+': 12 connections concurrently create three-line documents, unique consecutive numbers, 36 ledger rows');
 }
 const request=randomUUID();await Promise.all(clients.map(c=>c.query(pickupSql,pickupArgs(request))));
 assert.equal((await base.query('select count(*)::int n from pickup_records where request_id=$1',[request])).rows[0].n,3);pass('12 concurrent retries of one pickup request create exactly one document');
 const duplicate=randomUUID(),rs=await Promise.allSettled(clients.map(c=>c.query(receiptSql,receiptArgs(duplicate))));assert.equal(rs.filter(r=>r.status==='fulfilled').length,1);pass('Receipt duplicate document ID: one winner, other attempts rejected without extra rows');
 const doc=(await base.query('select * from pickup_records where request_id=$1 order by id',[request])).rows;
 const editArgs=[doc[0].pickup_document_id,JSON.stringify(doc.map(r=>({id:r.id,row_version:r.row_version}))),'2026-10-09',f.projects[0],JSON.stringify(doc.map(r=>({id:r.id,inventory_item_id:r.inventory_item_id,quantity:2}))),ids.actor];
 const es=await Promise.allSettled(clients.slice(0,2).map(c=>c.query('select save_pickup_document_v1($1,$2,$3,$4,$5,$6)',editArgs)));assert.equal(es.filter(r=>r.status==='fulfilled').length,1);assert.match(es.find(r=>r.status==='rejected').reason.message,/已被更新/);pass('Concurrent whole-document edits: one winner, stale writer rejected');
 // Disjoint inventory sets prevent inventory locks from masking numbering races.
 const disjoint=clients.map((_,i)=>({kind:'pickup',id:randomUUID(),date:'2026-10-20',scope:f.projects[0]}));
 await Promise.all(clients.map((c,i)=>c.query('select ensure_stock_document_v1($1,$2,$3,$4)',Object.values(disjoint[i]))));
 assert.equal((await base.query("select count(distinct sequence_no)::int n from stock_transaction_documents where kind='pickup' and numbering_date='2026-10-20'")).rows[0].n,12);pass('Number allocator serialized correctly with no shared inventory lock');
 const batches=[0,1].map(i=>[f.projects[0],f.projects[1]].map((p,j)=>({project_id:p,pickup_date:'2026-10-21',inventory_item_id:f.items[i*2+j],quantity:1})));
 batches[1].reverse();await Promise.all(clients.slice(0,2).map((c,i)=>c.query(pickupSql,[JSON.stringify(batches[i]),ids.actor,'fixture-admin',null,randomUUID(),'fixture-admin'])));
 assert.equal((await base.query("select count(*)::int n from stock_transaction_documents where kind='pickup' and numbering_date='2026-10-21'")).rows[0].n,4);pass('Mixed-project batches with reversed input order and disjoint items finish without deadlock');
 // Prove real blocking (not merely scheduled promises on a single connection).
 const lockId=randomUUID();await clients[0].query('begin');await clients[0].query('select ensure_stock_document_v1($1,$2,$3,$4)',['receipt',lockId,'2026-10-22',extraIds.supplier]);
 const pending=clients[1].query('select ensure_stock_document_v1($1,$2,$3,$4)',['receipt',randomUUID(),'2026-10-22',extraIds.supplier]);
 let blocked=false;for(let i=0;i<50;i++){blocked=(await base.query('select exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type=\'Lock\') blocked',[clients[1].processID])).rows[0].blocked;if(blocked)break;await new Promise(r=>setTimeout(r,10));}
 assert.ok(blocked);await clients[0].query('rollback');await pending;assert.equal((await base.query("select sequence_no from stock_transaction_documents where kind='receipt' and numbering_date='2026-10-22'")).rows[0].sequence_no,1);pass('Observed PostgreSQL lock wait; rollback frees allocation without orphan document/number');
 if(testEditableNumbers){
  const statement='select save_stock_receipt_document_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result';
  const createArgs=(id,item,date,number)=>[id,true,'[]',date,extraIds.supplier,JSON.stringify([{inventory_item_id:item,quantity:1}]),[],'[]',ids.actor,number];
  const docs=[randomUUID(),randomUUID()];
  await Promise.all(clients.slice(0,2).map((c,i)=>c.query(statement,createArgs(docs[i],f.items[i],'2026-11-03',null))));
  const lines=await Promise.all(docs.map(id=>base.query('select * from stock_receipts where receipt_document_id=$1',[id])));
  const edits=lines.map((result,i)=>{const r=result.rows[0];return[docs[i],false,JSON.stringify([{id:r.id,row_version:r.row_version}]),'2026-11-03',extraIds.supplier,JSON.stringify([{id:r.id,inventory_item_id:r.inventory_item_id,quantity:7}]),[],'[]',ids.actor,'SAME-MANUAL'];});
  const races=await Promise.allSettled(clients.slice(0,2).map((c,i)=>c.query(statement,edits[i])));
  assert.equal(races.filter(r=>r.status==='fulfilled').length,1);assert.match(races.find(r=>r.status==='rejected').reason.message,/已使用/);
  assert.equal((await base.query('select sum(quantity)::int n from stock_receipts where receipt_document_id=any($1)',[docs])).rows[0].n,8);
  pass('Two disjoint-item documents rename concurrently: one winner; losing content changes rolled back');
  await clients[0].query('begin');await clients[0].query(statement,createArgs(randomUUID(),f.items[0],'2026-11-04','20261105'));
  const automatic=clients[1].query(statement,createArgs(randomUUID(),f.items[1],'2026-11-05',null));
  let blocked=false;for(let i=0;i<50;i++){blocked=(await base.query("select exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock') blocked",[clients[1].processID])).rows[0].blocked;if(blocked)break;await new Promise(r=>setTimeout(r,10));}
  assert.ok(blocked);await clients[0].query('commit');const automaticResult=await automatic;
  assert.equal(automaticResult.rows[0].result.document_no,'20261105-2');
  pass('Observed supplier-namespace lock between manual reservation and automatic allocation; auto safely skips reserved number');
 }
 await writeFile(path.join(out,testEditableNumbers?'receipt-number-concurrency-results.json':'concurrency-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),version:(await base.query('select version()')).rows[0].version,environment:'new isolated localhost PostgreSQL; synthetic fixtures',results},null,2));
}catch(error){console.error(error.message,error.where||'');process.exitCode=1;}
finally{for(const c of clients)await c.end();if(base)await base.end();if(started)await execute('pg_ctl',['-D',data,'-m','fast','-w','stop']);useIsolatedDatabaseFactory(undefined);}
