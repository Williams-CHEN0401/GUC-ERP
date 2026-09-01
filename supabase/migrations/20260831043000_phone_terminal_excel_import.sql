begin;

create table if not exists public.phone_terminal_import_logs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  contract_service_type_id uuid not null references public.contract_service_types(id) on delete restrict,
  file_name text not null check (char_length(file_name) between 1 and 255),
  import_type text not null check (import_type in ('system', 'field')),
  uploaded_at timestamptz not null default now(),
  actor text not null check (char_length(btrim(actor)) between 1 and 160),
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
  on public.phone_terminal_points(
    customer_id,
    contract_service_type_id,
    endpoint_side,
    frame_name,
    frame_block,
    frame_position
  )
  where frame_name is not null
    and frame_block is not null
    and frame_position is not null;

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
  v_number_extension public.phone_extensions;
  v_point public.phone_terminal_points;
  v_existing_point public.phone_terminal_points;
  v_slot integer;
  v_frame_name text;
  v_board text;
  v_number text;
  v_building text;
  v_floor text;
  v_terminal text;
  v_terminal_type text;
  v_installation_location text;
  v_phone_type text;
  v_preview_status text;
  v_preview_message text;
  v_existing_id uuid;
  v_source_reference text;
  v_phone_marker text;
  v_point_note text;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_failed integer := 0;
  v_failures jsonb := '[]'::jsonb;
  v_log_id uuid;
