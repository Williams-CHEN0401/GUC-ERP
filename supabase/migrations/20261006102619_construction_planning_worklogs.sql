begin;
set local lock_timeout='5s';

create table public.construction_plans (
 id uuid primary key default gen_random_uuid(),
 project_id uuid not null references public.projects(id) on delete restrict,
 construction_date date not null,
 content text not null check(length(btrim(content)) between 1 and 2000),
 status text not null default 'pending' check(status in ('pending','in_progress','completed','cancelled')),
 notes text not null default '' check(length(notes)<=2000),
 created_by_user_id uuid not null references public.app_users(id) on delete restrict,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 row_version integer not null default 1, deleted_at timestamptz
);
create index construction_plans_project_date_idx on public.construction_plans(project_id,construction_date,id) where deleted_at is null;
create index construction_plans_creator_idx on public.construction_plans(created_by_user_id);
create table public.construction_plan_assignees (
 construction_plan_id uuid not null references public.construction_plans(id) on delete restrict,
 user_id uuid not null references public.app_users(id) on delete restrict,
 primary key(construction_plan_id,user_id)
);
create index construction_plan_assignees_user_idx on public.construction_plan_assignees(user_id,construction_plan_id);
alter table public.site_work_logs add column construction_plan_id uuid references public.construction_plans(id) on delete restrict;
create index site_work_logs_construction_plan_idx on public.site_work_logs(construction_plan_id,log_date,id) where construction_plan_id is not null;
create or replace view public.erp_private_site_work_logs with(security_invoker=true) as
 select r.* from public.site_work_logs r where public.erp_private_json_visible_v1(to_jsonb(r));
alter table public.construction_plans enable row level security;
alter table public.construction_plan_assignees enable row level security;
revoke all on public.construction_plans,public.construction_plan_assignees from public,anon,authenticated;
grant select,insert,update,delete on public.construction_plans,public.construction_plan_assignees to service_role;

-- Use existing project owners and module permissions, never display names.
create function public.construction_project_access_v1(p_user_id uuid,p_project_id uuid,p_manage boolean default false)
returns boolean language sql stable security invoker set search_path='' as $$
 select public.has_app_permission_v1(p_user_id,'projects','VIEW')
 and (not p_manage or public.has_app_permission_v1(p_user_id,'projects','UPDATE'))
 and exists(select 1 from public.app_users u join public.app_roles r on r.code=u.role
 where u.id=p_user_id and u.is_active and
 (u.role='admin' or exists(select 1 from public.project_workers w where w.project_id=p_project_id and w.user_id=u.id and w.is_assignee)
 or not p_manage and (not r.project_scoped or exists(select 1 from public.project_workers w where w.project_id=p_project_id and w.user_id=u.id and w.can_view))));
$$;
create function public.construction_log_visible_v1(p_user_id uuid,p_log public.site_work_logs)
returns boolean language sql stable security invoker set search_path='' as $$
 select public.has_app_permission_v1(p_user_id,'worklogs','VIEW') and
 (p_log.access_creator_user_id=p_user_id
 or public.construction_project_access_v1(p_user_id,p_log.project_id,false)
    and (exists(select 1 from public.app_users where id=p_user_id and role='admin')
     or exists(select 1 from public.project_workers where project_id=p_log.project_id and user_id=p_user_id and is_assignee))
 or public.construction_project_access_v1(p_user_id,p_log.project_id,false)
    and not public.has_app_permission_v1(p_user_id,'worklogs','UPDATE'));
$$;

create function public.assert_construction_log_access_v1(p_user_id uuid,p_plan_id uuid,p_log_id uuid,p_action text)
returns void language plpgsql security invoker set search_path='' as $$
declare v_plan public.construction_plans; v_project public.projects; v_log public.site_work_logs;
begin
 if not public.has_app_permission_v1(p_user_id,'worklogs',p_action) then raise exception '沒有工作日誌操作權限。'; end if;
 -- Serialize reassignment/deletion with log saves; removed workers cannot race a save.
 select * into v_plan from public.construction_plans where id=p_plan_id for update;
 if not found then raise exception '找不到施工規劃。'; end if;
 select * into v_project from public.projects where id=v_plan.project_id for update;
 perform public.erp_private_prepare_v1(p_user_id);
 perform public.erp_private_assert_v1(to_jsonb(v_project));
 if p_log_id is null then
  if p_action<>'CREATE' or v_plan.deleted_at is not null or v_plan.status='cancelled' or v_project.deleted_at is not null
   or v_project.project_type<>'construction' or coalesce(v_project.construction_category,'') not in ('small_purchase','tender')
   or not exists(select 1 from public.construction_plan_assignees where construction_plan_id=p_plan_id and user_id=p_user_id)
  then raise exception '只有目前被指派的施工人員可以新增此規劃日誌。'; end if;
 else
  select * into v_log from public.site_work_logs where id=p_log_id and deleted_at is null for update;
  if not found or v_log.construction_plan_id is distinct from p_plan_id then raise exception '日誌與施工規劃不相符。'; end if;
  perform public.erp_private_assert_v1(to_jsonb(v_log));
  if p_action='VIEW' then
   if not public.construction_log_visible_v1(p_user_id,v_log) then raise exception '沒有此施工日誌查看權限。'; end if;
  elsif v_log.access_creator_user_id is distinct from p_user_id
   and not exists(select 1 from public.app_users where id=p_user_id and is_active and role='admin') then
   raise exception '只能修改或刪除自己建立的施工日誌。';
  end if;
 end if;
