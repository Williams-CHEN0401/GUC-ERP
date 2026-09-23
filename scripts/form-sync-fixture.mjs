// Local synthetic database only; no production credentials or external writes.
import {readFile} from 'node:fs/promises';
import {independentDatabase} from './independent-work-fixture.mjs';
import {sql,definition,ids} from './worklog-save-fixture.mjs';
export const equipmentTypeMigration='20260923050521_equipment_testing_maintenance_event.sql';
export const typeBaselineSources={
  "upsert_project_site_work_log_v1": "20260913140234_site_survey_work_type.sql",
  "upsert_customer_project_work_log_v2": "20260913140234_site_survey_work_type.sql",
  "upsert_project_site_work_log_v2": "20260913140234_site_survey_work_type.sql",
  "upsert_customer_project_work_log_v3": "20260923003902_independent_work_log_pickup_project.sql",
  "upsert_erp_project_with_workers_v2": "20260922103001_preserve_daily_work_log_type.sql",
  "create_project_auto_number_v1": "20260913140234_site_survey_work_type.sql",
  "upsert_customer_project_work_log_department_v1": "20260916001938_worklog_title_selection.sql",
  "erp_work_content_types_v1": "20260915150407_shared_work_types_and_worklog_rename.sql",
  "create_work_assignment_with_project_v1": "20260917003129_work_assignment_manual_project.sql"
};
export const syncOperatorId='10000000-0000-4000-8000-000000000004';
export async function formSyncDatabase({fixed=true}={}){
 const db=await independentDatabase();
 await db.exec(await sql('20260923004454_fix_project_soft_delete_audit.sql'));
 for(const [name,file] of Object.entries(typeBaselineSources)){
  if(!(await db.query("select 1 from pg_proc where pronamespace='public'::regnamespace and proname=$1",[name])).rows.length){
   await db.exec(definition(await sql(file),name));
   const [{signature}]=(await db.query("select oid::regprocedure::text signature from pg_proc where pronamespace='public'::regnamespace and proname=$1",[name])).rows;
   await db.exec('revoke all on function '+signature+' from public,anon,authenticated;grant execute on function '+signature+' to service_role');
  }
 }
 await db.exec(`
 alter table maintenance_events add constraint maintenance_events_type_check check(event_type in ('SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','REPAIR','REPLACEMENT','INSTALLATION','MAINTENANCE','PROGRAM_CONFIG','INSPECTION','OTHER'));
 alter table projects add constraint projects_project_type_check check(project_type in ('construction','repair','maintenance','delivery','clerical','site_survey'));
 alter table site_work_logs add constraint site_work_logs_work_type_check check(work_type in ('工程施工','維修紀錄','維護保養','送貨','文書作業','場勘'));
 alter table product_categories alter column id set default gen_random_uuid(),add name text,add code_prefix text,add source text,add updated_by text,add row_version integer default 1,add created_at timestamptz default now(),add updated_at timestamptz default now();
 create unique index fixture_category_names on product_categories(lower(btrim(name)));
 alter table inventory_items alter column id set default gen_random_uuid(),add item_name text,add item_type text,add inventory_code text,add brand text,add model text,add unit text default '台',add opening_quantity numeric default 0,add source text,add updated_by text,add row_version integer default 1,add created_at timestamptz default now(),add updated_at timestamptz default now();
 create trigger fixture_category_version before update on product_categories for each row execute function test_version();
 create trigger fixture_item_version before update on inventory_items for each row execute function test_version();
 grant select,insert,update on product_categories,inventory_items to service_role;
 `);
 await db.query("update product_categories set name='電腦設備',code_prefix='T' where id=$1",[ids.category]);
 await db.query("update inventory_items set item_name='查修測試電腦',item_type='電腦設備',inventory_code='T001',brand='測試品牌',model='BASE',opening_quantity=100 where id=$1",[ids.item]);
 await db.query("insert into app_users(id,username,display_name,role) values($1,'fixture-operator','隔離測試員 B','operator')",[syncOperatorId]);
 await db.exec(definition(await sql('20260909010509_delivery_maintenance_category_crud.sql'),'create_product_category_v1'));
 await db.exec(await readFile(new URL('./fixtures/inventory-batch-baseline.sql',import.meta.url),'utf8'));
 for(const name of ['create_product_category_v1','create_inventory_items_batch_v1']){
  const [{signature}]=(await db.query("select oid::regprocedure::text signature from pg_proc where pronamespace='public'::regnamespace and proname=$1",[name])).rows;
  await db.exec('revoke all on function '+signature+' from public,anon,authenticated;grant execute on function '+signature+' to service_role');
 }
 if(fixed)await db.exec(await sql(equipmentTypeMigration));
 return db;
}
