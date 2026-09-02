begin;

-- Generate the monitoring credential key inside Supabase Vault. The Edge
-- Function receives it only through a service-role-only RPC when no managed
-- function secret has been configured.
do $$
begin
  if not exists (
    select 1 from vault.secrets where name = 'guc_monitoring_device_credentials_v1'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'base64'),
      'guc_monitoring_device_credentials_v1',
      'GUC monitoring device credential AES-256-GCM key v1',
      null
    );
  end if;
end;
$$;

create or replace function public.get_monitoring_device_key_v1()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'guc_monitoring_device_credentials_v1'
  limit 1;
$$;

create table if not exists public.monitoring_device_types (
  code text primary key,
  name text not null unique,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monitoring_device_types_code_check
    check (code in ('monitoring_host', 'camera', 'hub')),
  constraint monitoring_device_types_name_check
    check (char_length(btrim(name)) between 1 and 80)
);

insert into public.monitoring_device_types (code, name, sort_order)
values
  ('monitoring_host', '監控主機', 10),
  ('camera', '監控攝影機', 20),
  ('hub', '集線器', 30)
on conflict (code) do update
set name = excluded.name,
    sort_order = excluded.sort_order,
    is_active = true,
    updated_at = now();

alter table public.monitoring_device_types enable row level security;
revoke all on public.monitoring_device_types from public, anon, authenticated;
grant select on public.monitoring_device_types to service_role;

alter table public.site_devices
  add column if not exists device_type text,
  add column if not exists network_cable_no text,
  add column if not exists cabinet text,
  add column if not exists device_brand text,
  add column if not exists device_model text,
  add column if not exists details text,
  add column if not exists manual_url text,
  add column if not exists credential_configured boolean not null default false,
  add column if not exists created_by text,
  add column if not exists deleted_at timestamptz;

alter table public.site_devices
  drop constraint if exists site_devices_device_type_check,
  add constraint site_devices_device_type_check
    check (device_type is null or device_type in ('monitoring_host', 'camera', 'hub')),
  drop constraint if exists site_devices_network_cable_no_check,
  add constraint site_devices_network_cable_no_check
    check (network_cable_no is null or char_length(network_cable_no) <= 120),
  drop constraint if exists site_devices_cabinet_check,
  add constraint site_devices_cabinet_check
    check (cabinet is null or char_length(cabinet) <= 160),
  drop constraint if exists site_devices_brand_check,
  add constraint site_devices_brand_check
    check (device_brand is null or char_length(device_brand) <= 120),
  drop constraint if exists site_devices_model_check,
  add constraint site_devices_model_check
    check (device_model is null or char_length(device_model) <= 160),
  drop constraint if exists site_devices_details_check,
  add constraint site_devices_details_check
    check (details is null or char_length(details) <= 4000),
  drop constraint if exists site_devices_manual_url_check,
  add constraint site_devices_manual_url_check
    check (manual_url is null or (char_length(manual_url) <= 1000 and manual_url ~* '^https?://')),
  drop constraint if exists site_devices_status_check,
  add constraint site_devices_status_check
    check (status in ('planned', 'installed', 'tested', 'active', 'inactive', 'maintenance'));

create unique index if not exists site_devices_active_ip_unique
  on public.site_devices ((ip_address::inet))
  where deleted_at is null and ip_address is not null and btrim(ip_address) <> '';

create index if not exists site_devices_monitoring_search_idx
  on public.site_devices (device_type, device_brand, device_model, cabinet)
  where deleted_at is null;

create index if not exists site_devices_monitoring_updated_idx
  on public.site_devices (updated_at desc)
  where deleted_at is null;

create table if not exists public.site_device_credentials (
  device_id uuid primary key references public.site_devices(id) on delete cascade,
  username_ciphertext bytea not null,
  username_iv bytea not null,
  username_authentication_tag bytea not null,
  password_ciphertext bytea not null,
  password_iv bytea not null,
  password_authentication_tag bytea not null,
  masked_username text not null,
  key_version text not null default 'v1',
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint site_device_credentials_mask_check
    check (char_length(masked_username) between 1 and 260),
  constraint site_device_credentials_key_version_check
    check (key_version ~ '^v[1-9][0-9]*$'),
  constraint site_device_credentials_iv_check
    check (octet_length(username_iv) = 12 and octet_length(password_iv) = 12),
  constraint site_device_credentials_tag_check
    check (octet_length(username_authentication_tag) = 16 and octet_length(password_authentication_tag) = 16)
);

alter table public.site_device_credentials enable row level security;
revoke all on public.site_device_credentials from public, anon, authenticated;
grant select on public.site_device_credentials to service_role;