end $$;

-- Preserve the original authorization path for every non-plan work log.
alter function public.assert_work_log_access_v1(uuid,uuid,uuid,text) rename to assert_regular_work_log_access_v1;
create function public.assert_work_log_access_v1(p_user_id uuid,p_project_id uuid,p_log_id uuid,p_action text)
returns void language plpgsql security invoker set search_path='' as $$
declare v_plan_id uuid; v_project_id uuid;
begin
 select construction_plan_id into v_plan_id from public.site_work_logs where id=p_log_id;
 v_plan_id:=coalesce(v_plan_id,nullif(current_setting('app.construction_plan_id',true),'')::uuid);
 if v_plan_id is null then
  perform public.assert_regular_work_log_access_v1(p_user_id,p_project_id,p_log_id,p_action); return;
 end if;
 perform public.assert_construction_log_access_v1(p_user_id,v_plan_id,p_log_id,p_action);
 select project_id into v_project_id from public.construction_plans where id=v_plan_id;
 if p_project_id is not null and p_project_id is distinct from v_project_id then raise exception '施工日誌不能移到其他工作內容。'; end if;
end $$;

-- Stamp at INSERT so existing audit and replay results include the relation.
-- Updates through any legacy RPC cannot unlink or move a plan work log.
create function public.preserve_construction_log_v1() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_plan_id uuid; v_project uuid;
begin
 if TG_OP='INSERT' then
  v_plan_id:=nullif(current_setting('app.construction_plan_id',true),'')::uuid;
  if new.construction_plan_id is not null and new.construction_plan_id is distinct from v_plan_id then raise exception '施工規劃關聯必須由受驗證的日誌流程建立。'; end if;
  new.construction_plan_id:=v_plan_id;
 else
  if new.construction_plan_id is distinct from old.construction_plan_id then raise exception '不能變更施工日誌的施工規劃關聯。'; end if;
 end if;
 if new.construction_plan_id is not null then
  select project_id into v_project from public.construction_plans where id=new.construction_plan_id;
  if new.project_id is distinct from v_project or new.work_type is distinct from '工程施工' then raise exception '施工日誌的工作內容或工作類型不相符。'; end if;
 end if;
 return new;
end $$;
create trigger preserve_construction_log before insert or update on public.site_work_logs for each row execute function public.preserve_construction_log_v1();

