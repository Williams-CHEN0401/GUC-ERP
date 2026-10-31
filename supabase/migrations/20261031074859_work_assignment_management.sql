begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- One assignment table and the existing project RBAC. Preserve completed rows
-- and their pickup/audit relationships; cancellation never deletes a project.
alter table public.work_assignments drop constraint work_assignments_status_check;
alter table public.work_assignments add constraint work_assignments_status_check
 check(status in ('pending','in_progress','completed','cancelled'));

-- Retain the installed private-data wrappers and all established writer logic.
-- Replace only their legacy administrator test, including wrapped originals.
do $$
declare r record; source text; revised text;
begin
 for r in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and (p.proname like '%create_work_assignment_v1%'
  or p.proname like '%create_work_assignment_with_project_v1%' or p.proname='create_work_assignments_v1') loop
  source:=pg_get_functiondef(r.oid);
  revised:=regexp_replace(source,
   'not exists\s*\(\s*select 1 from public.app_users\s*where id\s*=\s*(p_created_by_user_id|p_actor_user_id) and role\s*=\s*''admin'' and is_active\s*\)',
   'not (public.has_app_permission_v1(\1,''appointments'',''VIEW'') and public.has_app_permission_v1(\1,''projects'',''VIEW'') and public.has_app_permission_v1(\1,''projects'',''CREATE''))','g');
  if r.proname like '%create_work_assignment_v1%' and revised like '%insert into public.work_assignments%' then
   revised:=replace(revised,'insert into public.work_assignments',
    'if not public.construction_project_access_v1(p_created_by_user_id,p_project_id,false) then raise exception ''沒有此工作內容存取權限。'';end if; insert into public.work_assignments');
  end if;
  if revised<>source then execute replace(revised,'只有啟用中的管理員可以建立工作指派。','沒有建立工作指派的權限。');end if;
 end loop;
end $$;

create function public.work_assignment_management_v1(p_actor_user_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare manager boolean; result jsonb;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'appointments','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') then raise exception '沒有工作指派查看權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 manager:=public.has_app_permission_v1(p_actor_user_id,'projects','CREATE') or public.has_app_permission_v1(p_actor_user_id,'projects','UPDATE') or public.has_app_permission_v1(p_actor_user_id,'projects','DELETE');
 select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('project',p.name,'project_code',p.project_code,'customer',c.name,'assignee',u.display_name,'creator',creator.display_name) order by a.created_at desc,a.id),'[]') into result
 from public.work_assignments a join public.projects p on p.id=a.project_id join public.customers c on c.id=p.customer_id
 join public.app_users u on u.id=a.assignee_user_id join public.app_users creator on creator.id=a.created_by_user_id
 where a.assignment_type in ('general','pickup') and (manager or a.assignee_user_id=p_actor_user_id)
 and public.erp_private_json_visible_v1(to_jsonb(a))
 and (not exists(select 1 from public.app_users au join public.app_roles ar on ar.code=au.role where au.id=p_actor_user_id and ar.project_scoped)
  or a.assignee_user_id=p_actor_user_id or public.construction_project_access_v1(p_actor_user_id,p.id,false));
 return jsonb_build_object('records',result);
end $$;

