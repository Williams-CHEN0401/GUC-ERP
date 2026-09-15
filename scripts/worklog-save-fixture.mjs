// Isolated PostgreSQL-WASM. No network or production credentials.
// Reuse minimal unrelated table adapters, but execute actual ERP permissions,
// numbering entrypoint, log writer, sync triggers, maintenance and replay RPCs.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
export const migrationName='20260914200535_fix_worklog_department_save_boundary.sql';
export const ids={customer:'30000000-0000-4000-8000-000000000001',department:'30000000-0000-4000-8000-000000000002',actor:'10000000-0000-4000-8000-000000000001',viewer:'10000000-0000-4000-8000-000000000002',scoped:'10000000-0000-4000-8000-000000000003',service:'20000000-0000-4000-8000-000000000001',category:'20000000-0000-4000-8000-000000000002',item:'20000000-0000-4000-8000-000000000003'};
export const sql=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
export function definition(source,name){
 const start=source.search(new RegExp('create (?:or replace )?function public\\.'+name+'\\b','i'));
 if(start<0)throw Error('Missing function '+name);
 const tail=source.slice(start),body=/\bas\s+(\$[a-z_]*\$)/i.exec(tail),end=tail.indexOf(body[1],body.index+body[0].length);
 return tail.slice(0,tail.indexOf(';',end+body[1].length)+1).replace(/^create function/i,'create or replace function');
}
export async function worklogDatabase({fixed=true}={}){
 const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite();
 const previous=await readFile(new URL('./verify-customer-departments-db.mjs',import.meta.url),'utf8');
 const setup=previous.split('await db.exec(`')[1].split('`.replaceAll')[0];
 await db.exec(setup.replaceAll('language plpgsql as $$',()=> 'language plpgsql set search_path=public as $$'));
 await db.exec(`
 alter table customers add name text,add customer_code text,add customer_category text;
 alter table app_users add role text default 'admin';
 create table app_roles(code text primary key,project_scoped boolean default false);
 create table role_permissions(role_code text,module text,can_view boolean,can_create boolean,can_update boolean,can_delete boolean);
 create table project_workers(project_id uuid,user_id uuid,can_view boolean,can_create_work_log boolean,can_update_work_log boolean,can_delete_work_log boolean);
 alter table projects add project_code text,add project_type text,add status text,add assigned_to text,add description text,add estimated_cost numeric,add note text,add source text,add created_at timestamptz default now(),add updated_at timestamptz default now();
 create table sites(id uuid primary key default gen_random_uuid(),project_id uuid unique references projects);
 alter table site_work_logs add site_id uuid references sites,add log_date date,add reporter_user_id uuid,add title text,add work_type text,add time_period text,add status text,add source text,add updated_by text,add deleted_at timestamptz,add created_at timestamptz default now();
 create table site_work_log_workers(work_log_id uuid,user_id uuid,primary key(work_log_id,user_id));
 create trigger logs_version before update on site_work_logs for each row execute function test_version();
 create sequence test_number;
 create function next_business_number_value_v1(text) returns bigint language sql as $$ select nextval('public.test_number') $$;
 -- Only site provisioning is adapted to this minimal fixture schema.
 create function ensure_project_site_v1(p_project_id uuid,p_actor text) returns sites language plpgsql as $$
 declare v public.sites;begin
 insert into public.sites(project_id) values(p_project_id) on conflict(project_id) do nothing;
 select * into v from public.sites where project_id=p_project_id;return v;end $$;
 drop function has_app_permission_v1(uuid,text,text);
 drop function assert_work_log_access_v1(uuid,uuid,uuid,text);
 drop function create_project_auto_number_v1(text,uuid,text,text,text,text,numeric,text,text);
 drop function upsert_customer_project_work_log_v3(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,text);
 `);
 const access=await sql('20260908060047_role_permissions_project_scope.sql');
 for(const name of ['has_app_permission_v1','has_project_permission_v1','assert_work_log_access_v1','upsert_customer_project_work_log_with_maintenance_v2'])await db.exec(definition(access,name));
 const current=await sql('20260913140234_site_survey_work_type.sql');
 for(const name of ['create_project_auto_number_v1','upsert_customer_project_work_log_v3','upsert_project_site_work_log_v2','sync_project_fields_to_work_logs_v1','sync_work_log_fields_to_project_v1'])await db.exec(definition(current,name));
 await db.exec(definition(await sql('20260828000200_standalone_work_logs_contracts_accounts_nas.sql'),'set_site_work_log_project_id_v1'));
 await db.exec(`
 create trigger log_project_link before insert or update of site_id on site_work_logs for each row execute function set_site_work_log_project_id_v1();
 create trigger project_sync after insert or update of project_type,status on projects for each row execute function sync_project_fields_to_work_logs_v1();
 create trigger worklog_sync after insert or update of project_id,work_type,status on site_work_logs for each row execute function sync_work_log_fields_to_project_v1();
 `);
 await db.exec(await sql('20260914130833_add_maintenance_handling_process.sql'));
 await db.exec(await sql('20260914120540_customer_department_selection.sql'));
 await db.exec(`
 grant usage on schema public to service_role;
 grant select,insert,update,delete on all tables in schema public to service_role;
 grant usage,select on all sequences in schema public to service_role;
 revoke all on work_log_save_requests,repair_items from public,anon,authenticated,service_role;
 grant select on repair_items to service_role;
 alter table work_log_save_requests enable row level security;
 alter table work_log_save_requests force row level security;
 alter table repair_items enable row level security;
 `);
 const signatures=(await db.query("select oid::regprocedure::text signature from pg_proc where pronamespace='public'::regnamespace and proname in ('upsert_customer_project_work_log_with_maintenance_v1','upsert_customer_project_work_log_with_maintenance_v2','upsert_customer_project_work_log_v3','upsert_project_site_work_log_v2','create_project_auto_number_v1','has_app_permission_v1','has_project_permission_v1','assert_work_log_access_v1')")).rows;
 for(const {signature} of signatures)await db.exec(`revoke all on function ${signature} from public,anon,authenticated;grant execute on function ${signature} to service_role;`);
 await db.query('insert into customers(id,name,customer_code,customer_category) values($1,$2,$3,$4)',[ids.customer,'國立高雄大學','TEST-NUK','school']);
 await db.query('insert into customer_departments(id,customer_id,name) values($1,$2,$3)',[ids.department,ids.customer,'應用數學系']);
 await db.exec("insert into app_roles values('admin',false),('viewer',false),('scoped',true);insert into role_permissions values('scoped','worklogs',true,true,true,false)");
 for(const [id,role] of [[ids.actor,'admin'],[ids.viewer,'viewer'],[ids.scoped,'scoped']])await db.query('insert into app_users(id,username,display_name,role) values($1,$2,$3,$4)',[id,'fixture-'+role,'隔離測試員-'+role,role]);
 await db.query('insert into customer_contract_services values($1,$2)',[ids.customer,ids.service]);
 await db.query('insert into product_categories values($1,true)',[ids.category]);
 await db.query('insert into inventory_items values($1,$2)',[ids.item,ids.category]);
 if(fixed)await db.exec(await sql(migrationName));
 return db;
}
export const sample=()=>({request_id:randomUUID(),id:null,row_version:null,project_id:null,customer_id:ids.customer,department_id:ids.department,project_name:'應用數學系設備查修（隔離測試）',log_date:'2026-09-15',time_period:'上午',work_type:'維修紀錄',summary:'測試故障\n檢查設定並完成測試',status:'in_progress',worker_user_ids:[ids.actor],maintenance_events:[{id:null,row_version:null,service_id:ids.service,event_type:'REPAIR',occurred_at:'2026-09-15',description:'測試故障\n檢查設定並完成測試',cause:'測試故障',handling_process:'檢查設定並完成測試',result:'檢查設定並完成測試',equipment_ids:[],worker_user_ids:[],inventory_category_id:ids.category,inventory_item_id:ids.item}]});
export async function saveLog(db,payload,actor=ids.actor){
 const keys=['id','row_version','project_id','customer_id','project_name','log_date','work_type','summary','time_period','status','worker_user_ids'];
 const args=[...keys.map(k=>payload[k]??null),actor,JSON.stringify(payload.maintenance_events??[]),'fixture-admin',payload.department_id??null,payload.request_id??null];
 await db.exec('set role service_role');
 try{return(await db.query('select upsert_customer_project_work_log_department_v1('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args)).rows[0].result;}
 finally{await db.exec('reset role');}
}
