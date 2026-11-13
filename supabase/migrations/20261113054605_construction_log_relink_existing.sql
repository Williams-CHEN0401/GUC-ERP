-- Restore existing-log assignment lost when construction RBAC was introduced.
-- No row backfill, new grants, new auth or changes to other roles.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $baseline$ begin
 if md5(replace(pg_get_functiondef('public.assert_construction_log_access_v1(uuid,uuid,uuid,text)'::regprocedure),chr(13),''))<>'386c7055cdfa4d1d7ae62adeebaa13fd' then raise exception 'Unexpected construction log authorization baseline';end if;
end $baseline$;

CREATE OR REPLACE FUNCTION public.assert_construction_log_access_v1(p_user_id uuid, p_plan_id uuid, p_log_id uuid, p_action text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_plan public.construction_plans; v_project public.projects; v_log public.site_work_logs;
begin
 if not public.construction_permission_v1(p_user_id,'construction_plans','VIEW') or not public.construction_permission_v1(p_user_id,'construction_logs','VIEW') or not public.construction_permission_v1(p_user_id,'construction_logs',p_action) then raise exception '沒有工作日誌操作權限。'; end if;
 -- Serialize reassignment/deletion with log saves; removed workers cannot race a save.
 select * into v_plan from public.construction_plans where id=p_plan_id for update;
 if not found then raise exception '找不到施工規劃。'; end if;
 select * into v_project from public.projects where id=v_plan.project_id for update;
 perform public.erp_private_prepare_v1(p_user_id);
 perform public.erp_private_assert_v1(to_jsonb(v_project));
 if p_log_id is null then
  if p_action<>'CREATE' or v_plan.deleted_at is not null or v_plan.status='cancelled' or v_project.deleted_at is not null
   or v_project.project_type<>'construction' or coalesce(v_project.construction_category,'') not in ('small_purchase','tender')
   or not (exists(select 1 from public.construction_plan_assignees where construction_plan_id=p_plan_id and user_id=p_user_id) or public.construction_project_access_v1(p_user_id,v_project.id,true))
  then raise exception '只有指派施工人員、工作內容負責人或管理員可以新增此規劃日誌。'; end if;
 else
  select * into v_log from public.site_work_logs where id=p_log_id and deleted_at is null for update;
  if not found or v_log.project_id is distinct from v_project.id then raise exception '日誌與施工規劃必須屬於同一工作內容。'; end if;
  -- A relink is an UPDATE of an existing log, not permission to edit another
  -- person's log. Validate the destination and the existing source separately.
  if v_log.construction_plan_id is distinct from p_plan_id then
   if p_action<>'UPDATE' or v_plan.deleted_at is not null or v_plan.status='cancelled' or v_project.deleted_at is not null
    or v_project.project_type<>'construction' or coalesce(v_project.construction_category,'') not in ('small_purchase','tender')
    or not (exists(select 1 from public.construction_plan_assignees where construction_plan_id=p_plan_id and user_id=p_user_id)
      or public.construction_project_access_v1(p_user_id,v_project.id,true))
   then raise exception '沒有指定此施工規劃的權限。'; end if;
   perform public.erp_private_assert_v1(to_jsonb(v_log));
   if v_log.construction_plan_id is null then
    perform public.assert_regular_work_log_access_v1(p_user_id,v_project.id,p_log_id,'UPDATE');
   elsif not public.construction_log_action_v1(p_user_id,v_log,'UPDATE') then
    raise exception '沒有修改或刪除此施工日誌的權限。';
   end if;
   return;
  end if;
  perform public.erp_private_assert_v1(to_jsonb(v_log));
  if p_action='VIEW' then
   if not public.construction_log_visible_v1(p_user_id,v_log) then raise exception '沒有此施工日誌查看權限。'; end if;
  elsif not public.construction_log_action_v1(p_user_id,v_log,p_action) then
   raise exception '沒有修改或刪除此施工日誌的權限。';
  end if;
 end if;
end $function$
;
commit;
