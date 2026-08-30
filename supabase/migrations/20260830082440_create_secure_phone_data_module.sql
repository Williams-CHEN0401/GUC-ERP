begin;

-- The key is generated inside Supabase Vault at migration time. It is never
-- stored in source control or returned by the application API.
do $$
begin
  if not exists (
    select 1 from vault.secrets where name = 'guc_phone_credentials_v1'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'base64'),
      'guc_phone_credentials_v1',
      'GUC phone system credential encryption key v1',
      null
    );
  end if;
end;
$$;

create table if not exists public.phone_systems (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  contract_service_type_id uuid not null,
  system_name text not null,
  ip_address inet,
  installation_location text,
  device_brand text,
  device_model text,
  notes text,
  credential_configured boolean not null default false,
  source text not null default 'web',
  updated_by text,
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phone_systems_contract_fkey
    foreign key (customer_id, contract_service_type_id)
    references public.customer_contract_services(customer_id, service_type_id)
    on delete cascade,
  constraint phone_systems_name_check
    check (char_length(btrim(system_name)) between 1 and 160),
  constraint phone_systems_location_check
    check (installation_location is null or char_length(installation_location) <= 300),
  constraint phone_systems_brand_check
    check (device_brand is null or char_length(device_brand) <= 120),
  constraint phone_systems_model_check
    check (device_model is null or char_length(device_model) <= 160),
  constraint phone_systems_notes_check
    check (notes is null or char_length(notes) <= 2000),
  constraint phone_systems_identity_unique
    unique (id, customer_id, contract_service_type_id)
);

create unique index if not exists phone_systems_customer_name_uidx
  on public.phone_systems(customer_id, contract_service_type_id, lower(btrim(system_name)));
create index if not exists phone_systems_contract_idx
  on public.phone_systems(customer_id, contract_service_type_id);

create table if not exists public.phone_extensions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  contract_service_type_id uuid not null,
  phone_system_id uuid,
  line_type text not null default 'extension'
    check (line_type in ('extension', 'trunk', 'special')),
  extension_number text not null,
  extension_name text,
  floor text,
  installation_location text,
  device_brand text,
  device_model text,
  notes text,
  source_reference text,
  source text not null default 'web',
  updated_by text,
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phone_extensions_contract_fkey
    foreign key (customer_id, contract_service_type_id)
    references public.customer_contract_services(customer_id, service_type_id)
    on delete cascade,
  constraint phone_extensions_system_fkey
    foreign key (phone_system_id, customer_id, contract_service_type_id)
    references public.phone_systems(id, customer_id, contract_service_type_id)
    on delete restrict,
  constraint phone_extensions_number_check
    check (char_length(btrim(extension_number)) between 1 and 40),
  constraint phone_extensions_name_check
    check (extension_name is null or char_length(extension_name) <= 160),
  constraint phone_extensions_floor_check
    check (floor is null or char_length(floor) <= 80),
  constraint phone_extensions_location_check
    check (installation_location is null or char_length(installation_location) <= 300),
  constraint phone_extensions_brand_check
    check (device_brand is null or char_length(device_brand) <= 120),
  constraint phone_extensions_model_check
    check (device_model is null or char_length(device_model) <= 160),
  constraint phone_extensions_notes_check
    check (notes is null or char_length(notes) <= 2000),
  constraint phone_extensions_identity_unique
    unique (id, customer_id, contract_service_type_id),
  constraint phone_extensions_number_unique
    unique (customer_id, contract_service_type_id, extension_number)
);

create index if not exists phone_extensions_system_idx
  on public.phone_extensions(phone_system_id);
create index if not exists phone_extensions_floor_idx
  on public.phone_extensions(customer_id, contract_service_type_id, floor);
create index if not exists phone_extensions_model_idx
  on public.phone_extensions(customer_id, contract_service_type_id, device_model);

