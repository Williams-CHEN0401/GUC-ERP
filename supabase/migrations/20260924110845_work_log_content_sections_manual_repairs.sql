-- Timestamp aligned with the verified production migration record.
begin;
set local lock_timeout = '5s';

-- NULL/NULL denotes a legacy summary. No existing business row is backfilled.
alter table public.site_work_logs
 add column completed_content text,
 add column pending_content text,
 add constraint site_work_logs_content_sections_length check (
  (completed_content is null and pending_content is null) or
  (completed_content is not null and pending_content is not null
   and char_length(completed_content)<=2000 and char_length(pending_content)<=2000)
 );

-- An older client editing summary invalidates only the structured projection.
-- Preserve its actual text; status-only updates do not clear the sections.
create function public.reset_legacy_work_log_sections_v1() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.summary is distinct from old.summary and
    new.completed_content is not distinct from old.completed_content and
    new.pending_content is not distinct from old.pending_content then
  new.completed_content:=null; new.pending_content:=null;
 end if;
 return new;
end $$;
revoke all on function public.reset_legacy_work_log_sections_v1() from public,anon,authenticated;
create trigger reset_legacy_work_log_sections before update of summary on public.site_work_logs
 for each row execute function public.reset_legacy_work_log_sections_v1();

-- Stop automatic repair creation in the existing common writer (including old
-- clients). Keep equipment references, audit, RBAC and historical repair dates.
do $$
declare v_definition text; v_old text;
begin
 v_definition:=replace(pg_get_functiondef('public.upsert_customer_project_work_log_with_maintenance_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text)'::regprocedure),chr(13),'');
 v_old:='if v_before.inventory_item_id is not null'||chr(10)||'        and (';
 if position(v_old in v_definition)=0 then raise exception 'Unexpected repair association guard baseline'; end if;
 v_definition:=replace(v_definition,v_old,'if exists(select 1 from public.repair_items where source_maintenance_event_id=v_before.id)'||chr(10)||'        and (');
 v_old:=$old$    if v_inventory_item_id is not null then
      v_register_repair := v_event_type in ('REPAIR','REPLACEMENT')
        and (v_event_id is null or v_before.inventory_item_id is null);
      if v_register_repair and ($old$;
 if position(v_old in v_definition)=0 then raise exception 'Unexpected repair item validation baseline'; end if;
 v_definition:=replace(v_definition,v_old,$new$    if v_inventory_item_id is not null then
      if ($new$);
 v_old:=substring(v_definition from '    if v_register_repair then[\s\S]*?    end if;');
 if v_old is null or position('insert into public.repair_items' in v_old)=0 then raise exception 'Unexpected automatic repair insert baseline'; end if;
 v_definition:=replace(v_definition,v_old,'    -- Repair registration is now a separate explicit user action.');
 execute v_definition;
end $$;

-- Reuse the authorized department writer and its replay record. The wrapper owns
-- the full request fingerprint so content edits cannot replay a different save.
-- Existing service-only SECURITY DEFINER boundary; no table/RLS grants changed.
create function public.upsert_work_log_sections_v1(
 p_id uuid,p_row_version integer,p_project_id uuid,p_customer_id uuid,p_project_name text,p_log_date date,
 p_work_type text,p_summary text,p_time_period text,p_status text,p_worker_user_ids uuid[],p_reporter_user_id uuid,
 p_maintenance_events jsonb,p_actor text,p_department_id uuid,p_request_id uuid,
 p_completed_content text,p_pending_content text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_payload jsonb; v_previous public.work_log_save_requests; v_result jsonb;
 v_before public.site_work_logs; v_log public.site_work_logs;
begin
 perform public.assert_work_log_access_v1(p_reporter_user_id,p_project_id,p_id,case when p_id is null then 'CREATE' else 'UPDATE' end);
 if p_request_id is null or p_reporter_user_id is null then raise exception '缺少工作日誌送出識別碼或使用者。'; end if;
 if (p_completed_content is null) is distinct from (p_pending_content is null)
  or char_length(coalesce(p_completed_content,''))>2000 or char_length(coalesce(p_pending_content,''))>2000 then
  raise exception '已完成／未完成內容格式不正確或超過長度限制。';
 end if;
 if p_completed_content is not null and
   coalesce(p_summary,'') is distinct from concat_ws(E'\n',nullif(btrim(p_completed_content),''),nullif(btrim(p_pending_content),'')) then
  raise exception '工作內容與已完成／未完成內容不一致。';
 end if;
 v_payload:=jsonb_build_object('operation','work_log_sections_v1','id',p_id,'row_version',p_row_version,
  'project_id',p_project_id,'customer_id',p_customer_id,'project_name',p_project_name,'log_date',p_log_date,
  'work_type',p_work_type,'summary',p_summary,'time_period',p_time_period,'status',p_status,
  'worker_user_ids',p_worker_user_ids,'maintenance_events',p_maintenance_events,'actor',p_actor,
  'department_id',p_department_id,'completed_content',p_completed_content,'pending_content',p_pending_content);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,0));
 select * into v_previous from public.work_log_save_requests where request_id=p_request_id;
 if found then
  if v_previous.reporter_id is distinct from p_reporter_user_id or v_previous.request_payload is distinct from v_payload then
   raise exception '此送出識別碼已使用，請重新載入日誌確認後再修改，避免重複建立。';
  end if;
  return v_previous.result;
 end if;
 v_result:=public.upsert_customer_project_work_log_department_v1(p_id,p_row_version,p_project_id,p_customer_id,
  p_project_name,p_log_date,p_work_type,p_summary,p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,
  p_maintenance_events,p_actor,p_department_id,p_request_id);
 select * into v_before from public.site_work_logs where id=(v_result#>>'{work_log,id}')::uuid;
 update public.site_work_logs set completed_content=p_completed_content,pending_content=p_pending_content,updated_by=p_actor
  where id=v_before.id and (completed_content is distinct from p_completed_content or pending_content is distinct from p_pending_content);
 select * into v_log from public.site_work_logs where id=v_before.id;
 if v_before.completed_content is distinct from v_log.completed_content or v_before.pending_content is distinct from v_log.pending_content then
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
   values('site_work_logs',v_log.id,'update',to_jsonb(v_before),to_jsonb(v_log),'web',p_actor);
 end if;
 v_result:=v_result||jsonb_build_object('work_log',to_jsonb(v_log));
 update public.work_log_save_requests set request_payload=v_payload,result=v_result
  where request_id=p_request_id and reporter_id=p_reporter_user_id;
 if not found then raise exception '工作日誌送出紀錄未建立，操作已取消。'; end if;
 return v_result;
end $$;
revoke all on function public.upsert_work_log_sections_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.upsert_work_log_sections_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid,text,text) to service_role;
commit;
