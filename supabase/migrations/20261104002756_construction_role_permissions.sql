begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Extend the existing role matrix. Missing entries retain the released rules;
-- explicit false entries deny, including when projects/worklogs still allow.
do $constraint$ declare d text;begin
 select pg_get_constraintdef(oid) into d from pg_constraint where conrelid='public.role_permissions'::regclass and conname='role_permissions_module_check';
 if position('construction_plans' in d)=0 then
  alter table public.role_permissions drop constraint role_permissions_module_check;
  execute 'alter table public.role_permissions add constraint role_permissions_module_check check (('||substring(d from 8 for length(d)-8)||') or module in (''construction_plans'',''construction_items'',''construction_logs'',''construction_logs_all''))';
 end if;
end $constraint$;

create function public.construction_permission_v1(p_user_id uuid,p_module text,p_action text)
returns boolean language sql stable security invoker set search_path='' as $$
 select coalesce((select case when u.role='admin' then true
  when exists(select 1 from public.role_permissions where role_code=u.role and module=p_module)
   then public.has_app_permission_v1(p_user_id,p_module,p_action)
  when p_module='construction_plans' and p_action='VIEW' then public.has_app_permission_v1(p_user_id,'projects','VIEW') or public.has_app_permission_v1(p_user_id,'worklogs','VIEW')
  when p_module='construction_plans' then public.has_app_permission_v1(p_user_id,'projects','VIEW') and public.has_app_permission_v1(p_user_id,'projects','UPDATE')
  when p_module='construction_logs' then public.has_app_permission_v1(p_user_id,'worklogs',p_action)
  else false end from public.app_users u where u.id=p_user_id and u.is_active),false);
$$;

create function public.construction_project_scope_v1(p_user_id uuid,p_project_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.app_users u join public.app_roles r on r.code=u.role
 where u.id=p_user_id and u.is_active and (u.role='admin' or not r.project_scoped
 or exists(select 1 from public.project_workers w where w.project_id=p_project_id and w.user_id=u.id and (w.can_view or w.is_assignee))
 or exists(select 1 from public.construction_plan_assignees a join public.construction_plans c on c.id=a.construction_plan_id
 where c.project_id=p_project_id and c.deleted_at is null and a.user_id=u.id)));
$$;
create or replace function public.construction_project_legacy_access_v1(p_user_id uuid,p_project_id uuid,p_manage boolean default false)
returns boolean language sql stable security invoker set search_path='' as $$
 select public.has_app_permission_v1(p_user_id,'projects','VIEW')
 and (not p_manage or public.has_app_permission_v1(p_user_id,'projects','UPDATE'))
 and exists(select 1 from public.app_users u join public.app_roles r on r.code=u.role
 where u.id=p_user_id and u.is_active and
 (u.role='admin' or exists(select 1 from public.project_workers w where w.project_id=p_project_id and w.user_id=u.id and w.is_assignee)
 or not p_manage and (not r.project_scoped or exists(select 1 from public.project_workers w where w.project_id=p_project_id and w.user_id=u.id and w.can_view))));
$$;

create or replace function public.construction_project_access_v1(p_user_id uuid,p_project_id uuid,p_manage boolean default false)
returns boolean language sql stable security invoker set search_path='' as $$
 select case when exists(select 1 from public.role_permissions p join public.app_users u on u.role=p.role_code where u.id=p_user_id and p.module='construction_plans')
 then public.construction_permission_v1(p_user_id,'construction_plans','VIEW')
  and (not p_manage or public.construction_permission_v1(p_user_id,'construction_plans','UPDATE'))
  and public.construction_project_scope_v1(p_user_id,p_project_id)
 else public.construction_project_legacy_access_v1(p_user_id,p_project_id,p_manage) end;
$$;
create function public.construction_plan_write_allowed_v1(p_user_id uuid,p_project_id uuid,p_action text)
returns boolean language sql stable security invoker set search_path='' as $$
 select public.construction_permission_v1(p_user_id,'construction_plans','VIEW')
 and public.construction_permission_v1(p_user_id,'construction_plans',p_action)
 and case when exists(select 1 from public.role_permissions p join public.app_users u on u.role=p.role_code where u.id=p_user_id and p.module='construction_plans')
 then public.construction_project_scope_v1(p_user_id,p_project_id)
 else public.construction_project_legacy_access_v1(p_user_id,p_project_id,true) end;