drop trigger if exists site_device_credentials_set_updated_at on public.site_device_credentials;
create trigger site_device_credentials_set_updated_at
before update on public.site_device_credentials for each row
execute function public.set_updated_at();

create table if not exists public.monitoring_device_imports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  sheet_name text not null,
  file_hash text not null,
  site_id uuid not null references public.sites(id) on delete restrict,
  actor text not null,
  total_count integer not null check (total_count between 1 and 1000),
  inserted_count integer not null default 0 check (inserted_count >= 0),
  status text not null default 'completed' check (status in ('completed', 'failed')),
  created_at timestamptz not null default now(),
  constraint monitoring_device_imports_file_name_check
    check (char_length(btrim(file_name)) between 1 and 255),
  constraint monitoring_device_imports_sheet_name_check
    check (char_length(btrim(sheet_name)) between 1 and 120),
  constraint monitoring_device_imports_file_hash_check
    check (file_hash ~ '^[0-9a-f]{64}$'),
  constraint monitoring_device_imports_actor_check
    check (char_length(btrim(actor)) between 1 and 160)
);

create table if not exists public.monitoring_device_import_rows (
  id bigint generated always as identity primary key,
  import_id uuid not null references public.monitoring_device_imports(id) on delete cascade,
  source_row integer not null check (source_row >= 2),
  device_id uuid not null references public.site_devices(id) on delete restrict,
  sanitized_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint monitoring_device_import_rows_unique unique (import_id, source_row)
);

create index if not exists monitoring_device_imports_created_idx
  on public.monitoring_device_imports(created_at desc);
create index if not exists monitoring_device_import_rows_import_idx
  on public.monitoring_device_import_rows(import_id, source_row);

alter table public.monitoring_device_imports enable row level security;
alter table public.monitoring_device_import_rows enable row level security;
revoke all on public.monitoring_device_imports from public, anon, authenticated;
revoke all on public.monitoring_device_import_rows from public, anon, authenticated;
grant select on public.monitoring_device_imports to service_role;
grant select on public.monitoring_device_import_rows to service_role;

create sequence if not exists public.site_device_monitoring_no_seq start with 1;
revoke all on sequence public.site_device_monitoring_no_seq from public, anon, authenticated;
grant usage, select on sequence public.site_device_monitoring_no_seq to service_role;

create or replace function public.upsert_monitoring_device_v1(
  p_id uuid,
  p_row_version integer,
  p_site_id uuid,
  p_device_name text,
  p_ip_address text,
  p_device_type text,
  p_network_cable_no text,
  p_cabinet text,
  p_device_brand text,
  p_device_model text,
  p_details text,
  p_manual_url text,
  p_status text,
  p_credential jsonb,
  p_actor text
)
returns public.site_devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.site_devices;
  v_device_no text;
