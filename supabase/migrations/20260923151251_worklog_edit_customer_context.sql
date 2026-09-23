begin;

-- Extend the existing authorized, transactional writer. Do not change ERP
-- customer/project masters when one log is moved to another customer/department.
do $$
declare v_definition text; v_old text; v_new text;
begin
  v_definition := replace(pg_get_functiondef('public.upsert_customer_project_work_log_v3(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,text)'::regprocedure),chr(13),'');
  v_old := 'if not found or v_project.customer_id <> p_customer_id then';
  if position(v_old in v_definition)=0 then raise exception 'Unexpected work-log customer baseline'; end if;
  v_definition := replace(v_definition,v_old,'if not found or (v_project.customer_id <> p_customer_id and (p_project_id is null or p_project_id = v_project.id)) then');
  v_old := E'if not found or v_target.customer_id is distinct from v_project.customer_id\n         or v_target.department_id is distinct from v_project.department_id then';
  if position(v_old in v_definition)=0 then raise exception 'Unexpected work-log target baseline'; end if;
  v_definition := replace(v_definition,v_old,'if not found or v_target.customer_id is distinct from p_customer_id then');
  v_definition := replace(v_definition,'僅能選擇同一客戶、同一科室的工作內容。','所選工作內容不屬於指定客戶。');
  -- The department entrypoint restricts EXISTING destinations to in-progress;
  -- a newly created destination may retain this log''s completed status.
  v_definition := replace(v_definition,$str$if v_target.status is distinct from 'in_progress' then$str$,$str$if v_target.status not in ('in_progress','completed') then$str$);
  v_old := '      -- Financial/material history and historical file ownership are not implicitly moved.';
  v_new := $guard$
      if v_target.customer_id is distinct from v_project.customer_id
         or v_target.department_id is distinct from v_project.department_id then
        if exists(select 1 from public.repair_items r join public.maintenance_events e on e.id=r.source_maintenance_event_id where e.work_log_id=p_id) then
          raise exception '此日誌已登錄維修品，請先處理維修品的客戶／科室關聯，不能直接變更客戶或科室。';
        end if;
        if v_target.customer_id is distinct from v_project.customer_id and exists(
          select 1 from public.maintenance_event_equipment x join public.maintenance_events e on e.id=x.event_id where e.work_log_id=p_id
        ) then
          raise exception '此日誌已有客戶設備關聯，不能直接移至另一客戶；設備歷史保持不變。';
        end if;
      end if;
      -- Financial/material history and historical file ownership are not implicitly moved.
$guard$;
  if position(v_old in v_definition)=0 then raise exception 'Unexpected work-log ownership baseline'; end if;
  execute replace(v_definition,v_old,v_new);

  v_definition := replace(pg_get_functiondef('public.upsert_customer_project_work_log_department_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid)'::regprocedure),chr(13),'');
  v_old := E'    select * into v_project from public.projects where id=v_project_id for update;\n  elsif p_project_id is not null then';
  v_new := $resolve$
    select * into v_project from public.projects where id=v_project_id for update;
    if p_project_id is null and (v_project.customer_id is distinct from p_customer_id or v_project.department_id is distinct from p_department_id) then
      if not public.has_app_permission_v1(p_reporter_user_id,'projects','UPDATE')
         or exists(select 1 from public.app_users u join public.app_roles r on r.code=u.role where u.id=p_reporter_user_id and r.project_scoped) then
        raise exception '沒有變更工作日誌歸屬的權限。' using errcode='42501';
      end if;
      select * into v_project from public.projects where customer_id=p_customer_id
        and lower(btrim(name))=lower(btrim(p_project_name)) and deleted_at is null for update;
    end if;
    if v_project.id is not null and v_project.id is distinct from (select project_id from public.site_work_logs where id=p_id)
       and v_project.status is distinct from 'in_progress' then
      raise exception '僅能改歸到進行中的工作內容。';
    end if;
  elsif p_project_id is not null then
$resolve$;
  if position(v_old in v_definition)=0 then raise exception 'Unexpected department edit baseline'; end if;
  v_definition := replace(v_definition,v_old,v_new);
  v_old := '  if not v_existing then';
  v_new := $create$
  if not v_existing then
    if p_id is not null and (not public.has_app_permission_v1(p_reporter_user_id,'projects','CREATE')
       or exists(select 1 from public.app_users u join public.app_roles r on r.code=u.role where u.id=p_reporter_user_id and r.project_scoped)) then
      raise exception '沒有建立新工作內容的權限。' using errcode='42501';
    end if;
$create$;
  if position(v_old in v_definition)=0 then raise exception 'Unexpected department create baseline'; end if;
  execute replace(v_definition,v_old,v_new);
end $$;

-- Existing function identities, grants, security modes, replay, maintenance,
-- optimistic locks and pickup/attachment safeguards remain in place.
commit;