$$;
create function public.construction_item_access_v1(p_user_id uuid,p_plan_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.construction_plans c where c.id=p_plan_id and c.deleted_at is null and c.status<>'cancelled'
 and public.construction_permission_v1(p_user_id,'construction_plans','VIEW') and
 case when exists(select 1 from public.role_permissions p join public.app_users u on u.role=p.role_code where u.id=p_user_id and p.module='construction_items')
 then public.construction_permission_v1(p_user_id,'construction_items','VIEW') and public.construction_permission_v1(p_user_id,'construction_items','UPDATE') and public.construction_project_scope_v1(p_user_id,c.project_id)
 else public.construction_project_legacy_access_v1(p_user_id,c.project_id,true) end);
$$;
create or replace function public.construction_log_legacy_visible_v1(p_user_id uuid,p_log public.site_work_logs)
returns boolean language sql stable security invoker set search_path='' as $$
 select public.has_app_permission_v1(p_user_id,'worklogs','VIEW') and
 (p_log.access_creator_user_id=p_user_id
 or public.construction_project_legacy_access_v1(p_user_id,p_log.project_id,false)
    and (exists(select 1 from public.app_users where id=p_user_id and role='admin')
     or exists(select 1 from public.project_workers where project_id=p_log.project_id and user_id=p_user_id and is_assignee))
 or public.construction_project_legacy_access_v1(p_user_id,p_log.project_id,false)
    and not public.has_app_permission_v1(p_user_id,'worklogs','UPDATE'));
$$;

create or replace function public.construction_log_visible_v1(p_user_id uuid,p_log public.site_work_logs)
returns boolean language sql stable security invoker set search_path='' as $$
 select public.construction_permission_v1(p_user_id,'construction_plans','VIEW')
 and public.construction_permission_v1(p_user_id,'construction_logs','VIEW') and
 (p_log.access_creator_user_id=p_user_id or
  case when exists(select 1 from public.role_permissions p join public.app_users u on u.role=p.role_code where u.id=p_user_id and p.module='construction_logs_all')
  then public.construction_permission_v1(p_user_id,'construction_logs_all','VIEW') and public.construction_project_scope_v1(p_user_id,p_log.project_id)
  else public.construction_log_legacy_visible_v1(p_user_id,p_log) end);
$$;
create function public.construction_log_action_v1(p_user_id uuid,p_log public.site_work_logs,p_action text)
returns boolean language sql stable security invoker set search_path='' as $$
 select public.construction_log_visible_v1(p_user_id,p_log)
 and public.construction_permission_v1(p_user_id,'construction_logs',p_action)
 and (p_action='VIEW' or p_log.access_creator_user_id=p_user_id
  or public.construction_permission_v1(p_user_id,'construction_logs_all',p_action));
$$;
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
  if not found or v_log.construction_plan_id is distinct from p_plan_id then raise exception '日誌與施工規劃不相符。'; end if;
  perform public.erp_private_assert_v1(to_jsonb(v_log));
  if p_action='VIEW' then
   if not public.construction_log_visible_v1(p_user_id,v_log) then raise exception '沒有此施工日誌查看權限。'; end if;
  elsif not public.construction_log_action_v1(p_user_id,v_log,p_action) then
   raise exception '沒有修改或刪除此施工日誌的權限。';
  end if;
 end if;
