// Isolated PostgreSQL-WASM only. Current maintenance SQL is real; unrelated legacy entrypoints are fixture adapters.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
const migration=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const value=async(sql,params=[])=>(await db.query(sql,params)).rows[0];
try {
 await db.exec(`
 create role anon; create role authenticated; create role service_role bypassrls;
 create table customers(id uuid primary key);
 create table projects(id uuid primary key default gen_random_uuid(),customer_id uuid references customers,name text,row_version integer default 1,updated_by text,construction_category text);
 create unique index project_name_uq on projects(customer_id,lower(btrim(name)));
 create table site_work_logs(id uuid primary key default gen_random_uuid(),project_id uuid references projects,summary text,row_version integer default 1);
 create table customer_contract_services(customer_id uuid,service_type_id uuid);
 create table product_categories(id uuid primary key,is_active boolean default true);
 create table inventory_items(id uuid primary key,category_id uuid references product_categories);
 create table app_users(id uuid primary key,username text,display_name text,is_active boolean default true);
 create table phone_terminal_versions(id uuid primary key,version_no integer);
 create table equipment_registry(id uuid primary key,customer_id uuid,service_id uuid,source_table text,source_id uuid,status text default 'active');
 create table maintenance_events(id uuid primary key default gen_random_uuid(),work_log_id uuid references site_work_logs,service_id uuid,event_type text,occurred_at date,
 description text,cause text,result text,notes text,inventory_category_id uuid,inventory_item_id uuid,phone_terminal_version_id uuid,
 status text default 'active',row_version integer default 1,created_by uuid,updated_by uuid,created_at timestamptz default now(),updated_at timestamptz default now());
 create table maintenance_event_equipment(event_id uuid,equipment_id uuid,primary key(event_id,equipment_id));
 create table maintenance_event_workers(event_id uuid,user_id uuid,primary key(event_id,user_id));
 create table repair_items(id uuid primary key default gen_random_uuid(),customer_id uuid references customers,inventory_item_id uuid,notes text,received_on date,quantity numeric,status text,
 issue_description text,source_maintenance_event_id uuid,source text,updated_by text,row_version integer default 1);
 create table work_log_save_requests(request_id uuid primary key,reporter_id uuid,request_payload jsonb,result jsonb);
 create table stock_receipts(id uuid primary key default gen_random_uuid(),row_version integer default 1,note text);
 create table stock_receipt_customers(stock_receipt_id uuid references stock_receipts,customer_id uuid references customers,created_by uuid,created_at timestamptz default now(),primary key(stock_receipt_id,customer_id));
 create table audit_logs(id bigint generated always as identity primary key,entity_type text,entity_id uuid,action text,before_data jsonb,after_data jsonb,source text,actor text);
 create schema audit_internal;
 create function audit_internal.capture_links() returns trigger language plpgsql security definer as $$ begin
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data) values(tg_table_name,new.id,lower(tg_op),case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new));return new;end $$;
 create function public.test_version() returns trigger language plpgsql as $$ begin new.row_version:=old.row_version+1;return new;end $$;
 create trigger project_version before update on projects for each row execute function test_version();
 create trigger repair_version before update on repair_items for each row execute function test_version();
 create trigger event_version before update on maintenance_events for each row execute function test_version();
 create function public.has_app_permission_v1(uuid,text,text) returns boolean language sql as $$ select $1 is not null $$;
 create function public.assert_work_log_access_v1(uuid,uuid,uuid,text) returns void language plpgsql as $$ begin if $1 is null then raise exception 'permission denied';end if;end $$;
 create function public.create_project_auto_number_v1(text,uuid,text,text,text,text,numeric,text,text) returns projects language plpgsql as $$ declare v projects;begin
 insert into projects(name,customer_id,updated_by) values($1,$2,$9) returning * into v;return v;end $$;
 create function public.upsert_erp_project_with_workers_v4(uuid,integer,text,uuid,text,text,text,numeric,text,uuid[],text,date,text)
 returns jsonb language plpgsql as $$ declare v projects;begin
 if $1 is null then insert into projects(name,customer_id,updated_by,construction_category) values($3,$4,$11,$13) returning * into v;
 else update projects set name=$3,customer_id=$4,updated_by=$11,construction_category=$13 where id=$1 and row_version=$2 returning * into v;if not found then raise exception 'stale project';end if;end if;
 return jsonb_build_object('project',to_jsonb(v));end $$;
 create function public.upsert_erp_project_with_workers_v3(uuid,integer,text,uuid,text,text,text,numeric,text,uuid[],text,date)
 returns jsonb language plpgsql as $$ begin return upsert_erp_project_with_workers_v4($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,(select construction_category from projects where id=$1));end $$;
 create function public.upsert_repair_item_v1(uuid,integer,date,uuid,uuid,integer,text,text,uuid,date,date,date,text,text,text,text)
 returns repair_items language plpgsql as $$ declare v repair_items;begin
 if $1 is null then insert into repair_items(customer_id,received_on,inventory_item_id,quantity,issue_description,status,notes,updated_by) values($4,$3,$5,$6,$8,$13,$15,$16) returning * into v;
 else update repair_items set customer_id=$4,notes=$15,updated_by=$16 where id=$1 and row_version=$2 returning * into v;if not found then raise exception 'stale repair';end if;end if;return v;end $$;
 create function public.upsert_customer_project_work_log_v3(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,text)
 returns jsonb language plpgsql as $$ declare v_project uuid;v site_work_logs;begin
 if $1 is not null then select project_id into v_project from site_work_logs where id=$1;
 elsif $3 is not null then v_project:=$3;
 else select id into v_project from projects where customer_id=$4 and lower(btrim(name))=lower(btrim($5));
 if v_project is null then insert into projects(customer_id,name) values($4,$5) returning id into v_project;end if;end if;
 if $1 is null then insert into site_work_logs(project_id,summary) values(v_project,$8) returning * into v;
 else update site_work_logs set summary=$8,row_version=row_version+1 where id=$1 and row_version=$2 returning * into v;if not found then raise exception 'stale work log';end if;end if;
 return jsonb_build_object('work_log',to_jsonb(v));end $$;
 create function public.set_receipt_customers_v1(uuid,uuid[],uuid) returns void language plpgsql as $$ begin
 delete from stock_receipt_customers where stock_receipt_id=$1 and not(customer_id=any($2));
 insert into stock_receipt_customers(stock_receipt_id,customer_id,created_by) select $1,id,$3 from unnest($2) id on conflict do nothing;end $$;
 create function public.create_stock_receipts_with_customers_v1(jsonb,uuid[],uuid) returns jsonb language plpgsql as $$ declare v_id uuid;v_ids uuid[]:='{}';v_row jsonb;begin
 for v_row in select value from jsonb_array_elements($1) loop insert into stock_receipts(note) values(v_row->>'note') returning id into v_id;
 perform set_receipt_customers_v1(v_id,$2,$3);v_ids:=array_append(v_ids,v_id);end loop;
 return jsonb_build_object('ids',v_ids,'created',cardinality(v_ids));end $$;
 create function public.update_stock_receipt_with_customers_v1(uuid,integer,date,uuid,numeric,uuid,text,uuid[],uuid) returns jsonb language plpgsql as $$ declare v stock_receipts;begin
 update stock_receipts set note=$7,row_version=row_version+1 where id=$1 and row_version=$2 returning * into v;if not found then raise exception 'stale receipt';end if;
 if $8 is not null then perform set_receipt_customers_v1($1,$8,$9);end if;return to_jsonb(v);end $$;
 `.replaceAll('language plpgsql as $$',()=> 'language plpgsql set search_path=public as $$'));
 await db.exec(await migration('20260914130833_add_maintenance_handling_process.sql'));
 await db.exec(await migration('20260914120540_customer_department_selection.sql'));
 const c1=randomUUID(),c2=randomUUID(),c3=randomUUID(),actor=randomUUID(),service=randomUUID(),category=randomUUID(),item=randomUUID();
 await db.query('insert into customers values($1),($2),($3)',[c1,c2,c3]);
 await db.query("insert into app_users values($1,'fixture','測試員',true)",[actor]);
 await db.query('insert into customer_contract_services values($1,$2)',[c1,service]);
 await db.query('insert into product_categories values($1,true)',[category]);
 await db.query('insert into inventory_items values($1,$2)',[item,category]);
 const manage=async(action,id,version,customer,name,active=true)=>(await value('select to_jsonb(public.manage_customer_department_v1($1,$2,$3,$4,$5,$6,\'fixture\')) result',[action,id,version,customer,name,active])).result;
 const dep=await manage('create',null,null,c1,'資訊室'),dep2=await manage('create',null,null,c2,'資訊室');
 await assert.rejects(manage('create',null,null,c1,' 資訊室 '),/已有相同/);
 await assert.rejects(manage('update',dep.id,7,c1,'資訊組'),/已被更新/);
 await assert.rejects(manage('update',dep.id,1,c2,'資訊組'),/不屬於/);
 await assert.rejects(db.query('update customer_departments set customer_id=$1 where id=$2',[c2,dep.id]),/不可移/);
 await assert.rejects(db.query('delete from customer_departments where id=$1',[dep.id]),/不可刪除/);
 const chk=(customer,department,old=null,preserve=false)=>db.query('select assert_customer_department_v1($1,$2,$3,$4)',[customer,department,old,preserve]);
 await chk(c3,null);await chk(c1,null,null,true);
 await assert.rejects(chk(c1,null),/請選擇科室/);
 await assert.rejects(chk(c1,dep2.id),/不屬於/);
 const off=await manage('deactivate',dep.id,1,c1,null);assert.equal(off.is_active,false);assert.equal(off.row_version,2);
 await assert.rejects(chk(c1,dep.id),/已停用/);await chk(c1,dep.id,dep.id,true);
 await manage('update',dep.id,2,c1,'資訊室',true);
 const project=async(id,version,customer,department,name='工程',construction=null,provided=true)=>(await value(`select public.upsert_erp_project_department_v1($1,$2,$3,$4,'construction','in_progress',null,null,null,'{}','fixture','2026-09-14',$6,$5,$7) result`,[id,version,name,customer,department,construction,provided])).result.project;
 const p=await project(null,null,c1,dep.id);assert.equal(p.department_id,dep.id);
 await assert.rejects(project(null,null,c1,null),/請選擇科室/);
 await assert.rejects(project(p.id,1,c1,dep.id),/stale project/);
 const p2=await project(p.id,p.row_version,c2,dep2.id);assert.equal(p2.customer_id,c2);assert.equal(p2.department_id,dep2.id);
 const classified=await project(null,null,c1,dep.id,'保留工程分類','tender');
 const preserved=await project(classified.id,classified.row_version,c1,dep.id,'保留工程分類',null,false);
 assert.equal(preserved.construction_category,'tender','omitted construction category preserves existing value');
 const cleared=await project(preserved.id,preserved.row_version,c1,dep.id,'保留工程分類',null,true);
 assert.equal(cleared.construction_category,null,'explicit null clears construction category');
 await assert.rejects(project(cleared.id,preserved.row_version,c1,dep.id,'保留工程分類',null,false),/stale project/);
 await assert.rejects(db.query('insert into projects(customer_id,name,department_id) values($1,\'bad\',$2)',[c1,dep2.id]),/foreign key/);
 const log=(name,dept,request,events=[],id=null,version=null,pid=null)=>value(`select upsert_customer_project_work_log_department_v1($1,$2,$3,$4,$5,'2026-09-14','維修紀錄','摘要','上午','in_progress',array[$6::uuid],$6,$7::jsonb,'fixture',$8,$9) result`,[id,version,pid,c1,name,actor,JSON.stringify(events),dept,request]);
 const event={service_id:service,event_type:'REPAIR',occurred_at:'2026-09-14',description:'摘要',cause:'測試故障',handling_process:'完整保留處理流程',result:'已處理',inventory_category_id:category,inventory_item_id:item,equipment_ids:[],worker_user_ids:[]};
 const req=randomUUID(),first=(await log('日誌測試',dep.id,req,[event])).result;
 assert.equal(first.project.department_id,dep.id);assert.equal(first.created_repair_item_ids.length,1);
 assert.equal((await value('select department_id from repair_items where id=$1',[first.created_repair_item_ids[0]])).department_id,dep.id);
 assert.equal((await value('select handling_process from maintenance_events where id=$1',[first.maintenance_event_ids[0]])).handling_process,event.handling_process);
 assert.deepEqual((await log('日誌測試',dep.id,req,[event])).result,first);
 await assert.rejects(log('日誌測試',null,req,[event]),/識別碼已使用/);
 await assert.rejects(log('日誌測試',null,randomUUID()),/科室不相符/);
 const counts=await value('select (select count(*) from projects)::int projects,(select count(*) from site_work_logs)::int logs');
 await assert.rejects(log('應回滾',dep.id,randomUUID(),[{...event,result:''}]),/內容/);
 assert.deepEqual(await value('select (select count(*) from projects)::int projects,(select count(*) from site_work_logs)::int logs'),counts);
 const second=(await log('日誌測試',dep.id,randomUUID(),[{...event,id:first.maintenance_event_ids[0],row_version:1}],first.work_log.id,1,first.project.id)).result;
 assert.equal(second.created_repair_item_ids.length,0);assert.equal((await value('select count(*)::int n from repair_items')).n,1);
 const repairs=async(id,version,customer,department)=>(await value(`select to_jsonb(upsert_repair_item_department_v1($1,$2,'2026-09-14',$3,$4,1,null,'故障',null,null,null,null,'received',null,null,'fixture',$5)) result`,[id,version,customer,item,department])).result;
 const repair=await repairs(null,null,c1,dep.id);assert.equal(repair.department_id,dep.id);
 await assert.rejects(repairs(null,null,c1,dep2.id),/不屬於/);
 await assert.rejects(repairs(repair.id,1,c1,dep.id),/stale repair/);
 const multi=[{customer_id:c1,department_id:dep.id},{customer_id:c2,department_id:dep2.id}];
 const receipt=async(mapping)=>value('select create_stock_receipts_department_v1($1::jsonb,$2::uuid[],$3::jsonb,$4) result',[JSON.stringify([{note:'fixture'}]),[c1,c2],JSON.stringify(mapping),actor]);
 const created=(await receipt(multi)).result,id=created.ids[0];
 assert.equal((await value('select count(*)::int n from stock_receipt_customers where stock_receipt_id=$1 and department_id is not null',[id])).n,2);
 await assert.rejects(receipt([{customer_id:c1,department_id:dep2.id},{customer_id:c2,department_id:dep2.id}]),/不屬於/);
 await assert.rejects(receipt([multi[0],multi[0]]),/逐一對應/);
 assert.equal((await value('select count(*)::int n from stock_receipts')).n,1,'failed receipt insert rolls back');
 const before=await value('select row_version,note from stock_receipts where id=$1',[id]);
 await assert.rejects(value('select update_stock_receipt_department_v1($1,1,\'2026-09-14\',$2,1,$2,\'bad\',$3::uuid[],$4::jsonb,$5)',[id,item,[c1,c2],JSON.stringify([multi[0],{customer_id:c2,department_id:dep.id}]),actor]),/不屬於/);
 assert.deepEqual(await value('select row_version,note from stock_receipts where id=$1',[id]),before);
 await db.query('insert into projects(customer_id,name) values($1,\'舊資料\')',[c1]);
 const legacy=await value('select id,row_version from projects where name=\'舊資料\'');
 assert.equal((await project(legacy.id,legacy.row_version,c1,null,'舊資料')).department_id,null);
 assert.equal((await value('select relrowsecurity from pg_class where oid=\'customer_departments\'::regclass')).relrowsecurity,true);
 for(const role of ['anon','authenticated']){
  assert.equal((await value('select has_table_privilege($1,\'customer_departments\',\'SELECT\') allowed',[role])).allowed,false);
  assert.equal((await value('select count(*)::int n from pg_proc where pronamespace=\'public\'::regnamespace and proname like \'%department%\' and has_function_privilege($1,oid,\'EXECUTE\')',[role])).n,0);
 }
 assert.equal((await value("select has_table_privilege('service_role','customer_departments','DELETE') allowed")).allowed,false);
 assert.ok((await value("select count(*)::int n from audit_logs where entity_type='customer_departments'")).n>=4);
 assert.ok((await value("select count(*)::int n from audit_logs where entity_type='repair_items' and after_data->>'department_id' is not null")).n>=2);
 console.log('PASS departments: CRUD/version/audit/RLS; cross-customer FK; legacy NULL; active selection; atomic project/repair/receipt; real maintenance handling_process and repair inheritance; department-aware request replay/rollback.');
} catch(error) {console.error(error.message, error.where||'', error.detail||'');process.exitCode=1;} finally {await db.close();}