create table if not exists public.phone_terminal_points (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  contract_service_type_id uuid not null,
  phone_extension_id uuid not null,
  endpoint_side text not null
    check (endpoint_side in ('system', 'field', 'carrier', 'other')),
  frame_name text,
  frame_block text,
  frame_position integer check (frame_position is null or frame_position between 1 and 10000),
  terminal_code text,
  slot_identifier text,
  floor text,
  installation_location text,
  notes text,
  source_reference text,
  source text not null default 'web',
  updated_by text,
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phone_terminal_points_contract_fkey
    foreign key (customer_id, contract_service_type_id)
    references public.customer_contract_services(customer_id, service_type_id)
    on delete cascade,
  constraint phone_terminal_points_extension_fkey
    foreign key (phone_extension_id, customer_id, contract_service_type_id)
    references public.phone_extensions(id, customer_id, contract_service_type_id)
    on delete cascade,
  constraint phone_terminal_points_frame_name_check
    check (frame_name is null or char_length(frame_name) <= 160),
  constraint phone_terminal_points_frame_block_check
    check (frame_block is null or char_length(frame_block) <= 80),
  constraint phone_terminal_points_terminal_code_check
    check (terminal_code is null or char_length(terminal_code) <= 80),
  constraint phone_terminal_points_slot_check
    check (slot_identifier is null or char_length(slot_identifier) <= 120),
  constraint phone_terminal_points_floor_check
    check (floor is null or char_length(floor) <= 80),
  constraint phone_terminal_points_location_check
    check (installation_location is null or char_length(installation_location) <= 300),
  constraint phone_terminal_points_notes_check
    check (notes is null or char_length(notes) <= 1000),
  constraint phone_terminal_points_side_unique
    unique (phone_extension_id, endpoint_side)
);

create index if not exists phone_terminal_points_contract_idx
  on public.phone_terminal_points(customer_id, contract_service_type_id);
create index if not exists phone_terminal_points_extension_idx
  on public.phone_terminal_points(phone_extension_id);
create index if not exists phone_terminal_points_slot_idx
  on public.phone_terminal_points(customer_id, contract_service_type_id, slot_identifier);
create index if not exists phone_terminal_points_terminal_code_idx
  on public.phone_terminal_points(customer_id, contract_service_type_id, terminal_code);

create table if not exists public.phone_system_credentials (
  phone_system_id uuid primary key,
  customer_id uuid not null,
  contract_service_type_id uuid not null,
  login_username_ciphertext bytea not null,
  login_password_ciphertext bytea not null,
  key_version text not null default 'v1',
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phone_system_credentials_system_fkey
    foreign key (phone_system_id, customer_id, contract_service_type_id)
    references public.phone_systems(id, customer_id, contract_service_type_id)
    on delete cascade,
  constraint phone_system_credentials_key_version_check
    check (key_version ~ '^v[1-9][0-9]*$')
);

create index if not exists phone_system_credentials_contract_idx
  on public.phone_system_credentials(customer_id, contract_service_type_id);

create table if not exists public.phone_credential_access_logs (
  id bigint generated always as identity primary key,
  phone_system_id uuid,
  customer_id uuid,
  contract_service_type_id uuid,
  action text not null check (action in ('reveal', 'update', 'clear')),
  actor text not null,
  source text not null default 'site_data',
  created_at timestamptz not null default now(),
  constraint phone_credential_access_logs_actor_check
    check (char_length(btrim(actor)) between 1 and 160)
);

create index if not exists phone_credential_access_logs_customer_idx
  on public.phone_credential_access_logs(customer_id, contract_service_type_id, created_at desc);
create index if not exists phone_credential_access_logs_system_idx
  on public.phone_credential_access_logs(phone_system_id, created_at desc);

create or replace function public.validate_phone_contract_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.customer_contract_services links
    join public.contract_service_types types
      on types.id = links.service_type_id
    where links.customer_id = new.customer_id
      and links.service_type_id = new.contract_service_type_id
      and types.code = 'phone_system'
      and types.is_active = true
  ) then
    raise exception '客戶未承攬啟用中的電話系統服務。';
  end if;
  return new;
end;
$$;

drop trigger if exists phone_systems_validate_contract on public.phone_systems;
create trigger phone_systems_validate_contract
before insert or update of customer_id, contract_service_type_id
on public.phone_systems for each row
execute function public.validate_phone_contract_v1();

drop trigger if exists phone_extensions_validate_contract on public.phone_extensions;
create trigger phone_extensions_validate_contract
before insert or update of customer_id, contract_service_type_id
on public.phone_extensions for each row
execute function public.validate_phone_contract_v1();

drop trigger if exists phone_terminal_points_validate_contract on public.phone_terminal_points;
create trigger phone_terminal_points_validate_contract
before insert or update of customer_id, contract_service_type_id
on public.phone_terminal_points for each row
execute function public.validate_phone_contract_v1();