end $function$;
CREATE OR REPLACE FUNCTION public.construction_scope_without_progress_v1(p_actor_user_id uuid, p_project_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_projects uuid[]; v_plans uuid[]; v_logs uuid[]; v_result jsonb;
begin
 if not public.construction_permission_v1(p_actor_user_id,'construction_plans','VIEW') then
  raise exception '沒有施工規劃查看權限。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 select coalesce(array_agg(p.id),'{}') into v_projects from public.projects p where p.deleted_at is null
 and (p_project_id is null or p.id=p_project_id) and public.erp_private_json_visible_v1(to_jsonb(p))
 and ((p.project_type='construction' and p.construction_category in ('small_purchase','tender')) or exists(select 1 from public.construction_plans where project_id=p.id))
 and (public.construction_project_access_v1(p_actor_user_id,p.id,false)
 or public.construction_permission_v1(p_actor_user_id,'construction_logs','VIEW') and exists(select 1 from public.construction_plans c where c.project_id=p.id
  and (exists(select 1 from public.construction_plan_assignees a where a.construction_plan_id=c.id and a.user_id=p_actor_user_id)
   or exists(select 1 from public.site_work_logs l where l.construction_plan_id=c.id and l.access_creator_user_id=p_actor_user_id))));
 if p_project_id is not null and not(p_project_id=any(v_projects)) then raise exception '找不到施工工作內容或沒有查看權限。'; end if;
 select coalesce(array_agg(c.id),'{}') into v_plans from public.construction_plans c where c.project_id=any(v_projects) and c.deleted_at is null
 and (public.construction_project_access_v1(p_actor_user_id,c.project_id,false)
 or exists(select 1 from public.construction_plan_assignees a where a.construction_plan_id=c.id and a.user_id=p_actor_user_id)
 or exists(select 1 from public.site_work_logs l where l.construction_plan_id=c.id and l.access_creator_user_id=p_actor_user_id));
 select coalesce(array_agg(l.id),'{}') into v_logs from public.site_work_logs l where l.construction_plan_id=any(v_plans) and l.deleted_at is null
 and public.construction_log_visible_v1(p_actor_user_id,l) and public.erp_private_json_visible_v1(to_jsonb(l));
 select jsonb_build_object(
 'construction_plans',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object(
  'assignee_user_ids',coalesce((select jsonb_agg(user_id order by user_id) from public.construction_plan_assignees where construction_plan_id=c.id),'[]'),
  'can_manage',public.construction_plan_write_allowed_v1(p_actor_user_id,c.project_id,'UPDATE'),
  'can_delete',public.construction_plan_write_allowed_v1(p_actor_user_id,c.project_id,'DELETE'),
  'can_create_log',public.construction_permission_v1(p_actor_user_id,'construction_logs','CREATE') and c.status<>'cancelled'
   and exists(select 1 from public.projects where id=c.project_id and project_type='construction' and construction_category in ('small_purchase','tender'))
   and (exists(select 1 from public.construction_plan_assignees where construction_plan_id=c.id and user_id=p_actor_user_id) or public.construction_project_access_v1(p_actor_user_id,c.project_id,true))) order by c.construction_date,c.created_at,c.id) from public.construction_plans c where c.id=any(v_plans)),'[]'),
 'projects',coalesce((select jsonb_agg(to_jsonb(p)||jsonb_build_object('can_create_construction_plan',public.construction_plan_write_allowed_v1(p_actor_user_id,p.id,'CREATE'))) from public.projects p where p.id=any(v_projects)),'[]'),
 'customers',coalesce((select jsonb_agg(to_jsonb(c)) from public.customers c where c.id in(select customer_id from public.projects where id=any(v_projects))),'[]'),
 'site_work_logs',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('can_update_log',public.construction_log_action_v1(p_actor_user_id,l,'UPDATE'),'can_delete_log',public.construction_log_action_v1(p_actor_user_id,l,'DELETE'))) from public.site_work_logs l where l.id=any(v_logs)),'[]'),
 'site_work_log_workers',coalesce((select jsonb_agg(to_jsonb(w)) from public.site_work_log_workers w where w.work_log_id=any(v_logs)),'[]'),
 'project_workers',coalesce((select jsonb_agg(to_jsonb(w)) from public.project_workers w where w.project_id=any(v_projects) and w.is_assignee),'[]'),
 'site_workers',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'display_name',u.display_name,'is_active',u.is_active,'can_work_on_site',u.can_work_on_site)) from public.app_users u where u.is_active
 or u.id in(select access_creator_user_id from public.site_work_logs where id=any(v_logs))),'[]')) into v_result;
 return v_result;
