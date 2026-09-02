begin;

-- Project type and work-log type are one shared project-level value.
alter table public.projects
  drop constraint if exists projects_project_type_check;
alter table public.projects
  add constraint projects_project_type_check
  check (project_type in ('construction', 'repair', 'maintenance'));

-- Existing projects with work logs adopt the latest log's explicit type/status.
-- Projects without logs keep their current type and status.
with latest_log as (
  select distinct on (logs.project_id)
    logs.project_id,
    logs.work_type,
    logs.status
  from public.site_work_logs logs
  where logs.project_id is not null
  order by logs.project_id, logs.log_date desc, logs.updated_at desc, logs.id desc
)
update public.projects projects
set project_type = case latest_log.work_type
      when '工程施工' then 'construction'
      when '維修紀錄' then 'repair'
      else 'maintenance'
    end,
    status = latest_log.status,
    updated_by = coalesce(projects.updated_by, 'project_work_log_sync_migration')
from latest_log
where projects.id = latest_log.project_id
  and (
    projects.project_type is distinct from case latest_log.work_type
      when '工程施工' then 'construction'
      when '維修紀錄' then 'repair'
      else 'maintenance'
    end
    or projects.status is distinct from latest_log.status
  );

update public.site_work_logs logs
set work_type = case projects.project_type
      when 'construction' then '工程施工'
      when 'repair' then '維修紀錄'
      else '維護保養'
    end,
    status = projects.status,
    updated_by = coalesce(logs.updated_by, 'project_work_log_sync_migration')
from public.projects projects
where projects.id = logs.project_id
  and (
    logs.work_type is distinct from case projects.project_type
      when 'construction' then '工程施工'
      when 'repair' then '維修紀錄'
      else '維護保養'
    end
    or logs.status is distinct from projects.status
  );

create or replace function public.sync_project_fields_to_work_logs_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_work_type text;
begin
  v_work_type := case new.project_type
    when 'construction' then '工程施工'
    when 'repair' then '維修紀錄'
    else '維護保養'
  end;

  update public.site_work_logs
  set work_type = v_work_type,
      status = new.status,
      updated_by = coalesce(nullif(btrim(coalesce(new.updated_by, '')), ''), 'project_sync')
  where project_id = new.id
    and (
      work_type is distinct from v_work_type
      or status is distinct from new.status
    );

  return new;
end;
$$;

create or replace function public.sync_work_log_fields_to_project_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project_type text;
  v_actor text;
begin
  if new.project_id is null then
    return new;
  end if;

  v_project_type := case new.work_type
    when '工程施工' then 'construction'
    when '維修紀錄' then 'repair'
    else 'maintenance'
  end;
  v_actor := coalesce(nullif(btrim(coalesce(new.updated_by, '')), ''), 'work_log_sync');

  update public.projects
  set project_type = v_project_type,
      status = new.status,
      updated_by = v_actor
  where id = new.project_id
    and (
      project_type is distinct from v_project_type
      or status is distinct from new.status
    );

  update public.site_work_logs
  set work_type = new.work_type,
      status = new.status,
      updated_by = v_actor
  where project_id = new.project_id
    and id <> new.id
    and (
      work_type is distinct from new.work_type
      or status is distinct from new.status
    );

  return new;
end;
$$;

revoke all on function public.sync_project_fields_to_work_logs_v1()
from public, anon, authenticated;
revoke all on function public.sync_work_log_fields_to_project_v1()
from public, anon, authenticated;

drop trigger if exists projects_sync_work_logs_v1 on public.projects;
create trigger projects_sync_work_logs_v1
after insert or update of project_type, status on public.projects
for each row
execute function public.sync_project_fields_to_work_logs_v1();

drop trigger if exists work_logs_sync_project_v1 on public.site_work_logs;
create trigger work_logs_sync_project_v1
after insert or update of project_id, work_type, status on public.site_work_logs
for each row
execute function public.sync_work_log_fields_to_project_v1();

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
  v_work_type text;
begin
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 120 then
    raise exception '專案名稱必須為 1 至 120 個字。';
  end if;
  if p_customer_id is null or not exists(select 1 from public.customers where id = p_customer_id) then
    raise exception '找不到指定客戶。';
  end if;
  if p_project_type not in ('construction', 'repair', 'maintenance') then
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
            select 1
            from public.project_workers existing_workers
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

  v_work_type := case p_project_type
    when 'construction' then '工程施工'
    when 'repair' then '維修紀錄'
    else '維護保養'
  end;

  update public.site_work_logs
  set work_type = v_work_type,
      status = p_status,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where project_id = v_project.id
    and (
      work_type is distinct from v_work_type
      or status is distinct from p_status
    );

  return jsonb_build_object(
    'project', to_jsonb(v_project),
    'worker_user_ids', to_jsonb(v_worker_ids),
    'work_log_type', v_work_type,
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

