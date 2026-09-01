begin;

create table if not exists public.phone_terminal_import_logs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  contract_service_type_id uuid not null references public.contract_service_types(id) on delete restrict,
  file_name text not null check (char_length(file_name) between 1 and 255),
  import_type text not null check (import_type in ('system', 'field')),
  uploaded_at timestamptz not null default now(),
  actor text not null,
  total_count integer not null default 0 check (total_count >= 0),
  inserted_count integer not null default 0 check (inserted_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  failure_reasons jsonb not null default '[]'::jsonb,
  source_rows jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.phone_terminal_import_logs enable row level security;
revoke all on public.phone_terminal_import_logs from public, anon, authenticated;
grant select, insert on public.phone_terminal_import_logs to service_role;

create index if not exists phone_terminal_import_logs_customer_idx
  on public.phone_terminal_import_logs(customer_id, uploaded_at desc);

create unique index if not exists phone_terminal_points_location_uidx
  on public.phone_terminal_points(customer_id, contract_service_type_id, endpoint_side, frame_name, frame_block, frame_position)
  where frame_name is not null and frame_block is not null and frame_position is not null;

create or replace function public.import_phone_terminal_rows_v1(
  p_customer_id uuid,
  p_contract_service_type_id uuid,
  p_file_name text,
  p_import_type text,
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
  v_extension public.phone_extensions;
  v_point public.phone_terminal_points;
  v_slot integer;
  v_board text;
  v_number text;
  v_building text;
  v_floor text;
  v_terminal text;
  v_existing_id uuid;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_failures jsonb := '[]'::jsonb;
  v_log_id uuid;
begin
  if p_customer_id is null or p_contract_service_type_id is null
     or nullif(btrim(coalesce(p_file_name, '')), '') is null
     or p_import_type not in ('system', 'field')
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) < 1
     or jsonb_array_length(p_rows) > 1000
     or nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception '端子匯入資料不完整。';
  end if;

  if not exists (
    select 1 from public.customer_contract_services ccs
    join public.contract_service_types cst on cst.id = ccs.service_type_id
    where ccs.customer_id = p_customer_id
      and ccs.service_type_id = p_contract_service_type_id
      and cst.code = 'phone_system'
      and cst.is_active = true
  ) then raise exception '指定客戶沒有有效的電話系統承攬內容。'; end if;

  perform set_config('app.actor', p_actor, true);

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_board := nullif(btrim(coalesce(v_row->>'board', '')), '');
    v_slot := case when coalesce(v_row->>'slot', '') ~ '^[0-9]{1,5}$' then (v_row->>'slot')::integer else null end;
    v_number := nullif(btrim(coalesce(v_row->>'extension_number', '')), '');
    v_building := nullif(btrim(coalesce(v_row->>'building', '')), '');
    v_floor := nullif(btrim(coalesce(v_row->>'floor', '')), '');
    v_terminal := nullif(btrim(coalesce(v_row->>'terminal_position', '')), '');
    v_existing_id := case when coalesce(v_row->>'existing_extension_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (v_row->>'existing_extension_id')::uuid else null end;

    if v_board is null or v_slot is null or v_slot < 1 or v_slot > 10000 then
      raise exception '端子板與槽位格式不正確。';
    end if;

    if p_import_type = 'system' then
      select pt.* into v_point
      from public.phone_terminal_points pt
      where pt.customer_id = p_customer_id
        and pt.contract_service_type_id = p_contract_service_type_id
        and pt.endpoint_side = 'system'
        and pt.frame_name = '總機系統端'
        and pt.frame_block = v_board
        and pt.frame_position = v_slot
      for update;

      if found then
        select * into v_extension from public.phone_extensions where id = v_point.phone_extension_id for update;
        update public.phone_extensions
        set extension_number = coalesce(v_number, extension_number),
            building_name = coalesce(v_building, building_name),
            floor = coalesce(v_floor, floor), source = 'excel_import', updated_by = p_actor
        where id = v_extension.id;
        update public.phone_terminal_points
        set terminal_code = coalesce(v_terminal, terminal_code),
            slot_identifier = v_slot::text,
            source_reference = concat(p_file_name, ':', coalesce(v_row->>'source_sheet', ''), ':', coalesce(v_row->>'source_row', '')),
            source = 'excel_import', updated_by = p_actor
        where id = v_point.id;
        v_updated := v_updated + 1;
      else
        v_extension := null;
        if v_number is not null then
          select * into v_extension from public.phone_extensions
          where customer_id = p_customer_id and contract_service_type_id = p_contract_service_type_id
            and extension_number = v_number for update;
        end if;
        if v_extension.id is null then
          insert into public.phone_extensions (
            customer_id, contract_service_type_id, line_type, extension_number,
            building_name, floor, source_reference, source, updated_by
          ) values (
            p_customer_id, p_contract_service_type_id, 'extension', v_number,
            v_building, v_floor, concat(p_file_name, ':', coalesce(v_row->>'source_sheet', ''), ':', coalesce(v_row->>'source_row', '')),
            'excel_import', p_actor
          ) returning * into v_extension;
        else
          update public.phone_extensions set
            building_name = coalesce(v_building, building_name), floor = coalesce(v_floor, floor),
            source = 'excel_import', updated_by = p_actor
          where id = v_extension.id returning * into v_extension;
        end if;
        insert into public.phone_terminal_points (
          customer_id, contract_service_type_id, phone_extension_id, endpoint_side,
          frame_name, frame_block, frame_position, terminal_code, slot_identifier,
          source_reference, source, updated_by
        ) values (
          p_customer_id, p_contract_service_type_id, v_extension.id, 'system',
          '總機系統端', v_board, v_slot, v_terminal, v_slot::text,
          concat(p_file_name, ':', coalesce(v_row->>'source_sheet', ''), ':', coalesce(v_row->>'source_row', '')),
          'excel_import', p_actor
        );
        v_inserted := v_inserted + 1;
      end if;
    else
      if v_existing_id is null then raise exception '現場端資料缺少唯一的既有系統端關聯。'; end if;
      select * into v_extension from public.phone_extensions
      where id = v_existing_id and customer_id = p_customer_id
        and contract_service_type_id = p_contract_service_type_id
        and (v_number is null or extension_number = v_number)
      for update;
      if not found then raise exception '現場端資料找不到相符的既有系統端。'; end if;
      if not exists (select 1 from public.phone_terminal_points where phone_extension_id = v_extension.id and endpoint_side = 'system') then
        raise exception '現場端資料不得建立為沒有系統端的孤立資料。';
      end if;
      insert into public.phone_terminal_points (
        customer_id, contract_service_type_id, phone_extension_id, endpoint_side,
        frame_name, frame_block, frame_position, slot_identifier, floor,
        source_reference, source, updated_by
      ) values (
        p_customer_id, p_contract_service_type_id, v_extension.id, 'field',
        coalesce(nullif(concat_ws(' ', v_building, v_floor), ''), '現場端'),
        v_board, v_slot, v_slot::text, v_floor,
        concat(p_file_name, ':', coalesce(v_row->>'source_sheet', ''), ':', coalesce(v_row->>'source_row', '')),
        'excel_import', p_actor
      ) on conflict (phone_extension_id, endpoint_side) do update set
        frame_name = excluded.frame_name, frame_block = excluded.frame_block,
        frame_position = excluded.frame_position, slot_identifier = excluded.slot_identifier,
        floor = coalesce(excluded.floor, public.phone_terminal_points.floor),
        source_reference = excluded.source_reference, source = excluded.source, updated_by = excluded.updated_by;
      update public.phone_extensions set building_name = coalesce(v_building, building_name),
        floor = coalesce(v_floor, floor), source = 'excel_import', updated_by = p_actor
      where id = v_extension.id;
      v_updated := v_updated + 1;
    end if;
  end loop;

  insert into public.phone_terminal_import_logs (
    customer_id, contract_service_type_id, file_name, import_type, actor,
    total_count, inserted_count, updated_count, skipped_count, failed_count,
    failure_reasons, source_rows
  ) values (
    p_customer_id, p_contract_service_type_id, btrim(p_file_name), p_import_type, p_actor,
    jsonb_array_length(p_rows), v_inserted, v_updated, v_skipped, 0,
    v_failures, p_rows
  ) returning id into v_log_id;

  return jsonb_build_object('log_id', v_log_id, 'inserted', v_inserted, 'updated', v_updated, 'skipped', v_skipped, 'failed', 0);
end;
$$;

revoke all on function public.import_phone_terminal_rows_v1(uuid,uuid,text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.import_phone_terminal_rows_v1(uuid,uuid,text,text,jsonb,text) to service_role;

commit;
