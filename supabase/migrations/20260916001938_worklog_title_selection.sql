begin;
set local lock_timeout = '5s';
-- Extend existing entrypoints; preserve their security modes, signatures and ACLs.
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
  v_target_type text;
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
      v_target_type := case v_target.project_type
        when 'construction' then '工程施工' when 'repair' then '維修紀錄'
        when 'delivery' then '送貨' when 'clerical' then '文書作業'
        when 'site_survey' then '場勘' else '維護保養' end;
      if p_work_type is distinct from v_target_type or p_status is distinct from v_target.status then
        raise exception '變更歸屬時類型與狀態必須沿用所選工作內容，請重新載入。';
      end if;
      select * into v_existing from public.site_work_logs where id=p_id for update;
      if p_row_version is null or v_existing.row_version <> p_row_version then
        raise exception '工作日誌已被其他使用者更新，請重新載入後再修改。';
      end if;
      -- Financial/material history and historical file ownership are not implicitly moved.
      if exists(select 1 from public.pickup_records where work_log_id=p_id)
         or exists(select 1 from public.site_assets where work_log_id=p_id) then
        raise exception '此日誌已有取貨或歷史附件關聯，不能直接變更工作內容歸屬；原資料保持不變。';
      end if;
      select * into v_site from public.ensure_project_site_v1(v_target.id,p_actor);
      update public.site_work_logs
        set site_id=v_site.id,project_id=v_target.id,title=v_target.name,
            work_type=v_target_type,status=v_target.status,source='web',updated_by=p_actor
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


create or replace function public.upsert_customer_project_work_log_department_v1(
  p_id uuid,p_row_version integer,p_project_id uuid,p_customer_id uuid,p_project_name text,p_log_date date,
  p_work_type text,p_summary text,p_time_period text,p_status text,p_worker_user_ids uuid[],p_reporter_user_id uuid,
  p_maintenance_events jsonb,p_actor text,p_department_id uuid,p_request_id uuid default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_project public.projects; v_project_id uuid; v_existing boolean; v_result jsonb;
begin
  perform public.assert_work_log_access_v1(p_reporter_user_id,p_project_id,p_id,case when p_id is null then 'CREATE' else 'UPDATE' end);
  -- Keep the existing lock order without accessing the private replay table.
  if p_request_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,0));
  end if;
  -- Serialize same-customer name resolution with department creation and all new wrappers.
  perform 1 from public.customers where id=p_customer_id for update;
  if p_id is not null then
    select project_id into v_project_id from public.site_work_logs where id=p_id;
    if not found then raise exception '找不到工作日誌。'; end if;
    -- The existing authorized writer validates source/target scope and moves atomically.
    v_project_id:=coalesce(p_project_id,v_project_id);
    select * into v_project from public.projects where id=v_project_id for update;
  elsif p_project_id is not null then
    select * into v_project from public.projects where id=p_project_id for update;
    if not found then raise exception '找不到工作內容。'; end if;
  else
    select * into v_project from public.projects where customer_id=p_customer_id
      and lower(btrim(name))=lower(btrim(p_project_name)) for update;
  end if;
  v_existing:=v_project.id is not null;
  if v_existing and (v_project.customer_id is distinct from p_customer_id or v_project.department_id is distinct from p_department_id) then
    raise exception '工作內容的客戶／科室不相符；同名但不同科室請使用不同名稱。';
  end if;
  perform public.assert_customer_department_v1(p_customer_id,p_department_id,v_project.department_id,v_existing);
  if not v_existing then
    -- Create exactly one new project; a concurrently inserted old-client name must fail uniqueness,
    -- never be silently adopted and moved to this department by the legacy name resolver.
    select * into v_project from public.create_project_auto_number_v1(btrim(p_project_name),p_customer_id,
      case p_work_type when '工程施工' then 'construction' when '維修紀錄' then 'repair' when '送貨' then 'delivery' when '文書作業' then 'clerical' when '場勘' then 'site_survey' else 'maintenance' end,
      p_status,null,'由工作日誌自動建立',null,null,p_actor);
    update public.projects set department_id=p_department_id,updated_by=p_actor where id=v_project.id
      and department_id is distinct from p_department_id;
  end if;
  -- Replay, maintenance writes and repair inheritance remain inside their existing
  -- authorized transaction entrypoints. Do not grant direct access to protected tables.
  if p_request_id is not null then
    v_result:=public.upsert_customer_project_work_log_with_maintenance_v2(p_id,p_row_version,v_project.id,p_customer_id,
      p_project_name,p_log_date,p_work_type,p_summary,p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,p_maintenance_events,p_actor,p_request_id);
  else
    v_result:=public.upsert_customer_project_work_log_with_maintenance_v1(p_id,p_row_version,v_project.id,p_customer_id,
      p_project_name,p_log_date,p_work_type,p_summary,p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,p_maintenance_events,p_actor);
  end if;
  v_project_id:=(v_result#>>'{work_log,project_id}')::uuid;
  select * into v_project from public.projects where id=v_project_id;
  v_result:=v_result||jsonb_build_object('project',to_jsonb(v_project));
  return v_result;
end $$;


commit;
