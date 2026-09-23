begin;
set local lock_timeout = '5s';

-- NULL preserves the legacy project department. No existing row is backfilled.
alter table public.site_work_logs add column department_id uuid references public.customer_departments(id);
create index site_work_logs_department_id_idx on public.site_work_logs(department_id);

-- Same service-only replay boundary as maintenance-v2. Reuse the existing
-- authorized writer; include the log department in the idempotency payload.
create function public.upsert_work_log_with_department_v1(
 p_id uuid,p_row_version integer,p_project_id uuid,p_customer_id uuid,p_project_name text,p_log_date date,
 p_work_type text,p_summary text,p_time_period text,p_status text,p_worker_user_ids uuid[],p_reporter_user_id uuid,
 p_maintenance_events jsonb,p_actor text,p_department_id uuid,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_payload jsonb; v_previous public.work_log_save_requests; v_result jsonb;
 v_before public.site_work_logs; v_log public.site_work_logs; v_project public.projects;
 v_repair public.repair_items; v_repair_after public.repair_items; v_old_department uuid;
begin
 perform public.assert_work_log_access_v1(p_reporter_user_id,p_project_id,p_id,case when p_id is null then 'CREATE' else 'UPDATE' end);
 if p_reporter_user_id is null then raise exception '缺少工作日誌使用者。'; end if;
 v_payload:=jsonb_build_object('operation','log_department_v1','id',p_id,'row_version',p_row_version,
  'project_id',p_project_id,'customer_id',p_customer_id,'project_name',p_project_name,'log_date',p_log_date,
  'work_type',p_work_type,'summary',p_summary,'time_period',p_time_period,'status',p_status,
  'worker_user_ids',p_worker_user_ids,'maintenance_events',p_maintenance_events,'actor',p_actor,'department_id',p_department_id);
 if p_request_id is not null then
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,0));
  select * into v_previous from public.work_log_save_requests where request_id=p_request_id;
  if found then
   if v_previous.reporter_id is distinct from p_reporter_user_id or v_previous.request_payload is distinct from v_payload then
    raise exception '此送出識別碼已使用，請重新載入日誌確認後再修改，避免重複建立。';
   end if;
   return v_previous.result;
  end if;
 end if;
 select * into v_project from public.projects where id=p_project_id and deleted_at is null;
 if not found or v_project.customer_id is distinct from p_customer_id then raise exception '工作內容不屬於所選客戶。'; end if;
 if p_work_type is distinct from '維護保養' and v_project.department_id is distinct from p_department_id then
  raise exception '只有維護保養日誌可以跨科室選用工作內容。';
 end if;
 if p_id is not null then
  select * into v_before from public.site_work_logs where id=p_id;
  select coalesce(v_before.department_id,p.department_id) into v_old_department from public.projects p where p.id=v_before.project_id;
 end if;
 perform public.assert_customer_department_v1(p_customer_id,p_department_id,v_old_department,p_id is not null);
 if p_id is not null and exists(select 1 from public.repair_items r join public.maintenance_events e on e.id=r.source_maintenance_event_id
  where e.work_log_id=p_id and (r.customer_id is distinct from p_customer_id or r.department_id is distinct from p_department_id)) then
  raise exception '此日誌已登錄維修品，不能直接變更維修品的客戶或科室。';
 end if;
 v_result:=public.upsert_customer_project_work_log_with_maintenance_v1(p_id,p_row_version,p_project_id,p_customer_id,
  p_project_name,p_log_date,p_work_type,p_summary,p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,p_maintenance_events,p_actor);
 select * into v_before from public.site_work_logs where id=(v_result#>>'{work_log,id}')::uuid;
 update public.site_work_logs set department_id=case when p_work_type='維護保養' then p_department_id else null end,updated_by=p_actor
  where id=v_before.id and department_id is distinct from (case when p_work_type='維護保養' then p_department_id else null end);
 select * into v_log from public.site_work_logs where id=v_before.id;
 if v_before.department_id is distinct from v_log.department_id then
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
   values('site_work_logs',v_log.id,'update',to_jsonb(v_before),to_jsonb(v_log),'web',p_actor);
 end if;
 -- Only repairs created by this save inherit this log's room; historical repairs
 -- are never reassigned. Keep the existing privileged repair/audit boundary.
 for v_repair in select r.* from public.repair_items r where r.id in
  (select value::uuid from jsonb_array_elements_text(coalesce(v_result->'created_repair_item_ids','[]'::jsonb)))
  and r.department_id is distinct from p_department_id
 loop
  update public.repair_items set department_id=p_department_id,updated_by=p_actor where id=v_repair.id returning * into v_repair_after;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
   values('repair_items',v_repair.id,'UPDATE_REPAIR_ITEM',to_jsonb(v_repair),to_jsonb(v_repair_after),'work_log',p_actor);
 end loop;
 v_result:=v_result||jsonb_build_object('work_log',to_jsonb(v_log));
 if p_request_id is not null then
  insert into public.work_log_save_requests(request_id,reporter_id,request_payload,result) values(p_request_id,p_reporter_user_id,v_payload,v_result);
 end if;
 return v_result;
end $$;
revoke all on function public.upsert_work_log_with_department_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.upsert_work_log_with_department_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid) to service_role;

do $$
declare v_definition text; v_old text; v_new text;
begin
 v_definition:=replace(pg_get_functiondef('public.upsert_customer_project_work_log_department_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid)'::regprocedure),chr(13),'');
 v_old:='v_project.customer_id is distinct from p_customer_id or v_project.department_id is distinct from p_department_id';
 if position(v_old in v_definition)=0 then raise exception 'Unexpected department context baseline'; end if;
 v_definition:=replace(v_definition,v_old,'v_project.customer_id is distinct from p_customer_id or (p_work_type is distinct from ''維護保養'' and v_project.department_id is distinct from p_department_id)');
 v_old:='perform public.assert_customer_department_v1(p_customer_id,p_department_id,v_project.department_id,v_existing);';
 v_new:=$check$if p_work_type='維護保養' then
   perform public.assert_customer_department_v1(p_customer_id,p_department_id,
    (select coalesce(l.department_id,p.department_id) from public.site_work_logs l join public.projects p on p.id=l.project_id where l.id=p_id),p_id is not null);
  else
   perform public.assert_customer_department_v1(p_customer_id,p_department_id,v_project.department_id,v_existing);
  end if;$check$;
 if position(v_old in v_definition)=0 then raise exception 'Unexpected department validation baseline'; end if;
 v_definition:=replace(v_definition,v_old,v_new);
 v_old:=E'  if p_request_id is not null then\n    v_result:=public.upsert_customer_project_work_log_with_maintenance_v2';
 v_new:=$route$  if p_work_type='維護保養' or exists(select 1 from public.site_work_logs where id=p_id and department_id is not null) then
    v_result:=public.upsert_work_log_with_department_v1(p_id,p_row_version,v_project.id,p_customer_id,
      p_project_name,p_log_date,p_work_type,p_summary,p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,p_maintenance_events,p_actor,p_department_id,p_request_id);
  elsif p_request_id is not null then
    v_result:=public.upsert_customer_project_work_log_with_maintenance_v2$route$;
 if position(v_old in v_definition)=0 then raise exception 'Unexpected maintenance replay baseline'; end if;
 execute replace(v_definition,v_old,v_new);
end $$;

-- No table grants, RLS policy changes or writes to existing business records.
commit;