drop trigger if exists phone_systems_increment_row_version on public.phone_systems;
create trigger phone_systems_increment_row_version
before update on public.phone_systems for each row
execute function public.increment_row_version();

drop trigger if exists phone_extensions_increment_row_version on public.phone_extensions;
create trigger phone_extensions_increment_row_version
before update on public.phone_extensions for each row
execute function public.increment_row_version();

drop trigger if exists phone_terminal_points_increment_row_version on public.phone_terminal_points;
create trigger phone_terminal_points_increment_row_version
before update on public.phone_terminal_points for each row
execute function public.increment_row_version();

drop trigger if exists phone_system_credentials_set_updated_at on public.phone_system_credentials;
create trigger phone_system_credentials_set_updated_at
before update on public.phone_system_credentials for each row
execute function public.set_updated_at();

drop trigger if exists phone_systems_audit on public.phone_systems;
create trigger phone_systems_audit
after insert or update or delete on public.phone_systems for each row
execute function public.capture_audit_log();

drop trigger if exists phone_extensions_audit on public.phone_extensions;
create trigger phone_extensions_audit
after insert or update or delete on public.phone_extensions for each row
execute function public.capture_audit_log();

drop trigger if exists phone_terminal_points_audit on public.phone_terminal_points;
create trigger phone_terminal_points_audit
after insert or update or delete on public.phone_terminal_points for each row
execute function public.capture_audit_log();

create or replace function public.upsert_phone_extension_v1(
  p_customer_id uuid,
  p_contract_service_type_id uuid,
  p_phone_system_id uuid,
  p_id uuid,
  p_row_version integer,
  p_line_type text,
  p_extension_number text,
  p_extension_name text,
  p_floor text,
  p_installation_location text,
  p_device_brand text,
  p_device_model text,
  p_notes text,
  p_system_slot text,
  p_system_terminal_code text,
  p_field_slot text,
  p_field_terminal_code text,
  p_actor text
)
returns public.phone_extensions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_extension public.phone_extensions;
  v_system_name text;
