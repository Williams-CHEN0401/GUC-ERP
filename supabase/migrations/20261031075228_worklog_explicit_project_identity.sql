begin;
set local lock_timeout='5s';

-- A missing project ID on a NEW log means manual creation, never a name lookup.
-- The existing customer lock and numbering/department/writer boundaries remain
-- authoritative. Stored work, names and links are not rewritten by this migration.
create function public.create_named_work_log_department_v1(
 p_customer_id uuid,p_project_name text,p_log_date date,p_work_type text,
 p_summary text,p_time_period text,p_status text,p_worker_user_ids uuid[],p_reporter_user_id uuid,
 p_maintenance_events jsonb,p_actor text,p_department_id uuid,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_payload jsonb; v_previous public.work_log_save_requests; v_project public.projects;
 v_name text; v_result jsonb; v_type text;
begin
 perform public.assert_work_log_access_v1(p_reporter_user_id,null,null,'CREATE');
 if p_request_id is null then raise exception '缺少工作日誌送出識別碼，請重新開啟表單。';end if;
 v_payload:=jsonb_build_object('operation','new_named_work_v1','customer_id',p_customer_id,
  'project_name',p_project_name,'log_date',p_log_date,'work_type',p_work_type,'summary',p_summary,
  'time_period',p_time_period,'status',p_status,'worker_user_ids',p_worker_user_ids,
  'maintenance_events',p_maintenance_events,'actor',p_actor,'department_id',p_department_id);
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into v_previous from public.work_log_save_requests where request_id=p_request_id;
 if found then
  if v_previous.reporter_id is distinct from p_reporter_user_id or v_previous.request_payload is distinct from v_payload then
   raise exception '此送出識別碼已使用，請重新載入日誌確認後再修改，避免重複建立。';
  end if;
  return v_previous.result;
 end if;
 perform 1 from public.customers where id=p_customer_id and deleted_at is null for update;
 if not found then raise exception '找不到指定客戶。';end if;
 perform public.assert_customer_department_v1(p_customer_id,p_department_id,null,false);
 v_type:=case p_work_type when '工程施工' then 'construction' when '維修紀錄' then 'repair'
  when '送貨' then 'delivery' when '文書作業' then 'clerical' when '場勘' then 'site_survey'
  when '維護保養' then 'maintenance' end;
 if v_type is null then raise exception '工作類型不正確。';end if;
 v_name:=public.repair_visit_name_v1(p_customer_id,p_project_name,p_log_date);
 select * into v_project from public.create_project_auto_number_v1(v_name,p_customer_id,v_type,'in_progress',null,'由工作日誌自動建立',null,null,p_actor);
 update public.projects set department_id=p_department_id,updated_by=p_actor where id=v_project.id
  and department_id is distinct from p_department_id;
 -- Supplying the newly created ID prevents recursion. Outer replay owns the
 -- original user payload, while the established writer validates the new log.
 v_result:=public.upsert_customer_project_work_log_department_v1(null,null,v_project.id,p_customer_id,
  v_name,p_log_date,p_work_type,p_summary,p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,p_maintenance_events,p_actor,p_department_id,null);
 v_result:=v_result||jsonb_build_object('new_work_created',true);
 insert into public.work_log_save_requests(request_id,reporter_id,request_payload,result)
  values(p_request_id,p_reporter_user_id,v_payload,v_result);
 return v_result;
end $$;
revoke all on function public.create_named_work_log_department_v1(uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.create_named_work_log_department_v1(uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid) to service_role;

do $$
declare def text; old text; replacement text;
begin
 def:=replace(pg_get_functiondef('public.upsert_customer_project_work_log_department_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid)'::regprocedure),chr(13),'');
 old:=$route$  if p_id is null and p_work_type='維修紀錄' then
    return public.create_repair_work_log_department_v1(p_project_id,p_customer_id,p_project_name,p_log_date,p_summary,p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,p_maintenance_events,p_actor,p_department_id,p_request_id);
  end if;$route$;
 replacement:=$route$  if p_id is null and p_project_id is null then
    return public.create_named_work_log_department_v1(p_customer_id,p_project_name,p_log_date,p_work_type,p_summary,p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,p_maintenance_events,p_actor,p_department_id,p_request_id);
  end if;$route$;
 if position(old in def)=0 then raise exception 'Unexpected repair routing baseline';end if;
 execute replace(def,old,replacement);

 def:=replace(pg_get_functiondef('public.pending_maintenance_items_v1(uuid,uuid,date,uuid)'::regprocedure),chr(13),'');
 old:='coalesce(pr.repair_root_project_id,pr.id)=coalesce(p.repair_root_project_id,p.id)';
 if position(old in def)=0 then raise exception 'Unexpected pending work identity baseline';end if;
 execute replace(def,old,'pr.id=p.id');
end $$;
commit;
