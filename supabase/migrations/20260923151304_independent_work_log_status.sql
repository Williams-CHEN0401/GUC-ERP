begin;
set local lock_timeout='5s';

-- Keep shared naming, but neither direction propagates completion anymore.
create or replace function public.sync_project_fields_to_work_logs_v1()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='UPDATE' and old.name is distinct from new.name then
  update public.site_work_logs set title=new.name,updated_by=coalesce(nullif(btrim(new.updated_by),''),'project_sync')
   where project_id=new.id and title is distinct from new.name;
 end if;
 return new;
end $$;
create or replace function public.sync_work_log_fields_to_project_v1()
returns trigger language plpgsql security invoker set search_path='' as $$
begin return new; end $$;

do $$
declare v_definition text; v_old text;
begin
 v_definition:=replace(pg_get_functiondef('public.upsert_erp_project_with_workers_v2(uuid,integer,text,uuid,text,text,text,numeric,text,uuid[],text)'::regprocedure),chr(13),'');
 v_old:=E'  update public.site_work_logs\n  set status = p_status,\n      updated_by = nullif(btrim(coalesce(p_actor, '''')), '''')\n  where project_id = v_project.id\n    and status is distinct from p_status;';
 if position(v_old in v_definition)=0 then raise exception 'Unexpected project status baseline'; end if;
 execute replace(v_definition,v_old,'  -- Work-log status is independent.');

 v_definition:=replace(pg_get_functiondef('public.upsert_project_site_work_log_v2(uuid,uuid,integer,date,text,text,text,text,text,uuid[],uuid,text)'::regprocedure),chr(13),'');
 v_old:=E'  update public.projects\n  set status = p_status,\n      source = ''web'',\n      updated_by = nullif(btrim(coalesce(p_actor, '''')), '''')\n  where id = p_project_id\n    and status is distinct from p_status;\n\n  update public.site_work_logs\n  set status = p_status,\n      updated_by = nullif(btrim(coalesce(p_actor, '''')), '''')\n  where project_id = p_project_id\n    and id <> v_log.id\n    and status is distinct from p_status;';
 if position(v_old in v_definition)=0 then raise exception 'Unexpected log writer status baseline'; end if;
 v_definition:=replace(v_definition,v_old,'  -- Save only this log; project and siblings remain unchanged.');
 execute replace(v_definition,'''project_status'', p_status','''project_status'', (select status from public.projects where id=p_project_id)');

 v_definition:=replace(pg_get_functiondef('public.upsert_customer_project_work_log_v3(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,text)'::regprocedure),chr(13),'');
 v_old:=E'      if p_status is distinct from v_target.status then\n        raise exception ''變更歸屬時狀態必須沿用所選工作內容，請重新載入。'';\n      end if;';
 if position(v_old in v_definition)=0 then raise exception 'Unexpected move status baseline'; end if;
 v_definition:=replace(v_definition,v_old,'      -- Moving a log preserves its independently selected status.');
 v_definition:=replace(v_definition,'work_type=p_work_type,status=v_target.status','work_type=p_work_type,status=p_status');
 v_definition:=replace(v_definition,'p_status, null, ''由工作日誌自動建立''','''in_progress'', null, ''由工作日誌自動建立''');
 execute v_definition;

 v_definition:=pg_get_functiondef('public.upsert_customer_project_work_log_department_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid)'::regprocedure);
 v_old:='p_status,null,''由工作日誌自動建立''';
 if position(v_old in v_definition)=0 then raise exception 'Unexpected department project creation baseline'; end if;
 execute replace(v_definition,v_old,'''in_progress'',null,''由工作日誌自動建立''');
 v_definition:=pg_get_functiondef('public.create_repair_work_log_department_v1(uuid,uuid,text,date,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid)'::regprocedure);
 v_old:='v_name,p_customer_id,''repair'',p_status,';
 if position(v_old in v_definition)=0 then raise exception 'Unexpected repair project creation baseline'; end if;
 execute replace(v_definition,v_old,'v_name,p_customer_id,''repair'',''in_progress'',');
end $$;

-- Explicit close is a narrow, authorized action; it does not edit project fields
-- or any work log. Existing project status/date/version triggers still apply.
create function public.close_work_content_from_log_v1(p_id uuid,p_row_version integer,p_work_log_id uuid,p_actor_user_id uuid,p_actor text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_project public.projects; v_before public.projects;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'projects','UPDATE')
  or exists(select 1 from public.app_users u join public.app_roles r on r.code=u.role where u.id=p_actor_user_id and r.project_scoped) then
  raise exception '沒有結案工作內容的權限。' using errcode='42501';
 end if;
 perform public.assert_work_log_access_v1(p_actor_user_id,p_id,p_work_log_id,'VIEW');
 select * into v_project from public.projects where id=p_id and deleted_at is null for update;
 if not found or not exists(select 1 from public.site_work_logs where id=p_work_log_id and project_id=p_id and deleted_at is null) then
  raise exception '工作日誌的工作內容已變更，請重新整理。';
 end if;
 if v_project.status='completed' then return jsonb_build_object('project',to_jsonb(v_project)); end if;
 if p_row_version is null or v_project.row_version<>p_row_version then raise exception '工作內容已被其他使用者修改，請重新整理後結案。'; end if;
 v_before:=v_project;
 update public.projects set status='completed',source='web',updated_by=p_actor where id=p_id returning * into v_project;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
  values('projects',p_id,'update',to_jsonb(v_before),to_jsonb(v_project),'web',p_actor);
 return jsonb_build_object('project',to_jsonb(v_project));
end $$;
revoke all on function public.close_work_content_from_log_v1(uuid,integer,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.close_work_content_from_log_v1(uuid,integer,uuid,uuid,text) to service_role;

-- No existing project or log statuses are rewritten.
commit;
