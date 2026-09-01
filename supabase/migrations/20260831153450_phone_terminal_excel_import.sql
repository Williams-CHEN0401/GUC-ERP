create table if not exists public.phone_terminal_import_batches (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  contract_service_type_id uuid not null,
  file_name text not null check (char_length(btrim(file_name)) between 1 and 240),
  file_hash text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  import_type text not null check (import_type in ('system', 'field')),
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  total_rows integer not null default 0 check (total_rows >= 0),
  success_rows integer not null default 0 check (success_rows >= 0),
  inserted_rows integer not null default 0 check (inserted_rows >= 0),
  updated_rows integer not null default 0 check (updated_rows >= 0),
  skipped_rows integer not null default 0 check (skipped_rows >= 0),
  failed_rows integer not null default 0 check (failed_rows >= 0),
  warning_rows integer not null default 0 check (warning_rows >= 0),
  uploaded_by text not null check (char_length(btrim(uploaded_by)) between 1 and 120),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (customer_id, contract_service_type_id)
    references public.customer_contract_services(customer_id, service_type_id)
    on delete cascade
);

create table if not exists public.phone_terminal_import_rows (
  id bigint generated always as identity primary key,
  batch_id uuid not null references public.phone_terminal_import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  sheet_name text not null check (char_length(btrim(sheet_name)) between 1 and 120),
  source_reference text not null check (char_length(btrim(source_reference)) between 1 and 500),
  raw_payload jsonb not null default '{}'::jsonb,
  normalized_payload jsonb not null default '{}'::jsonb,
  action text not null check (action in ('insert', 'update', 'skip')),
  status text not null check (status in ('success', 'error')),
  error_reason text check (error_reason is null or char_length(error_reason) <= 1000),
  warning_reasons text[] not null default '{}'::text[],
  phone_extension_id uuid references public.phone_extensions(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (batch_id, row_number, source_reference)
);

create index if not exists phone_terminal_import_batches_customer_idx
  on public.phone_terminal_import_batches(customer_id, contract_service_type_id, created_at desc);
create index if not exists phone_terminal_import_rows_batch_idx
  on public.phone_terminal_import_rows(batch_id, row_number);

create unique index if not exists phone_terminal_points_import_position_uidx
  on public.phone_terminal_points(
    customer_id,
    contract_service_type_id,
    endpoint_side,
    lower(frame_name),
    lower(frame_block),
    frame_position
  )
  where frame_name is not null and frame_block is not null and frame_position is not null;

alter table public.phone_terminal_import_batches enable row level security;
alter table public.phone_terminal_import_rows enable row level security;

revoke all on public.phone_terminal_import_batches from public, anon, authenticated;
revoke all on public.phone_terminal_import_rows from public, anon, authenticated;
grant select on public.phone_terminal_import_batches to service_role;
grant select on public.phone_terminal_import_rows to service_role;

create or replace function public.commit_phone_terminal_import_v1(
  p_customer_id uuid,
  p_contract_service_type_id uuid,
  p_file_name text,
  p_file_hash text,
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
  v_batch_id uuid;
  v_row jsonb;
  v_ordinality bigint;
  v_block text;
  v_slot integer;
  v_slot_identifier text;
  v_phone text;
  v_terminal_code text;
  v_building text;
  v_floor text;
  v_phone_type text;
  v_source_reference text;
  v_sheet_name text;
  v_source_row integer;
  v_extension public.phone_extensions%rowtype;
  v_number_extension_id uuid;
  v_slot_extension_id uuid;
  v_match_count integer;
  v_duplicate_count integer;
  v_action text;
  v_warnings text[];
  v_inserted integer := 0;
  v_updated integer := 0;
  v_failed integer := 0;
  v_warning_rows integer := 0;
begin
  if p_customer_id is null
     or p_contract_service_type_id is null
     or nullif(btrim(coalesce(p_file_name, '')), '') is null
     or char_length(p_file_name) > 240
     or coalesce(p_file_hash, '') !~ '^[0-9a-f]{64}$'
     or p_import_type not in ('system', 'field')
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) < 1
     or jsonb_array_length(p_rows) > 1000
     or nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception '端子版正式匯入資料不完整。';
  end if;

  if not exists (
    select 1
    from public.customer_contract_services links
    join public.contract_service_types types on types.id = links.service_type_id
    where links.customer_id = p_customer_id
      and links.service_type_id = p_contract_service_type_id
      and types.code = 'phone_system'
      and types.is_active = true
  ) then
    raise exception '此客戶未承攬啟用中的電話系統服務。';
  end if;

  perform set_config('app.actor', p_actor, true);
  insert into public.phone_terminal_import_batches (
    customer_id, contract_service_type_id, file_name, file_hash,
    import_type, status, total_rows, uploaded_by
  ) values (
    p_customer_id, p_contract_service_type_id, btrim(p_file_name), lower(p_file_hash),
    p_import_type, 'processing', jsonb_array_length(p_rows), btrim(p_actor)
  ) returning id into v_batch_id;

  for v_row, v_ordinality in
    select value, ordinality from jsonb_array_elements(p_rows) with ordinality
  loop
    begin
      v_block := nullif(btrim(v_row ->> 'terminal_block'), '');
      v_slot := nullif(v_row ->> 'slot', '')::integer;
      v_slot_identifier := nullif(btrim(v_row ->> 'slot_identifier'), '');
      v_phone := nullif(btrim(v_row ->> 'phone_number'), '');
      v_terminal_code := nullif(btrim(v_row ->> 'system_terminal_code'), '');
      v_building := nullif(btrim(v_row ->> 'building_name'), '');
      v_floor := nullif(btrim(v_row ->> 'floor'), '');
      v_phone_type := nullif(btrim(v_row ->> 'phone_type'), '');
      v_source_reference := nullif(btrim(v_row ->> 'source_reference'), '');
      v_sheet_name := nullif(btrim(v_row ->> 'sheet_name'), '');
      v_source_row := nullif(v_row ->> 'source_row', '')::integer;
      v_extension := null;
      v_number_extension_id := null;
      v_slot_extension_id := null;
      v_action := 'skip';

      select coalesce(array_agg(value), '{}'::text[])
      into v_warnings
      from jsonb_array_elements_text(coalesce(v_row -> 'mapping_warnings', '[]'::jsonb));

      if v_block is null or char_length(v_block) > 80
         or v_slot is null or v_slot < 1 or v_slot > 10000
         or v_slot_identifier is null or char_length(v_slot_identifier) > 120
         or v_source_reference is null or char_length(v_source_reference) > 500
         or v_sheet_name is null or char_length(v_sheet_name) > 120
         or v_source_row is null or v_source_row < 1
         or (v_phone is not null and char_length(v_phone) > 40)
         or (v_terminal_code is not null and char_length(v_terminal_code) > 80)
         or (v_building is not null and char_length(v_building) > 80)
         or (v_floor is not null and char_length(v_floor) > 80)
         or (v_phone_type is not null and v_phone_type not in ('digital', 'analog', 'ip', 'trunk')) then
        raise exception '正規化欄位格式不正確。';
      end if;

      select count(*) into v_duplicate_count
      from jsonb_array_elements(p_rows) item
      where lower(btrim(item ->> 'terminal_block')) = lower(v_block)
        and (item ->> 'slot')::integer = v_slot;
      if v_duplicate_count > 1 then
        raise exception '同一匯入檔有重複的端子板＋槽位。';
      end if;

      if v_phone is not null then
        select count(*) into v_duplicate_count
        from jsonb_array_elements(p_rows) item
        where lower(btrim(item ->> 'phone_number')) = lower(v_phone);
        if v_duplicate_count > 1 then
          raise exception '同一匯入檔有重複的電話／分機，無法唯一對應。';
        end if;
      end if;

      if p_import_type = 'system' then
        select count(*)
        into v_match_count
        from public.phone_terminal_points points
        where points.customer_id = p_customer_id
          and points.contract_service_type_id = p_contract_service_type_id
          and points.endpoint_side = 'system'
          and lower(coalesce(points.frame_block, '')) = lower(v_block)
          and (points.frame_position = v_slot or (points.frame_position is null and points.slot_identifier = v_slot_identifier));
        if v_match_count > 1 then raise exception '資料庫已有多筆相同系統端端子位置。'; end if;
        if v_match_count = 1 then
          select points.phone_extension_id into v_slot_extension_id
          from public.phone_terminal_points points
          where points.customer_id = p_customer_id
            and points.contract_service_type_id = p_contract_service_type_id
            and points.endpoint_side = 'system'
            and lower(coalesce(points.frame_block, '')) = lower(v_block)
            and (points.frame_position = v_slot or (points.frame_position is null and points.slot_identifier = v_slot_identifier))
          limit 1;
        end if;

        if v_phone is not null then
          select id into v_number_extension_id
          from public.phone_extensions
          where customer_id = p_customer_id
            and contract_service_type_id = p_contract_service_type_id
            and extension_number = v_phone;
        end if;
        if v_slot_extension_id is not null and v_number_extension_id is not null and v_slot_extension_id <> v_number_extension_id then
          raise exception '槽位與電話／分機分別指向不同既有資料。';
        end if;

        if v_slot_extension_id is not null then
          select * into v_extension from public.phone_extensions where id = v_slot_extension_id;
        elsif v_number_extension_id is not null then
          select * into v_extension from public.phone_extensions where id = v_number_extension_id;
          if exists (
            select 1 from public.phone_terminal_points points
            where points.phone_extension_id = v_extension.id
              and points.endpoint_side = 'system'
              and (lower(coalesce(points.frame_block, '')) <> lower(v_block) or coalesce(points.frame_position, -1) <> v_slot)
          ) then
            raise exception '相同電話／分機已對應其他系統端槽位。';
          end if;
        end if;

        if v_extension.id is null then
          insert into public.phone_extensions (
            customer_id, contract_service_type_id, line_type, extension_number,
            building_name, floor, notes, source_reference, source, updated_by
          ) values (
            p_customer_id, p_contract_service_type_id,
            case when v_phone_type = 'trunk' then 'trunk' else 'extension' end,
            v_phone, v_building, v_floor,
            case when v_phone_type is not null then '[[GUC_PHONE_TYPE:' || v_phone_type || ']]' else '[[GUC_IMPORT_PHONE_TYPE:unconfirmed]]' end,
            v_source_reference, 'excel_import', p_actor
          ) returning * into v_extension;
          v_action := 'insert';
          v_inserted := v_inserted + 1;
        else
          if v_phone is not null and v_extension.extension_number is not null and v_extension.extension_number <> v_phone then
            raise exception '既有槽位的電話／分機與 Excel 不一致。';
          end if;
          update public.phone_extensions
          set extension_number = coalesce(v_phone, extension_number),
              building_name = coalesce(v_building, building_name),
              floor = coalesce(v_floor, floor),
              line_type = case when v_phone_type = 'trunk' then 'trunk' else line_type end,
              notes = case when v_phone_type is not null and notes is null then '[[GUC_PHONE_TYPE:' || v_phone_type || ']]' else notes end,
              source_reference = v_source_reference,
              source = 'excel_import',
              updated_by = p_actor
          where id = v_extension.id
          returning * into v_extension;
          v_action := 'update';
          v_updated := v_updated + 1;
        end if;

        insert into public.phone_terminal_points (
          customer_id, contract_service_type_id, phone_extension_id, endpoint_side,
          frame_name, frame_block, frame_position, terminal_code, slot_identifier,
          source_reference, source, updated_by
        ) values (
          p_customer_id, p_contract_service_type_id, v_extension.id, 'system',
          '系統端', v_block, v_slot, v_terminal_code, v_slot_identifier,
          v_source_reference, 'excel_import', p_actor
        )
        on conflict (phone_extension_id, endpoint_side) do update
        set frame_name = coalesce(public.phone_terminal_points.frame_name, excluded.frame_name),
            frame_block = excluded.frame_block,
            frame_position = excluded.frame_position,
            terminal_code = coalesce(excluded.terminal_code, public.phone_terminal_points.terminal_code),
            slot_identifier = excluded.slot_identifier,
            source_reference = excluded.source_reference,
            source = excluded.source,
            updated_by = excluded.updated_by;
      else
        if v_phone is null then raise exception '缺少電話／分機，無法對應既有系統端。'; end if;
        select * into v_extension
        from public.phone_extensions
        where customer_id = p_customer_id
          and contract_service_type_id = p_contract_service_type_id
          and extension_number = v_phone;
        if v_extension.id is null then
          raise exception '找不到相同電話／分機的既有系統端資料，為避免孤立資料不會新增。';
        end if;
        if not exists (
          select 1 from public.phone_terminal_points points
          where points.phone_extension_id = v_extension.id and points.endpoint_side = 'system'
        ) then
          raise exception '找到電話／分機，但該筆沒有系統端端點。';
        end if;

        update public.phone_extensions
        set building_name = coalesce(v_building, building_name),
            floor = coalesce(v_floor, floor),
            line_type = case when v_phone_type = 'trunk' then 'trunk' else line_type end,
            notes = case when v_phone_type is not null and notes is null then '[[GUC_PHONE_TYPE:' || v_phone_type || ']]' else notes end,
            source_reference = v_source_reference,
            source = 'excel_import',
            updated_by = p_actor
        where id = v_extension.id
        returning * into v_extension;

        insert into public.phone_terminal_points (
          customer_id, contract_service_type_id, phone_extension_id, endpoint_side,
          frame_name, frame_block, frame_position, slot_identifier, floor,
          source_reference, source, updated_by
        ) values (
          p_customer_id, p_contract_service_type_id, v_extension.id, 'field',
          coalesce(nullif(concat_ws(' ', v_building, v_floor), ''), '現場端'),
          v_block, v_slot, v_slot_identifier, v_floor,
          v_source_reference, 'excel_import', p_actor
        )
        on conflict (phone_extension_id, endpoint_side) do update
        set frame_name = coalesce(nullif(excluded.frame_name, '現場端'), public.phone_terminal_points.frame_name, '現場端'),
            frame_block = excluded.frame_block,
            frame_position = excluded.frame_position,
            slot_identifier = excluded.slot_identifier,
            floor = coalesce(excluded.floor, public.phone_terminal_points.floor),
            source_reference = excluded.source_reference,
            source = excluded.source,
            updated_by = excluded.updated_by;
        v_action := 'update';
        v_updated := v_updated + 1;
      end if;

      if cardinality(v_warnings) > 0 then v_warning_rows := v_warning_rows + 1; end if;
      insert into public.phone_terminal_import_rows (
        batch_id, row_number, sheet_name, source_reference, raw_payload,
        normalized_payload, action, status, warning_reasons, phone_extension_id
      ) values (
        v_batch_id, v_source_row, v_sheet_name, v_source_reference,
        coalesce(v_row -> 'raw_values', '{}'::jsonb), v_row,
        v_action, 'success', v_warnings, v_extension.id
      );
    exception when others then
      v_failed := v_failed + 1;
      insert into public.phone_terminal_import_rows (
        batch_id, row_number, sheet_name, source_reference, raw_payload,
        normalized_payload, action, status, error_reason, warning_reasons
      ) values (
        v_batch_id,
        coalesce(nullif(v_row ->> 'source_row', '')::integer, v_ordinality::integer),
        left(coalesce(nullif(btrim(v_row ->> 'sheet_name'), ''), '未確認工作表'), 120),
        left(coalesce(nullif(btrim(v_row ->> 'source_reference'), ''), 'row-' || v_ordinality), 500),
        coalesce(v_row -> 'raw_values', '{}'::jsonb), v_row,
        'skip', 'error', left(sqlerrm, 1000), coalesce(v_warnings, '{}'::text[])
      );
    end;
  end loop;

  update public.phone_terminal_import_batches
  set status = 'completed',
      success_rows = v_inserted + v_updated,
      inserted_rows = v_inserted,
      updated_rows = v_updated,
      skipped_rows = v_failed,
      failed_rows = v_failed,
      warning_rows = v_warning_rows,
      completed_at = now()
  where id = v_batch_id;

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'total_rows', jsonb_array_length(p_rows),
    'success_rows', v_inserted + v_updated,
    'inserted_rows', v_inserted,
    'updated_rows', v_updated,
    'skipped_rows', v_failed,
    'failed_rows', v_failed,
    'warning_rows', v_warning_rows
  );
end;
$$;

revoke all on function public.commit_phone_terminal_import_v1(uuid, uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.commit_phone_terminal_import_v1(uuid, uuid, text, text, text, jsonb, text) to service_role;
