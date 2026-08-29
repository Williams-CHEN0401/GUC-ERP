-- Add work-log workers and link work-log pickup entries to the existing
-- pickup_records transaction table. Existing rows remain valid and unchanged.

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists public.site_work_log_workers (
  work_log_id uuid not null references public.site_work_logs(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (work_log_id, user_id)
);

alter table public.site_work_log_workers enable row level security;

revoke all on table public.site_work_log_workers from public, anon, authenticated;
grant select, insert, update, delete on table public.site_work_log_workers to service_role;

create index if not exists site_work_log_workers_user_id_idx
  on public.site_work_log_workers(user_id);

alter table public.pickup_records
  add column if not exists work_log_id uuid,
  add column if not exists request_id uuid,
  add column if not exists request_row integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.pickup_records'::regclass
      and conname = 'pickup_records_work_log_id_fkey'
  ) then
    alter table public.pickup_records
      add constraint pickup_records_work_log_id_fkey
      foreign key (work_log_id)
      references public.site_work_logs(id)
      on delete set null
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.pickup_records'::regclass
      and conname = 'pickup_records_request_pair_check'
  ) then
    alter table public.pickup_records
      add constraint pickup_records_request_pair_check
      check (
        (request_id is null and request_row is null)
        or
        (request_id is not null and request_row is not null and request_row between 1 and 50)
      )
      not valid;
  end if;
end;
$$;

alter table public.pickup_records
  validate constraint pickup_records_work_log_id_fkey;
alter table public.pickup_records
  validate constraint pickup_records_request_pair_check;

create index if not exists pickup_records_work_log_id_idx
  on public.pickup_records(work_log_id);

create unique index if not exists pickup_records_request_row_uidx
  on public.pickup_records(request_id, request_row)
  where request_id is not null;