create function public.save_construction_plan_v1(p_actor_user_id uuid,p_payload jsonb,p_delete boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_id uuid:=(p_payload->>'id')::uuid; v_project public.projects; v_old public.construction_plans;
 v_new public.construction_plans; v_users uuid[]; v_before jsonb; v_after jsonb;
begin
 if v_id is null then raise exception '缺少施工規劃編號。'; end if;
 select * into v_old from public.construction_plans where id=v_id for update;
 if p_delete or p_payload->>'row_version' is not null then
  if v_old.id is null or v_old.deleted_at is not null then raise exception '找不到施工規劃。'; end if;
  if (p_payload->>'row_version')::integer is distinct from v_old.row_version then raise exception '施工規劃已被其他使用者更新，請重新載入。'; end if;
 elsif v_old.id is not null then raise exception '施工規劃已建立，請重新整理，勿重複送出。'; end if;
 select * into v_project from public.projects where id=coalesce(v_old.project_id,(p_payload->>'project_id')::uuid) for update;
 if not found or v_project.deleted_at is not null then raise exception '找不到工作內容。'; end if;
 if not public.construction_project_access_v1(p_actor_user_id,v_project.id,true) then raise exception '只有工作內容負責人或管理員可以管理施工規劃。'; end if;
 if not p_delete and (v_project.project_type<>'construction' or coalesce(v_project.construction_category,'') not in ('small_purchase','tender')) then raise exception '僅工程施工的小額採購或標案可使用施工規劃。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform public.erp_private_assert_v1(to_jsonb(v_project));
 if v_old.id is not null then
  select to_jsonb(v_old)||jsonb_build_object('assignee_user_ids',coalesce(jsonb_agg(user_id),'[]')) into v_before from public.construction_plan_assignees where construction_plan_id=v_id;
 end if;
 if p_delete then
  if exists(select 1 from public.site_work_logs where construction_plan_id=v_id) then raise exception '此施工規劃已有工作日誌，請改為取消，保留歷史關聯。'; end if;
  update public.construction_plans set deleted_at=now(),updated_at=now(),row_version=row_version+1 where id=v_id returning * into v_new;
 else
  if (p_payload->>'project_id')::uuid is distinct from v_project.id then raise exception '不能變更施工規劃的工作內容。'; end if;
  if jsonb_typeof(p_payload->'assignee_user_ids') is distinct from 'array' then raise exception '請選擇有效的施工人員。'; end if;
  select array_agg(value::uuid) into v_users from jsonb_array_elements_text(p_payload->'assignee_user_ids');
  if coalesce(cardinality(v_users),0) not between 1 and 30 or array_position(v_users,null) is not null
   or cardinality(v_users)<>(select count(distinct id) from unnest(v_users) id)
   or exists(select 1 from unnest(v_users) x(id) where not exists(select 1 from public.app_users where id=x.id and is_active)) then raise exception '請選擇 1 至 30 位不重複的啟用中施工人員。'; end if;
  if nullif(btrim(p_payload->>'content'),'') is null or length(p_payload->>'content')>2000 or length(coalesce(p_payload->>'notes',''))>2000
   or coalesce(p_payload->>'status','') not in ('pending','in_progress','completed','cancelled') or nullif(p_payload->>'construction_date','') is null then raise exception '施工日期、內容或狀態不正確。'; end if;
  if v_old.id is null then
   insert into public.construction_plans(id,project_id,construction_date,content,status,notes,created_by_user_id)
   values(v_id,v_project.id,(p_payload->>'construction_date')::date,btrim(p_payload->>'content'),p_payload->>'status',coalesce(p_payload->>'notes',''),p_actor_user_id) returning * into v_new;
  else
   update public.construction_plans set construction_date=(p_payload->>'construction_date')::date,content=btrim(p_payload->>'content'),status=p_payload->>'status',notes=coalesce(p_payload->>'notes',''),updated_at=now(),row_version=row_version+1 where id=v_id returning * into v_new;
  end if;
  delete from public.construction_plan_assignees where construction_plan_id=v_id and not(user_id=any(v_users));
  insert into public.construction_plan_assignees select v_id,id from unnest(v_users) id on conflict do nothing;
 end if;
 select to_jsonb(v_new)||jsonb_build_object('assignee_user_ids',coalesce(jsonb_agg(user_id),'[]')) into v_after from public.construction_plan_assignees where construction_plan_id=v_id;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('construction_plans',v_id,case when p_delete then 'delete' when v_old.id is null then 'insert' else 'update' end,v_before,v_after,'web',(select username from public.app_users where id=p_actor_user_id));
 return v_after;
end $$;

create function public.save_construction_work_log_v1(p_actor_user_id uuid,p_plan_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_plan public.construction_plans; v_project public.projects; v_result jsonb; v_id uuid:=(p_payload->>'id')::uuid;
 v_workers uuid[]; v_old_context text:=current_setting('app.construction_plan_id',true);
begin
 perform public.assert_construction_log_access_v1(p_actor_user_id,p_plan_id,v_id,case when v_id is null then 'CREATE' else 'UPDATE' end);
 select * into v_plan from public.construction_plans where id=p_plan_id;
 select * into v_project from public.projects where id=v_plan.project_id;
 if (p_payload->>'project_id')::uuid is distinct from v_project.id or (p_payload->>'customer_id')::uuid is distinct from v_project.customer_id
  or p_payload->>'project_name' is distinct from v_project.name or p_payload->>'work_type' is distinct from '工程施工'
  or (p_payload->>'department_id')::uuid is distinct from v_project.department_id then raise exception '施工日誌需沿用規劃所屬工作內容、客戶與科室。'; end if;
 select array_agg(value::uuid) into v_workers from jsonb_array_elements_text(p_payload->'worker_user_ids');
 perform set_config('app.construction_plan_id',p_plan_id::text,true);
 v_result:=public.upsert_work_log_sections_v1(v_id,(p_payload->>'row_version')::integer,v_project.id,v_project.customer_id,v_project.name,
  (p_payload->>'log_date')::date,'工程施工',p_payload->>'summary',p_payload->>'time_period',p_payload->>'status',coalesce(v_workers,'{}'),p_actor_user_id,
  coalesce(p_payload->'maintenance_events','[]'),(select username from public.app_users where id=p_actor_user_id),v_project.department_id,
  (p_payload->>'request_id')::uuid,p_payload->>'completed_content',p_payload->>'pending_content');
 if (v_result#>>'{work_log,construction_plan_id}')::uuid is distinct from p_plan_id then raise exception '送出識別碼已用於其他規劃，請重新載入。'; end if;
 perform set_config('app.construction_plan_id',coalesce(v_old_context,''),true);
 return v_result;
end $$;

-- Authoritative read projection: no duplicate tasks and no broad project grant.
create function public.construction_scope_v1(p_actor_user_id uuid,p_project_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_projects uuid[]; v_plans uuid[]; v_logs uuid[]; v_result jsonb;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') and not public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW') then
  raise exception '沒有施工規劃查看權限。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 select coalesce(array_agg(p.id),'{}') into v_projects from public.projects p where p.deleted_at is null
 and (p_project_id is null or p.id=p_project_id) and public.erp_private_json_visible_v1(to_jsonb(p))
 and ((p.project_type='construction' and p.construction_category in ('small_purchase','tender')) or exists(select 1 from public.construction_plans where project_id=p.id))
 and (public.construction_project_access_v1(p_actor_user_id,p.id,false)
 or public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW') and exists(select 1 from public.construction_plans c where c.project_id=p.id
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
  'can_manage',public.construction_project_access_v1(p_actor_user_id,c.project_id,true),
  'can_create_log',public.has_app_permission_v1(p_actor_user_id,'worklogs','CREATE') and c.status<>'cancelled'
   and exists(select 1 from public.projects where id=c.project_id and project_type='construction' and construction_category in ('small_purchase','tender'))
   and exists(select 1 from public.construction_plan_assignees where construction_plan_id=c.id and user_id=p_actor_user_id)) order by c.construction_date,c.created_at,c.id) from public.construction_plans c where c.id=any(v_plans)),'[]'),
 'projects',coalesce((select jsonb_agg(to_jsonb(p)) from public.projects p where p.id=any(v_projects)),'[]'),
 'customers',coalesce((select jsonb_agg(to_jsonb(c)) from public.customers c where c.id in(select customer_id from public.projects where id=any(v_projects))),'[]'),
 'site_work_logs',coalesce((select jsonb_agg(to_jsonb(l)) from public.site_work_logs l where l.id=any(v_logs)),'[]'),
 'site_work_log_workers',coalesce((select jsonb_agg(to_jsonb(w)) from public.site_work_log_workers w where w.work_log_id=any(v_logs)),'[]'),
 'project_workers',coalesce((select jsonb_agg(to_jsonb(w)) from public.project_workers w where w.project_id=any(v_projects) and w.is_assignee),'[]'),
 'site_workers',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'display_name',u.display_name,'is_active',u.is_active)) from public.app_users u where u.is_active
 or u.id in(select access_creator_user_id from public.site_work_logs where id=any(v_logs))),'[]')) into v_result;
 return v_result;
