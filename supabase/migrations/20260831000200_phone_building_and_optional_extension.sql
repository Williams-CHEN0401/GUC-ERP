begin;

-- This is an additive, phone-module-only change. Existing rows remain unchanged.
alter table public.phone_extensions
  add column if not exists building_name text;

alter table public.phone_extensions
  drop constraint if exists phone_extensions_number_check;

alter table public.phone_extensions
  alter column extension_number drop not null;

alter table public.phone_extensions
  add constraint phone_extensions_number_check
  check (
    extension_number is null
    or char_length(btrim(extension_number)) between 1 and 40
  );

alter table public.phone_extensions
  drop constraint if exists phone_extensions_building_name_check;

alter table public.phone_extensions
  add constraint phone_extensions_building_name_check
  check (building_name is null or char_length(building_name) <= 80);

create index if not exists phone_extensions_building_floor_idx
  on public.phone_extensions(customer_id, contract_service_type_id, building_name, floor);

create or replace function public.upsert_phone_extension_v2(
  p_customer_id uuid,
  p_contract_service_type_id uuid,
  p_phone_system_id uuid,
  p_id uuid,
  p_row_version integer,
  p_line_type text,
  p_extension_number text,
  p_extension_name text,
  p_building_name text,
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
  if p_customer_id is null
     or p_contract_service_type_id is null
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
      extension_number, extension_name, building_name, floor, installation_location,
      device_brand, device_model, notes, source, updated_by
    ) values (
      p_customer_id, p_contract_service_type_id, p_phone_system_id, p_line_type,
      nullif(btrim(coalesce(p_extension_number, '')), ''),
      nullif(btrim(coalesce(p_extension_name, '')), ''),
      nullif(btrim(coalesce(p_building_name, '')), ''),
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
        extension_number = nullif(btrim(coalesce(p_extension_number, '')), ''),
        extension_name = nullif(btrim(coalesce(p_extension_name, '')), ''),
        building_name = nullif(btrim(coalesce(p_building_name, '')), ''),
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
      coalesce(
        nullif(concat_ws(' ', nullif(btrim(coalesce(p_building_name, '')), ''), nullif(btrim(coalesce(p_floor, '')), '')), ''),
        '現場端'
      ),
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

revoke all on function public.upsert_phone_extension_v2(
  uuid,uuid,uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,text,text,text,text
) from public, anon, authenticated;

grant execute on function public.upsert_phone_extension_v2(
  uuid,uuid,uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,text,text,text,text
) to service_role;

commit;
