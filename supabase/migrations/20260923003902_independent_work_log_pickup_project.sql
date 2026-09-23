begin;
set local lock_timeout = '5s';
-- No backfill, master-data moves, new entrypoints, grants, or schema changes.
-- Existing SECURITY DEFINER / empty search_path / service-only ACLs are retained.
-- Linking and reassignment serialize on the log before pickup and inventory rows.

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
  v_locked_log_id uuid;
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

  -- Acquire the target FK lock before the log lock: work-log reassignment
  -- holds project locks before logs. Do not invert that order at UPDATE time.
  perform 1 from public.projects where id=p_project_id for key share;
  if not found then raise exception '找不到指定專案。'; end if;
  -- Reassignment locks logs before pickups. Keep that order here as well.
  select work_log_id into v_locked_log_id from public.pickup_records where id=p_id;
  if v_locked_log_id is not null then
    perform 1 from public.site_work_logs where id=v_locked_log_id for share;
  end if;
  select * into v_existing
  from public.pickup_records
  where id = p_id
  for update;
  if not found then
    raise exception '找不到取貨紀錄。';
  end if;
  if v_existing.row_version <> p_row_version
     or v_existing.work_log_id is distinct from v_locked_log_id then
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

    -- Detach a mismatching link below; never move the source log.
  end if;

  update public.pickup_records
  set pickup_date = p_pickup_date,
      project_id = p_project_id,
      work_log_id = case when v_work_log_project_id is not distinct from p_project_id
        then v_existing.work_log_id else null end,
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

  -- Same request -> log -> inventory lock order as the work-log writer.
  if p_request_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,0));
  end if;
  if p_work_log_id is not null then
    -- A linked batch must belong to exactly one work content. Lock its target
    -- before the log, rather than acquiring the FK lock later while inserting.
    if (select count(distinct id) from unnest(v_project_ids) id) <> 1 then
      raise exception '取貨專案與工作日誌不相符，請重新選擇。';
    end if;
    perform 1 from public.projects where id=any(v_project_ids) for key share;
    select sites.project_id
    into v_work_log_project_id
    from public.site_work_logs logs
    join public.sites sites on sites.id = logs.site_id
    where logs.id = p_work_log_id
    for share of logs;

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

