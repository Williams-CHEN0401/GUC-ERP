-- One department source owned by existing customers. Legacy NULL associations stay NULL.
begin;
set local lock_timeout = '5s';

create table public.customer_departments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  name text not null check(name=btrim(name) and char_length(name) between 1 and 120),
  is_active boolean not null default true,
  row_version integer not null default 1 check(row_version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  unique(customer_id,id)
);
create unique index customer_departments_customer_name_idx on public.customer_departments(customer_id,lower(btrim(name)));
alter table public.customer_departments enable row level security;
revoke all on public.customer_departments from public,anon,authenticated;
grant select,insert,update on public.customer_departments to service_role;

alter table public.projects add column department_id uuid;
alter table public.repair_items add column department_id uuid;
alter table public.stock_receipt_customers add column department_id uuid;
alter table public.projects add constraint projects_department_requires_customer check(department_id is null or customer_id is not null);
alter table public.repair_items add constraint repair_items_department_requires_customer check(department_id is null or customer_id is not null);
alter table public.projects add constraint projects_customer_department_fkey foreign key(customer_id,department_id)
  references public.customer_departments(customer_id,id) on delete restrict deferrable initially deferred;
alter table public.repair_items add constraint repair_items_customer_department_fkey foreign key(customer_id,department_id)
  references public.customer_departments(customer_id,id) on delete restrict deferrable initially deferred;
alter table public.stock_receipt_customers add constraint stock_receipt_customers_department_fkey foreign key(customer_id,department_id)
  references public.customer_departments(customer_id,id) on delete restrict deferrable initially deferred;
create index projects_customer_department_idx on public.projects(customer_id,department_id);
create index repair_items_customer_department_idx on public.repair_items(customer_id,department_id);
create index stock_receipt_customers_department_idx on public.stock_receipt_customers(customer_id,department_id);
comment on column public.projects.department_id is '科室唯一來源；工作日誌、取貨及附件沿用 project_id，不重複保存科室。';

create function public.version_customer_department_v1() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception '科室不可刪除，請改為停用。'; end if;
  if new.id is distinct from old.id or new.customer_id is distinct from old.customer_id then
    raise exception '科室不可移至其他客戶。';
  end if;
  new.row_version:=old.row_version+1; new.updated_at:=now(); return new;
end $$;
create trigger customer_departments_version before update or delete on public.customer_departments
for each row execute function public.version_customer_department_v1();
create trigger customer_departments_context_audit after insert or update on public.customer_departments
for each row execute function audit_internal.capture_links();
create trigger projects_department_audit after update of department_id on public.projects
for each row when (old.department_id is distinct from new.department_id) execute function audit_internal.capture_links();
create trigger repair_items_department_audit after update of department_id on public.repair_items
for each row when (old.department_id is distinct from new.department_id) execute function audit_internal.capture_links();

create function public.manage_customer_department_v1(
  p_action text,p_id uuid,p_row_version integer,p_customer_id uuid,p_name text,p_is_active boolean,p_actor text
) returns public.customer_departments language plpgsql security invoker set search_path='' as $$
declare v_existing public.customer_departments; v_result public.customer_departments; v_name text:=btrim(coalesce(p_name,''));
begin
  if p_action is null or p_action not in ('create','update','deactivate') then raise exception '不支援的科室操作。'; end if;
  perform 1 from public.customers where id=p_customer_id for update;
  if not found then raise exception '所選客戶不存在。'; end if;
  perform pg_catalog.set_config('app.actor',coalesce(p_actor,''),true);
  if p_action<>'deactivate' and (char_length(v_name) not between 1 and 120 or (p_action='create' and p_is_active is null)) then
    raise exception '科室名稱須為 1–120 個字，並指定有效狀態。';
  end if;
  if p_action='create' then
    if p_id is not null or p_row_version is not null then raise exception '新增科室不應包含版本或編號。'; end if;
    insert into public.customer_departments(customer_id,name,is_active,updated_by)
    values(p_customer_id,v_name,p_is_active,p_actor) returning * into v_result;
  else
    select * into v_existing from public.customer_departments where id=p_id and customer_id=p_customer_id for update;
    if not found or p_row_version is null or v_existing.row_version<>p_row_version then
      raise exception '此科室已被更新或不屬於所選客戶，請重新載入。';
    end if;
    update public.customer_departments set name=case when p_action='deactivate' then name else v_name end,
      is_active=case when p_action='deactivate' then false else coalesce(p_is_active,is_active) end,updated_by=p_actor
    where id=p_id returning * into v_result;
  end if;
  return v_result;
