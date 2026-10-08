// Cross-repository integration: real current quotation and ERP migrations/RPCs.
// All identities, records and Postgres storage are synthetic in-memory PGlite.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {sql,definition} from './worklog-save-fixture.mjs';
const quotationRoot=process.env.QUOTATION_REPO_PATH||resolve('../GUC-Quotation-search-sort-0926');
const qImport=path=>import(pathToFileURL(resolve(quotationRoot,path)).href);
const {multiWorkDatabase}=await qImport('tests/multi-work-fixture.mjs');
const {actor,outsider,customer,project,createQuote}=await qImport('tests/database-fixture.mjs');
const {quotationGateway,rpcCall}=await qImport('tests/gateway-fixture.mjs');
const db=await multiWorkDatabase();
const rpc=(name,parameters)=>rpcCall(db,name,parameters);
const results=[],pass=label=>{results.push(label);console.log('PASS '+label);};
try{
 await db.exec(`
 alter table customers add row_version integer default 1,add updated_at timestamptz default now();
 alter table site_work_logs add reporter_user_id uuid references app_users;
 alter table project_workers add can_create_work_log boolean default false,add can_update_work_log boolean default false,add can_delete_work_log boolean default false;
 create table stock_receipts(id uuid primary key,inventory_item_id uuid,quantity numeric);
 create table stock_receipt_customers(stock_receipt_id uuid references stock_receipts,customer_id uuid references customers);
 create table sites(id uuid primary key,customer_id uuid references customers,project_id uuid references projects,contract_service_type_id uuid,status text);
 create table site_devices(id uuid primary key,site_id uuid references sites,device_type text,device_brand text,device_model text,cabinet text,network_cable_no text,deleted_at timestamptz);
 create table equipment_registry(id uuid primary key,customer_id uuid references customers,service_id uuid,site_id uuid references sites,source_table text,source_id uuid,status text,equipment_type text,search_key text,display_name text);
 create table maintenance_event_equipment(event_id uuid references maintenance_events,equipment_id uuid references equipment_registry);
 create table maintenance_event_workers(event_id uuid references maintenance_events,user_id uuid references app_users);
 create table phone_terminal_versions(id uuid primary key,customer_id uuid references customers,version_no integer);
 alter table maintenance_events add service_id uuid,add event_type text,add cause text,add notes text,add phone_terminal_version_id uuid references phone_terminal_versions,add row_version integer default 1,add created_at timestamptz default now(),add updated_at timestamptz default now();
 create table contract_service_types(id uuid primary key,code text,is_active boolean);
 create table customer_contract_services(customer_id uuid references customers,service_type_id uuid references contract_service_types,is_active boolean);
 `);
 // Existing ERP project-RBAC implementation, not a permissive test stub.
 await db.exec(definition(await sql('20260908060047_role_permissions_project_scope.sql'),'has_project_permission_v1'));
 await db.exec(await sql('20261004152032_erp_private_data_access.sql'));
 for(const [file,name] of [
  ['20260914130833_add_maintenance_handling_process.sql','get_equipment_history_v1'],
  ['20260907155544_customer_services_and_shared_history.sql','search_equipment_history_v1'],
  ['20260908064210_customer_filters_phone_versions_purchase_customers.sql','monitoring_customer_filters_v1']])await db.exec(definition(await sql(file),name));
 await db.exec(`revoke all on function get_equipment_history_v1(text,uuid),search_equipment_history_v1(uuid,uuid,text,text,integer),monitoring_customer_filters_v1(uuid) from public,anon,authenticated;grant execute on function get_equipment_history_v1(text,uuid),search_equipment_history_v1(uuid,uuid,text,text,integer),monitoring_customer_filters_v1(uuid) to service_role;`);
 await db.exec(await sql('20261005005222_cross_system_private_access.sql'));
 await db.exec(await readFile(resolve(quotationRoot,'supabase/migrations/20261005005228_quotation_private_access.sql'),'utf8'));

 await db.exec("alter table projects add column if not exists deleted_at timestamptz");
 await db.exec(await readFile(resolve(quotationRoot,'supabase/migrations/20261008000705_accounting_quotation_lifecycle.sql'),'utf8'));
 let detail=await createQuote(db),id=detail.quotation.id;
 detail=await rpc('update_quotation_status_v1',{p_actor_user_id:actor,p_quotation_id:id,p_expected_row_version:detail.quotation.row_version,p_status:'confirmed',p_note:null});
 detail=await rpc('update_quotation_billing_status_v1',{p_actor_user_id:actor,p_quotation_id:id,p_expected_row_version:detail.quotation.row_version,p_status:'in_progress',p_note:null});

 detail=await rpc('update_quotation_billing_status_v1',{p_actor_user_id:actor,p_quotation_id:id,p_expected_row_version:detail.quotation.row_version,p_status:'unbilled',p_note:null});
 assert.equal(detail.quotation.id,id);assert.equal(detail.quotation.quote_status,'confirmed');assert.equal(detail.quotation.can_edit,true);
 const v=detail.current_version;
 detail=await rpc('update_quotation_v1',{p_actor_user_id:actor,p_quotation_id:id,p_expected_quotation_row_version:detail.quotation.row_version,p_expected_version_row_version:v.row_version,p_customer_id:customer,p_project_id:project,p_owner_user_id:actor,p_contact_id:null,p_quote_date:'2026-10-08',p_valid_until:'2026-11-08',p_discount_twd:0,p_tax_rate_basis_points:500,p_note:'退回後修改',p_items:JSON.stringify([{description:'新數量價格',quantity_milli:2000,unit:'式',unit_price_twd:1234}])});
 assert.equal(detail.quotation.id,id);assert.equal(Number(detail.current_version.subtotal_twd),2468);
 assert.equal(detail.billing_history[0].note,null);
 for(const note of ['', '   ', '客戶修改']){
  detail=await rpc('update_quotation_billing_status_v1',{p_actor_user_id:actor,p_quotation_id:id,p_expected_row_version:detail.quotation.row_version,p_status:'in_progress',p_note:null});
  const previousVersion=detail.quotation.row_version;
  detail=await rpc('update_quotation_billing_status_v1',{p_actor_user_id:actor,p_quotation_id:id,p_expected_row_version:previousVersion,p_status:'unbilled',p_note:note});
  assert.equal(detail.billing_history[0].note,note.trim()||null);
  assert.equal(detail.quotation.id,id);
  await assert.rejects(rpc('update_quotation_billing_status_v1',{p_actor_user_id:actor,p_quotation_id:id,p_expected_row_version:previousVersion,p_status:'in_progress',p_note:null}),/重新載入/);
 }
 pass('confirmed → billing → confirmed, same ID, optional reason, editable quantities/prices and totals');
 detail=await rpc('update_quotation_invoice_v1',{p_actor_user_id:actor,p_quotation_id:id,p_expected_row_version:detail.quotation.row_version,p_invoice_date:'2026-10-08',p_invoice_number:'AA12345678',p_billing_note:'正式憑證'});
 await assert.rejects(rpc('update_quotation_billing_status_v1',{p_actor_user_id:actor,p_quotation_id:id,p_expected_row_version:detail.quotation.row_version,p_status:'unbilled',p_note:'不可退'}),/發票/);
 assert.equal((await db.query('select invoice_number from quotations where id=$1',[id])).rows[0].invoice_number,'AA12345678');
 for(const target of ['partial','in_progress','completed','partial']){
  detail=await rpc('update_quotation_billing_status_v1',{p_actor_user_id:actor,p_quotation_id:id,p_expected_row_version:detail.quotation.row_version,p_status:target,p_note:null});
  assert.equal(detail.quotation.billing_status,target);assert.equal(detail.billing_history[0].note,null);
 }
 await assert.rejects(rpc('update_quotation_billing_status_v1',{p_actor_user_id:actor,p_quotation_id:id,p_expected_row_version:detail.quotation.row_version,p_status:'in_progress',p_note:'x'.repeat(1001)}),/1000/);
 pass('issued financial document blocks unbilled rollback; partial/completed corrections accept blank notes while preserving invoice and note limit');
 const extra=randomUUID();
 await db.query("insert into projects(id,customer_id,name,status,project_type,project_date) values($1,$2,'刪除隔離工作','in_progress','repair','2026-10-08')",[extra,customer]);
 const erpBefore=(await db.query('select to_jsonb(p) data from projects p where id=$1',[extra])).rows[0].data;
 const disposable=await createQuote(db,extra),quoteId=disposable.quotation.id;
 const result=await rpc('delete_quotation_v1',{p_actor_user_id:actor,p_quotation_id:quoteId,p_expected_row_version:disposable.quotation.row_version,p_reason:'隔離測試永久刪除'});
 assert.equal(result.deleted,true);
 for(const table of ['quotations','quotation_versions','quotation_items','quotation_work_links','quotation_billing_history','quotation_status_history','quotation_audit_log']){
  const key=table==='quotations'?'id':table==='quotation_items'?'quotation_version_id':'quotation_id';
  const target=table==='quotation_items'?disposable.current_version.id:quoteId;
  assert.equal((await db.query('select count(*)::int n from '+table+' where '+key+'=$1',[target])).rows[0].n,0,table);
 }
 assert.deepEqual((await db.query('select to_jsonb(p) data from projects p where id=$1',[extra])).rows[0].data,erpBefore);
 const options=await rpc('quotation_work_options_v1',{p_actor_user_id:actor});assert.equal(options.projects.some(p=>p.id===extra),false);
 assert.equal((await db.query('select count(*)::int n from quotation_work_content_rows_v1 where work_content_id=$1',[extra])).rows[0].n,0);
 await assert.rejects(createQuote(db,extra),/已刪除/);
 pass('hard delete all quote-owned rows; preserve ERP project; list/options exclude immutable work ID; direct re-creation blocked');
 const sharedProject=randomUUID();
 await db.query("insert into projects(id,customer_id,name,status,project_type,project_date) values($1,$2,'舊新報價共用工作','in_progress','repair','2026-10-08')",[sharedProject,customer]);
 const previous=await createQuote(db,sharedProject);
 const voided=await rpc('void_quotation_v1',{p_actor_user_id:actor,p_quotation_id:previous.quotation.id,p_expected_row_version:previous.quotation.row_version,p_reason:'舊版作廢'});
 const current=await createQuote(db,sharedProject);
 await rpc('delete_quotation_v1',{p_actor_user_id:actor,p_quotation_id:voided.quotation.id,p_expected_row_version:voided.quotation.row_version,p_reason:'刪舊保留新版'});
 assert.equal((await db.query('select count(*)::int n from quotation_all_work_rows_v1 where quotation_id=$1',[current.quotation.id])).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from quotation_unquoted_deletions where project_id=$1',[sharedProject])).rows[0].n,0);
 pass('deleting a voided old quote preserves the valid current quote for the same ERP work');
 console.log('TOTAL '+results.length+' quotation lifecycle groups passed');
}finally{await db.close();}
