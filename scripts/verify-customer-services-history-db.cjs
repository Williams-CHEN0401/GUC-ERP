// Executes the changed SQL in isolated PostgreSQL. The pre-existing work-log RPC is a test adapter.
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const fs=require('node:fs'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
(async()=>{const db=new PGlite();try{
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create table app_users(id uuid primary key,username text,display_name text,role text,is_active boolean);
create table customers(id uuid primary key,updated_at timestamptz default now());
create table projects(id uuid primary key,customer_id uuid);
create table contract_service_types(id uuid primary key,code text,name text,is_active boolean);
create table customer_contract_services(customer_id uuid references customers,service_type_id uuid references contract_service_types,created_at timestamptz default now(),created_by uuid,primary key(customer_id,service_type_id));
create table sites(id uuid primary key,customer_id uuid,contract_service_type_id uuid);
create table phone_systems(id uuid primary key,customer_id uuid,contract_service_type_id uuid);
create table phone_extensions(id uuid primary key,customer_id uuid,contract_service_type_id uuid);
create table equipment_registry(id uuid primary key,customer_id uuid,service_id uuid,status text,display_name text,search_key text,equipment_type text,source_id uuid,source_table text,metadata jsonb);
create table maintenance_events(id uuid primary key default gen_random_uuid(),work_log_id uuid,service_id uuid,event_type text not null,occurred_at date not null,description text not null check(length(description)>0),cause text,result text not null check(length(result)>0),notes text,status text default 'active',row_version integer default 1,created_at timestamptz default now(),updated_at timestamptz default now(),updated_by uuid);
create table maintenance_event_equipment(event_id uuid references maintenance_events,equipment_id uuid references equipment_registry,primary key(event_id,equipment_id));
create table maintenance_event_workers(event_id uuid references maintenance_events,user_id uuid references app_users,primary key(event_id,user_id));
create table audit_logs(id bigserial,entity_type text,entity_id uuid,action text,before_data jsonb,after_data jsonb,source text,actor text);
create function test_version() returns trigger language plpgsql as $$begin new.row_version=old.row_version+1;return new;end$$;
create trigger version before update on maintenance_events for each row execute function test_version();
create function public.update_customer_with_contracts_v1(p_id uuid,p_codes text[]) returns void language plpgsql as $$declare v_codes text[]:=p_codes;begin
delete from public.customer_contract_services where customer_id = p_id;
insert into public.customer_contract_services(customer_id,service_type_id) select p_id,types.id from public.contract_service_types types where types.code = any(v_codes);
end$$;
create table test_dispatch(request_id uuid primary key,result jsonb);
create function public.upsert_customer_project_work_log_with_maintenance_v2(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid) returns jsonb language plpgsql set search_path=public as $$
declare e jsonb:=$13->0;eid uuid;v jsonb;begin
select result into v from test_dispatch where request_id=$15;if found then return v;end if;
insert into maintenance_events(work_log_id,service_id,event_type,occurred_at,description,result) values(gen_random_uuid(),(e->>'service_id')::uuid,e->>'event_type',(e->>'occurred_at')::date,e->>'description',e->>'result') returning id into eid;
insert into maintenance_event_equipment select eid,value::uuid from jsonb_array_elements_text(e->'equipment_ids');
insert into maintenance_event_workers select eid,unnest($11);v:=jsonb_build_object('maintenance_event_ids',jsonb_build_array(eid));insert into test_dispatch values($15,v);return v;end$$;
grant usage on schema public to service_role;grant all on all tables in schema public to service_role;grant usage,select on all sequences in schema public to service_role;
`);
await db.exec(fs.readFileSync(new URL('../supabase/migrations/20260907155544_customer_services_and_shared_history.sql','file://'+__filename.replaceAll('\\','/')),'utf8'));
const admin=randomUUID(),operator=randomUUID(),viewer=randomUUID(),customer=randomUUID(),other=randomUUID(),service=randomUUID(),service2=randomUUID(),equipment=randomUUID(),otherEquipment=randomUUID();
await db.query('insert into app_users values($1,\'admin\',\'管理員\',\'admin\',true),($2,\'operator\',\'施工員\',\'operator\',true),($3,\'viewer\',\'檢視者\',\'viewer\',true)',[admin,operator,viewer]);
await db.query('insert into customers(id) values($1),($2)',[customer,other]);await db.query('insert into contract_service_types values($1,\'monitor\',\'監控\',true),($2,\'phone\',\'電話\',true)',[service,service2]);
const manage=(action,actor=admin,version=1,active=true,sid=service)=>db.query('select manage_customer_service_v1($1,$2,$3,$4,$5,$6,$7) as result',[customer,sid,action,version,active,'測試備註',actor]);
await assert.rejects(manage('create',viewer),/權限/);await assert.rejects(manage('create',operator),/權限/);
await manage('create');await assert.rejects(manage('create'),/相同承攬/);await assert.rejects(manage('update',admin,9),/其他使用者/);
await db.query('insert into equipment_registry values($1,$2,$3,\'active\',\'校門口攝影機\',\'校門口 CAM001 192.0.2.10 Test Model\',\'camera\',$4,\'site_devices\',\'{}\'),($5,$6,$3,\'active\',\'其他客戶設備\',\'其他\',\'camera\',$7,\'site_devices\',\'{}\')',[equipment,customer,service,randomUUID(),otherEquipment,other,randomUUID()]);
const event={event_type:'REPAIR',occurred_at:'2026-09-07',description:'重新壓接',cause:'接觸不良',result:'恢復',notes:'保留',worker_user_ids:[operator]};const requestId=randomUUID();
const save=(actor=operator,e=event,eq=equipment,rid=requestId)=>db.query('select save_equipment_history_v1($1,$2,$3,$4) as result',[eq,JSON.stringify(e),actor,rid]);
await assert.rejects(save(viewer),/權限/);await assert.rejects(save(operator,{...event,worker_user_ids:[]}),/處理人員/);
const result=(await save()).rows[0].result,eid=result.maintenance_event_ids[0];assert.equal((await save()).rows[0].result.maintenance_event_ids[0],eid);
await save(operator,{...event,id:eid,row_version:1,result:'複驗完成'});await assert.rejects(save(operator,{...event,id:eid,row_version:1}),/其他使用者/);
await assert.rejects(save(operator,{...event,id:eid,row_version:2},otherEquipment),/停用|找不到/);
assert.equal((await db.query('select count(*)::int n from audit_logs where entity_id=$1 and action=\'update\'',[eid])).rows[0].n,1);
const search=(await db.query('select search_equipment_history_v1($1,$2,\'CAM001\',\'camera\',1) as result',[customer,service])).rows[0].result;assert.equal(search.total,1);assert.equal(search.records[0].total,1);assert.equal(search.records[0].last_maintenance,'2026-09-07');
assert.equal((await manage('delete')).rows[0].result.action,'deactivated');await assert.rejects(save(operator,{...event,id:eid,row_version:2}),/停用/);
await db.query('select update_customer_with_contracts_v1($1,$2)',[customer,['monitor']]);assert.equal((await db.query('select is_active from customer_contract_services where customer_id=$1',[customer])).rows[0].is_active,true);
await db.query('select update_customer_with_contracts_v1($1,$2)',[customer,[]]);assert.equal((await db.query('select count(*)::int n from customer_contract_services where customer_id=$1',[customer])).rows[0].n,1);
await manage('create',admin,1,true,service2);assert.equal((await manage('delete',admin,1,true,service2)).rows[0].result.action,'deleted');
for(const name of ['manage_customer_service_v1(uuid,uuid,text,integer,boolean,text,uuid)','save_equipment_history_v1(uuid,jsonb,uuid,uuid)','search_equipment_history_v1(uuid,uuid,text,text,integer)'])for(const role of ['anon','authenticated'])assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,name])).rows[0].allowed,false);
console.log(JSON.stringify({passed:true,database:'isolated PostgreSQL',checks:['admin-only customer CRUD','composite duplicate prevention','optimistic conflicts','related soft delete','unrelated delete','legacy customer update compatibility','writer/viewer permissions','workers validation','new event RPC dispatch and retry ID','event update with audit','cross-customer isolation','equipment search and summary','inactive service guard','no browser SQL privileges']}));
}finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