create or replace function public.upsert_project_site_work_log_v1(
  p_project_id uuid,
  p_id uuid,
  p_row_version integer,
  p_log_date date,
  p_title text,
  p_summary text,
  p_work_type text,
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
  v_site public.sites;
  v_existing public.site_work_logs;
  v_log public.site_work_logs;
  v_worker_ids uuid[];
  v_worker_count integer;
begin
  if p_project_id is null or p_log_date is null or p_reporter_user_id is null then
    raise exception '工作日誌的專案、日期或登錄人員不完整。';
  end if;
  if nullif(btrim(p_title), '') is null or char_length(btrim(p_title)) > 160 then
    raise exception '工作日誌標題必須為 1 至 160 個字。';
  end if;
  if char_length(coalesce(p_summary, '')) > 2000 then
    raise exception '工作日誌內容不可超過 2000 個字。';
  end if;
  if p_work_type is null or p_work_type not in ('工程施工', '維修紀錄', '維護保養') then
    raise exception '工作類型不正確。';
  end if;

  perform 1
  from public.app_users
  where id = p_reporter_user_id
    and is_active = true;
  if not found then
    raise exception '工作日誌登錄帳號無效或已停用。';
  end if;

  select coalesce(array_agg(distinct worker_id order by worker_id), '{}'::uuid[])
  into v_worker_ids
  from unnest(coalesce(p_worker_user_ids, '{}'::uuid[])) as workers(worker_id)
  where worker_id is not null;

  if cardinality(v_worker_ids) > 30 then
    raise exception '每篇工作日誌最多可選擇 30 位施工人員。';
  end if;

  if cardinality(v_worker_ids) > 0 then
    select count(*)
    into v_worker_count
    from public.app_users users
    where users.id = any(v_worker_ids)
      and (
        users.is_active = true
        or (
          p_id is not null
          and exists (
            select 1
            from public.site_work_log_workers existing_workers
            where existing_workers.work_log_id = p_id
              and existing_workers.user_id = users.id
          )
        )
      );

    if v_worker_count <> cardinality(v_worker_ids) then
      raise exception '部分施工人員不存在或已停用，請重新選擇。';
    end if;
  end if;

  select * into v_site
  from public.ensure_project_site_v1(p_project_id, p_actor);

  if p_id is null then
    insert into public.site_work_logs (
      site_id, log_date, reporter_user_id, title, summary, work_type,
      source, updated_by
    )
    values (
      v_site.id, p_log_date, p_reporter_user_id, btrim(p_title),
      nullif(btrim(coalesce(p_summary, '')), ''), p_work_type,
      'web', nullif(btrim(coalesce(p_actor, '')), '')
    )
    returning * into v_log;
  else
    if p_row_version is null or p_row_version < 1 then
      raise exception '工作日誌版本不正確，請重新整理後再修改。';
    end if;

    select * into v_existing
    from public.site_work_logs
    where id = p_id
      and site_id = v_site.id
    for update;

    if not found then
      raise exception '找不到所選專案的工作日誌。';
    end if;
    if v_existing.row_version <> p_row_version then
      raise exception '工作日誌已被其他使用者更新，請重新載入後再修改。';
    end if;

    update public.site_work_logs
    set log_date = p_log_date,
        reporter_user_id = p_reporter_user_id,
        title = btrim(p_title),
        summary = nullif(btrim(coalesce(p_summary, '')), ''),
        work_type = p_work_type,
        source = 'web',
        updated_by = nullif(btrim(coalesce(p_actor, '')), '')
    where id = p_id
      and row_version = p_row_version
    returning * into v_log;

    if not found then
      raise exception '工作日誌已被其他使用者更新，請重新載入後再修改。';
    end if;
  end if;

  delete from public.site_work_log_workers
  where work_log_id = v_log.id;

  insert into public.site_work_log_workers (work_log_id, user_id)
  select v_log.id, worker_id
  from unnest(v_worker_ids) as workers(worker_id);

  return jsonb_build_object(
    'work_log', to_jsonb(v_log),
    'worker_user_ids', to_jsonb(v_worker_ids)
  );
end;
$$;

revoke all on function public.upsert_project_site_work_log_v1(
  uuid, uuid, integer, date, text, text, text, uuid[], uuid, text
) from public, anon, authenticated;
grant execute on function public.upsert_project_site_work_log_v1(
  uuid, uuid, integer, date, text, text, text, uuid[], uuid, text
) to service_role;

create or replace function public.create_pickup_records_batch_v2(
  p_rows jsonb,
  p_created_by_user_id uuid,
  p_created_by_username text,
  p_work_log_id uuid,
  p_request_id uuid,
  p_actor text default 'system'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_normalized jsonb := '[]'::jsonb;
  v_row_number integer := 0;
  v_pickup_date date;
  v_project_id uuid;
  v_inventory_item_id uuid;
  v_quantity numeric;
  v_item_ids uuid[] := '{}'::uuid[];
  v_project_ids uuid[] := '{}'::uuid[];
  v_locked integer;
  v_existing_count integer;
  v_work_log_project_id uuid;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '取貨批次資料格式不正確。';
  end if;
  if jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 50 then
    raise exception '每次必須登錄 1 至 50 筆取貨資料。';
  end if;
  if p_created_by_user_id is null or p_created_by_username is null then
    raise exception '取貨必須由已登入帳號建立。';
  end if;
  if p_work_log_id is not null and p_request_id is null then
    raise exception '工作日誌取貨缺少防重複識別碼。';
  end if;

  perform 1
  from public.app_users
  where id = p_created_by_user_id
    and username = p_created_by_username
    and is_active = true;
  if not found then
    raise exception '取貨登錄帳號無效或已停用。';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_row_number := v_row_number + 1;
    if jsonb_typeof(v_row) <> 'object' then
      raise exception '第 % 筆取貨資料格式不正確。', v_row_number;
    end if;
    begin
      v_pickup_date := nullif(btrim(v_row ->> 'pickup_date'), '')::date;
      v_project_id := nullif(btrim(v_row ->> 'project_id'), '')::uuid;
      v_inventory_item_id := nullif(btrim(v_row ->> 'inventory_item_id'), '')::uuid;
      v_quantity := nullif(btrim(v_row ->> 'quantity'), '')::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
        raise exception '第 % 筆取貨資料的日期、專案、品項或數量格式不正確。', v_row_number;
    end;
    if v_pickup_date is null or v_project_id is null or v_inventory_item_id is null then
      raise exception '第 % 筆取貨資料不完整。', v_row_number;
    end if;
    if v_quantity is null or v_quantity <= 0 then
      raise exception '第 % 筆取貨數量必須大於 0。', v_row_number;
    end if;

    v_item_ids := array_append(v_item_ids, v_inventory_item_id);
    v_project_ids := array_append(v_project_ids, v_project_id);
    v_normalized := v_normalized || jsonb_build_array(jsonb_build_object(
      'request_row', v_row_number,
      'pickup_date', v_pickup_date,
      'project_id', v_project_id,
      'inventory_item_id', v_inventory_item_id,
      'quantity', round(v_quantity, 2)
    ));
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(v_normalized) as rows(value)
    group by value ->> 'pickup_date', value ->> 'project_id', value ->> 'inventory_item_id'
    having count(*) > 1
  ) then
    raise exception '同一批取貨有重複列，請合併數量。';
  end if;

  if p_work_log_id is not null then
    select sites.project_id
    into v_work_log_project_id
    from public.site_work_logs logs
    join public.sites sites on sites.id = logs.site_id
    where logs.id = p_work_log_id;

    if not found or v_work_log_project_id is null then
      raise exception '找不到工作日誌所屬專案。';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(v_normalized) as rows(value)
      where (value ->> 'project_id')::uuid <> v_work_log_project_id
    ) then
      raise exception '取貨專案與工作日誌不相符，請重新選擇。';
    end if;
  end if;

  if p_request_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_request_id::text, 0)
    );

    select count(*)
    into v_existing_count
    from public.pickup_records
    where request_id = p_request_id;

    if v_existing_count > 0 then
      if v_existing_count <> jsonb_array_length(v_normalized)
         or exists (
           select 1
           from jsonb_array_elements(v_normalized) with ordinality as expected(value, row_number)
           full join (
             select *
             from public.pickup_records
             where request_id = p_request_id
           ) existing
             on existing.request_row = expected.row_number
           where expected.value is null
              or existing.id is null
              or existing.pickup_date is distinct from (expected.value ->> 'pickup_date')::date
              or existing.project_id is distinct from (expected.value ->> 'project_id')::uuid
              or existing.inventory_item_id is distinct from (expected.value ->> 'inventory_item_id')::uuid
              or existing.quantity is distinct from (expected.value ->> 'quantity')::numeric
              or existing.work_log_id is distinct from p_work_log_id
              or existing.created_by_user_id is distinct from p_created_by_user_id
              or existing.created_by_username is distinct from p_created_by_username
         ) then
        raise exception '此取貨請求識別碼已被其他資料使用，請重新整理後再試。';
      end if;
      return v_existing_count;
    end if;
  end if;

  select array_agg(distinct ids.value order by ids.value)
  into v_item_ids
  from unnest(v_item_ids) as ids(value);
  select array_agg(distinct ids.value order by ids.value)
  into v_project_ids
  from unnest(v_project_ids) as ids(value);

  perform 1
  from public.inventory_items
  where id = any(v_item_ids)
  order by id
  for update;
  get diagnostics v_locked = row_count;
  if v_locked <> cardinality(v_item_ids) then
    raise exception '部分取貨品項不存在，請重新載入。';
  end if;

  select count(*)
  into v_locked
  from public.projects
  where id = any(v_project_ids);
  if v_locked <> cardinality(v_project_ids) then
    raise exception '部分取貨專案不存在，請重新載入。';
  end if;

  for v_row in select value from jsonb_array_elements(v_normalized)
  loop
    insert into public.pickup_records (
      pickup_date, project_id, inventory_item_id, quantity,
      source, updated_by, created_by_user_id, created_by_username,
      work_log_id, request_id, request_row
    ) values (
      (v_row ->> 'pickup_date')::date,
      (v_row ->> 'project_id')::uuid,
      (v_row ->> 'inventory_item_id')::uuid,
      (v_row ->> 'quantity')::numeric,
      'web', nullif(p_actor, ''), p_created_by_user_id, p_created_by_username,
      p_work_log_id, p_request_id,
      case when p_request_id is null then null else (v_row ->> 'request_row')::integer end
    );
  end loop;

  return jsonb_array_length(v_normalized);
