-- Unified equipment registry and maintenance history.
-- The production migration is intentionally additive: existing equipment rows remain the source of truth.

do $$
declare
  v_missing text[] := '{}'::text[];
begin
  if to_regclass('public.customers') is null then v_missing := array_append(v_missing, 'public.customers'); end if;
  if to_regclass('public.contract_service_types') is null then v_missing := array_append(v_missing, 'public.contract_service_types'); end if;
  if to_regclass('public.customer_contract_services') is null then v_missing := array_append(v_missing, 'public.customer_contract_services'); end if;
  if to_regclass('public.app_users') is null then v_missing := array_append(v_missing, 'public.app_users'); end if;
  if to_regclass('public.site_work_logs') is null then v_missing := array_append(v_missing, 'public.site_work_logs'); end if;
  if to_regclass('public.site_devices') is null then v_missing := array_append(v_missing, 'public.site_devices'); end if;
  if to_regclass('public.phone_systems') is null then v_missing := array_append(v_missing, 'public.phone_systems'); end if;
  if to_regclass('public.phone_extensions') is null then v_missing := array_append(v_missing, 'public.phone_extensions'); end if;
  if to_regclass('public.phone_terminal_points') is null then v_missing := array_append(v_missing, 'public.phone_terminal_points'); end if;
  if to_regclass('public.audit_logs') is null then v_missing := array_append(v_missing, 'public.audit_logs'); end if;
  if to_regprocedure('public.upsert_customer_project_work_log_v3(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,text)') is null then
    v_missing := array_append(v_missing, 'public.upsert_customer_project_work_log_v3');
  end if;
  if cardinality(v_missing) > 0 then
    raise exception '設備履歷 migration 缺少相依物件：%', array_to_string(v_missing, ', ');
  end if;
end $$;

create table if not exists public.equipment_registry (
  id uuid primary key default gen_random_uuid(),
  equipment_type text not null,
  customer_id uuid not null references public.customers(id) on delete restrict,
  service_id uuid references public.contract_service_types(id) on delete restrict,
  site_id uuid references public.sites(id) on delete set null,
  source_table text not null,
  source_id uuid not null,
  display_name text not null,
  search_key text not null default '',
  status text not null default 'active',
  installation_date date,
  installation_precision text not null default 'unknown',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint equipment_registry_type_check check (char_length(btrim(equipment_type)) between 1 and 80),
  constraint equipment_registry_source_table_check check (source_table in ('site_devices','phone_systems','phone_extensions','phone_terminal_points')),
  constraint equipment_registry_display_name_check check (char_length(btrim(display_name)) between 1 and 240),
  constraint equipment_registry_status_check check (status in ('active','inactive','retired')),
  constraint equipment_registry_installation_precision_check check (installation_precision in ('unknown','year_only','date')),
  constraint equipment_registry_source_unique unique (source_table, source_id)
);

create table if not exists public.maintenance_events (
  id uuid primary key default gen_random_uuid(),
  work_log_id uuid not null references public.site_work_logs(id) on delete restrict,
  service_id uuid not null references public.contract_service_types(id) on delete restrict,
  event_type text not null,
  occurred_at date not null,
  description text not null,
  cause text,
  result text not null,
  notes text,
  status text not null default 'active',
  voided_at timestamptz,
  voided_by uuid references public.app_users(id) on delete restrict,
  void_reason text,
  created_by uuid not null references public.app_users(id) on delete restrict,
  updated_by uuid not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  constraint maintenance_events_type_check check (event_type in ('INSTALLATION','MAINTENANCE','REPAIR','REPLACEMENT','SOFTWARE_CONFIG','PROGRAM_CONFIG','INSPECTION','OTHER')),
  constraint maintenance_events_description_check check (char_length(btrim(description)) between 1 and 4000),
  constraint maintenance_events_cause_check check (cause is null or char_length(cause) <= 2000),
  constraint maintenance_events_result_check check (char_length(btrim(result)) between 1 and 2000),
  constraint maintenance_events_notes_check check (notes is null or char_length(notes) <= 2000),
  constraint maintenance_events_status_check check (status in ('active','voided')),
  constraint maintenance_events_row_version_check check (row_version >= 1),
  constraint maintenance_events_void_check check (
    (status = 'active' and voided_at is null and voided_by is null and void_reason is null)
    or
    (status = 'voided' and voided_at is not null and voided_by is not null and nullif(btrim(void_reason), '') is not null)
  )
);

