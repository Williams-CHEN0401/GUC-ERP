begin;

alter table public.site_work_logs
  add column if not exists time_period text;

alter table public.site_work_logs
  drop constraint if exists site_work_logs_time_period_check;
alter table public.site_work_logs
  add constraint site_work_logs_time_period_check
  check (time_period is null or char_length(btrim(time_period)) between 1 and 80);

alter table public.site_work_logs
  drop constraint if exists site_work_logs_status_check;
alter table public.site_work_logs
  add constraint site_work_logs_status_check
  check (status in ('in_progress', 'completed'));
alter table public.site_work_logs
  alter column status set default 'in_progress';

-- The status is project-level. Existing work logs adopt their project's current
-- status so the two ERP screens start from a consistent state.
update public.site_work_logs logs
set status = projects.status,
    updated_by = coalesce(logs.updated_by, 'status_sync_migration')
from public.projects projects
where projects.id = logs.project_id
  and projects.status in ('in_progress', 'completed')
  and logs.status is distinct from projects.status;

create or replace function public.upsert_project_site_work_log_v2(
  p_project_id uuid,
  p_id uuid,
  p_row_version integer,
  p_log_date date,
  p_title text,
  p_summary text,
  p_work_type text,
  p_time_period text,
  p_status text,
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
  if char_length(coalesce(p_time_period, '')) > 80 then
    raise exception '工作日誌時段不可超過 80 個字。';
  end if;
  if p_work_type is null or p_work_type not in ('工程施工', '維修紀錄', '維護保養') then
    raise exception '工作類型不正確。';
  end if;
  if p_status not in ('in_progress', 'completed') then
    raise exception '工作日誌狀態不正確。';
  end if;

  perform 1
  from public.projects
  where id = p_project_id
  for update;
  if not found then
    raise exception '找不到工作日誌所屬專案。';
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
      time_period, status, source, updated_by
    )
    values (
      v_site.id, p_log_date, p_reporter_user_id, btrim(p_title),
      nullif(btrim(coalesce(p_summary, '')), ''), p_work_type,
      nullif(btrim(coalesce(p_time_period, '')), ''), p_status,
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
        time_period = nullif(btrim(coalesce(p_time_period, '')), ''),
        status = p_status,
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

  update public.projects
  set status = p_status,
      source = 'web',
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where id = p_project_id
    and status is distinct from p_status;

  update public.site_work_logs
  set status = p_status,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where project_id = p_project_id
    and id <> v_log.id
    and status is distinct from p_status;

  return jsonb_build_object(
    'work_log', to_jsonb(v_log),
    'worker_user_ids', to_jsonb(v_worker_ids),
    'project_status', p_status
  );
end;
$$;

revoke all on function public.upsert_project_site_work_log_v2(
  uuid, uuid, integer, date, text, text, text, text, text, uuid[], uuid, text
) from public, anon, authenticated;
grant execute on function public.upsert_project_site_work_log_v2(
  uuid, uuid, integer, date, text, text, text, text, text, uuid[], uuid, text
) to service_role;

create or replace function public.upsert_customer_project_work_log_v3(
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
  if p_status not in ('in_progress', 'completed') then
    raise exception '工作日誌狀態不正確。';
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
        p_status, null, '由工作日誌自動建立', null, null, p_actor
      );
    end if;
  end if;

  return public.upsert_project_site_work_log_v2(
    v_project.id, p_id, p_row_version, p_log_date, v_project.name,
    p_summary, p_work_type, p_time_period, p_status, p_worker_user_ids,
    p_reporter_user_id, p_actor
  );
end;
$$;

revoke all on function public.upsert_customer_project_work_log_v3(
  uuid, integer, uuid, uuid, text, date, text, text, text, text, uuid[], uuid, text
) from public, anon, authenticated;
grant execute on function public.upsert_customer_project_work_log_v3(
  uuid, integer, uuid, uuid, text, date, text, text, text, text, uuid[], uuid, text
) to service_role;

create or replace function public.upsert_erp_project_with_workers_v2(
  p_id uuid,
  p_row_version integer,
  p_name text,
  p_customer_id uuid,
  p_project_type text,
  p_status text,
  p_description text,
  p_estimated_cost numeric,
  p_note text,
  p_worker_user_ids uuid[],
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.projects;
  v_project public.projects;
  v_worker_ids uuid[];
  v_worker_count integer;
  v_assigned_to text;
begin
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 120 then
    raise exception '專案名稱必須為 1 至 120 個字。';
  end if;
  if p_customer_id is null or not exists(select 1 from public.customers where id = p_customer_id) then
    raise exception '找不到指定客戶。';
  end if;
  if p_project_type not in ('construction', 'maintenance') then
    raise exception '專案類型不正確。';
  end if;
  if p_status not in ('in_progress', 'completed') then
    raise exception '專案狀態不正確。';
  end if;
  if char_length(coalesce(p_description, '')) > 2000 or char_length(coalesce(p_note, '')) > 1000 then
    raise exception '專案說明或備註超過長度限制。';
  end if;
  if p_estimated_cost is not null and p_estimated_cost < 0 then
    raise exception '預估成本不可小於 0。';
  end if;

  select coalesce(array_agg(distinct worker_id order by worker_id), '{}'::uuid[])
  into v_worker_ids
  from unnest(coalesce(p_worker_user_ids, '{}'::uuid[])) as workers(worker_id)
  where worker_id is not null;

  if cardinality(v_worker_ids) > 30 then
    raise exception '每個專案最多可選擇 30 位負責人。';
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
            select 1 from public.project_workers existing_workers
            where existing_workers.project_id = p_id
              and existing_workers.user_id = users.id
          )
        )
      );
    if v_worker_count <> cardinality(v_worker_ids) then
      raise exception '部分專案負責人不存在或已停用，請重新選擇。';
    end if;
  end if;

  select string_agg(users.display_name, '、' order by users.display_name)
  into v_assigned_to
  from public.app_users users
  where users.id = any(v_worker_ids);

  if p_id is null then
    select * into v_project
    from public.create_project_auto_number_v1(
      btrim(p_name), p_customer_id, p_project_type, p_status,
      v_assigned_to, nullif(btrim(coalesce(p_description, '')), ''),
      p_estimated_cost, nullif(btrim(coalesce(p_note, '')), ''), p_actor
    );
  else
    if p_row_version is null or p_row_version < 1 then
      raise exception '專案版本不正確，請重新整理後再修改。';
    end if;
    select * into v_existing from public.projects where id = p_id for update;
    if not found then raise exception '找不到專案。'; end if;
    if v_existing.row_version <> p_row_version then
      raise exception '專案資料已被其他使用者更新，請重新載入後再修改。';
    end if;
    update public.projects
    set name = btrim(p_name),
        customer_id = p_customer_id,
        project_type = p_project_type,
        status = p_status,
        assigned_to = nullif(v_assigned_to, ''),
        description = nullif(btrim(coalesce(p_description, '')), ''),
        estimated_cost = p_estimated_cost,
        note = nullif(btrim(coalesce(p_note, '')), ''),
        source = 'web',
        updated_by = nullif(btrim(coalesce(p_actor, '')), '')
    where id = p_id and row_version = p_row_version
    returning * into v_project;
    if not found then
      raise exception '專案資料已被其他使用者更新，請重新載入後再修改。';
    end if;
  end if;

  delete from public.project_workers where project_id = v_project.id;
  insert into public.project_workers(project_id, user_id)
  select v_project.id, worker_id from unnest(v_worker_ids) as workers(worker_id);

  update public.site_work_logs
  set status = p_status,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where project_id = v_project.id
    and status is distinct from p_status;

  return jsonb_build_object(
    'project', to_jsonb(v_project),
    'worker_user_ids', to_jsonb(v_worker_ids),
    'work_log_status', p_status
  );
end;
$$;

revoke all on function public.upsert_erp_project_with_workers_v2(
  uuid, integer, text, uuid, text, text, text, numeric, text, uuid[], text
) from public, anon, authenticated;
grant execute on function public.upsert_erp_project_with_workers_v2(
  uuid, integer, text, uuid, text, text, text, numeric, text, uuid[], text
) to service_role;

commit;