CREATE OR REPLACE FUNCTION public.upsert_customer_project_work_log_v3(p_id uuid, p_row_version integer, p_project_id uuid, p_customer_id uuid, p_project_name text, p_log_date date, p_work_type text, p_summary text, p_time_period text, p_status text, p_worker_user_ids uuid[], p_reporter_user_id uuid, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_project public.projects;
  v_existing public.site_work_logs;
  v_save_version integer := p_row_version;
  v_target public.projects;
  v_site public.sites;
begin
  perform public.assert_work_log_access_v1(p_reporter_user_id,p_project_id,p_id,case when p_id is null then 'CREATE' else 'UPDATE' end);
  if p_customer_id is null or nullif(btrim(p_project_name), '') is null then
    raise exception '請選擇客戶並輸入專案／日誌標題。';
  end if;
  if char_length(btrim(p_project_name)) > 120 then
    raise exception '專案／日誌標題不可超過 120 個字。';
  end if;
  if p_status not in ('in_progress', 'completed') then
    raise exception '工作日誌狀態不正確。';
  end if;

  if p_id is not null then
    perform 1 from public.customers where id = p_customer_id for update;
    select * into v_existing from public.site_work_logs where id = p_id;
    if not found then raise exception '找不到工作日誌。'; end if;
    select * into v_project from public.projects where id = v_existing.project_id for update;
    if not found or v_project.customer_id <> p_customer_id then
      raise exception '工作日誌的客戶與原專案不相符。';
    end if;
    if p_project_id is not null and p_project_id is distinct from v_project.id then
      -- A selection moves only this log; a typed name still renames its shared project.
      if not public.has_app_permission_v1(p_reporter_user_id,'projects','UPDATE')
         or exists(select 1 from public.app_users u join public.app_roles r on r.code=u.role
                   where u.id=p_reporter_user_id and r.project_scoped) then
        raise exception '沒有變更工作日誌歸屬的權限。' using errcode='42501';
      end if;
      perform public.assert_work_log_access_v1(p_reporter_user_id,p_project_id,null,'CREATE');
      select * into v_target from public.projects where id=p_project_id for update;
      if not found or v_target.customer_id is distinct from v_project.customer_id
         or v_target.department_id is distinct from v_project.department_id then
        raise exception '僅能選擇同一客戶、同一科室的工作內容。';
      end if;
      if v_target.status is distinct from 'in_progress' then
        raise exception '僅能改歸到進行中的工作內容。';
      end if;
      if v_target.name is distinct from btrim(p_project_name) then
        raise exception '所選工作內容名稱已變更，請重新選擇。';
      end if;
      if p_status is distinct from v_target.status then
        raise exception '變更歸屬時狀態必須沿用所選工作內容，請重新載入。';
      end if;
      select * into v_existing from public.site_work_logs where id=p_id for update;
      if p_row_version is null or v_existing.row_version <> p_row_version then
        raise exception '工作日誌已被其他使用者更新，請重新載入後再修改。';
      end if;
      -- Financial/material history and historical file ownership are not implicitly moved.
      if exists(select 1 from public.site_assets where work_log_id=p_id) then
        raise exception '此日誌已有歷史附件關聯，不能直接變更工作內容歸屬；附件與原資料保持不變。';
      end if;
      -- Keep material ownership and quantities unchanged. Existing audit/version
      -- triggers record the link change. Later validation failures roll it back.
      perform 1 from public.pickup_records where work_log_id=p_id
        and project_id is distinct from v_target.id order by id for update;
      update public.pickup_records set work_log_id=null,source='web',updated_by=p_actor
        where work_log_id=p_id and project_id is distinct from v_target.id;
      select * into v_site from public.ensure_project_site_v1(v_target.id,p_actor);
      update public.site_work_logs
        set site_id=v_site.id,project_id=v_target.id,title=v_target.name,
            work_type=p_work_type,status=v_target.status,source='web',updated_by=p_actor
        where id=p_id returning row_version into v_save_version;
      v_project := v_target;
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
        case p_work_type when '工程施工' then 'construction' when '維修紀錄' then 'repair' when '送貨' then 'delivery' when '文書作業' then 'clerical' when '場勘' then 'site_survey' else 'maintenance' end,
        p_status, null, '由工作日誌自動建立', null, null, p_actor
      );
    end if;
  end if;

  if p_id is not null and v_project.name is distinct from btrim(p_project_name) then
    -- Project first, then logs: same order as the existing writer.
    select * into v_existing from public.site_work_logs where id = p_id for update;
    if p_row_version is null or v_existing.row_version <> p_row_version then
      raise exception '工作日誌已被其他使用者更新，請重新載入後再修改。';
    end if;
    if not public.has_app_permission_v1(p_reporter_user_id,'projects','UPDATE')
       or exists(select 1 from public.app_users u join public.app_roles r on r.code=u.role
                 where u.id=p_reporter_user_id and r.project_scoped) then
      raise exception '沒有修改共用工作內容名稱的權限。' using errcode='42501';
    end if;
    if exists(select 1 from public.projects p where p.customer_id=p_customer_id and p.id<>v_project.id
              and lower(regexp_replace(normalize(btrim(p.name),NFKC),'\s+',' ','g')) =
                  lower(regexp_replace(normalize(btrim(p_project_name),NFKC),'\s+',' ','g'))) then
      raise exception '此客戶已有相同工作內容名稱，請使用不同名稱。';
    end if;
    -- Keep all other project fields and historical quotation snapshots unchanged.
    update public.projects set name=btrim(p_project_name),updated_by=p_actor,source='web'
      where id=v_project.id returning * into v_project;
    -- The shared-name trigger legitimately advanced related log versions.
    select row_version into v_save_version from public.site_work_logs where id=p_id;
  end if;

  return public.upsert_project_site_work_log_v2(
    v_project.id, p_id, v_save_version, p_log_date, v_project.name,
    p_summary, p_work_type, p_time_period, p_status, p_worker_user_ids,
    p_reporter_user_id, p_actor
  );
end;
$function$
;

commit;