create function public.update_work_assignment_v1(p_actor_user_id uuid,p_actor text,p_id uuid,p_row_version integer,p_payload jsonb)
returns public.work_assignments language plpgsql security invoker set search_path='' as $$
declare prior public.work_assignments; result public.work_assignments; project public.projects;
 target uuid:=(p_payload->>'project_id')::uuid; assignee uuid:=(p_payload->>'assignee_user_id')::uuid;
 plan public.construction_plans; item public.construction_plan_items;
 plan_id uuid:=nullif(p_payload->>'construction_plan_id','')::uuid; item_id uuid:=nullif(p_payload->>'construction_item_id','')::uuid;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'appointments','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'projects','UPDATE') then raise exception '沒有修改工作指派的權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 select * into prior from public.work_assignments where id=p_id for update;
 if not found or prior.assignment_type not in ('general','pickup') then raise exception '找不到此工作指派。';end if;
 perform public.erp_private_assert_v1(to_jsonb(prior));perform public.erp_private_assert_v1(p_payload);
 if prior.row_version is distinct from p_row_version then raise exception '工作指派已被更新，請重新整理。';end if;
 if prior.status not in ('pending','in_progress') then raise exception '已完成或已取消的指派保留歷史，請新增另一筆指派。';end if;
 if exists(select 1 from public.pickup_records where work_assignment_id=p_id) then raise exception '此指派已有取貨紀錄，不可改寫。';end if;
 select * into project from public.projects where id=target for share;
 if not found or project.deleted_at is not null or project.status='completed' then raise exception '請選擇有效且尚未完成的工作內容。';end if;
 if not public.construction_project_access_v1(p_actor_user_id,prior.project_id,false) or not public.construction_project_access_v1(p_actor_user_id,target,false) then raise exception '沒有此工作內容存取權限。';end if;
 if not exists(select 1 from public.app_users where id=assignee and is_active) then raise exception '請選擇啟用中的責任人。';end if;
 if p_payload->>'status' is null or p_payload->>'status' not in ('pending','in_progress') then raise exception '請選擇待處理或處理中；由責任人回報完成。';end if;
 if coalesce(length(btrim(p_payload->>'instructions')),0) not between 1 and 2000 then raise exception '工作說明須為 1 至 2000 個字。';end if;
 if prior.assignment_request_id is not null and exists(select 1 from public.work_assignments where id<>p_id and created_by_user_id=prior.created_by_user_id and assignment_request_id=prior.assignment_request_id and assignee_user_id=assignee) then raise exception '此人已在同次指派中，請取消重複指派或另建新指派。';end if;
 if item_id is not null and plan_id is null then raise exception '請先選擇施工規劃。';end if;
 if plan_id is not null then
  select * into plan from public.construction_plans where id=plan_id and project_id=target for share;
  if not found or plan.deleted_at is not null or plan.status not in ('pending','in_progress') then raise exception '施工規劃已變更或不屬於此工作。';end if;
  if item_id is not null then
   select * into item from public.construction_plan_items where id=item_id and construction_plan_id=plan_id for share;
   if not found or item.deleted_at is not null or item.is_completed then raise exception '施工子項目已完成或不屬於此規劃。';end if;
  end if;
 end if;
 update public.work_assignments set project_id=target,assignee_user_id=assignee,instructions=btrim(p_payload->>'instructions'),status=p_payload->>'status',
 construction_plan_id=plan_id,construction_item_id=item_id,construction_plan_title=plan.content,construction_item_title=item.title,
 row_version=row_version+1,updated_at=now(),updated_by=p_actor where id=p_id returning * into result;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor) values('work_assignment',p_id,'update',to_jsonb(prior),to_jsonb(result),'web',p_actor);
 return result;
end $$;

create function public.cancel_work_assignment_v1(p_actor_user_id uuid,p_actor text,p_id uuid,p_row_version integer)
returns public.work_assignments language plpgsql security invoker set search_path='' as $$
declare prior public.work_assignments; result public.work_assignments;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'appointments','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'projects','DELETE') then raise exception '沒有取消工作指派的權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 select * into prior from public.work_assignments where id=p_id for update;
 if not found or prior.assignment_type not in ('general','pickup') then raise exception '找不到此工作指派。';end if;
 perform public.erp_private_assert_v1(to_jsonb(prior));
 if not public.construction_project_access_v1(p_actor_user_id,prior.project_id,false) then raise exception '沒有此工作內容存取權限。';end if;
 if prior.status='cancelled' then return prior;end if;
 if prior.row_version is distinct from p_row_version then raise exception '工作指派已被更新，請重新整理。';end if;
 if prior.status='completed' or exists(select 1 from public.pickup_records where work_assignment_id=p_id) then raise exception '已完成或已產生取貨紀錄的指派保留歷史，不可刪除。';end if;
 update public.work_assignments set status='cancelled',row_version=row_version+1,updated_at=now(),updated_by=p_actor where id=p_id returning * into result;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor) values('work_assignment',p_id,'update',to_jsonb(prior),to_jsonb(result),'web',p_actor);
 return result;
end $$;
revoke all on function public.work_assignment_management_v1(uuid),public.update_work_assignment_v1(uuid,text,uuid,integer,jsonb),public.cancel_work_assignment_v1(uuid,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.work_assignment_management_v1(uuid),public.update_work_assignment_v1(uuid,text,uuid,integer,jsonb),public.cancel_work_assignment_v1(uuid,text,uuid,integer) to service_role;
notify pgrst,'reload schema';
commit;