end $$;

-- Extend existing private-data propagation through the actual foreign keys.
do $$ declare d text; begin
 d:=pg_get_functiondef('public.erp_private_scope_v1(uuid)'::regprocedure);
 if position('''construction_details'',''maintenance_details''' in d)=0 then raise exception 'Unexpected private-scope baseline'; end if;
 execute replace(d,'''construction_details'',''maintenance_details''','''construction_plans'',''construction_plan_assignees'',''construction_details'',''maintenance_details''');
end $$;

revoke all on function public.construction_project_access_v1(uuid,uuid,boolean),public.construction_log_visible_v1(uuid,public.site_work_logs),
 public.assert_construction_log_access_v1(uuid,uuid,uuid,text),public.assert_work_log_access_v1(uuid,uuid,uuid,text),
 public.preserve_construction_log_v1(),public.save_construction_plan_v1(uuid,jsonb,boolean),public.save_construction_work_log_v1(uuid,uuid,jsonb),public.construction_scope_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.construction_project_access_v1(uuid,uuid,boolean),public.construction_log_visible_v1(uuid,public.site_work_logs),
 public.assert_construction_log_access_v1(uuid,uuid,uuid,text),public.assert_work_log_access_v1(uuid,uuid,uuid,text),
 public.preserve_construction_log_v1(),public.save_construction_plan_v1(uuid,jsonb,boolean),public.save_construction_work_log_v1(uuid,uuid,jsonb),public.construction_scope_v1(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
