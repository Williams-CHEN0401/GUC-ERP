-- Standalone work logs, extensible customer contracts and deterministic NAS paths.
-- Existing work logs, maintenance history and attachments are preserved.

create table if not exists public.contract_service_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null unique,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contract_service_types_code_check check (code ~ '^[a-z0-9_]{2,64}$'),
  constraint contract_service_types_name_check check (char_length(btrim(name)) between 1 and 80)
);

create table if not exists public.customer_contract_services (
  customer_id uuid not null references public.customers(id) on delete cascade,
  service_type_id uuid not null references public.contract_service_types(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references public.app_users(id) on delete set null,
  primary key (customer_id, service_type_id)
);

create index if not exists customer_contract_services_service_type_id_idx
  on public.customer_contract_services(service_type_id);

create index if not exists customer_contract_services_created_by_idx
  on public.customer_contract_services(created_by)
  where created_by is not null;

alter table public.contract_service_types enable row level security;
alter table public.customer_contract_services enable row level security;
revoke all on table public.contract_service_types, public.customer_contract_services from public, anon, authenticated;
grant select, insert, update, delete on table public.contract_service_types, public.customer_contract_services to service_role;

insert into public.contract_service_types (code, name, sort_order)
values
  ('phone_system', '電話系統', 10),
  ('surveillance', '監控系統', 20),
  ('office_cabling', '辦公室佈線', 30),
  ('audio_system', '音響', 40),
  ('gate_barrier', '柵欄機', 50),
  ('emergency_call', '緊急求救系統', 60),
  ('basketball_coin_machine', '籃球場投幣機', 70)
on conflict (code) do update
set name = excluded.name,
    sort_order = excluded.sort_order;

alter table public.site_work_logs
  add column if not exists project_id uuid;

update public.site_work_logs logs
set project_id = sites.project_id
from public.sites sites
where logs.site_id = sites.id
  and logs.project_id is null;

do $$
begin
  if exists (select 1 from public.site_work_logs where project_id is null) then
    raise exception '仍有工作日誌無法由案場回填專案，已停止移轉。';
  end if;
end;
$$;

alter table public.site_work_logs
  drop constraint if exists site_work_logs_project_id_fkey;
alter table public.site_work_logs
  add constraint site_work_logs_project_id_fkey
  foreign key (project_id) references public.projects(id) on delete restrict;
alter table public.site_work_logs alter column project_id set not null;
create index if not exists site_work_logs_project_date_idx
  on public.site_work_logs(project_id, log_date desc);

create or replace function public.set_site_work_log_project_id_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select sites.project_id into new.project_id
  from public.sites sites
  where sites.id = new.site_id;
  if new.project_id is null then
    raise exception '工作日誌所屬案場尚未關聯專案。';
  end if;
  return new;
end;
$$;

drop trigger if exists site_work_logs_project_link_v1 on public.site_work_logs;
create trigger site_work_logs_project_link_v1
before insert or update of site_id on public.site_work_logs
for each row execute function public.set_site_work_log_project_id_v1();

revoke all on function public.set_site_work_log_project_id_v1()
  from public, anon, authenticated;

alter table public.projects drop constraint if exists projects_name_key;
do $$
begin
  if exists (select 1 from public.projects where customer_id is null) then
    raise exception '仍有專案未關聯客戶，拒絕將 projects.customer_id 設為 NOT NULL';
  end if;
  if exists (
    select 1
    from public.projects
    group by customer_id, lower(trim(name))
    having count(*) > 1
  ) then
    raise exception '同一客戶內仍有重複專案名稱，拒絕建立客戶範圍唯一索引';
  end if;
end
$$;

alter table public.projects alter column customer_id set not null;
alter table public.projects drop constraint if exists projects_customer_id_fkey;
alter table public.projects
  add constraint projects_customer_id_fkey
  foreign key (customer_id) references public.customers(id) on delete restrict;
create unique index if not exists projects_customer_normalized_name_uidx
  on public.projects(customer_id, lower(btrim(name)));

create or replace function public.create_customer_with_contracts_v1(
  p_customer_category text,
  p_name text,
  p_phone text,
  p_email text,
  p_address text,
  p_note text,
  p_service_codes text[],
  p_actor text
)
returns public.customers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer public.customers;
  v_codes text[];
  v_count integer;
begin
  select coalesce(array_agg(distinct btrim(code) order by btrim(code)), '{}'::text[])
  into v_codes
  from unnest(coalesce(p_service_codes, '{}'::text[])) as selected(code)
  where nullif(btrim(code), '') is not null;

  select count(*) into v_count
  from public.contract_service_types
  where code = any(v_codes) and is_active = true;
  if v_count <> cardinality(v_codes) then
    raise exception '承攬內容包含不存在或已停用的項目。';
  end if;

  select * into v_customer
  from public.create_customer_auto_number_v2(
    p_customer_category, p_name, p_phone, p_email, p_address, p_note, p_actor
  );

  insert into public.customer_contract_services (customer_id, service_type_id)
  select v_customer.id, types.id
  from public.contract_service_types types
  where types.code = any(v_codes);
  return v_customer;
end;
$$;

create or replace function public.update_customer_with_contracts_v1(
  p_id uuid,
  p_row_version integer,
  p_customer_category text,
  p_name text,
  p_phone text,
  p_email text,
  p_address text,
  p_note text,
  p_service_codes text[],
  p_actor text
)
returns public.customers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer public.customers;
  v_codes text[];
  v_count integer;
begin
  select coalesce(array_agg(distinct btrim(code) order by btrim(code)), '{}'::text[])
  into v_codes
  from unnest(coalesce(p_service_codes, '{}'::text[])) as selected(code)
  where nullif(btrim(code), '') is not null;

  select count(*) into v_count
  from public.contract_service_types
  where code = any(v_codes) and is_active = true;
  if v_count <> cardinality(v_codes) then
    raise exception '承攬內容包含不存在或已停用的項目。';
  end if;

  update public.customers
  set customer_category = p_customer_category,
      name = btrim(p_name),
      phone = nullif(btrim(coalesce(p_phone, '')), ''),
      email = nullif(btrim(coalesce(p_email, '')), ''),
      address = nullif(btrim(coalesce(p_address, '')), ''),
      note = nullif(btrim(coalesce(p_note, '')), ''),
      source = 'web',
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where id = p_id and row_version = p_row_version
  returning * into v_customer;
  if not found then
    raise exception '客戶資料已被其他使用者更新，請重新載入後再修改。';
  end if;

  delete from public.customer_contract_services where customer_id = p_id;
  insert into public.customer_contract_services (customer_id, service_type_id)
  select p_id, types.id
  from public.contract_service_types types
  where types.code = any(v_codes);
  return v_customer;
end;
$$;

create or replace function public.upsert_customer_project_work_log_v2(
  p_id uuid,
  p_row_version integer,
  p_project_id uuid,
  p_customer_id uuid,
  p_project_name text,
  p_log_date date,
  p_work_type text,
  p_summary text,
  p_worker_user_ids uuid[],
  p_reporter_user_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.projects;
  v_existing public.site_work_logs;
begin
  if p_customer_id is null or nullif(btrim(p_project_name), '') is null then
    raise exception '請選擇客戶並輸入專案／日誌標題。';
  end if;
  if char_length(btrim(p_project_name)) > 120 then
    raise exception '專案／日誌標題不可超過 120 個字。';
  end if;

  if p_id is not null then
    select * into v_existing from public.site_work_logs where id = p_id;
    if not found then raise exception '找不到工作日誌。'; end if;
    select * into v_project from public.projects where id = v_existing.project_id;
    if not found or v_project.customer_id <> p_customer_id then
      raise exception '工作日誌的客戶與原專案不相符。';
    end if;
  elsif p_project_id is not null then
    select * into v_project
    from public.projects
    where id = p_project_id and customer_id = p_customer_id;
    if not found then raise exception '所選專案不屬於此客戶。'; end if;
  else
    select * into v_project
    from public.projects
    where customer_id = p_customer_id
      and lower(btrim(name)) = lower(btrim(p_project_name))
    limit 1;
    if not found then
      select * into v_project
      from public.create_project_auto_number_v1(
        btrim(p_project_name), p_customer_id,
        case when p_work_type = '工程施工' then 'construction' else 'maintenance' end,
        'in_progress', null, '由工作日誌自動建立', null, null, p_actor
      );
    end if;
  end if;

  return public.upsert_project_site_work_log_v1(
    v_project.id, p_id, p_row_version, p_log_date, v_project.name,
    p_summary, p_work_type, p_worker_user_ids, p_reporter_user_id, p_actor
  );
end;
$$;

create or replace function public.register_site_attachments_v2(
  p_project_id uuid,
  p_rows jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_asset public.site_assets;
  v_result jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 10 then
    raise exception '附件索引格式不正確。';
  end if;
  if not exists (select 1 from public.projects where id = p_project_id) then
    raise exception '找不到附件所屬專案。';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    insert into public.site_assets (
      id, site_id, project_id, work_log_id, asset_type, title, description,
      original_name, mime_type, file_size, nas_path, upload_status,
      uploaded_by, uploaded_at, sha256, source, updated_by
    ) values (
      (v_row->>'id')::uuid, null, p_project_id, nullif(v_row->>'work_log_id','')::uuid,
      v_row->>'asset_type', v_row->>'title', nullif(v_row->>'description',''),
      v_row->>'original_name', v_row->>'mime_type', (v_row->>'file_size')::bigint,
      v_row->>'nas_path', 'uploaded', p_actor, (v_row->>'uploaded_at')::timestamptz,
      v_row->>'sha256', 'nas_webdav', p_actor
    )
    on conflict (nas_path) where nas_path is not null do update
    set project_id = excluded.project_id,
        work_log_id = excluded.work_log_id,
        asset_type = excluded.asset_type,
        title = excluded.title,
        description = excluded.description,
        original_name = excluded.original_name,
        mime_type = excluded.mime_type,
        file_size = excluded.file_size,
        upload_status = 'uploaded',
        uploaded_by = excluded.uploaded_by,
        uploaded_at = excluded.uploaded_at,
        sha256 = excluded.sha256,
        source = excluded.source,
        updated_by = excluded.updated_by
    returning * into v_asset;
    v_result := v_result || jsonb_build_array(to_jsonb(v_asset));
  end loop;
  return v_result;
end;
$$;

revoke all on function public.create_customer_with_contracts_v1(text,text,text,text,text,text,text[],text) from public, anon, authenticated;
revoke all on function public.update_customer_with_contracts_v1(uuid,integer,text,text,text,text,text,text,text[],text) from public, anon, authenticated;
revoke all on function public.upsert_customer_project_work_log_v2(uuid,integer,uuid,uuid,text,date,text,text,uuid[],uuid,text) from public, anon, authenticated;
revoke all on function public.register_site_attachments_v2(uuid,jsonb,text) from public, anon, authenticated;
grant execute on function public.create_customer_with_contracts_v1(text,text,text,text,text,text,text[],text) to service_role;
grant execute on function public.update_customer_with_contracts_v1(uuid,integer,text,text,text,text,text,text,text[],text) to service_role;
grant execute on function public.upsert_customer_project_work_log_v2(uuid,integer,uuid,uuid,text,date,text,text,uuid[],uuid,text) to service_role;
grant execute on function public.register_site_attachments_v2(uuid,jsonb,text) to service_role;