begin
  if p_customer_id is null or p_contract_service_type_id is null
     or nullif(btrim(coalesce(p_extension_number, '')), '') is null
     or p_line_type not in ('extension', 'trunk', 'special')
     or nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception '電話資料輸入不完整。';
  end if;

  perform set_config('app.actor', p_actor, true);

  if p_phone_system_id is not null then
    select system_name into v_system_name
    from public.phone_systems
    where id = p_phone_system_id
      and customer_id = p_customer_id
      and contract_service_type_id = p_contract_service_type_id;
    if not found then raise exception '所選總機不屬於此客戶與電話承攬內容。'; end if;
  end if;

  if p_id is null then
    insert into public.phone_extensions (
      customer_id, contract_service_type_id, phone_system_id, line_type,
      extension_number, extension_name, floor, installation_location,
      device_brand, device_model, notes, source, updated_by
    ) values (
      p_customer_id, p_contract_service_type_id, p_phone_system_id, p_line_type,
      btrim(p_extension_number), nullif(btrim(coalesce(p_extension_name, '')), ''),
      nullif(btrim(coalesce(p_floor, '')), ''),
      nullif(btrim(coalesce(p_installation_location, '')), ''),
      nullif(btrim(coalesce(p_device_brand, '')), ''),
      nullif(btrim(coalesce(p_device_model, '')), ''),
      nullif(btrim(coalesce(p_notes, '')), ''), 'site_data', p_actor
    ) returning * into v_extension;
  else
    update public.phone_extensions
    set phone_system_id = p_phone_system_id,
        line_type = p_line_type,
        extension_number = btrim(p_extension_number),
        extension_name = nullif(btrim(coalesce(p_extension_name, '')), ''),
        floor = nullif(btrim(coalesce(p_floor, '')), ''),
        installation_location = nullif(btrim(coalesce(p_installation_location, '')), ''),
        device_brand = nullif(btrim(coalesce(p_device_brand, '')), ''),
        device_model = nullif(btrim(coalesce(p_device_model, '')), ''),
        notes = nullif(btrim(coalesce(p_notes, '')), ''),
        source = 'site_data',
        updated_by = p_actor
    where id = p_id
      and customer_id = p_customer_id
      and contract_service_type_id = p_contract_service_type_id
      and row_version = p_row_version
    returning * into v_extension;
    if not found then raise exception '電話資料已被其他使用者更新，請重新載入後再修改。'; end if;
  end if;

  if nullif(btrim(coalesce(p_system_slot, '')), '') is null
     and nullif(btrim(coalesce(p_system_terminal_code, '')), '') is null then
    delete from public.phone_terminal_points
    where phone_extension_id = v_extension.id and endpoint_side = 'system';
  else
    insert into public.phone_terminal_points (
      customer_id, contract_service_type_id, phone_extension_id, endpoint_side,
      frame_name, terminal_code, slot_identifier, source, updated_by
    ) values (
      p_customer_id, p_contract_service_type_id, v_extension.id, 'system',
      coalesce(v_system_name, '總機系統端'),
      nullif(btrim(coalesce(p_system_terminal_code, '')), ''),
      nullif(btrim(coalesce(p_system_slot, '')), ''), 'site_data', p_actor
    )
    on conflict (phone_extension_id, endpoint_side) do update
    set frame_name = excluded.frame_name,
        terminal_code = excluded.terminal_code,
        slot_identifier = excluded.slot_identifier,
        source = excluded.source,
        updated_by = excluded.updated_by;
  end if;

  if nullif(btrim(coalesce(p_field_slot, '')), '') is null
     and nullif(btrim(coalesce(p_field_terminal_code, '')), '') is null then
    delete from public.phone_terminal_points
    where phone_extension_id = v_extension.id and endpoint_side = 'field';
  else
    insert into public.phone_terminal_points (
      customer_id, contract_service_type_id, phone_extension_id, endpoint_side,
      frame_name, terminal_code, slot_identifier, floor, installation_location,
      source, updated_by
    ) values (
      p_customer_id, p_contract_service_type_id, v_extension.id, 'field',
      coalesce(nullif(btrim(coalesce(p_floor, '')), ''), '現場端'),
      nullif(btrim(coalesce(p_field_terminal_code, '')), ''),
      nullif(btrim(coalesce(p_field_slot, '')), ''),
      nullif(btrim(coalesce(p_floor, '')), ''),
      nullif(btrim(coalesce(p_installation_location, '')), ''),
      'site_data', p_actor
    )
    on conflict (phone_extension_id, endpoint_side) do update
    set frame_name = excluded.frame_name,
        terminal_code = excluded.terminal_code,
        slot_identifier = excluded.slot_identifier,
        floor = excluded.floor,
        installation_location = excluded.installation_location,
        source = excluded.source,
        updated_by = excluded.updated_by;
  end if;

  return v_extension;
exception
  when unique_violation then
    raise exception '同一客戶的電話號碼已存在。';
end;
$$;

