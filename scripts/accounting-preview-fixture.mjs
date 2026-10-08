// Synthetic Postgres only; no production config or network is loaded.
import {accountingQuotationDatabase} from './accounting-quotation-fixture.mjs';
import {sql,definition} from './worklog-save-fixture.mjs';
import {randomUUID} from 'node:crypto';
export async function accountingPreviewDatabase(){
 const db=await accountingQuotationDatabase();
 await db.exec(`
 alter table projects add column if not exists completed_on date;
 alter table site_work_logs add column if not exists time_period text;
 create table inventory_items(id uuid primary key,item_name text,brand text,model text,unit text);
 create table pickup_records(id uuid primary key,project_id uuid references projects,inventory_item_id uuid references inventory_items,pickup_date date,quantity numeric,created_by_username text);
 alter table stock_receipts add unit_price numeric(14,2),add receipt_date date,add created_at timestamptz default now();
 `);
 const reportSql=await sql('20261008000659_receipt_prices_accounting_reports.sql');
 await db.exec(reportSql.slice(reportSql.indexOf('create table public.accounting_material_prices'),reportSql.indexOf('-- Both websites')));
 await db.exec(definition(await sql('20260915150407_shared_work_types_and_worklog_rename.sql'),'erp_work_content_types_v1'));
 await db.exec(definition(reportSql,'work_content_report_v1'));
 await db.exec(definition(reportSql,'save_accounting_material_price_v1'));
 const actor='10000000-0000-4000-8000-000000000001',customer='20000000-0000-4000-8000-000000000001',project='30000000-0000-4000-8000-000000000001',item=randomUUID();
 await db.query("update projects set project_code='TEST-1008',name='一號大樓監控工程（隔離）',created_at='2026-10-01',project_type='construction' where id=$1",[project]);
 await db.query("insert into inventory_items values($1,'測試攝影機','GUC','DEMO','台')",[item]);
 await db.query("insert into stock_receipts(id,inventory_item_id,quantity,unit_price,receipt_date) values($1,$2,10,2800,'2026-10-01'),($3,$2,10,3200,'2026-10-07')",[randomUUID(),item,randomUUID()]);
 await db.query("insert into pickup_records values($1,$2,$3,'2026-10-08',3,'williams'),($4,$2,$3,'2026-10-08',2,'williams')",[randomUUID(),project,item,randomUUID()]);
 for(const date of ['2026-10-07','2026-10-08','2026-10-08']){
 const id=randomUUID();await db.query("insert into site_work_logs(id,project_id,log_date,title,summary,status,work_type) values($1,$2,$3,'配管施工','合成測試施工','completed','工程施工')",[id,project,date]);
 await db.query('insert into site_work_log_workers(work_log_id,user_id) values($1,$2)',[id,actor]);
 }
 for(const type of ['clerical','site_survey'])await db.query("insert into projects(id,customer_id,name,project_type,status,project_date) values($1,$2,$3,$3,'in_progress','2026-10-08')",[randomUUID(),customer,type]);
 return db;
}