end $function$;

-- Patch only the authorization branch in the original writer; all item,
-- monitoring, locking, versioning, history and audit wrappers remain in place.
do $writer$ declare d text; old text:='if not public.construction_project_access_v1(p_actor_user_id,v_project.id,true)';begin
 d:=pg_get_functiondef('public.save_construction_plan_without_items_v1(uuid,jsonb,boolean)'::regprocedure);
 if position(old in d)=0 then raise exception 'Unexpected construction writer baseline';end if;
 execute replace(d,old,'if not public.construction_plan_write_allowed_v1(p_actor_user_id,v_project.id,case when p_delete then ''DELETE'' when v_old.id is null then ''CREATE'' else ''UPDATE'' end)');
end $writer$;
create or replace function public.set_construction_item_completed_v1(p_actor_user_id uuid,p_item_id uuid,p_row_version integer,p_completed boolean)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare item public.construction_plan_items; plan public.construction_plans; project public.projects; previous jsonb;
begin
 select * into item from public.construction_plan_items where id=p_item_id;
 if not found then raise exception '找不到施工子項目。'; end if;
 -- Same lock order as plan editing and log saves: plan before item.
 select * into plan from public.construction_plans where id=item.construction_plan_id for update;
 select * into project from public.projects where id=plan.project_id for update;
 select * into item from public.construction_plan_items where id=p_item_id for update;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform public.erp_private_assert_v1(to_jsonb(project));
 if plan.deleted_at is not null or plan.status='cancelled' or project.deleted_at is not null or item.deleted_at is not null then raise exception '此施工規劃或子項目已取消或刪除。'; end if;
 if not public.construction_item_access_v1(p_actor_user_id,plan.id) then raise exception '沒有勾選施工子項目完成的權限。'; end if;
 if p_completed is null or item.row_version is distinct from p_row_version then raise exception '子項目已被其他使用者更新，請重新讀取。'; end if;
 previous:=to_jsonb(item);
 update public.construction_plan_items set is_completed=p_completed,completed_at=case when p_completed then now() end,
  completed_by_user_id=case when p_completed then p_actor_user_id end,row_version=row_version+1,updated_at=now() where id=item.id returning * into item;
 update public.construction_plans set status=case
  when not exists(select 1 from public.construction_plan_items where construction_plan_id=plan.id and deleted_at is null and not is_completed) then 'completed'
  when status='completed' or p_completed then 'in_progress' else status end,updated_at=now(),row_version=row_version+1 where id=plan.id;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('construction_plan_items',item.id,'update',previous,to_jsonb(item),'web',(select username from public.app_users where id=p_actor_user_id));
 return to_jsonb(item);