end;
$$;

revoke all on function public.create_pickup_records_batch_v2(
  jsonb, uuid, text, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.create_pickup_records_batch_v2(
  jsonb, uuid, text, uuid, uuid, text
) to service_role;

create or replace function public.create_pickup_records_batch(
  p_rows jsonb,
  p_created_by_user_id uuid,
  p_created_by_username text,
  p_actor text default 'system'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.create_pickup_records_batch_v2(
    p_rows,
    p_created_by_user_id,
    p_created_by_username,
    null,
    null,
    p_actor
  );
end;
$$;

revoke all on function public.create_pickup_records_batch(jsonb, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.create_pickup_records_batch(jsonb, uuid, text, text)
  to service_role;

create or replace function public.update_pickup_record(
  p_id uuid,
  p_row_version integer,
  p_pickup_date date,
  p_project_id uuid,
  p_inventory_item_id uuid,
  p_quantity numeric,
  p_actor text default 'system'
)
returns public.pickup_records
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.pickup_records;
  v_result public.pickup_records;
  v_work_log_project_id uuid;
begin
  if p_id is null or p_pickup_date is null or p_project_id is null or p_inventory_item_id is null then
    raise exception '取貨資料不完整。';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception '取貨數量必須大於 0。';
  end if;
  if p_row_version is null or p_row_version < 1 then
    raise exception '取貨版本資料不正確。';
  end if;

  select * into v_existing
  from public.pickup_records
  where id = p_id
  for update;
  if not found then
    raise exception '找不到取貨紀錄。';
  end if;
  if v_existing.row_version <> p_row_version then
    raise exception '此取貨紀錄已被其他使用者更新，請重新載入。';
  end if;

  perform 1
  from public.inventory_items
  where id in (v_existing.inventory_item_id, p_inventory_item_id)
  order by id
  for update;
  if not exists (select 1 from public.inventory_items where id = p_inventory_item_id) then
    raise exception '找不到指定品項。';
  end if;
  if not exists (select 1 from public.projects where id = p_project_id) then
    raise exception '找不到指定專案。';
  end if;

  if v_existing.work_log_id is not null then
    select sites.project_id
    into v_work_log_project_id
    from public.site_work_logs logs
    join public.sites sites on sites.id = logs.site_id
    where logs.id = v_existing.work_log_id;

    if v_work_log_project_id is distinct from p_project_id then
      raise exception '此取貨已關聯工作日誌，不可改至其他專案。';
    end if;
  end if;

  update public.pickup_records
  set pickup_date = p_pickup_date,
      project_id = p_project_id,
      inventory_item_id = p_inventory_item_id,
      quantity = round(p_quantity, 2),
      source = 'web',
      updated_by = nullif(p_actor, '')
  where id = p_id
    and row_version = p_row_version
  returning * into v_result;

  if not found then
    raise exception '此取貨紀錄已被其他使用者更新，請重新載入。';
  end if;
  return v_result;
end;
$$;

revoke all on function public.update_pickup_record(
  uuid, integer, date, uuid, uuid, numeric, text
) from public, anon, authenticated;
grant execute on function public.update_pickup_record(
  uuid, integer, date, uuid, uuid, numeric, text
) to service_role;
