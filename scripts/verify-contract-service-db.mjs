import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {contractCatalogDatabase,catalogCall,catalogMigration} from './contract-service-fixture.mjs';
import {ids,sql,sample,saveLog} from './worklog-save-fixture.mjs';
const db=await contractCatalogDatabase({fixed:false});
const all=async table=>(await db.query('select to_jsonb(t) row from '+table+' t order by id')).rows.map(r=>r.row);
try{
 const before=await all('contract_service_types'),links=(await db.query('select * from customer_contract_services')).rows;
 await db.exec(await sql(catalogMigration));
 assert.deepEqual((await all('contract_service_types')).map(({row_version,...r})=>r),before);
 const created=await catalogCall(db,'create',null,' 測試承攬 ',15);assert.match(created.code,/^custom_/);assert.equal(created.name,'測試承攬');
 const edited=await catalogCall(db,'update',created,'更新承攬',20);assert.equal(edited.id,created.id);assert.equal(edited.code,created.code);assert.equal(edited.row_version,2);
 await assert.rejects(catalogCall(db,'update',created,'舊版',1),/更新或刪除/);
 await assert.rejects(catalogCall(db,'create',null,'   ',1),/1–80/);
 await assert.rejects(catalogCall(db,'create',null,'有效名稱',-1),/排序/);
 const caps=await catalogCall(db,'create',null,'SERVICE');await assert.rejects(catalogCall(db,'create',null,'service'),/已存在/);
 await assert.rejects(catalogCall(db,'update',edited,'service'),/已存在/);
 await catalogCall(db,'delete',caps,null);
 await assert.rejects(db.query('update contract_service_types set code=$1 where id=$2',['rewritten',edited.id]),/代碼不可變更/);
 const currentCustomer=(await db.query('select * from customers where id=$1',[ids.customer])).rows[0];
 await db.query("select update_customer_with_contracts_v1($1,$2,'school',$3,null,null,null,null,$4,'fixture-admin')",[ids.customer,currentCustomer.row_version,currentCustomer.name,['computer',edited.code]]);
 const work=sample();work.maintenance_events[0].service_id=edited.id;
 const saved=await saveLog(db,work);assert.ok(saved.work_log.id);
 const logBefore=await all('site_work_logs'),eventBefore=await all('maintenance_events');
 const renamed=await catalogCall(db,'update',edited,'最後承攬名稱',30);
 assert.deepEqual(await all('site_work_logs'),logBefore);assert.deepEqual(await all('maintenance_events'),eventBefore);
 const joined=(await db.query('select t.name from maintenance_events e join contract_service_types t on t.id=e.service_id where e.work_log_id=$1',[saved.work_log.id])).rows[0];assert.equal(joined.name,renamed.name);
 await assert.rejects(catalogCall(db,'delete',renamed,null),/已有客戶/);
 const inactive=await catalogCall(db,'create',null,'停用關聯仍受保護');await db.query('insert into customer_contract_services(customer_id,service_type_id,is_active) values($1,$2,false)',[ids.customer,inactive.id]);
 await assert.rejects(catalogCall(db,'delete',inactive,null),/已有客戶/);
 for(const table of ['sites','equipment_registry','maintenance_events','phone_terminal_import_logs','phone_terminal_versions']){
  const item=await catalogCall(db,'create',null,table+' 歷史保護');const column=['sites','phone_terminal_import_logs'].includes(table)?'contract_service_type_id':'service_id';
  await db.query('insert into '+table+'(id,'+column+') values($1,$2)',[randomUUID(),item.id]);await assert.rejects(catalogCall(db,'delete',item,null),/歷史紀錄/);
 }
 const unused=await catalogCall(db,'create',null,'可刪除');await catalogCall(db,'delete',unused,null);assert.equal((await db.query('select 1 from contract_service_types where id=$1',[unused.id])).rows.length,0);
 for(const code of ['phone_system','surveillance']){const r=(await db.query('select * from contract_service_types where code=$1',[code])).rows[0];await assert.rejects(catalogCall(db,'delete',r,null),/系統必要/);}
 assert.equal((await db.query("select count(*)::int n from audit_logs where entity_type='contract_service_types' and actor='fixture-admin'")).rows[0].n>3,true);
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);await assert.rejects(db.query("select manage_contract_service_type_v1('create',null,null,'拒絕',1,'fake')"),/permission denied/);await assert.rejects(db.query('select * from contract_service_types'),/permission denied/);await db.exec('reset role');
 }
 assert.equal(links.length,1);assert.ok((await db.query('select 1 from customer_contract_services where service_type_id=$1',[ids.service])).rows.length);
 console.log('PASS catalog SQL: preserves baseline; CRUD; immutable identity; duplicate/stale rejection; actual customer assignment/work-log creation and live label join; inactive/historical/system delete guards; audit; RLS/client denial.');
}finally{await db.close();}
