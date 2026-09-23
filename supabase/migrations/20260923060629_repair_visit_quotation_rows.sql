begin;
set local lock_timeout = '5s';

-- Called under the customer row lock. Includes archived names because the existing
-- customer/name uniqueness constraint includes them too; never rename old work.
create function public.repair_visit_name_v1(p_customer_id uuid,p_name text,p_date date)
returns text language plpgsql security invoker set search_path='' as $$
declare v_name text:=btrim(p_name); v_base text; v_suffix integer:=2;
begin
  if p_customer_id is null or nullif(v_name,'') is null or p_date is null then
    raise exception '請選擇客戶、填寫工作內容名稱與日誌日期。';
  end if;
  if exists(select 1 from public.projects where customer_id=p_customer_id and lower(btrim(name))=lower(v_name)) then
    v_base:=v_name||to_char(p_date,'YYMMDD'); v_name:=v_base;
    while exists(select 1 from public.projects where customer_id=p_customer_id and lower(btrim(name))=lower(v_name)) loop
      v_name:=v_base||'-'||v_suffix; v_suffix:=v_suffix+1;
    end loop;
  end if;
  if char_length(v_name)>120 then raise exception '加上日期／流水尾碼後，工作內容名稱不可超過 120 個字，請縮短名稱。'; end if;
  return v_name;
end $$;

-- Same privileged replay boundary as the existing maintenance-v2 RPC. Only the
-- authenticated Gateway's service role may invoke it; actor RBAC is checked before
-- replay and before creating work. No direct grants on the private replay table.
create function public.create_repair_work_log_department_v1(
  p_project_id uuid,p_customer_id uuid,p_project_name text,p_log_date date,
  p_summary text,p_time_period text,p_status text,p_worker_user_ids uuid[],p_reporter_user_id uuid,
  p_maintenance_events jsonb,p_actor text,p_department_id uuid,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_payload jsonb; v_previous public.work_log_save_requests; v_project public.projects;
  v_template public.projects; v_name text; v_result jsonb;
begin
  perform public.assert_work_log_access_v1(p_reporter_user_id,p_project_id,null,'CREATE');
  -- A scoped caller must supply an already-authorized source. The exact same
  -- grants are inherited below; arbitrary new names/users/privileges are not.
  if p_request_id is null then raise exception '缺少工作日誌送出識別碼，請重新開啟表單。'; end if;
  v_payload:=jsonb_build_object('operation','repair_visit_v1','project_id',p_project_id,'customer_id',p_customer_id,
    'project_name',p_project_name,'log_date',p_log_date,'summary',p_summary,'time_period',p_time_period,
    'status',p_status,'worker_user_ids',p_worker_user_ids,'maintenance_events',p_maintenance_events,
    'actor',p_actor,'department_id',p_department_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,0));
  select * into v_previous from public.work_log_save_requests where request_id=p_request_id;
  if found then
    if v_previous.reporter_id is distinct from p_reporter_user_id or v_previous.request_payload is distinct from v_payload then
      raise exception '此送出識別碼已使用，請重新載入日誌確認後再修改，避免重複建立。';
    end if;
    return v_previous.result;
  end if;
  perform 1 from public.customers where id=p_customer_id for update;
  if not found then raise exception '找不到指定客戶。'; end if;
  if p_project_id is not null then
    select * into v_template from public.projects where id=p_project_id and deleted_at is null for update;
    if not found or v_template.customer_id is distinct from p_customer_id or v_template.department_id is distinct from p_department_id then
      raise exception '工作內容的客戶／科室不相符。';
    end if;
    if v_template.name is distinct from btrim(p_project_name) then raise exception '所選工作內容名稱已變更，請重新選擇。'; end if;
    perform 1 from public.project_workers where project_id=v_template.id order by user_id for share;
  end if;
  perform public.assert_customer_department_v1(p_customer_id,p_department_id,null,false);
  v_name:=public.repair_visit_name_v1(p_customer_id,p_project_name,p_log_date);
  select * into v_project from public.create_project_auto_number_v1(v_name,p_customer_id,'repair',p_status,
    v_template.assigned_to,'由工作日誌自動建立',null,null,p_actor);
  update public.projects set department_id=p_department_id,updated_by=p_actor where id=v_project.id
    and department_id is distinct from p_department_id;
  if v_template.id is not null then
    insert into public.project_workers(project_id,user_id,is_assignee,can_view,can_create_work_log,can_update_work_log,can_delete_work_log,granted_by,granted_at)
    select v_project.id,user_id,is_assignee,can_view,can_create_work_log,can_update_work_log,can_delete_work_log,p_reporter_user_id,now()
    from public.project_workers where project_id=v_template.id;
  end if;
  v_result:=public.upsert_customer_project_work_log_with_maintenance_v1(null,null,v_project.id,p_customer_id,
    v_name,p_log_date,'維修紀錄',p_summary,p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,p_maintenance_events,p_actor);
  select * into v_project from public.projects where id=v_project.id;
  v_result:=v_result||jsonb_build_object('project',to_jsonb(v_project),'repair_visit',true);
  insert into public.work_log_save_requests(request_id,reporter_id,request_payload,result)
    values(p_request_id,p_reporter_user_id,v_payload,v_result);
  return v_result;
end $$;

revoke all on function public.repair_visit_name_v1(uuid,text,date),
 public.create_repair_work_log_department_v1(uuid,uuid,text,date,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.repair_visit_name_v1(uuid,text,date),
 public.create_repair_work_log_department_v1(uuid,uuid,text,date,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid) to service_role;

-- Keep the existing invoker wrapper, edit/rename/move and construction save paths
-- unchanged. Route only NEW repair visits before any legacy name resolution.
do $$
declare v_definition text;
begin
  select pg_get_functiondef('public.upsert_customer_project_work_log_department_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid)'::regprocedure) into v_definition;
  v_definition:=replace(v_definition,chr(13),'');
  if position('v_existing boolean; v_result jsonb;' in v_definition)=0 then raise exception 'Unexpected department save baseline'; end if;
  v_definition:=replace(v_definition,'v_existing boolean; v_result jsonb;'||chr(10)||'begin',
    'v_existing boolean; v_result jsonb;'||chr(10)||'begin'||chr(10)||
    '  if p_id is null and p_work_type=''維修紀錄'' then'||chr(10)||
    '    return public.create_repair_work_log_department_v1(p_project_id,p_customer_id,p_project_name,p_log_date,p_summary,p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,p_maintenance_events,p_actor,p_department_id,p_request_id);'||chr(10)||
    '  end if;');
  if position('return public.create_repair_work_log_department_v1' in v_definition)=0 then raise exception 'Repair routing was not applied'; end if;
  execute v_definition;
end $$;
commit;
