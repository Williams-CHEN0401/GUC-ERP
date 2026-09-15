// Production function bodies + minimal isolated tables. Never connects to production.
import {readFile} from 'node:fs/promises';
import {worklogDatabase,ids,sql} from './worklog-save-fixture.mjs';
export const departmentMigration='20260914223754_fix_department_cross_system_boundaries.sql';
export const extraIds={otherCustomer:'40000000-0000-4000-8000-000000000001',otherDepartment:'40000000-0000-4000-8000-000000000002',secondDepartment:'40000000-0000-4000-8000-000000000003',emptyCustomer:'40000000-0000-4000-8000-000000000004',supplier:'40000000-0000-4000-8000-000000000005'};
export async function departmentDatabase({fixed=true}={}){
 const db=await worklogDatabase();
 await db.exec(`
 alter table projects add project_date date default '2026-09-15';
 alter table project_workers add is_assignee boolean default true;
 create unique index project_workers_uq on project_workers(project_id,user_id);
 alter table audit_logs add actor_user_id uuid,add system_module text;
 create table suppliers(id uuid primary key,name text);
 alter table repair_items add serial_number text,add supplier_id uuid references suppliers,add sent_to_supplier_on date,
 add returned_from_supplier_on date,add returned_to_customer_on date,add supplier_reference text,add repair_no text;
 alter table stock_receipts add receipt_date date,add inventory_item_id uuid references inventory_items,add quantity numeric,
 add supplier_id uuid references suppliers,add supplier text,add source text,add updated_by text;
 create trigger receipt_version before update on stock_receipts for each row execute function test_version();
 create table quotations(id uuid primary key default gen_random_uuid(),project_id uuid references projects,customer_id uuid references customers,
 archived_at timestamptz,quote_status text default 'completed',updated_by_user_id uuid);
 create function quotation_has_billing_v1(uuid) returns boolean language sql as $$ select false $$;
 create function normalize_work_content_name_v1(text) returns text language sql immutable as $$ select lower(btrim($1)) $$;
 grant select,insert,update,delete on suppliers to service_role;
 grant select,insert,update on customer_departments to service_role;
 revoke all on quotations from public,anon,authenticated,service_role;
 alter table quotations enable row level security;
 alter table quotations force row level security;
 alter table repair_items force row level security;
 `);
 await db.exec(await readFile(new URL('./fixtures/department-cross-system-baseline.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('./fixtures/department-writers-baseline.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('./fixtures/receipt-writer-baseline.sql',import.meta.url),'utf8'));
 await db.exec(`
 create trigger quotation_project_department_guard before update of department_id on projects for each row execute function quotation_project_department_guard_v1();
 create trigger work_content_quotation_tracking after insert or update of customer_id,name,project_type,project_date on projects for each row execute function audit_work_content_tracking_v1();
 create trigger work_content_quotation_delete_guard before delete on projects for each row execute function audit_work_content_tracking_v1();
 `);
 const functions=(await db.query("select oid::regprocedure::text signature from pg_proc where pronamespace='public'::regnamespace and proname in ('audit_work_content_tracking_v1','quotation_project_department_guard_v1','upsert_repair_item_v1','upsert_erp_project_with_workers_v2','upsert_erp_project_with_workers_v3','upsert_erp_project_with_workers_v4','set_receipt_customers_v1','create_stock_receipts_with_customers_v1','update_stock_receipt_with_customers_v1','update_stock_receipt_record_v2')")).rows;
 for(const {signature} of functions)await db.exec(`revoke all on function ${signature} from public,anon,authenticated;grant execute on function ${signature} to service_role;`);
 await db.query("insert into customers(id,name,customer_code,customer_category) values($1,'另一客戶（隔離）','TEST-OTHER','school'),($2,'無科室客戶（隔離）','TEST-EMPTY','school')",[extraIds.otherCustomer,extraIds.emptyCustomer]);
 await db.query("insert into customer_departments(id,customer_id,name) values($1,$2,'資訊室'),($3,$4,'資訊室')",[extraIds.otherDepartment,extraIds.otherCustomer,extraIds.secondDepartment,ids.customer]);
 await db.query("insert into suppliers values($1,'隔離供應商')",[extraIds.supplier]);
 if(fixed)await db.exec(await sql(departmentMigration));
 return db;
}
export async function callAsService(db,name,args){
 if(!/^[a-z_0-9]+$/.test(name))throw Error('Invalid fixture function');
 await db.exec('set role service_role');
 try{return(await db.query('select to_jsonb('+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+')) result',args)).rows[0].result;}
 finally{await db.exec('reset role');}
}
export const repairArgs=({id=null,version=null,customer=ids.customer,department=ids.department,notes='科室測試'}={})=>[id,version,'2026-09-15',customer,ids.item,1,'','檢查設備',null,null,null,null,'received','',notes,'fixture-admin',department];
export const projectArgs=({id=null,version=null,customer=ids.customer,department=ids.department,name='科室工作',type='construction'}={})=>[id,version,name,customer,type,'in_progress','',null,'',[ids.actor],'fixture-admin','2026-09-15',null,department,true];