begin
  if p_site_id is null
     or nullif(btrim(coalesce(p_device_name, '')), '') is null
     or char_length(p_device_name) > 160
     or nullif(btrim(coalesce(p_ip_address, '')), '') is null
     or p_ip_address::inet is null
     or p_device_type not in ('monitoring_host', 'camera', 'hub')
     or nullif(btrim(coalesce(p_cabinet, '')), '') is null
     or char_length(p_cabinet) > 160
     or nullif(btrim(coalesce(p_device_brand, '')), '') is null
     or char_length(p_device_brand) > 120
     or nullif(btrim(coalesce(p_device_model, '')), '') is null
     or char_length(p_device_model) > 160
     or nullif(btrim(coalesce(p_details, '')), '') is null
     or char_length(p_details) > 4000
     or char_length(coalesce(p_network_cable_no, '')) > 120
     or char_length(coalesce(p_manual_url, '')) > 1000
     or (nullif(btrim(coalesce(p_manual_url, '')), '') is not null and p_manual_url !~* '^https?://')
     or p_status not in ('active', 'inactive', 'maintenance')
     or nullif(btrim(coalesce(p_actor, '')), '') is null
     or char_length(p_actor) > 160 then
    raise exception '監控設備資料不完整或格式不正確。';
  end if;

  if not exists (
    select 1
    from public.sites s
    join public.contract_service_types cst on cst.id = s.contract_service_type_id
    where s.id = p_site_id and cst.code = 'surveillance' and cst.is_active = true
  ) then
    raise exception '設備必須屬於有效的監控系統承攬案場。';
  end if;

  if not exists (
    select 1 from public.monitoring_device_types
    where code = p_device_type and is_active = true
  ) then
    raise exception '設備類型不存在或已停用。';
  end if;

  if p_credential is not null and (
       p_credential->>'key_version' !~ '^v[1-9][0-9]*$'
       or nullif(p_credential->>'masked_username', '') is null
       or octet_length(decode(coalesce(p_credential->>'username_iv', ''), 'base64')) <> 12
       or octet_length(decode(coalesce(p_credential->>'password_iv', ''), 'base64')) <> 12
       or octet_length(decode(coalesce(p_credential->>'username_authentication_tag', ''), 'base64')) <> 16
       or octet_length(decode(coalesce(p_credential->>'password_authentication_tag', ''), 'base64')) <> 16
     ) then
    raise exception '設備登入資料加密封裝不完整。';
  end if;

  perform set_config('app.actor', p_actor, true);

  if p_id is null then
    v_device_no := concat('MON-', lpad(nextval('public.site_device_monitoring_no_seq')::text, 6, '0'));
    insert into public.site_devices (
      site_id, device_no, device_name, ip_address, device_type,
      network_cable_no, cabinet, device_brand, device_model, details,
      manual_url, status, notes, credential_configured, source,
      created_by, updated_by
    ) values (
      p_site_id, v_device_no, btrim(p_device_name), host(p_ip_address::inet), p_device_type,
      nullif(btrim(coalesce(p_network_cable_no, '')), ''), btrim(p_cabinet),
      btrim(p_device_brand), btrim(p_device_model), btrim(p_details),
      nullif(btrim(coalesce(p_manual_url, '')), ''), p_status, btrim(p_details),
      p_credential is not null, 'site_data', p_actor, p_actor
    ) returning * into v_device;
  else
    if p_row_version is null or p_row_version < 1 then
      raise exception '監控設備版本不正確。';
    end if;
    update public.site_devices
    set site_id = p_site_id,
        device_name = btrim(p_device_name),
        ip_address = host(p_ip_address::inet),
        device_type = p_device_type,
        network_cable_no = nullif(btrim(coalesce(p_network_cable_no, '')), ''),
        cabinet = btrim(p_cabinet),
        device_brand = btrim(p_device_brand),
        device_model = btrim(p_device_model),
        details = btrim(p_details),
        manual_url = nullif(btrim(coalesce(p_manual_url, '')), ''),
        status = p_status,
        notes = btrim(p_details),
        credential_configured = case when p_credential is null then credential_configured else true end,
        source = 'site_data',
        updated_by = p_actor
    where id = p_id and row_version = p_row_version and deleted_at is null
    returning * into v_device;
    if not found then
      raise exception '監控設備已被其他使用者更新，請重新載入後再修改。';
    end if;
  end if;

  if p_credential is not null then
    insert into public.site_device_credentials (
      device_id,
      username_ciphertext, username_iv, username_authentication_tag,
      password_ciphertext, password_iv, password_authentication_tag,
      masked_username, key_version, updated_by
    ) values (
      v_device.id,
      decode(p_credential->>'username_ciphertext', 'base64'),
      decode(p_credential->>'username_iv', 'base64'),
      decode(p_credential->>'username_authentication_tag', 'base64'),
      decode(p_credential->>'password_ciphertext', 'base64'),
      decode(p_credential->>'password_iv', 'base64'),
      decode(p_credential->>'password_authentication_tag', 'base64'),
      p_credential->>'masked_username', p_credential->>'key_version', p_actor
    )
    on conflict (device_id) do update
    set username_ciphertext = excluded.username_ciphertext,
        username_iv = excluded.username_iv,
        username_authentication_tag = excluded.username_authentication_tag,
        password_ciphertext = excluded.password_ciphertext,
        password_iv = excluded.password_iv,
        password_authentication_tag = excluded.password_authentication_tag,
        masked_username = excluded.masked_username,
        key_version = excluded.key_version,
        updated_by = excluded.updated_by;

    insert into public.audit_logs (
      entity_type, entity_id, action, before_data, after_data, source, actor
    ) values (
      'site_device_credentials', v_device.id, 'UPDATE_CREDENTIAL', null,
      jsonb_build_object('masked_username', p_credential->>'masked_username', 'key_version', p_credential->>'key_version'),
      'site_data', p_actor
    );
  end if;

  return v_device;
exception
  when unique_violation then
    raise exception '此 IP 位址已被其他有效設備使用。';
  when invalid_text_representation then
    raise exception 'IP 位址或加密資料格式不正確。';
end;
$$;

