begin;
set local lock_timeout = '5s';
-- Daily log types are independent. Only existing project-creation entrypoints
-- initialize project_type. Keep shared title/status, signatures, RBAC and ACLs.
create or replace function public.sync_project_fields_to_work_logs_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_renamed boolean := false;
begin
  if tg_op = 'UPDATE' then v_renamed := old.name is distinct from new.name; end if;
  update public.site_work_logs
  set title = case when v_renamed then new.name else title end,
      status = new.status,
      updated_by = coalesce(nullif(btrim(coalesce(new.updated_by, '')), ''), 'project_sync')
  where project_id = new.id
    and (v_renamed or status is distinct from new.status);
  return new;
end;
$$;

create or replace function public.sync_work_log_fields_to_project_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_actor text;
begin
  if new.project_id is null then return new; end if;
  v_actor := coalesce(nullif(btrim(coalesce(new.updated_by, '')), ''), 'work_log_sync');
  update public.projects
  set status = new.status, updated_by = v_actor
  where id = new.project_id and status is distinct from new.status;
  update public.site_work_logs
  set status = new.status, updated_by = v_actor
  where project_id = new.project_id and id <> new.id
    and status is distinct from new.status;
  return new;
end;
$$;

-- The project editor also had an explicit bulk type update after its trigger.
-- Preserve all validation, numbering, assignment, status and return contracts.
CREATE OR REPLACE FUNCTION public.upsert_erp_project_with_workers_v2(p_id uuid, p_row_version integer, p_name text, p_customer_id uuid, p_project_type text, p_status text, p_description text, p_estimated_cost numeric, p_note text, p_worker_user_ids uuid[], p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if p_project_type not in ('construction', 'repair', 'maintenance', 'delivery', 'clerical', 'site_survey') then
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

  update public.project_workers set is_assignee=false where project_id=v_project.id;
  insert into public.project_workers(project_id, user_id)
  select v_project.id, worker_id from unnest(v_worker_ids) as workers(worker_id) on conflict(project_id,user_id) do update set is_assignee=true;
  delete from public.project_workers where project_id=v_project.id and not is_assignee and not can_view;

  v_work_type := case p_project_type
    when 'construction' then '工程施工'
    when 'delivery' then '送貨'
    when 'clerical' then '文書作業'
    when 'site_survey' then '場勘'
    when 'repair' then '維修紀錄'
    else '維護保養'
  end;

  update public.site_work_logs
  set status = p_status,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where project_id = v_project.id
    and status is distinct from p_status;

  return jsonb_build_object(
    'project', to_jsonb(v_project),
    'worker_user_ids', to_jsonb(v_worker_ids),
    'work_log_type', v_work_type,
    'work_log_status', p_status
  );
end;
$function$
;

commit;