end $$;
create or replace function public.construction_scope_v1(p_actor_user_id uuid,p_project_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare data jsonb; plans jsonb; today date:=(now() at time zone 'Asia/Taipei')::date;
begin
 data:=public.construction_scope_without_progress_v1(p_actor_user_id,p_project_id);
 -- Aggregate only already-authorized plans and non-private rows. Raw worker
 -- notes continue to use the original ownership filter in the base projection.
 with authorized as (select value p from jsonb_array_elements(data->'construction_plans')),
 logs as (
  select l.* from public.site_work_logs l join authorized a on l.construction_plan_id=(a.p->>'id')::uuid
  where l.deleted_at is null and l.work_type='工程施工' and l.status in ('in_progress','completed') and l.log_date<=today and public.erp_private_json_visible_v1(to_jsonb(l))
 ), enriched as (
 select p,coalesce((select jsonb_agg(log_day order by log_day) from (select distinct l.log_date as log_day from logs l where l.construction_plan_id=(p->>'id')::uuid) d),'[]') dates,
  coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object(
   'worked_days',(select count(distinct l.log_date) from logs l where l.construction_item_id=i.id),
   'log_dates',coalesce((select jsonb_agg(log_day order by log_day) from (select distinct l.log_date as log_day from logs l where l.construction_item_id=i.id) d),'[]')) order by i.sort_order,i.id)
   from public.construction_plan_items i where i.construction_plan_id=(p->>'id')::uuid and i.deleted_at is null),'[]') items
 from authorized
 ), measured as (
 select *,jsonb_array_length(dates) days,jsonb_array_length(items) total,
 (select count(*)::int from jsonb_array_elements(items) i where (i->>'is_completed')::boolean) done,
 (select coalesce(jsonb_agg(jsonb_build_object('id',i->>'id','title',i->>'title')),'[]') from jsonb_array_elements(items) i where not (i->>'is_completed')::boolean and (i->>'worked_days')::int=0) unstarted
 from enriched), calculated as (select *,public.construction_completion_totals_v1(items,(p->>'planned_days')::integer,p->>'status') completion from measured)
 select coalesce(jsonb_agg(p||jsonb_build_object(
 'items',items,'worked_days',days,'completed_days',completion->'completed_days','work_dates',dates,'item_count',total,'completed_item_count',done,
 'completion_percent',completion->'completion_percent',
 'progress_percent',completion->'completion_percent',
 'remaining_days',case when (p->>'planned_days')::integer>0 then greatest((p->>'planned_days')::integer-days,0) end,
 'contract_start_date',(select contract_start_date from public.projects where id=(p->>'project_id')::uuid),
 'contract_end_date',(select contract_end_date from public.projects where id=(p->>'project_id')::uuid),
 'contract_remaining_days',(select contract_end_date-today from public.projects where id=(p->>'project_id')::uuid),
 'contract_completed_on',(select completed_on from public.projects where id=(p->>'project_id')::uuid),
 'contract_overdue',(select coalesce(project.contract_end_date<today
   and ((project.status<>'completed' and not exists(select 1 from public.construction_plan_items i join public.construction_plans c on c.id=i.construction_plan_id where c.project_id=project.id and c.deleted_at is null and c.status<>'cancelled' and i.deleted_at is null and public.erp_private_json_visible_v1(to_jsonb(c))))
    or exists(select 1 from public.construction_plan_items i join public.construction_plans c on c.id=i.construction_plan_id where c.project_id=project.id and c.deleted_at is null and c.status<>'cancelled' and i.deleted_at is null and not i.is_completed and public.erp_private_json_visible_v1(to_jsonb(c)))),false) from public.projects project where project.id=(p->>'project_id')::uuid),
 'overrun_days',case when p->>'planned_days' is not null then greatest(days-(p->>'planned_days')::int,0) end,
 'warning_after_days',(p->>'warning_work_days')::integer,
 'progress_alert',alert->'progress_alert','progress_gap',alert->'progress_gap',
 'unstarted_items',unstarted,
 'needs_attention',alert->'progress_alert',
 'can_complete_items',public.construction_item_access_v1(p_actor_user_id,(p->>'id')::uuid)
 ) order by p->>'construction_date',p->>'created_at',p->>'id'),'[]') into plans from calculated cross join lateral(select public.construction_progress_alert_v1(days,total,done,(p->>'warning_work_days')::integer,(p->>'warning_min_progress')::numeric,p->>'status') alert) a;
 return jsonb_set(data,'{construction_plans}',plans);
end $$;
revoke all on function public.construction_permission_v1(uuid,text,text),public.construction_project_scope_v1(uuid,uuid),public.construction_project_legacy_access_v1(uuid,uuid,boolean),public.construction_plan_write_allowed_v1(uuid,uuid,text),public.construction_item_access_v1(uuid,uuid),public.construction_log_legacy_visible_v1(uuid,public.site_work_logs),public.construction_log_action_v1(uuid,public.site_work_logs,text) from public,anon,authenticated;
grant execute on function public.construction_permission_v1(uuid,text,text),public.construction_project_scope_v1(uuid,uuid),public.construction_project_legacy_access_v1(uuid,uuid,boolean),public.construction_plan_write_allowed_v1(uuid,uuid,text),public.construction_item_access_v1(uuid,uuid),public.construction_log_legacy_visible_v1(uuid,public.site_work_logs),public.construction_log_action_v1(uuid,public.site_work_logs,text) to service_role;
notify pgrst,'reload schema';
commit;