create or replace function public.delete_monitoring_device_v1(
  p_id uuid,
  p_row_version integer,
  p_actor text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_id is null or p_row_version is null or p_row_version < 1
     or nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception '監控設備或版本不正確。';
  end if;
  perform set_config('app.actor', p_actor, true);
  delete from public.site_device_credentials where device_id = p_id;
  update public.site_devices
  set deleted_at = now(), credential_configured = false, updated_by = p_actor
  where id = p_id and row_version = p_row_version and deleted_at is null;
  if not found then
    raise exception '監控設備已被其他使用者更新，請重新載入後再刪除。';
  end if;
end;
$$;

create or replace function public.import_monitoring_devices_v1(
  p_file_name text,
  p_sheet_name text,
  p_file_hash text,
  p_site_id uuid,
  p_rows jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_import_id uuid;
  v_row jsonb;
  v_device public.site_devices;
  v_count integer := 0;
begin
  if p_site_id is null
     or nullif(btrim(coalesce(p_file_name, '')), '') is null
     or char_length(p_file_name) > 255
     or nullif(btrim(coalesce(p_sheet_name, '')), '') is null
     or char_length(p_sheet_name) > 120
     or p_file_hash !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) < 1
     or jsonb_array_length(p_rows) > 1000
     or nullif(btrim(coalesce(p_actor, '')), '') is null
     or char_length(p_actor) > 160 then
    raise exception '監控設備匯入資料不完整。';
  end if;

  if not exists (
    select 1
    from public.sites s
    join public.contract_service_types cst on cst.id = s.contract_service_type_id
    where s.id = p_site_id and cst.code = 'surveillance' and cst.is_active = true
  ) then
    raise exception '匯入目標必須是有效的監控系統承攬案場。';
  end if;

  if exists (
    select 1
    from (
      select host((value->>'ip_address')::inet) as ip, count(*)
      from jsonb_array_elements(p_rows)
      group by host((value->>'ip_address')::inet)
      having count(*) > 1
    ) duplicate_ips
  ) then
    raise exception '匯入檔案包含重複 IP 位址。';
  end if;

  insert into public.monitoring_device_imports (
    file_name, sheet_name, file_hash, site_id, actor, total_count, inserted_count
  ) values (
    btrim(p_file_name), btrim(p_sheet_name), p_file_hash, p_site_id, p_actor,
    jsonb_array_length(p_rows), 0
  ) returning id into v_import_id;

  perform set_config('app.actor', p_actor, true);
  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_device := public.upsert_monitoring_device_v1(
      null,
      null,
      p_site_id,
      v_row->>'device_name',
      v_row->>'ip_address',
      v_row->>'device_type',
      v_row->>'network_cable_no',
      v_row->>'cabinet',
      v_row->>'device_brand',
      v_row->>'device_model',
      v_row->>'details',
      v_row->>'manual_url',
      coalesce(nullif(v_row->>'status', ''), 'active'),
      v_row->'credential',
      p_actor
    );

    insert into public.monitoring_device_import_rows (
      import_id, source_row, device_id, sanitized_payload
    ) values (
      v_import_id,
      (v_row->>'source_row')::integer,
      v_device.id,
      jsonb_build_object(
        'device_name', v_device.device_name,
        'ip_address', v_device.ip_address,
        'device_type', v_device.device_type,
        'network_cable_no', v_device.network_cable_no,
        'cabinet', v_device.cabinet,
        'device_brand', v_device.device_brand,
        'device_model', v_device.device_model,
        'details', v_device.details,
        'manual_url', v_device.manual_url,
        'masked_username', v_row#>>'{credential,masked_username}',
        'password_provided', v_row ? 'credential'
      )
    );
    v_count := v_count + 1;
  end loop;

  update public.monitoring_device_imports
  set inserted_count = v_count
  where id = v_import_id;

  insert into public.audit_logs (
    entity_type, entity_id, action, before_data, after_data, source, actor
  ) values (
    'monitoring_device_imports', v_import_id, 'IMPORT_DEVICES', null,
    jsonb_build_object('file_name', btrim(p_file_name), 'sheet_name', btrim(p_sheet_name), 'total_count', v_count),
    'site_data', p_actor
  );

  return jsonb_build_object('import_id', v_import_id, 'inserted', v_count, 'total', jsonb_array_length(p_rows));
end;
$$;

revoke all on function public.upsert_monitoring_device_v1(uuid,integer,uuid,text,text,text,text,text,text,text,text,text,text,jsonb,text)
  from public, anon, authenticated;
revoke all on function public.get_monitoring_device_key_v1()
  from public, anon, authenticated;
revoke all on function public.delete_monitoring_device_v1(uuid,integer,text)
  from public, anon, authenticated;
revoke all on function public.import_monitoring_devices_v1(text,text,text,uuid,jsonb,text)
  from public, anon, authenticated;

grant execute on function public.upsert_monitoring_device_v1(uuid,integer,uuid,text,text,text,text,text,text,text,text,text,text,jsonb,text)
  to service_role;
grant execute on function public.get_monitoring_device_key_v1()
  to service_role;
grant execute on function public.delete_monitoring_device_v1(uuid,integer,text)
  to service_role;
grant execute on function public.import_monitoring_devices_v1(text,text,text,uuid,jsonb,text)
  to service_role;

commit;
