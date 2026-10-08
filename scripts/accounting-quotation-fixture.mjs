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

export async function accountingQuotationDatabase(){
 const db=await multiWorkDatabase();
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

 return db;
}