create or replace function public.delete_phone_extension_v1(
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
  perform set_config('app.actor', coalesce(p_actor, ''), true);
  delete from public.phone_extensions
  where id = p_id and row_version = p_row_version;
  if not found then raise exception '電話資料已被其他使用者更新，請重新載入後再刪除。'; end if;
end;
$$;

create or replace function public.delete_phone_system_v1(
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
  perform set_config('app.actor', coalesce(p_actor, ''), true);
  if exists (select 1 from public.phone_extensions where phone_system_id = p_id) then
    raise exception '此總機仍有分機資料，請先移轉或刪除相關分機。';
  end if;
  delete from public.phone_systems
  where id = p_id and row_version = p_row_version;
  if not found then raise exception '總機資料已被其他使用者更新，請重新載入後再刪除。'; end if;
end;
$$;

create or replace function public.store_phone_system_credential_v1(
  p_phone_system_id uuid,
  p_login_username text,
  p_login_password text,
  p_actor text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_system public.phone_systems;
begin
  if char_length(coalesce(p_login_username, '')) not between 1 and 256
     or char_length(coalesce(p_login_password, '')) not between 1 and 512
     or nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception '總機登入帳號或密碼格式不正確。';
  end if;

  select * into v_system from public.phone_systems where id = p_phone_system_id;
  if not found then raise exception '找不到總機資料。'; end if;

  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'guc_phone_credentials_v1';
  if v_key is null then raise exception '電話憑證加密金鑰尚未建立。'; end if;

  insert into public.phone_system_credentials (
    phone_system_id, customer_id, contract_service_type_id,
    login_username_ciphertext, login_password_ciphertext,
    key_version, updated_by
  ) values (
    v_system.id, v_system.customer_id, v_system.contract_service_type_id,
    extensions.pgp_sym_encrypt(p_login_username, v_key, 'cipher-algo=aes256,compress-algo=0'),
    extensions.pgp_sym_encrypt(p_login_password, v_key, 'cipher-algo=aes256,compress-algo=0'),
    'v1', p_actor
  )
  on conflict (phone_system_id) do update
  set login_username_ciphertext = excluded.login_username_ciphertext,
      login_password_ciphertext = excluded.login_password_ciphertext,
      key_version = excluded.key_version,
      updated_by = excluded.updated_by;

  update public.phone_systems
  set credential_configured = true,
      source = 'site_data',
      updated_by = p_actor
  where id = v_system.id;

  insert into public.phone_credential_access_logs (
    phone_system_id, customer_id, contract_service_type_id, action, actor
  ) values (
    v_system.id, v_system.customer_id, v_system.contract_service_type_id,
    'update', p_actor
  );
end;
$$;

create or replace function public.reveal_phone_system_credential_v1(
  p_phone_system_id uuid,
  p_actor text
)
returns table(login_username text, login_password text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_credential public.phone_system_credentials;
begin
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception '缺少敏感資料操作人員。';
  end if;

  select * into v_credential
  from public.phone_system_credentials
  where phone_system_id = p_phone_system_id;
  if not found then raise exception '此總機尚未設定登入帳號密碼。'; end if;

  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'guc_phone_credentials_v1';
  if v_key is null then raise exception '電話憑證加密金鑰無法使用。'; end if;

  insert into public.phone_credential_access_logs (
    phone_system_id, customer_id, contract_service_type_id, action, actor
  ) values (
    v_credential.phone_system_id, v_credential.customer_id,
    v_credential.contract_service_type_id, 'reveal', p_actor
  );

  return query select
    extensions.pgp_sym_decrypt(v_credential.login_username_ciphertext, v_key),
    extensions.pgp_sym_decrypt(v_credential.login_password_ciphertext, v_key);
end;
$$;

alter table public.phone_systems enable row level security;
alter table public.phone_extensions enable row level security;
alter table public.phone_terminal_points enable row level security;
alter table public.phone_system_credentials enable row level security;
alter table public.phone_credential_access_logs enable row level security;

revoke all on public.phone_systems from public, anon, authenticated;
revoke all on public.phone_extensions from public, anon, authenticated;
revoke all on public.phone_terminal_points from public, anon, authenticated;
revoke all on public.phone_system_credentials from public, anon, authenticated;
revoke all on public.phone_credential_access_logs from public, anon, authenticated;

grant select, insert, update, delete on public.phone_systems to service_role;
grant select, insert, update, delete on public.phone_extensions to service_role;
grant select, insert, update, delete on public.phone_terminal_points to service_role;
grant select, insert, update, delete on public.phone_system_credentials to service_role;
grant select, insert on public.phone_credential_access_logs to service_role;
grant usage, select on sequence public.phone_credential_access_logs_id_seq to service_role;

revoke all on function public.validate_phone_contract_v1()
  from public, anon, authenticated;
revoke all on function public.upsert_phone_extension_v1(uuid,uuid,uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,text,text,text)
  from public, anon, authenticated;
revoke all on function public.delete_phone_extension_v1(uuid,integer,text)
  from public, anon, authenticated;
revoke all on function public.delete_phone_system_v1(uuid,integer,text)
  from public, anon, authenticated;
revoke all on function public.store_phone_system_credential_v1(uuid,text,text,text)
  from public, anon, authenticated;
revoke all on function public.reveal_phone_system_credential_v1(uuid,text)
  from public, anon, authenticated;

grant execute on function public.upsert_phone_extension_v1(uuid,uuid,uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,text,text,text)
  to service_role;
grant execute on function public.delete_phone_extension_v1(uuid,integer,text)
  to service_role;
grant execute on function public.delete_phone_system_v1(uuid,integer,text)
  to service_role;
grant execute on function public.store_phone_system_credential_v1(uuid,text,text,text)
  to service_role;
grant execute on function public.reveal_phone_system_credential_v1(uuid,text)
  to service_role;

commit;