begin
  if p_customer_id is null
     or p_contract_service_type_id is null
     or nullif(btrim(coalesce(p_file_name, '')), '') is null
     or char_length(p_file_name) > 255
     or p_import_type not in ('system', 'field')
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) < 1
     or jsonb_array_length(p_rows) > 1000
     or nullif(btrim(coalesce(p_actor, '')), '') is null
     or char_length(p_actor) > 160 then
    raise exception '端子匯入資料不完整。';
  end if;

  if not exists (
    select 1
    from public.customer_contract_services ccs
    join public.contract_service_types cst on cst.id = ccs.service_type_id
    where ccs.customer_id = p_customer_id
      and ccs.service_type_id = p_contract_service_type_id
      and cst.code = 'phone_system'
      and cst.is_active = true
  ) then
    raise exception '指定客戶沒有有效的電話系統承攬內容。';
  end if;

  perform set_config('app.actor', p_actor, true);

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_preview_status := btrim(coalesce(v_row->>'preview_status', ''));
    v_preview_message := left(btrim(coalesce(v_row->>'preview_message', '')), 500);

    if v_preview_status = 'skip' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if v_preview_status = 'error' then
      v_failed := v_failed + 1;
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'source_sheet', v_row->>'source_sheet',
        'source_row', v_row->>'source_row',
        'source_column', v_row->>'source_column',
        'message', coalesce(nullif(v_preview_message, ''), '匯入預覽判定 Mapping 失敗。')
      ));
      continue;
    end if;

    if v_preview_status not in ('new', 'update') then
      v_failed := v_failed + 1;
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'source_sheet', v_row->>'source_sheet',
        'source_row', v_row->>'source_row',
        'source_column', v_row->>'source_column',
        'message', '缺少有效的匯入預覽狀態。'
      ));
      continue;
    end if;

    begin
      v_frame_name := nullif(btrim(coalesce(v_row->>'frame_name', '')), '');
      v_board := nullif(btrim(coalesce(v_row->>'board', '')), '');
      v_slot := case
        when coalesce(v_row->>'slot', '') ~ '^[0-9]{1,5}$' then (v_row->>'slot')::integer
        else null
      end;
      v_number := nullif(btrim(coalesce(v_row->>'extension_number', '')), '');
      v_building := nullif(btrim(coalesce(v_row->>'building', '')), '');
      v_floor := nullif(btrim(coalesce(v_row->>'floor', '')), '');
      v_terminal := nullif(btrim(coalesce(v_row->>'terminal_position', '')), '');
      v_terminal_type := nullif(btrim(coalesce(v_row->>'terminal_type', '')), '');
      v_installation_location := nullif(btrim(coalesce(v_row->>'installation_location', '')), '');
      v_phone_type := nullif(btrim(coalesce(v_row->>'phone_type', '')), '');
      v_existing_id := case
        when coalesce(v_row->>'existing_extension_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then (v_row->>'existing_extension_id')::uuid
        else null
      end;
      v_source_reference := concat(
        left(btrim(p_file_name), 255),
        ':', left(coalesce(v_row->>'source_sheet', ''), 120),
        ':R', coalesce(v_row->>'source_row', ''),
        'C', coalesce(v_row->>'source_column', '')
      );
      v_phone_marker := case
        when v_phone_type in ('digital', 'analog', 'ip', 'trunk') then format('[[phone_type:%s]]', v_phone_type)
        else null
      end;
      v_point_note := case
        when v_terminal_type is not null then left(concat('Excel 型態：', v_terminal_type), 1000)
        else null
      end;

      if v_frame_name is null
         or char_length(v_frame_name) > 160
         or v_board is null
         or char_length(v_board) > 80
         or v_slot is null
         or v_slot < 1
         or v_slot > 10000
         or char_length(coalesce(v_number, '')) > 40
         or char_length(coalesce(v_building, '')) > 80
         or char_length(coalesce(v_floor, '')) > 80
         or char_length(coalesce(v_terminal, '')) > 80
         or char_length(coalesce(v_installation_location, '')) > 300
         or coalesce(v_phone_type, 'unknown') not in ('digital', 'analog', 'ip', 'trunk', 'unknown') then
        raise exception '端子群組、端子板、槽位或欄位格式不正確。';
      end if;

      v_extension := null;
      v_number_extension := null;
      v_point := null;
      v_existing_point := null;

      if p_import_type = 'system' then
        select pt.* into v_point
        from public.phone_terminal_points pt
        where pt.customer_id = p_customer_id
          and pt.contract_service_type_id = p_contract_service_type_id
          and pt.endpoint_side = 'system'
          and pt.frame_name = v_frame_name
          and pt.frame_block = v_board
          and pt.frame_position = v_slot
        for update;

        if v_number is not null then
          select pe.* into v_number_extension
          from public.phone_extensions pe
          where pe.customer_id = p_customer_id
            and pe.contract_service_type_id = p_contract_service_type_id
            and pe.extension_number = v_number
          for update;
        end if;

        if v_point.id is not null then
          select pe.* into v_extension
          from public.phone_extensions pe
          where pe.id = v_point.phone_extension_id
            and pe.customer_id = p_customer_id
            and pe.contract_service_type_id = p_contract_service_type_id
          for update;
          if v_extension.id is null then raise exception '系統端位置缺少有效的電話關聯。'; end if;
          if v_existing_id is not null and v_existing_id <> v_extension.id then raise exception '預覽關聯與系統端位置不一致。'; end if;
          if v_number_extension.id is not null and v_number_extension.id <> v_extension.id then raise exception '系統端位置與號碼分別指向不同資料。'; end if;
          if v_number is not null and v_extension.extension_number is not null and v_extension.extension_number <> v_number then raise exception '系統端位置已屬於不同號碼。'; end if;

          update public.phone_extensions
          set extension_number = coalesce(v_number, extension_number),
              line_type = case when v_phone_type = 'trunk' then 'trunk' else line_type end,
              building_name = coalesce(v_building, building_name),
              floor = coalesce(v_floor, floor),
              notes = case
                when v_phone_marker is not null
                  and coalesce(notes, '') !~ '\[\[phone_type:(digital|analog|ip|trunk)\]\]'
                  then nullif(concat_ws(E'\n', nullif(notes, ''), v_phone_marker), '')
                else notes
              end,
              source = 'excel_import',
              updated_by = p_actor
          where id = v_extension.id;

          update public.phone_terminal_points
          set terminal_code = coalesce(v_terminal, terminal_code),
              slot_identifier = v_slot::text,
              installation_location = coalesce(v_installation_location, installation_location),
              notes = coalesce(v_point_note, notes),
              source_reference = v_source_reference,
              source = 'excel_import',
              updated_by = p_actor
          where id = v_point.id;
          v_updated := v_updated + 1;
        else
          if v_existing_id is not null then
            select pe.* into v_extension
            from public.phone_extensions pe
            where pe.id = v_existing_id
              and pe.customer_id = p_customer_id
              and pe.contract_service_type_id = p_contract_service_type_id
              and (v_number is null or pe.extension_number is null or pe.extension_number = v_number)
            for update;
            if v_extension.id is null then raise exception '預覽指定的既有電話資料不相符。'; end if;
          elsif v_number_extension.id is not null then
            v_extension := v_number_extension;
          end if;

          if v_extension.id is not null then
            select pt.* into v_existing_point
            from public.phone_terminal_points pt
            where pt.phone_extension_id = v_extension.id
              and pt.endpoint_side = 'system'
            for update;
            if v_existing_point.id is not null then raise exception '同一號碼已有不同的系統端位置。'; end if;

            update public.phone_extensions
            set extension_number = coalesce(v_number, extension_number),
                line_type = case when v_phone_type = 'trunk' then 'trunk' else line_type end,
                building_name = coalesce(v_building, building_name),
                floor = coalesce(v_floor, floor),
                notes = case
                  when v_phone_marker is not null
                    and coalesce(notes, '') !~ '\[\[phone_type:(digital|analog|ip|trunk)\]\]'
                    then nullif(concat_ws(E'\n', nullif(notes, ''), v_phone_marker), '')
                  else notes
                end,
                source = 'excel_import',
                updated_by = p_actor
            where id = v_extension.id
            returning * into v_extension;
          else
            insert into public.phone_extensions (
              customer_id, contract_service_type_id, line_type, extension_number,
              building_name, floor, notes, source_reference, source, updated_by
            ) values (
              p_customer_id,
              p_contract_service_type_id,
              case when v_phone_type = 'trunk' then 'trunk' else 'extension' end,
              v_number,
              v_building,
              v_floor,
              v_phone_marker,
              v_source_reference,
              'excel_import',
              p_actor
            ) returning * into v_extension;
          end if;

          insert into public.phone_terminal_points (
            customer_id, contract_service_type_id, phone_extension_id, endpoint_side,
            frame_name, frame_block, frame_position, terminal_code, slot_identifier,
            installation_location, notes, source_reference, source, updated_by
          ) values (
            p_customer_id, p_contract_service_type_id, v_extension.id, 'system',
            v_frame_name, v_board, v_slot, v_terminal, v_slot::text,
            v_installation_location, v_point_note, v_source_reference, 'excel_import', p_actor
          );
          v_inserted := v_inserted + 1;
        end if;
      else
        if v_existing_id is null or v_number is null then raise exception '現場端資料缺少唯一的既有系統端關聯。'; end if;
        if v_building is null or v_floor is null then raise exception '現場端資料缺少已確認的棟名或樓層。'; end if;

        select pe.* into v_extension
        from public.phone_extensions pe
        where pe.id = v_existing_id
          and pe.customer_id = p_customer_id
          and pe.contract_service_type_id = p_contract_service_type_id
          and pe.extension_number = v_number
        for update;
        if v_extension.id is null then raise exception '現場端資料找不到相符的既有系統端。'; end if;
        if not exists (
          select 1
          from public.phone_terminal_points pt
          where pt.phone_extension_id = v_extension.id
            and pt.endpoint_side = 'system'
        ) then
          raise exception '現場端資料不得建立為沒有系統端的孤立資料。';
        end if;

        select pt.* into v_existing_point
        from public.phone_terminal_points pt
        where pt.phone_extension_id = v_extension.id
          and pt.endpoint_side = 'field'
        for update;

        if v_existing_point.id is not null then
          if v_existing_point.frame_name is distinct from v_frame_name
             or v_existing_point.frame_block is distinct from v_board
             or v_existing_point.frame_position is distinct from v_slot then
            raise exception '同一號碼已有不同的現場端位置。';
          end if;
          update public.phone_terminal_points
          set terminal_code = coalesce(v_terminal, terminal_code),
              slot_identifier = v_slot::text,
              floor = coalesce(v_floor, floor),
              installation_location = coalesce(v_installation_location, installation_location),
              notes = coalesce(v_point_note, notes),
              source_reference = v_source_reference,
              source = 'excel_import',
              updated_by = p_actor
          where id = v_existing_point.id;
        else
          insert into public.phone_terminal_points (
            customer_id, contract_service_type_id, phone_extension_id, endpoint_side,
            frame_name, frame_block, frame_position, terminal_code, slot_identifier,
            floor, installation_location, notes, source_reference, source, updated_by
          ) values (
            p_customer_id, p_contract_service_type_id, v_extension.id, 'field',
            v_frame_name, v_board, v_slot, v_terminal, v_slot::text,
            v_floor, v_installation_location, v_point_note, v_source_reference, 'excel_import', p_actor
          );
        end if;

        if v_extension.building_name is not null and v_extension.building_name <> v_building then
          raise exception '既有電話的棟名與現場端檔案不一致。';
        end if;
        if v_extension.floor is not null and v_extension.floor <> v_floor then
          raise exception '既有電話的樓層與現場端檔案不一致。';
        end if;

        update public.phone_extensions
        set building_name = coalesce(building_name, v_building),
            floor = coalesce(floor, v_floor),
            installation_location = coalesce(installation_location, v_installation_location),
            notes = case
              when v_phone_marker is not null
                and coalesce(notes, '') !~ '\[\[phone_type:(digital|analog|ip|trunk)\]\]'
                then nullif(concat_ws(E'\n', nullif(notes, ''), v_phone_marker), '')
              else notes
            end,
            source = 'excel_import',
            updated_by = p_actor
        where id = v_extension.id;
        v_updated := v_updated + 1;
      end if;
    exception
      when others then
        v_failed := v_failed + 1;
        v_failures := v_failures || jsonb_build_array(jsonb_build_object(
          'source_sheet', v_row->>'source_sheet',
          'source_row', v_row->>'source_row',
          'source_column', v_row->>'source_column',
          'message', left(sqlerrm, 500)
        ));
    end;
  end loop;

  insert into public.phone_terminal_import_logs (
    customer_id, contract_service_type_id, file_name, import_type, actor,
    total_count, inserted_count, updated_count, skipped_count, failed_count,
    failure_reasons, source_rows
  ) values (
    p_customer_id, p_contract_service_type_id, btrim(p_file_name), p_import_type, p_actor,
    jsonb_array_length(p_rows), v_inserted, v_updated, v_skipped, v_failed,
    v_failures, p_rows
  ) returning id into v_log_id;

  return jsonb_build_object(
    'log_id', v_log_id,
    'total', jsonb_array_length(p_rows),
    'inserted', v_inserted,
    'updated', v_updated,
    'skipped', v_skipped,
    'failed', v_failed
  );
end;
$$;

revoke all on function public.import_phone_terminal_rows_v1(uuid,uuid,text,text,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.import_phone_terminal_rows_v1(uuid,uuid,text,text,jsonb,text)
  to service_role;

commit;