exception when unique_violation then raise exception '此客戶已有相同名稱的科室。';
end $$;

-- Callers may preserve ONLY an existing association they have already loaded and locked.
create function public.assert_customer_department_v1(
  p_customer_id uuid,p_department_id uuid,p_existing_department_id uuid default null,p_preserve_existing boolean default false
) returns void language plpgsql security invoker set search_path='' as $$
declare v_active boolean;
begin
  perform 1 from public.customers where id=p_customer_id for update;
  if not found then raise exception '所選客戶不存在。'; end if;
  if p_department_id is not null then
    select is_active into v_active from public.customer_departments where id=p_department_id and customer_id=p_customer_id;
    if not found then raise exception '所選科室不屬於此客戶。'; end if;
    if not v_active and not (coalesce(p_preserve_existing,false) and p_department_id is not distinct from p_existing_department_id) then
      raise exception '所選科室已停用，請選擇有效科室。';
    end if;
  elsif not (coalesce(p_preserve_existing,false) and p_existing_department_id is null)
    and exists(select 1 from public.customer_departments where customer_id=p_customer_id and is_active) then
    raise exception '此客戶已有科室，請選擇科室。';
  end if;
end $$;

create function public.upsert_erp_project_department_v1(
  p_id uuid,p_row_version integer,p_name text,p_customer_id uuid,p_project_type text,p_status text,
  p_description text,p_estimated_cost numeric,p_note text,p_worker_user_ids uuid[],p_actor text,
  p_project_date date,p_construction_category text,p_department_id uuid,p_construction_category_provided boolean default true
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_old public.projects; v_project public.projects; v_result jsonb;
begin
  -- Match work-log creation lock order: customer first, then project/version.
  perform 1 from public.customers where id=p_customer_id for update;
  if p_id is not null then select * into v_old from public.projects where id=p_id for update; end if;
  perform public.assert_customer_department_v1(p_customer_id,p_department_id,v_old.department_id,
    p_id is not null and v_old.customer_id=p_customer_id);
  if exists(select 1 from public.projects where customer_id=p_customer_id and lower(btrim(name))=lower(btrim(p_name))
    and id is distinct from p_id and department_id is distinct from p_department_id) then
    raise exception '此客戶已有同名工作內容，但科室不同；請使用不同名稱。';
  end if;
  if coalesce(p_construction_category_provided,true) then
    v_result:=public.upsert_erp_project_with_workers_v4(p_id,p_row_version,p_name,p_customer_id,p_project_type,p_status,
      p_description,p_estimated_cost,p_note,p_worker_user_ids,p_actor,p_project_date,p_construction_category);
  else
    -- Omission preserves the pre-existing v3 contract; an explicit NULL still uses v4 and clears it.
    v_result:=public.upsert_erp_project_with_workers_v3(p_id,p_row_version,p_name,p_customer_id,p_project_type,p_status,
      p_description,p_estimated_cost,p_note,p_worker_user_ids,p_actor,p_project_date);
  end if;
  update public.projects set department_id=p_department_id,updated_by=p_actor
    where id=(v_result#>>'{project,id}')::uuid and department_id is distinct from p_department_id;
  select * into v_project from public.projects where id=(v_result#>>'{project,id}')::uuid;
  return v_result || jsonb_build_object('project',to_jsonb(v_project));
end $$;

create function public.upsert_repair_item_department_v1(
  p_id uuid,p_row_version integer,p_received_on date,p_customer_id uuid,p_inventory_item_id uuid,p_quantity integer,
  p_serial_number text,p_issue_description text,p_supplier_id uuid,p_sent_to_supplier_on date,p_returned_from_supplier_on date,
  p_returned_to_customer_on date,p_status text,p_supplier_reference text,p_notes text,p_actor text,p_department_id uuid
) returns public.repair_items language plpgsql security invoker set search_path='' as $$
declare v_old public.repair_items; v_result public.repair_items;
begin
  perform 1 from public.customers where id=p_customer_id for update;
  if p_id is not null then select * into v_old from public.repair_items where id=p_id for update; end if;
  perform public.assert_customer_department_v1(p_customer_id,p_department_id,v_old.department_id,
    p_id is not null and v_old.customer_id=p_customer_id);
  select * into v_result from public.upsert_repair_item_v1(p_id,p_row_version,p_received_on,p_customer_id,p_inventory_item_id,
    p_quantity,p_serial_number,p_issue_description,p_supplier_id,p_sent_to_supplier_on,p_returned_from_supplier_on,
    p_returned_to_customer_on,p_status,p_supplier_reference,p_notes,p_actor);
  if v_result.department_id is distinct from p_department_id then
    update public.repair_items set department_id=p_department_id,updated_by=p_actor where id=v_result.id returning * into v_result;
  end if;
  return v_result;
end $$;

create function public.upsert_customer_project_work_log_department_v1(
  p_id uuid,p_row_version integer,p_project_id uuid,p_customer_id uuid,p_project_name text,p_log_date date,
  p_work_type text,p_summary text,p_time_period text,p_status text,p_worker_user_ids uuid[],p_reporter_user_id uuid,
  p_maintenance_events jsonb,p_actor text,p_department_id uuid,p_request_id uuid default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_project public.projects; v_project_id uuid; v_existing boolean; v_payload jsonb;
  v_previous public.work_log_save_requests; v_result jsonb; v_repair_id uuid;
begin
  perform public.assert_work_log_access_v1(p_reporter_user_id,p_project_id,p_id,case when p_id is null then 'CREATE' else 'UPDATE' end);
  v_payload:=jsonb_build_object('id',p_id,'row_version',p_row_version,'project_id',p_project_id,'customer_id',p_customer_id,
    'project_name',p_project_name,'log_date',p_log_date,'work_type',p_work_type,'summary',p_summary,'time_period',p_time_period,
    'status',p_status,'worker_user_ids',p_worker_user_ids,'maintenance_events',p_maintenance_events,'actor',p_actor,
    'department_id',p_department_id);
  if p_request_id is not null then
    if p_reporter_user_id is null then raise exception '缺少工作日誌送出識別碼。'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,0));
    select * into v_previous from public.work_log_save_requests where request_id=p_request_id;
    if found then
      if v_previous.reporter_id<>p_reporter_user_id or v_previous.request_payload<>v_payload then
        raise exception '此送出識別碼已使用，請重新載入日誌確認後再修改，避免重複建立。';
      end if;
      return v_previous.result;
    end if;
  end if;
  -- Serialize same-customer name resolution with department creation and all new wrappers.
  perform 1 from public.customers where id=p_customer_id for update;
  if p_id is not null then
    select project_id into v_project_id from public.site_work_logs where id=p_id;
    if not found then raise exception '找不到工作日誌。'; end if;
    if p_project_id is not null and p_project_id is distinct from v_project_id then raise exception '工作日誌不可移至其他工作內容。'; end if;
    select * into v_project from public.projects where id=v_project_id for update;
  elsif p_project_id is not null then
    select * into v_project from public.projects where id=p_project_id for update;
    if not found then raise exception '找不到工作內容。'; end if;
  else
    select * into v_project from public.projects where customer_id=p_customer_id
      and lower(btrim(name))=lower(btrim(p_project_name)) for update;
  end if;
  v_existing:=v_project.id is not null;
  if v_existing and (v_project.customer_id is distinct from p_customer_id or v_project.department_id is distinct from p_department_id) then
    raise exception '工作內容的客戶／科室不相符；同名但不同科室請使用不同名稱。';
  end if;
  perform public.assert_customer_department_v1(p_customer_id,p_department_id,v_project.department_id,v_existing);
  if not v_existing then
    -- Create exactly one new project; a concurrently inserted old-client name must fail uniqueness,
    -- never be silently adopted and moved to this department by the legacy name resolver.
    select * into v_project from public.create_project_auto_number_v1(btrim(p_project_name),p_customer_id,
      case when p_work_type='工程施工' then 'construction' else 'maintenance' end,
      p_status,null,'由工作日誌自動建立',null,null,p_actor);
    update public.projects set department_id=p_department_id,updated_by=p_actor where id=v_project.id
      and department_id is distinct from p_department_id;
  end if;
  -- Existing maintenance implementation owns handling_process, repairs, workers, audit and version checks.
  v_result:=public.upsert_customer_project_work_log_with_maintenance_v1(p_id,p_row_version,v_project.id,p_customer_id,
    p_project_name,p_log_date,p_work_type,p_summary,p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,p_maintenance_events,p_actor);
  v_project_id:=(v_result#>>'{work_log,project_id}')::uuid;
  -- Only newly auto-registered repairs inherit the project's department; old repairs are never overwritten.
  for v_repair_id in select value::uuid from jsonb_array_elements_text(coalesce(v_result->'created_repair_item_ids','[]')) loop
    update public.repair_items set department_id=p_department_id,updated_by=p_actor where id=v_repair_id
      and department_id is distinct from p_department_id;
  end loop;
  select * into v_project from public.projects where id=v_project_id;
  v_result:=v_result||jsonb_build_object('project',to_jsonb(v_project));
  if p_request_id is not null then
    insert into public.work_log_save_requests(request_id,reporter_id,request_payload,result)
    values(p_request_id,p_reporter_user_id,v_payload,v_result);
  end if;
  return v_result;
end $$;

-- Exact one-to-one customer selection mapping; no silent dropping, deduplication or cross-customer links.
create function public.set_receipt_departments_v1(p_receipt_id uuid,p_customer_ids uuid[],p_customer_departments jsonb,p_preserve_existing boolean,p_actor_user_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare v_row jsonb; v_customer uuid; v_department uuid; v_old public.stock_receipt_customers; v_found boolean; v_before jsonb; v_after jsonb;
begin
  if not (public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE') or public.has_app_permission_v1(p_actor_user_id,'purchases','UPDATE')) then raise exception '您的帳號沒有執行此操作的權限。'; end if;
  if p_customer_ids is null or cardinality(p_customer_ids)>2000 or array_position(p_customer_ids,null) is not null
    or p_customer_departments is null or jsonb_typeof(p_customer_departments)<>'array'
    or jsonb_array_length(p_customer_departments)<>cardinality(p_customer_ids)
    or cardinality(p_customer_ids)<>(select count(distinct id) from unnest(p_customer_ids) id) then raise exception '訂貨客戶與科室對應格式不正確。'; end if;
  if exists(select 1 from jsonb_array_elements(p_customer_departments) value where jsonb_typeof(value)<>'object') then raise exception '訂貨客戶與科室對應格式不正確。'; end if;
  if (select count(distinct (value->>'customer_id')::uuid) from jsonb_array_elements(p_customer_departments))<>cardinality(p_customer_ids)
    or exists(select 1 from jsonb_array_elements(p_customer_departments) value where not ((value->>'customer_id')::uuid=any(p_customer_ids)) or not(value?'department_id')) then
    raise exception '訂貨客戶與科室必須逐一對應。';
  end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by customer_id),'[]') into v_before from public.stock_receipt_customers r where stock_receipt_id=p_receipt_id;
  for v_row in select value from jsonb_array_elements(p_customer_departments) order by value->>'customer_id' loop
    v_customer:=(v_row->>'customer_id')::uuid; v_department:=nullif(v_row->>'department_id','')::uuid;
    select * into v_old from public.stock_receipt_customers where stock_receipt_id=p_receipt_id and customer_id=v_customer for update;
    v_found:=found;
    perform public.assert_customer_department_v1(v_customer,v_department,v_old.department_id,p_preserve_existing and v_found);
  end loop;
  perform public.set_receipt_customers_v1(p_receipt_id,p_customer_ids,p_actor_user_id);
  for v_row in select value from jsonb_array_elements(p_customer_departments) loop
    update public.stock_receipt_customers set department_id=nullif(v_row->>'department_id','')::uuid
      where stock_receipt_id=p_receipt_id and customer_id=(v_row->>'customer_id')::uuid;
  end loop;
  select coalesce(jsonb_agg(to_jsonb(r) order by customer_id),'[]') into v_after from public.stock_receipt_customers r where stock_receipt_id=p_receipt_id;
  if v_before is distinct from v_after then
    insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
    values('stock_receipt_customers',p_receipt_id,'update',jsonb_build_object('customer_departments',v_before),jsonb_build_object('customer_departments',v_after),'web',(select username from public.app_users where id=p_actor_user_id));
  end if;
end $$;

create function public.create_stock_receipts_department_v1(p_rows jsonb,p_customer_ids uuid[],p_customer_departments jsonb,p_actor_user_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_result jsonb; v_id uuid;
begin
  v_result:=public.create_stock_receipts_with_customers_v1(p_rows,p_customer_ids,p_actor_user_id);
  for v_id in select value::uuid from jsonb_array_elements_text(v_result->'ids') loop
    perform public.set_receipt_departments_v1(v_id,p_customer_ids,p_customer_departments,false,p_actor_user_id);
  end loop;
  return v_result;
end $$;

create function public.update_stock_receipt_department_v1(p_id uuid,p_row_version integer,p_receipt_date date,p_inventory_item_id uuid,p_quantity numeric,p_supplier_id uuid,p_note text,p_customer_ids uuid[],p_customer_departments jsonb,p_actor_user_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_result jsonb;
begin
  -- Preserve old links until the department validator has compared them. The receipt RPC still locks/checks version.
  v_result:=public.update_stock_receipt_with_customers_v1(p_id,p_row_version,p_receipt_date,p_inventory_item_id,p_quantity,p_supplier_id,p_note,null,p_actor_user_id);
  perform public.set_receipt_departments_v1(p_id,p_customer_ids,p_customer_departments,true,p_actor_user_id);
  return v_result;
end $$;

-- No public RPC route bypasses the existing Gateway permission checks.
revoke all on function public.version_customer_department_v1(),
 public.manage_customer_department_v1(text,uuid,integer,uuid,text,boolean,text),
 public.assert_customer_department_v1(uuid,uuid,uuid,boolean),
 public.upsert_erp_project_department_v1(uuid,integer,text,uuid,text,text,text,numeric,text,uuid[],text,date,text,uuid,boolean),
 public.upsert_repair_item_department_v1(uuid,integer,date,uuid,uuid,integer,text,text,uuid,date,date,date,text,text,text,text,uuid),
 public.upsert_customer_project_work_log_department_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid),
 public.set_receipt_departments_v1(uuid,uuid[],jsonb,boolean,uuid),
 public.create_stock_receipts_department_v1(jsonb,uuid[],jsonb,uuid),
 public.update_stock_receipt_department_v1(uuid,integer,date,uuid,numeric,uuid,text,uuid[],jsonb,uuid)
from public,anon,authenticated;
grant execute on function public.version_customer_department_v1(),
 public.manage_customer_department_v1(text,uuid,integer,uuid,text,boolean,text),
 public.assert_customer_department_v1(uuid,uuid,uuid,boolean),
 public.upsert_erp_project_department_v1(uuid,integer,text,uuid,text,text,text,numeric,text,uuid[],text,date,text,uuid,boolean),
 public.upsert_repair_item_department_v1(uuid,integer,date,uuid,uuid,integer,text,text,uuid,date,date,date,text,text,text,text,uuid),
 public.upsert_customer_project_work_log_department_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid),
 public.set_receipt_departments_v1(uuid,uuid[],jsonb,boolean,uuid),
 public.create_stock_receipts_department_v1(jsonb,uuid[],jsonb,uuid),
 public.update_stock_receipt_department_v1(uuid,integer,date,uuid,numeric,uuid,text,uuid[],jsonb,uuid)
to service_role;
commit;