create table if not exists public.maintenance_event_equipment (
  event_id uuid not null references public.maintenance_events(id) on delete restrict,
  equipment_id uuid not null references public.equipment_registry(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (event_id, equipment_id)
);

create table if not exists public.maintenance_event_workers (
  event_id uuid not null references public.maintenance_events(id) on delete restrict,
  user_id uuid not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

alter table public.site_work_logs
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.app_users(id) on delete restrict,
  add column if not exists delete_reason text;

create index if not exists equipment_registry_customer_service_idx
  on public.equipment_registry(customer_id, service_id, status, display_name);
create index if not exists equipment_registry_site_idx on public.equipment_registry(site_id) where site_id is not null;
create index if not exists equipment_registry_active_search_idx on public.equipment_registry(customer_id, search_key) where status = 'active';
create index if not exists maintenance_events_work_log_date_idx on public.maintenance_events(work_log_id, occurred_at desc) where status = 'active';
create index if not exists maintenance_events_service_date_idx on public.maintenance_events(service_id, occurred_at desc) where status = 'active';
create index if not exists maintenance_events_created_by_idx on public.maintenance_events(created_by);
create index if not exists maintenance_events_updated_by_idx on public.maintenance_events(updated_by);
create index if not exists maintenance_events_voided_by_idx on public.maintenance_events(voided_by) where voided_by is not null;
create index if not exists maintenance_event_equipment_equipment_idx on public.maintenance_event_equipment(equipment_id, event_id);
create index if not exists maintenance_event_workers_user_idx on public.maintenance_event_workers(user_id, event_id);
create index if not exists site_work_logs_active_project_date_idx on public.site_work_logs(project_id, log_date desc) where deleted_at is null;

alter table public.equipment_registry enable row level security;
alter table public.maintenance_events enable row level security;
alter table public.maintenance_event_equipment enable row level security;
alter table public.maintenance_event_workers enable row level security;

revoke all on table public.equipment_registry from public, anon, authenticated;
revoke all on table public.maintenance_events from public, anon, authenticated;
revoke all on table public.maintenance_event_equipment from public, anon, authenticated;
revoke all on table public.maintenance_event_workers from public, anon, authenticated;
grant select, insert, update on table public.equipment_registry to service_role;
grant select, insert, update on table public.maintenance_events to service_role;
grant select, insert, update on table public.maintenance_event_equipment to service_role;
grant select, insert, update on table public.maintenance_event_workers to service_role;

create or replace function public.sync_equipment_registry_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_source_id uuid := (v_row->>'id')::uuid;
  v_customer_id uuid;
  v_service_id uuid;
  v_site_id uuid;
  v_equipment_type text;
  v_display_name text;
  v_status text := 'active';
  v_metadata jsonb := '{}'::jsonb;
begin
  if tg_op = 'DELETE' then
    update public.equipment_registry
    set status = 'retired', updated_at = now()
    where source_table = tg_table_name and source_id = v_source_id;
    return old;
  end if;

  if tg_table_name = 'site_devices' then
    v_site_id := (v_row->>'site_id')::uuid;
    select sites.customer_id, sites.contract_service_type_id
    into v_customer_id, v_service_id
    from public.sites
    where sites.id = v_site_id;
    if not found then return new; end if;
    v_equipment_type := coalesce(nullif(v_row->>'device_type',''), 'site_device');
    v_display_name := coalesce(nullif(btrim(v_row->>'device_name'),''), nullif(btrim(v_row->>'device_no'),''), '未命名設備');
    v_status := case when nullif(v_row->>'deleted_at','') is not null then 'retired' when v_row->>'status' = 'inactive' then 'inactive' else 'active' end;
    v_metadata := jsonb_strip_nulls(jsonb_build_object('device_no',v_row->>'device_no','ip_address',v_row->>'ip_address','brand',v_row->>'device_brand','model',v_row->>'device_model'));
  elsif tg_table_name = 'phone_systems' then
    v_customer_id := (v_row->>'customer_id')::uuid;
    v_service_id := (v_row->>'contract_service_type_id')::uuid;
    v_equipment_type := 'phone_system';
    v_display_name := coalesce(nullif(btrim(v_row->>'system_name'),''), '未命名總機');
    v_metadata := jsonb_strip_nulls(jsonb_build_object('ip_address',v_row->>'ip_address','brand',v_row->>'device_brand','model',v_row->>'device_model'));
  elsif tg_table_name = 'phone_extensions' then
    v_customer_id := (v_row->>'customer_id')::uuid;
    v_service_id := (v_row->>'contract_service_type_id')::uuid;
    v_equipment_type := 'phone_extension';
    v_display_name := coalesce(nullif(btrim(v_row->>'extension_name'),''), nullif(btrim(v_row->>'extension_number'),''), '未命名分機');
    v_metadata := jsonb_strip_nulls(jsonb_build_object('extension_number',v_row->>'extension_number','building',v_row->>'building_name','floor',v_row->>'floor','location',v_row->>'installation_location','brand',v_row->>'device_brand','model',v_row->>'device_model'));
  elsif tg_table_name = 'phone_terminal_points' then
    v_customer_id := (v_row->>'customer_id')::uuid;
    v_service_id := (v_row->>'contract_service_type_id')::uuid;
    v_equipment_type := 'phone_terminal';
    v_display_name := concat_ws('｜', nullif(btrim(v_row->>'frame_name'),''), nullif(btrim(v_row->>'terminal_code'),''), nullif(btrim(v_row->>'slot_identifier'),''));
    if nullif(v_display_name,'') is null then v_display_name := '未命名電話端子'; end if;
    v_metadata := jsonb_strip_nulls(jsonb_build_object('side',v_row->>'endpoint_side','frame_block',v_row->>'frame_block','floor',v_row->>'floor','location',v_row->>'installation_location'));
  else
    return new;
  end if;

  insert into public.equipment_registry(
    equipment_type, customer_id, service_id, site_id, source_table, source_id,
    display_name, search_key, status, metadata
  ) values (
    v_equipment_type, v_customer_id, v_service_id, v_site_id, tg_table_name, v_source_id,
    v_display_name,
    lower(concat_ws(' ', v_display_name, v_equipment_type, v_metadata->>'device_no', v_metadata->>'ip_address', v_metadata->>'extension_number', v_metadata->>'building', v_metadata->>'floor', v_metadata->>'location', v_metadata->>'brand', v_metadata->>'model')),
    v_status, v_metadata
  )
  on conflict (source_table, source_id) do update
  set equipment_type = excluded.equipment_type,
      customer_id = excluded.customer_id,
      service_id = excluded.service_id,
      site_id = excluded.site_id,
      display_name = excluded.display_name,
      search_key = excluded.search_key,
      status = excluded.status,
      metadata = excluded.metadata,
      updated_at = now();
  return new;
end;
$$;

revoke all on function public.sync_equipment_registry_v1() from public, anon, authenticated, service_role;

drop trigger if exists site_devices_sync_equipment_registry on public.site_devices;
create trigger site_devices_sync_equipment_registry after insert or update or delete on public.site_devices
for each row execute function public.sync_equipment_registry_v1();
drop trigger if exists phone_systems_sync_equipment_registry on public.phone_systems;
create trigger phone_systems_sync_equipment_registry after insert or update or delete on public.phone_systems
for each row execute function public.sync_equipment_registry_v1();
drop trigger if exists phone_extensions_sync_equipment_registry on public.phone_extensions;
create trigger phone_extensions_sync_equipment_registry after insert or update or delete on public.phone_extensions
for each row execute function public.sync_equipment_registry_v1();
drop trigger if exists phone_terminal_points_sync_equipment_registry on public.phone_terminal_points;
create trigger phone_terminal_points_sync_equipment_registry after insert or update or delete on public.phone_terminal_points
for each row execute function public.sync_equipment_registry_v1();

-- Backfill registry records while preserving every source table and source UUID.
insert into public.equipment_registry(equipment_type,customer_id,service_id,site_id,source_table,source_id,display_name,search_key,status,metadata)
select
  coalesce(nullif(devices.device_type,''),'site_device'), sites.customer_id, sites.contract_service_type_id,
  devices.site_id, 'site_devices', devices.id,
  coalesce(nullif(btrim(devices.device_name),''),nullif(btrim(devices.device_no),''),'未命名設備'),
  lower(concat_ws(' ',devices.device_name,devices.device_no,devices.device_type,devices.ip_address,devices.device_brand,devices.device_model)),
  case when devices.deleted_at is not null then 'retired' when devices.status = 'inactive' then 'inactive' else 'active' end,
  jsonb_strip_nulls(jsonb_build_object('device_no',devices.device_no,'ip_address',devices.ip_address,'brand',devices.device_brand,'model',devices.device_model))
from public.site_devices devices
join public.sites sites on sites.id = devices.site_id
on conflict (source_table, source_id) do update set
  equipment_type=excluded.equipment_type, customer_id=excluded.customer_id, service_id=excluded.service_id,
  site_id=excluded.site_id, display_name=excluded.display_name, search_key=excluded.search_key,
  status=excluded.status, metadata=excluded.metadata, updated_at=now();

insert into public.equipment_registry(equipment_type,customer_id,service_id,source_table,source_id,display_name,search_key,metadata)
select 'phone_system', systems.customer_id, systems.contract_service_type_id, 'phone_systems', systems.id,
  coalesce(nullif(btrim(systems.system_name),''),'未命名總機'),
  lower(concat_ws(' ',systems.system_name,systems.ip_address,systems.device_brand,systems.device_model)),
  jsonb_strip_nulls(jsonb_build_object('ip_address',systems.ip_address,'brand',systems.device_brand,'model',systems.device_model))
from public.phone_systems systems
on conflict (source_table, source_id) do update set
  customer_id=excluded.customer_id, service_id=excluded.service_id, display_name=excluded.display_name,
  search_key=excluded.search_key, metadata=excluded.metadata, status='active', updated_at=now();

insert into public.equipment_registry(equipment_type,customer_id,service_id,source_table,source_id,display_name,search_key,metadata)
select 'phone_extension', extensions.customer_id, extensions.contract_service_type_id, 'phone_extensions', extensions.id,
  coalesce(nullif(btrim(extensions.extension_name),''),nullif(btrim(extensions.extension_number),''),'未命名分機'),
  lower(concat_ws(' ',extensions.extension_name,extensions.extension_number,extensions.building_name,extensions.floor,extensions.installation_location,extensions.device_brand,extensions.device_model)),
  jsonb_strip_nulls(jsonb_build_object('extension_number',extensions.extension_number,'building',extensions.building_name,'floor',extensions.floor,'location',extensions.installation_location,'brand',extensions.device_brand,'model',extensions.device_model))
from public.phone_extensions extensions
on conflict (source_table, source_id) do update set
  customer_id=excluded.customer_id, service_id=excluded.service_id, display_name=excluded.display_name,
  search_key=excluded.search_key, metadata=excluded.metadata, status='active', updated_at=now();

insert into public.equipment_registry(equipment_type,customer_id,service_id,source_table,source_id,display_name,search_key,metadata)
select 'phone_terminal', points.customer_id, points.contract_service_type_id, 'phone_terminal_points', points.id,
  coalesce(nullif(concat_ws('｜',nullif(btrim(points.frame_name),''),nullif(btrim(points.terminal_code),''),nullif(btrim(points.slot_identifier),'')),''),'未命名電話端子'),
  lower(concat_ws(' ',points.frame_name,points.frame_block,points.frame_position,points.terminal_code,points.slot_identifier,points.floor,points.installation_location)),
  jsonb_strip_nulls(jsonb_build_object('side',points.endpoint_side,'frame_block',points.frame_block,'floor',points.floor,'location',points.installation_location))
from public.phone_terminal_points points
on conflict (source_table, source_id) do update set
  customer_id=excluded.customer_id, service_id=excluded.service_id, display_name=excluded.display_name,
  search_key=excluded.search_key, metadata=excluded.metadata, status='active', updated_at=now();

-- Confirmed 2026-09-04: category is a single nullable text column, not a category FK/table.
update public.customers
set customer_category = 'government', updated_by = coalesce(nullif(updated_by,''),'equipment_history_migration')
where customer_category is null or btrim(customer_category) = '';

drop trigger if exists maintenance_events_increment_row_version on public.maintenance_events;
create trigger maintenance_events_increment_row_version before update on public.maintenance_events
for each row execute function public.increment_row_version();

create or replace function public.forbid_maintenance_history_delete_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception '設備維修履歷不可實體刪除；請使用作廢功能並填寫原因。';
end;
$$;
revoke all on function public.forbid_maintenance_history_delete_v1() from public, anon, authenticated, service_role;

drop trigger if exists maintenance_events_no_delete on public.maintenance_events;
create trigger maintenance_events_no_delete before delete on public.maintenance_events
for each row execute function public.forbid_maintenance_history_delete_v1();

-- Equipment and worker links are replaced within the same transaction and their before/after sets are audited.
create or replace function public.upsert_customer_project_work_log_with_maintenance_v1(
  p_id uuid,
  p_row_version integer,
  p_project_id uuid,
  p_customer_id uuid,
  p_project_name text,
  p_log_date date,
  p_work_type text,
  p_summary text,
  p_time_period text,
  p_status text,
  p_worker_user_ids uuid[],
  p_reporter_user_id uuid,
  p_maintenance_events jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_work_log_id uuid;
  v_event_json jsonb;
  v_event public.maintenance_events;
  v_before public.maintenance_events;
  v_event_id uuid;
  v_event_type text;
  v_service_id uuid;
  v_occurred_at date;
  v_description text;
  v_cause text;
  v_event_result text;
  v_notes text;
  v_equipment_ids uuid[];
  v_worker_ids uuid[];
  v_event_ids uuid[] := '{}'::uuid[];
  v_before_equipment_ids uuid[];
  v_before_worker_ids uuid[];
  v_equipment_count integer;
  v_worker_count integer;
  v_version integer;
begin
  if p_maintenance_events is null or jsonb_typeof(p_maintenance_events) <> 'array' or jsonb_array_length(p_maintenance_events) > 20 then
    raise exception '設備維修事件必須是 0 至 20 筆的陣列。';
  end if;

  v_result := public.upsert_customer_project_work_log_v3(
    p_id,p_row_version,p_project_id,p_customer_id,p_project_name,p_log_date,p_work_type,p_summary,
    p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,p_actor
  );
  v_work_log_id := (v_result->'work_log'->>'id')::uuid;

  for v_event_json in select value from jsonb_array_elements(p_maintenance_events)
  loop
    if jsonb_typeof(v_event_json) <> 'object' then raise exception '設備維修事件格式不正確。'; end if;
    v_event_id := nullif(v_event_json->>'id','')::uuid;
    v_version := nullif(v_event_json->>'row_version','')::integer;
    v_event_type := upper(btrim(coalesce(v_event_json->>'event_type','')));
    v_service_id := nullif(v_event_json->>'service_id','')::uuid;
    v_occurred_at := coalesce(nullif(v_event_json->>'occurred_at','')::date,p_log_date);
    v_description := btrim(coalesce(v_event_json->>'description',''));
    v_cause := nullif(btrim(coalesce(v_event_json->>'cause','')),'');
    v_event_result := btrim(coalesce(v_event_json->>'result',''));
    v_notes := nullif(btrim(coalesce(v_event_json->>'notes','')),'');

    if v_event_type not in ('INSTALLATION','MAINTENANCE','REPAIR','REPLACEMENT','SOFTWARE_CONFIG','PROGRAM_CONFIG','INSPECTION','OTHER')
      or v_service_id is null or v_occurred_at is null
      or char_length(v_description) not between 1 and 4000
      or char_length(v_event_result) not between 1 and 2000
      or char_length(coalesce(v_cause,'')) > 2000 or char_length(coalesce(v_notes,'')) > 2000 then
      raise exception '設備維修事件內容、日期、類型或處理結果不完整。';
    end if;

    perform 1 from public.customer_contract_services
    where customer_id = p_customer_id and service_type_id = v_service_id;
    if not found then raise exception '維修事件所選承攬內容不屬於此客戶。'; end if;

    select coalesce(array_agg(distinct equipment_id order by equipment_id),'{}'::uuid[])
    into v_equipment_ids
    from (
      select value::uuid as equipment_id
      from jsonb_array_elements_text(coalesce(v_event_json->'equipment_ids','[]'::jsonb))
    ) equipment;
    if cardinality(v_equipment_ids) < 1 or cardinality(v_equipment_ids) > 100 then
      raise exception '每筆設備維修事件必須選擇 1 至 100 台設備。';
    end if;
    select count(*) into v_equipment_count from public.equipment_registry registry
    where registry.id = any(v_equipment_ids) and registry.customer_id = p_customer_id
      and registry.service_id = v_service_id and registry.status = 'active';
    if v_equipment_count <> cardinality(v_equipment_ids) then
      raise exception '部分設備不屬於所選客戶／承攬內容，或設備已停用。';
    end if;

    select coalesce(array_agg(distinct worker_id order by worker_id),'{}'::uuid[])
    into v_worker_ids
    from (
      select value::uuid as worker_id
      from jsonb_array_elements_text(coalesce(v_event_json->'worker_user_ids','[]'::jsonb))
    ) workers;
    if cardinality(v_worker_ids) = 0 then v_worker_ids := coalesce(p_worker_user_ids,'{}'::uuid[]); end if;
    if cardinality(v_worker_ids) > 30 then raise exception '每筆維修事件最多可選擇 30 位處理人員。'; end if;
    select count(*) into v_worker_count from public.app_users users
    where users.id = any(v_worker_ids) and users.is_active = true;
    if v_worker_count <> cardinality(v_worker_ids) then raise exception '部分維修處理人員不存在或已停用。'; end if;

    if v_event_id is null then
      insert into public.maintenance_events(work_log_id,service_id,event_type,occurred_at,description,cause,result,notes,created_by,updated_by)
      values(v_work_log_id,v_service_id,v_event_type,v_occurred_at,v_description,v_cause,v_event_result,v_notes,p_reporter_user_id,p_reporter_user_id)
      returning * into v_event;
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_events',v_event.id,'insert',null,to_jsonb(v_event),'web',p_actor);
    else
      if v_event_id = any(v_event_ids) then raise exception '維修事件資料重複。'; end if;
      select * into v_before from public.maintenance_events where id = v_event_id and work_log_id = v_work_log_id for update;
      if not found then raise exception '找不到此工作日誌的維修事件。'; end if;
      if v_before.status = 'voided' then raise exception '已作廢的維修事件不可修改。'; end if;
      if v_version is null or v_before.row_version <> v_version then raise exception '維修事件已被其他使用者更新，請重新載入。'; end if;
      select coalesce(array_agg(equipment_id order by equipment_id),'{}'::uuid[]) into v_before_equipment_ids
      from public.maintenance_event_equipment where event_id = v_event_id;
      select coalesce(array_agg(user_id order by user_id),'{}'::uuid[]) into v_before_worker_ids
      from public.maintenance_event_workers where event_id = v_event_id;
      update public.maintenance_events
      set service_id=v_service_id,event_type=v_event_type,occurred_at=v_occurred_at,description=v_description,
          cause=v_cause,result=v_event_result,notes=v_notes,updated_by=p_reporter_user_id,updated_at=now()
      where id=v_event_id and row_version=v_version returning * into v_event;
      if not found then raise exception '維修事件已被其他使用者更新，請重新載入。'; end if;
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_events',v_event.id,'update',to_jsonb(v_before),to_jsonb(v_event),'web',p_actor);
      if v_before.result is distinct from v_event.result then
        insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
        values('maintenance_event_result',v_event.id,'update',jsonb_build_object('result',v_before.result),jsonb_build_object('result',v_event.result),'web',p_actor);
      end if;
      delete from public.maintenance_event_equipment where event_id = v_event.id;
      delete from public.maintenance_event_workers where event_id = v_event.id;
      if v_before_equipment_ids is distinct from v_equipment_ids then
        insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
        values('maintenance_event_equipment',v_event.id,'update',jsonb_build_object('work_log_id',v_work_log_id,'equipment_ids',v_before_equipment_ids),jsonb_build_object('work_log_id',v_work_log_id,'equipment_ids',v_equipment_ids),'web',p_actor);
      end if;
    end if;

    insert into public.maintenance_event_equipment(event_id,equipment_id)
    select v_event.id,equipment_id from unnest(v_equipment_ids) equipment(equipment_id);
    insert into public.maintenance_event_workers(event_id,user_id)
    select v_event.id,worker_id from unnest(v_worker_ids) workers(worker_id);
    if v_event_id is null then
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_event_equipment',v_event.id,'insert',null,jsonb_build_object('work_log_id',v_work_log_id,'equipment_ids',v_equipment_ids),'web',p_actor);
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_event_workers',v_event.id,'insert',null,jsonb_build_object('work_log_id',v_work_log_id,'user_ids',v_worker_ids),'web',p_actor);
    elsif v_before_worker_ids is distinct from v_worker_ids then
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_event_workers',v_event.id,'update',jsonb_build_object('work_log_id',v_work_log_id,'user_ids',v_before_worker_ids),jsonb_build_object('work_log_id',v_work_log_id,'user_ids',v_worker_ids),'web',p_actor);
    end if;
    v_event_ids := array_append(v_event_ids,v_event.id);
  end loop;

  return v_result || jsonb_build_object(
    'maintenance_event_ids',to_jsonb(v_event_ids),
    'maintenance_event_count',cardinality(v_event_ids)
  );
end;
$$;

revoke all on function public.upsert_customer_project_work_log_with_maintenance_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text) from public, anon, authenticated;
grant execute on function public.upsert_customer_project_work_log_with_maintenance_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text) to service_role;

create or replace function public.void_maintenance_event_v1(
  p_id uuid, p_row_version integer, p_reason text, p_actor_user_id uuid, p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_before public.maintenance_events; v_event public.maintenance_events;
begin
  if p_id is null or p_row_version is null or p_row_version < 1 or char_length(btrim(coalesce(p_reason,''))) not between 1 and 500 then
    raise exception '請提供有效的維修事件、版本與作廢原因。';
  end if;
  select * into v_before from public.maintenance_events where id=p_id for update;
  if not found then raise exception '找不到維修事件。'; end if;
  if v_before.status='voided' then raise exception '此維修事件已作廢。'; end if;
  if v_before.row_version<>p_row_version then raise exception '維修事件已被其他使用者更新，請重新載入。'; end if;
  update public.maintenance_events
  set status='voided',voided_at=now(),voided_by=p_actor_user_id,void_reason=btrim(p_reason),updated_by=p_actor_user_id,updated_at=now()
  where id=p_id and row_version=p_row_version returning * into v_event;
  if not found then raise exception '維修事件已被其他使用者更新，請重新載入。'; end if;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
  values('maintenance_events',v_event.id,'update',to_jsonb(v_before),to_jsonb(v_event)||jsonb_build_object('maintenance_action','void'),'web',p_actor);
  return to_jsonb(v_event);
end;
$$;
revoke all on function public.void_maintenance_event_v1(uuid,integer,text,uuid,text) from public, anon, authenticated;
grant execute on function public.void_maintenance_event_v1(uuid,integer,text,uuid,text) to service_role;

create or replace function public.soft_delete_site_work_log_v1(
  p_id uuid, p_row_version integer, p_reason text, p_actor_user_id uuid, p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_before public.site_work_logs; v_log public.site_work_logs;
begin
  if p_id is null or p_row_version is null or p_row_version < 1 or char_length(btrim(coalesce(p_reason,'管理員刪除'))) > 500 then
    raise exception '工作日誌資料、版本或刪除原因不正確。';
  end if;
  select * into v_before from public.site_work_logs where id=p_id and deleted_at is null for update;
  if not found then raise exception '找不到工作日誌。'; end if;
  if v_before.row_version<>p_row_version then raise exception '工作日誌已被其他使用者更新，請重新載入。'; end if;
  update public.site_work_logs
  set deleted_at=now(),deleted_by=p_actor_user_id,delete_reason=nullif(btrim(coalesce(p_reason,'管理員刪除')),''),updated_by=p_actor
  where id=p_id and row_version=p_row_version returning * into v_log;
  if not found then raise exception '工作日誌已被其他使用者更新，請重新載入。'; end if;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
  values('site_work_logs',v_log.id,'update',to_jsonb(v_before),to_jsonb(v_log)||jsonb_build_object('maintenance_action','soft_delete'),'web',p_actor);
  return to_jsonb(v_log);
end;
$$;
revoke all on function public.soft_delete_site_work_log_v1(uuid,integer,text,uuid,text) from public, anon, authenticated;
grant execute on function public.soft_delete_site_work_log_v1(uuid,integer,text,uuid,text) to service_role;

create or replace function public.get_equipment_history_v1(p_source_table text, p_source_id uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare v_equipment public.equipment_registry; v_events jsonb; v_total integer; v_last date;
begin
  if p_source_table not in ('site_devices','phone_systems','phone_extensions','phone_terminal_points') or p_source_id is null then
    raise exception '設備來源資料不正確。';
  end if;
  select * into v_equipment from public.equipment_registry
  where source_table=p_source_table and source_id=p_source_id;
  if not found then
    return jsonb_build_object('equipment',null,'events','[]'::jsonb,'summary',jsonb_build_object('total',0,'last_maintenance',null));
  end if;
  select count(*),max(events.occurred_at) into v_total,v_last
  from public.maintenance_event_equipment links
  join public.maintenance_events events on events.id=links.event_id
  where links.equipment_id=v_equipment.id and events.status='active';
  select coalesce(jsonb_agg(to_jsonb(history) order by history.occurred_at desc,history.created_at desc),'[]'::jsonb)
  into v_events
  from (
    select events.id,events.work_log_id,events.service_id,events.event_type,events.occurred_at,
      events.description,events.cause,events.result,events.notes,events.status,events.row_version,events.created_at,events.updated_at,
      coalesce((select jsonb_agg(jsonb_build_object('id',users.id,'display_name',users.display_name) order by users.display_name)
        from public.maintenance_event_workers workers join public.app_users users on users.id=workers.user_id
        where workers.event_id=events.id),'[]'::jsonb) as workers
    from public.maintenance_event_equipment links
    join public.maintenance_events events on events.id=links.event_id
    where links.equipment_id=v_equipment.id and events.status='active'
    order by events.occurred_at desc,events.created_at desc
    limit 100
  ) history;
  return jsonb_build_object('equipment',to_jsonb(v_equipment),'events',v_events,'summary',jsonb_build_object('total',v_total,'last_maintenance',v_last));
end;
$$;
revoke all on function public.get_equipment_history_v1(text,uuid) from public, anon, authenticated;
grant execute on function public.get_equipment_history_v1(text,uuid) to service_role;

-- Legacy maintenance_details is project-level and has no reliable equipment mapping; it is deliberately not auto-migrated.
