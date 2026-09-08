begin;
set local lock_timeout = '5s';

create table public.app_roles (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  name text not null check (length(btrim(name)) between 1 and 80),
  is_system boolean not null default false,
  project_scoped boolean not null default false,
  row_version integer not null default 1,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.role_permissions (
  role_code text not null references public.app_roles(code) on delete cascade,
  module text not null check (module in ('dashboard','worklogs','purchases','pickups','inventory','customers','projects','suppliers','repairs','reports','backup','settings','site','phone','monitoring','equipment','history','credentials','monitoring_import','users','audit')),
  can_view boolean not null default false,
  can_create boolean not null default false,
  can_update boolean not null default false,
  can_delete boolean not null default false,
  primary key(role_code,module),
  check (can_view or not (can_create or can_update or can_delete))
);
insert into public.app_roles(code,name,is_system,project_scoped) values
 ('admin','管理員',true,false),('operator','操作員',true,false),('viewer','檢視者',true,false),('worker','施工人員',true,true);
insert into public.role_permissions(role_code,module,can_view,can_create,can_update,can_delete)
select r.code,m.module,r.code='admin' or m.module not in ('credentials','monitoring_import','users','audit'),
 r.code='admin' or r.code='operator' and m.module in ('worklogs','purchases','pickups','projects','repairs','site','phone','monitoring','equipment','history'),
 r.code='admin' or r.code='operator' and m.module in ('worklogs','purchases','pickups','projects','repairs','site','phone','monitoring','equipment','history'),
 r.code='admin' or r.code='operator' and m.module in ('projects')
from public.app_roles r cross join unnest(array['dashboard','worklogs','purchases','pickups','inventory','customers','projects','suppliers','repairs','reports','backup','settings','site','phone','monitoring','equipment','history','credentials','monitoring_import','users','audit']) m(module)
where r.code in ('admin','operator','viewer');
insert into public.role_permissions values ('worker','worklogs',true,true,true,true);
alter table public.app_users drop constraint app_users_role_check;
alter table public.app_users add constraint app_users_role_fkey foreign key(role) references public.app_roles(code);

alter table public.project_workers
 add column is_assignee boolean not null default true,
 add column can_view boolean not null default false,
 add column can_create_work_log boolean not null default false,
 add column can_update_work_log boolean not null default false,
 add column can_delete_work_log boolean not null default false,
 add column granted_by uuid references public.app_users(id),
 add column granted_at timestamptz,
 add constraint project_workers_access_check check (can_view or not (can_create_work_log or can_update_work_log or can_delete_work_log));
create index project_workers_access_user_idx on public.project_workers(user_id,project_id) where can_view;

alter table public.app_roles enable row level security;
alter table public.role_permissions enable row level security;
revoke all on public.app_roles,public.role_permissions from public,anon,authenticated;
grant all on public.app_roles,public.role_permissions to service_role;

create function public.has_app_permission_v1(p_user_id uuid,p_module text,p_action text)
returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.app_users u join public.app_roles r on r.code=u.role
 left join public.role_permissions p on p.role_code=r.code and p.module=p_module
 where u.id=p_user_id and u.is_active and (u.role='admin' or
 case p_action when 'VIEW' then p.can_view when 'CREATE' then p.can_create when 'UPDATE' then p.can_update when 'DELETE' then p.can_delete else false end));
$$;

create function public.has_project_permission_v1(p_user_id uuid,p_project_id uuid,p_action text)
returns boolean language sql stable security invoker set search_path='' as $$
 select public.has_app_permission_v1(p_user_id,'worklogs',p_action) and exists(
 select 1 from public.app_users u join public.app_roles r on r.code=u.role
 where u.id=p_user_id and u.is_active and (not r.project_scoped or exists(
 select 1 from public.project_workers w where w.user_id=u.id and w.project_id=p_project_id and w.can_view and
 case p_action when 'VIEW' then true when 'CREATE' then w.can_create_work_log when 'UPDATE' then w.can_update_work_log when 'DELETE' then w.can_delete_work_log else false end)));
$$;

create function public.assert_work_log_access_v1(p_user_id uuid,p_project_id uuid,p_log_id uuid,p_action text)
returns void language plpgsql security invoker set search_path='' as $$
declare v_project uuid;
begin
 if not public.has_app_permission_v1(p_user_id,'worklogs',p_action) then raise exception '您的帳號沒有執行此操作的權限。'; end if;
 if p_log_id is not null then
  select project_id into v_project from public.site_work_logs where id=p_log_id and deleted_at is null for update;
  if not found or not public.has_project_permission_v1(p_user_id,v_project,p_action) then raise exception '您的帳號沒有執行此專案操作的權限。'; end if;
 end if;
 if p_action<>'DELETE' and not public.has_project_permission_v1(p_user_id,p_project_id,p_action) then raise exception '您的帳號沒有執行此專案操作的權限。'; end if;
 -- Keep a revoked grant from racing a write in this transaction.
 perform 1 from public.project_workers where user_id=p_user_id and project_id in (p_project_id,v_project) for share;
end;
$$;

create function public.save_app_role_v1(p_actor_user_id uuid,p_code text,p_name text,p_project_scoped boolean,p_row_version integer,p_permissions jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_before jsonb; v_after jsonb; v_row public.app_roles; v_perm jsonb;
begin
 if not exists(select 1 from public.app_users where id=p_actor_user_id and is_active and role='admin') then raise exception '您的帳號沒有執行此操作的權限。'; end if;
 if p_code='admin' then raise exception '管理員權限固定，不可修改。'; end if;
 if p_permissions is null or jsonb_typeof(p_permissions)<>'array' or jsonb_array_length(p_permissions)>19 then raise exception '角色權限格式不正確。'; end if;
 select * into v_row from public.app_roles where code=p_code for update;
 if found then
  if p_row_version is null or v_row.row_version<>p_row_version then raise exception '角色已被其他使用者修改，請重新載入。'; end if;
  if v_row.is_system and p_project_scoped is distinct from v_row.project_scoped then raise exception '系統角色的專案範圍模式不可修改。'; end if;
  select to_jsonb(v_row)||jsonb_build_object('permissions',coalesce(jsonb_agg(to_jsonb(p)),'[]')) into v_before from public.role_permissions p where role_code=p_code;
  update public.app_roles set name=p_name,project_scoped=p_project_scoped,row_version=row_version+1,updated_at=now() where code=p_code;
 else
  if p_row_version is not null then raise exception '找不到角色。'; end if;
  insert into public.app_roles(code,name,project_scoped,created_by) values(p_code,p_name,p_project_scoped,p_actor_user_id);
 end if;
 delete from public.role_permissions where role_code=p_code;
 for v_perm in select value from jsonb_array_elements(p_permissions) loop
  insert into public.role_permissions values(p_code,v_perm->>'module',coalesce((v_perm->>'can_view')::boolean,false),coalesce((v_perm->>'can_create')::boolean,false),coalesce((v_perm->>'can_update')::boolean,false),coalesce((v_perm->>'can_delete')::boolean,false));
 end loop;
 select to_jsonb(r)||jsonb_build_object('permissions',(select coalesce(jsonb_agg(to_jsonb(p)),'[]') from public.role_permissions p where p.role_code=p_code)) into v_after from public.app_roles r where r.code=p_code;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor) values('app_roles',p_actor_user_id,case when v_before is null then 'insert' else 'update' end,v_before,v_after,'web',(select username from public.app_users where id=p_actor_user_id));
 return v_after;
end;
$$;

create function public.save_user_project_access_v1(p_actor_user_id uuid,p_user_id uuid,p_row_version integer,p_grants jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_before jsonb; v_after jsonb; v_user public.app_users; v_grant jsonb;
begin
 if not exists(select 1 from public.app_users where id=p_actor_user_id and is_active and role='admin') then raise exception '您的帳號沒有執行此操作的權限。'; end if;
 select * into v_user from public.app_users where id=p_user_id for update;
 if not found then raise exception '找不到使用者。'; end if;
 if p_row_version is null or v_user.row_version<>p_row_version then raise exception '使用者授權已被其他使用者修改，請重新載入。'; end if;
 if p_grants is null or jsonb_typeof(p_grants)<>'array' or jsonb_array_length(p_grants)>2000 then raise exception '專案授權格式不正確。'; end if;
 if (select count(*) from jsonb_array_elements(p_grants))<>(select count(distinct value->>'project_id') from jsonb_array_elements(p_grants)) then raise exception '專案授權重複。'; end if;
 select coalesce(jsonb_agg(to_jsonb(w)),'[]') into v_before from public.project_workers w where user_id=p_user_id and can_view;
 update public.project_workers set can_view=false,can_create_work_log=false,can_update_work_log=false,can_delete_work_log=false,granted_by=p_actor_user_id,granted_at=now() where user_id=p_user_id;
 for v_grant in select value from jsonb_array_elements(p_grants) loop
  insert into public.project_workers(project_id,user_id,is_assignee,can_view,can_create_work_log,can_update_work_log,can_delete_work_log,granted_by,granted_at)
  values((v_grant->>'project_id')::uuid,p_user_id,false,true,coalesce((v_grant->>'can_create_work_log')::boolean,false),coalesce((v_grant->>'can_update_work_log')::boolean,false),coalesce((v_grant->>'can_delete_work_log')::boolean,false),p_actor_user_id,now())
  on conflict(project_id,user_id) do update set can_view=true,can_create_work_log=excluded.can_create_work_log,can_update_work_log=excluded.can_update_work_log,can_delete_work_log=excluded.can_delete_work_log,granted_by=excluded.granted_by,granted_at=excluded.granted_at;
 end loop;
 delete from public.project_workers where user_id=p_user_id and not is_assignee and not can_view;
 update public.app_users set updated_at=now() where id=p_user_id;
 select coalesce(jsonb_agg(to_jsonb(w)),'[]') into v_after from public.project_workers w where user_id=p_user_id and can_view;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor) values('project_access',p_user_id,'update',jsonb_build_object('user_id',p_user_id,'grants',v_before),jsonb_build_object('user_id',p_user_id,'grants',v_after),'web',(select username from public.app_users where id=p_actor_user_id));
 return jsonb_build_object('grants',v_after,'user_id',p_user_id);
end;
$$;

-- All new functions are internal Gateway RPCs. Client JWTs cannot choose an actor.
revoke all on function public.has_app_permission_v1(uuid,text,text), public.has_project_permission_v1(uuid,uuid,text),public.assert_work_log_access_v1(uuid,uuid,uuid,text), public.save_app_role_v1(uuid,text,text,boolean,integer,jsonb),public.save_user_project_access_v1(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.has_app_permission_v1(uuid,text,text),public.has_project_permission_v1(uuid,uuid,text),public.assert_work_log_access_v1(uuid,uuid,uuid,text),public.save_app_role_v1(uuid,text,text,boolean,integer,jsonb),public.save_user_project_access_v1(uuid,uuid,integer,jsonb) to service_role;
CREATE OR REPLACE FUNCTION public.soft_delete_site_work_log_v1(p_id uuid, p_row_version integer, p_reason text, p_actor_user_id uuid, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_before public.site_work_logs; v_log public.site_work_logs;
begin
  perform public.assert_work_log_access_v1(p_actor_user_id,null,p_id,'DELETE');
  if p_id is null or p_row_version is null or p_row_version < 1 or char_length(btrim(coalesce(p_reason,'管理員刪除'))) > 500 then
    raise exception '工作日誌資料、版本或刪除原因不正確。';
  end if;
  select * into v_before from public.site_work_logs where id=p_id and deleted_at is null for update;
  if not found then raise exception '找不到工作日誌。'; end if;
  if v_before.row_version<>p_row_version then raise exception '工作日誌已被其他使用者更新，請重新載入。'; end if;
  update public.site_work_logs
  set deleted_at=now(),deleted_by=p_actor_user_id,delete_reason=nullif(btrim(coalesce(p_reason,'管理員刪除')),''),updated_by=p_actor
  where id=p_id and row_version=p_row_version returning * into v_log;
  if not found then raise exception '工作日誌已被其他使用者更新，請重新載入。'; end if;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
  values('site_work_logs',v_log.id,'update',to_jsonb(v_before),to_jsonb(v_log)||jsonb_build_object('maintenance_action','soft_delete'),'web',p_actor);
  return to_jsonb(v_log);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_customer_project_work_log_v2(p_id uuid, p_row_version integer, p_project_id uuid, p_customer_id uuid, p_project_name text, p_log_date date, p_work_type text, p_summary text, p_worker_user_ids uuid[], p_reporter_user_id uuid, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_project public.projects;
  v_existing public.site_work_logs;
begin
  perform public.assert_work_log_access_v1(p_reporter_user_id,p_project_id,p_id,case when p_id is null then 'CREATE' else 'UPDATE' end);
  if p_customer_id is null or nullif(btrim(p_project_name), '') is null then
    raise exception '請選擇客戶並輸入專案／日誌標題。';
  end if;
  if char_length(btrim(p_project_name)) > 120 then
    raise exception '專案／日誌標題不可超過 120 個字。';
  end if;

  if p_id is not null then
    select * into v_existing from public.site_work_logs where id = p_id;
    if not found then raise exception '找不到工作日誌。'; end if;
    select * into v_project from public.projects where id = v_existing.project_id;
    if not found or v_project.customer_id <> p_customer_id then
      raise exception '工作日誌的客戶與原專案不相符。';
    end if;
  elsif p_project_id is not null then
    select * into v_project
    from public.projects
    where id = p_project_id and customer_id = p_customer_id;
    if not found then raise exception '所選專案不屬於此客戶。'; end if;
  else
    select * into v_project
    from public.projects
    where customer_id = p_customer_id
      and lower(btrim(name)) = lower(btrim(p_project_name))
    limit 1;
    if not found then
      select * into v_project
      from public.create_project_auto_number_v1(
        btrim(p_project_name), p_customer_id,
        case when p_work_type = '工程施工' then 'construction' else 'maintenance' end,
        'in_progress', null, '由工作日誌自動建立', null, null, p_actor
      );
    end if;
  end if;

  return public.upsert_project_site_work_log_v1(
    v_project.id, p_id, p_row_version, p_log_date, v_project.name,
    p_summary, p_work_type, p_worker_user_ids, p_reporter_user_id, p_actor
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_customer_project_work_log_v3(p_id uuid, p_row_version integer, p_project_id uuid, p_customer_id uuid, p_project_name text, p_log_date date, p_work_type text, p_summary text, p_time_period text, p_status text, p_worker_user_ids uuid[], p_reporter_user_id uuid, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_project public.projects;
  v_existing public.site_work_logs;
begin
  perform public.assert_work_log_access_v1(p_reporter_user_id,p_project_id,p_id,case when p_id is null then 'CREATE' else 'UPDATE' end);
  if p_customer_id is null or nullif(btrim(p_project_name), '') is null then
    raise exception '請選擇客戶並輸入專案／日誌標題。';
  end if;
  if char_length(btrim(p_project_name)) > 120 then
    raise exception '專案／日誌標題不可超過 120 個字。';
  end if;
  if p_status not in ('in_progress', 'completed') then
    raise exception '工作日誌狀態不正確。';
  end if;

  if p_id is not null then
    select * into v_existing from public.site_work_logs where id = p_id;
    if not found then raise exception '找不到工作日誌。'; end if;
    select * into v_project from public.projects where id = v_existing.project_id;
    if not found or v_project.customer_id <> p_customer_id then
      raise exception '工作日誌的客戶與原專案不相符。';
    end if;
  elsif p_project_id is not null then
    select * into v_project
    from public.projects
    where id = p_project_id and customer_id = p_customer_id;
    if not found then raise exception '所選專案不屬於此客戶。'; end if;
  else
    select * into v_project
    from public.projects
    where customer_id = p_customer_id
      and lower(btrim(name)) = lower(btrim(p_project_name))
    limit 1;
    if not found then
      select * into v_project
      from public.create_project_auto_number_v1(
        btrim(p_project_name), p_customer_id,
        case when p_work_type = '工程施工' then 'construction' else 'maintenance' end,
        p_status, null, '由工作日誌自動建立', null, null, p_actor
      );
    end if;
  end if;

  return public.upsert_project_site_work_log_v2(
    v_project.id, p_id, p_row_version, p_log_date, v_project.name,
    p_summary, p_work_type, p_time_period, p_status, p_worker_user_ids,
    p_reporter_user_id, p_actor
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_customer_project_work_log_with_maintenance_v1(p_id uuid, p_row_version integer, p_project_id uuid, p_customer_id uuid, p_project_name text, p_log_date date, p_work_type text, p_summary text, p_time_period text, p_status text, p_worker_user_ids uuid[], p_reporter_user_id uuid, p_maintenance_events jsonb, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_work_log_id uuid;
  v_event_json jsonb;
  v_event public.maintenance_events;
  v_before public.maintenance_events;
  v_event_id uuid;
  v_event_type text;
  v_service_id uuid;
  v_occurred_at date;
  v_description text;
  v_cause text;
  v_event_result text;
  v_notes text;
  v_equipment_ids uuid[];
  v_worker_ids uuid[];
  v_event_ids uuid[] := '{}'::uuid[];
  v_before_equipment_ids uuid[];
  v_before_worker_ids uuid[];
  v_equipment_count integer;
  v_worker_count integer;
  v_version integer;
  v_category_id uuid;
  v_inventory_item_id uuid;
  v_repair public.repair_items;
  v_repair_ids uuid[] := '{}'::uuid[];
  v_register_repair boolean;
begin
  perform public.assert_work_log_access_v1(p_reporter_user_id,p_project_id,p_id,case when p_id is null then 'CREATE' else 'UPDATE' end);
  if p_maintenance_events is null or jsonb_typeof(p_maintenance_events) <> 'array' or jsonb_array_length(p_maintenance_events) > 20 then
    raise exception '設備維修事件必須是 0 至 20 筆的陣列。';
  end if;

  v_result := public.upsert_customer_project_work_log_v3(
    p_id,p_row_version,p_project_id,p_customer_id,p_project_name,p_log_date,p_work_type,p_summary,
    p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,p_actor
  );
  v_work_log_id := (v_result->'work_log'->>'id')::uuid;

  for v_event_json in select value from jsonb_array_elements(p_maintenance_events)
  loop
    if jsonb_typeof(v_event_json) <> 'object' then raise exception '設備維修事件格式不正確。'; end if;
    v_event_id := nullif(v_event_json->>'id','')::uuid;
    v_version := nullif(v_event_json->>'row_version','')::integer;
    v_event_type := upper(btrim(coalesce(v_event_json->>'event_type','')));
    v_service_id := nullif(v_event_json->>'service_id','')::uuid;
    v_occurred_at := coalesce(nullif(v_event_json->>'occurred_at','')::date,p_log_date);
    v_description := btrim(coalesce(v_event_json->>'description',''));
    v_cause := nullif(btrim(coalesce(v_event_json->>'cause','')),'');
    v_event_result := btrim(coalesce(v_event_json->>'result',''));
    v_category_id := nullif(v_event_json->>'inventory_category_id','')::uuid;
    v_inventory_item_id := nullif(v_event_json->>'inventory_item_id','')::uuid;
    v_register_repair := false;
    v_notes := nullif(btrim(coalesce(v_event_json->>'notes','')),'');

    if v_event_type not in ('SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','REPAIR','REPLACEMENT','INSTALLATION','MAINTENANCE','PROGRAM_CONFIG','INSPECTION','OTHER')
      or v_service_id is null or v_occurred_at is null
      or char_length(v_description) not between 1 and 4000
      or char_length(v_event_result) not between 1 and 2000
      or char_length(coalesce(v_cause,'')) > 2000 or char_length(coalesce(v_notes,'')) > 2000 then
      raise exception '設備維修事件內容、日期、類型或處理結果不完整。';
    end if;

    perform 1 from public.customer_contract_services
    where customer_id = p_customer_id and service_type_id = v_service_id;
    if not found then raise exception '維修事件所選承攬內容不屬於此客戶。'; end if;

    select coalesce(array_agg(distinct equipment_id order by equipment_id),'{}'::uuid[])
    into v_equipment_ids
    from (
      select value::uuid as equipment_id
      from jsonb_array_elements_text(coalesce(v_event_json->'equipment_ids','[]'::jsonb))
    ) equipment;
    if cardinality(v_equipment_ids) > 100 then
      raise exception '每筆設備維修事件最多可選擇 100 台設備。';
    end if;
    select count(*) into v_equipment_count from public.equipment_registry registry
    where registry.id = any(v_equipment_ids) and registry.customer_id = p_customer_id
      and registry.service_id = v_service_id and registry.status = 'active';
    if v_equipment_count <> cardinality(v_equipment_ids) then
      raise exception '部分設備不屬於所選客戶／承攬內容，或設備已停用。';
    end if;

    select coalesce(array_agg(distinct worker_id order by worker_id),'{}'::uuid[])
    into v_worker_ids
    from (
      select value::uuid as worker_id
      from jsonb_array_elements_text(coalesce(v_event_json->'worker_user_ids','[]'::jsonb))
    ) workers;
    if cardinality(v_worker_ids) = 0 then v_worker_ids := coalesce(p_worker_user_ids,'{}'::uuid[]); end if;
    if cardinality(v_worker_ids) > 30 then raise exception '每筆維修事件最多可選擇 30 位處理人員。'; end if;
    select count(*) into v_worker_count from public.app_users users
    where users.id = any(v_worker_ids) and users.is_active = true;
    if v_worker_count <> cardinality(v_worker_ids) then raise exception '部分維修處理人員不存在或已停用。'; end if;

    -- Omitted keys from older clients preserve a previously registered source selection.
    if v_event_id is not null then
      select * into v_before from public.maintenance_events
      where id=v_event_id and work_log_id=v_work_log_id for update;
      if not found then raise exception '找不到此工作日誌的維修事件。'; end if;
      if not (v_event_json ? 'inventory_category_id') then v_category_id := v_before.inventory_category_id; end if;
      if not (v_event_json ? 'inventory_item_id') then v_inventory_item_id := v_before.inventory_item_id; end if;
      if v_before.inventory_item_id is not null and
        (v_inventory_item_id is distinct from v_before.inventory_item_id or v_category_id is distinct from v_before.inventory_category_id) then
        raise exception '此明細已登錄維修品，品項請至維修品管理修改。';
      end if;
    end if;
    -- Deprecated types may only be retained on their original, locked event.
    if v_event_type not in ('SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','REPAIR','REPLACEMENT')
      and (v_event_id is null or v_event_type is distinct from v_before.event_type) then
      raise exception '請選擇新的五種事件類型；舊分類僅可保留原紀錄。';
    end if;
    -- Only equipment repair/replacement may register a new repair item.
    -- Preserve previously registered associations when editing historical events.
    if v_event_type not in ('REPAIR','REPLACEMENT')
      and (v_event_id is null or v_before.inventory_item_id is null) then
      v_category_id := null;
      v_inventory_item_id := null;
    end if;
    if v_category_id is not null and not exists (
      select 1 from public.product_categories where id=v_category_id
        and (is_active or (v_event_id is not null and v_before.inventory_category_id=v_category_id))
    ) then raise exception '請選擇有效的設備種類。'; end if;
    if v_inventory_item_id is not null then
      v_register_repair := v_event_type in ('REPAIR','REPLACEMENT') and (v_event_id is null or v_before.inventory_item_id is null);
      if v_register_repair and (v_category_id is null or not exists (
        select 1 from public.inventory_items where id=v_inventory_item_id and category_id=v_category_id
      )) then raise exception '設備品項不屬於所選設備種類。'; end if;
    end if;

    if v_event_id is null then
      insert into public.maintenance_events(work_log_id,service_id,event_type,occurred_at,description,cause,result,notes,created_by,updated_by,inventory_category_id,inventory_item_id)
      values(v_work_log_id,v_service_id,v_event_type,v_occurred_at,v_description,v_cause,v_event_result,v_notes,p_reporter_user_id,p_reporter_user_id,v_category_id,v_inventory_item_id)
      returning * into v_event;
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_events',v_event.id,'insert',null,to_jsonb(v_event),'web',p_actor);
    else
      if v_event_id = any(v_event_ids) then raise exception '維修事件資料重複。'; end if;
      select * into v_before from public.maintenance_events where id = v_event_id and work_log_id = v_work_log_id for update;
      if not found then raise exception '找不到此工作日誌的維修事件。'; end if;
      if v_before.status = 'voided' then raise exception '已作廢的維修事件不可修改。'; end if;
      if v_version is null or v_before.row_version <> v_version then raise exception '維修事件已被其他使用者更新，請重新載入。'; end if;
      select coalesce(array_agg(equipment_id order by equipment_id),'{}'::uuid[]) into v_before_equipment_ids
      from public.maintenance_event_equipment where event_id = v_event_id;
      select coalesce(array_agg(user_id order by user_id),'{}'::uuid[]) into v_before_worker_ids
      from public.maintenance_event_workers where event_id = v_event_id;
      update public.maintenance_events
      set service_id=v_service_id,event_type=v_event_type,occurred_at=v_occurred_at,description=v_description,
          cause=v_cause,result=v_event_result,notes=v_notes,inventory_category_id=v_category_id,inventory_item_id=v_inventory_item_id,updated_by=p_reporter_user_id,updated_at=now()
      where id=v_event_id and row_version=v_version returning * into v_event;
      if not found then raise exception '維修事件已被其他使用者更新，請重新載入。'; end if;
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_events',v_event.id,'update',to_jsonb(v_before),to_jsonb(v_event),'web',p_actor);
      if v_before.result is distinct from v_event.result then
        insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
        values('maintenance_event_result',v_event.id,'update',jsonb_build_object('result',v_before.result),jsonb_build_object('result',v_event.result),'web',p_actor);
      end if;
      delete from public.maintenance_event_equipment where event_id = v_event.id;
      delete from public.maintenance_event_workers where event_id = v_event.id;
      if v_before_equipment_ids is distinct from v_equipment_ids then
        insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
        values('maintenance_event_equipment',v_event.id,'update',jsonb_build_object('work_log_id',v_work_log_id,'equipment_ids',v_before_equipment_ids),jsonb_build_object('work_log_id',v_work_log_id,'equipment_ids',v_equipment_ids),'web',p_actor);
      end if;
    end if;

    insert into public.maintenance_event_equipment(event_id,equipment_id)
    select v_event.id,equipment_id from unnest(v_equipment_ids) equipment(equipment_id);
    insert into public.maintenance_event_workers(event_id,user_id)
    select v_event.id,worker_id from unnest(v_worker_ids) workers(worker_id);
    if v_event_id is null then
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_event_equipment',v_event.id,'insert',null,jsonb_build_object('work_log_id',v_work_log_id,'equipment_ids',v_equipment_ids),'web',p_actor);
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_event_workers',v_event.id,'insert',null,jsonb_build_object('work_log_id',v_work_log_id,'user_ids',v_worker_ids),'web',p_actor);
    elsif v_before_worker_ids is distinct from v_worker_ids then
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_event_workers',v_event.id,'update',jsonb_build_object('work_log_id',v_work_log_id,'user_ids',v_before_worker_ids),jsonb_build_object('work_log_id',v_work_log_id,'user_ids',v_worker_ids),'web',p_actor);
    end if;
    if v_register_repair then
      insert into public.repair_items(
        customer_id,inventory_item_id,notes,received_on,quantity,status,issue_description,
        source_maintenance_event_id,source,updated_by
      ) values(
        p_customer_id,v_inventory_item_id,v_notes,null,null,null,v_cause,
        v_event.id,'work_log',p_actor
      ) returning * into v_repair;
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('repair_items',v_repair.id,'CREATE_REPAIR_ITEM',null,to_jsonb(v_repair),'work_log',p_actor);
      v_repair_ids := array_append(v_repair_ids,v_repair.id);
    end if;
    v_event_ids := array_append(v_event_ids,v_event.id);
  end loop;

  return v_result || jsonb_build_object(
    'maintenance_event_ids',to_jsonb(v_event_ids),
    'maintenance_event_count',cardinality(v_event_ids),
    'created_repair_item_ids',to_jsonb(v_repair_ids)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_customer_project_work_log_with_maintenance_v2(p_id uuid, p_row_version integer, p_project_id uuid, p_customer_id uuid, p_project_name text, p_log_date date, p_work_type text, p_summary text, p_time_period text, p_status text, p_worker_user_ids uuid[], p_reporter_user_id uuid, p_maintenance_events jsonb, p_actor text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_payload jsonb;
  v_previous public.work_log_save_requests;
  v_result jsonb;
begin
  perform public.assert_work_log_access_v1(p_reporter_user_id,p_project_id,p_id,case when p_id is null then 'CREATE' else 'UPDATE' end);
  if p_request_id is null or p_reporter_user_id is null then raise exception '缺少工作日誌送出識別碼。'; end if;
  v_payload := jsonb_build_object(
    'id',p_id,'row_version',p_row_version,'project_id',p_project_id,'customer_id',p_customer_id,
    'project_name',p_project_name,'log_date',p_log_date,'work_type',p_work_type,'summary',p_summary,
    'time_period',p_time_period,'status',p_status,'worker_user_ids',p_worker_user_ids,
    'maintenance_events',p_maintenance_events,'actor',p_actor
  );
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,0));
  select * into v_previous from public.work_log_save_requests where request_id=p_request_id;
  if found then
    if v_previous.reporter_id <> p_reporter_user_id or v_previous.request_payload <> v_payload then
      raise exception '此送出識別碼已使用，請重新載入日誌確認後再修改，避免重複建立。';
    end if;
    return v_previous.result;
  end if;
  v_result := public.upsert_customer_project_work_log_with_maintenance_v1(
    p_id,p_row_version,p_project_id,p_customer_id,p_project_name,p_log_date,p_work_type,p_summary,
    p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,p_maintenance_events,p_actor
  );
  insert into public.work_log_save_requests(request_id,reporter_id,request_payload,result)
  values(p_request_id,p_reporter_user_id,v_payload,v_result);
  return v_result;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_erp_project_with_workers_v2(p_id uuid, p_row_version integer, p_name text, p_customer_id uuid, p_project_type text, p_status text, p_description text, p_estimated_cost numeric, p_note text, p_worker_user_ids uuid[], p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_existing public.projects;
  v_project public.projects;
  v_worker_ids uuid[];
  v_worker_count integer;
  v_assigned_to text;
  v_work_type text;
begin
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 120 then
    raise exception '專案名稱必須為 1 至 120 個字。';
  end if;
  if p_customer_id is null or not exists(select 1 from public.customers where id = p_customer_id) then
    raise exception '找不到指定客戶。';
  end if;
  if p_project_type not in ('construction', 'repair', 'maintenance') then
    raise exception '專案類型不正確。';
  end if;
  if p_status not in ('in_progress', 'completed') then
    raise exception '專案狀態不正確。';
  end if;
  if char_length(coalesce(p_description, '')) > 2000 or char_length(coalesce(p_note, '')) > 1000 then
    raise exception '專案說明或備註超過長度限制。';
  end if;
  if p_estimated_cost is not null and p_estimated_cost < 0 then
    raise exception '預估成本不可小於 0。';
  end if;

  select coalesce(array_agg(distinct worker_id order by worker_id), '{}'::uuid[])
  into v_worker_ids
  from unnest(coalesce(p_worker_user_ids, '{}'::uuid[])) as workers(worker_id)
  where worker_id is not null;

  if cardinality(v_worker_ids) > 30 then
    raise exception '每個專案最多可選擇 30 位負責人。';
  end if;

  if cardinality(v_worker_ids) > 0 then
    select count(*)
    into v_worker_count
    from public.app_users users
    where users.id = any(v_worker_ids)
      and (
        users.is_active = true
        or (
          p_id is not null
          and exists (
            select 1
            from public.project_workers existing_workers
            where existing_workers.project_id = p_id
              and existing_workers.user_id = users.id
          )
        )
      );
    if v_worker_count <> cardinality(v_worker_ids) then
      raise exception '部分專案負責人不存在或已停用，請重新選擇。';
    end if;
  end if;

  select string_agg(users.display_name, '、' order by users.display_name)
  into v_assigned_to
  from public.app_users users
  where users.id = any(v_worker_ids);

  if p_id is null then
    select * into v_project
    from public.create_project_auto_number_v1(
      btrim(p_name), p_customer_id, p_project_type, p_status,
      v_assigned_to, nullif(btrim(coalesce(p_description, '')), ''),
      p_estimated_cost, nullif(btrim(coalesce(p_note, '')), ''), p_actor
    );
  else
    if p_row_version is null or p_row_version < 1 then
      raise exception '專案版本不正確，請重新整理後再修改。';
    end if;
    select * into v_existing from public.projects where id = p_id for update;
    if not found then raise exception '找不到專案。'; end if;
    if v_existing.row_version <> p_row_version then
      raise exception '專案資料已被其他使用者更新，請重新載入後再修改。';
    end if;
    update public.projects
    set name = btrim(p_name),
        customer_id = p_customer_id,
        project_type = p_project_type,
        status = p_status,
        assigned_to = nullif(v_assigned_to, ''),
        description = nullif(btrim(coalesce(p_description, '')), ''),
        estimated_cost = p_estimated_cost,
        note = nullif(btrim(coalesce(p_note, '')), ''),
        source = 'web',
        updated_by = nullif(btrim(coalesce(p_actor, '')), '')
    where id = p_id and row_version = p_row_version
    returning * into v_project;
    if not found then
      raise exception '專案資料已被其他使用者更新，請重新載入後再修改。';
    end if;
  end if;

  update public.project_workers set is_assignee=false where project_id=v_project.id;
  insert into public.project_workers(project_id, user_id)
  select v_project.id, worker_id from unnest(v_worker_ids) as workers(worker_id) on conflict(project_id,user_id) do update set is_assignee=true;
  delete from public.project_workers where project_id=v_project.id and not is_assignee and not can_view;

  v_work_type := case p_project_type
    when 'construction' then '工程施工'
    when 'repair' then '維修紀錄'
    else '維護保養'
  end;

  update public.site_work_logs
  set work_type = v_work_type,
      status = p_status,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where project_id = v_project.id
    and (
      work_type is distinct from v_work_type
      or status is distinct from p_status
    );

  return jsonb_build_object(
    'project', to_jsonb(v_project),
    'worker_user_ids', to_jsonb(v_worker_ids),
    'work_log_type', v_work_type,
    'work_log_status', p_status
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_project_site_work_log_v1(p_project_id uuid, p_id uuid, p_row_version integer, p_log_date date, p_title text, p_summary text, p_work_type text, p_worker_user_ids uuid[], p_reporter_user_id uuid, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_site public.sites;
  v_existing public.site_work_logs;
  v_log public.site_work_logs;
  v_worker_ids uuid[];
  v_worker_count integer;
begin
  perform public.assert_work_log_access_v1(p_reporter_user_id,p_project_id,p_id,case when p_id is null then 'CREATE' else 'UPDATE' end);
  if p_project_id is null or p_log_date is null or p_reporter_user_id is null then
    raise exception '工作日誌的專案、日期或登錄人員不完整。';
  end if;
  if nullif(btrim(p_title), '') is null or char_length(btrim(p_title)) > 160 then
    raise exception '工作日誌標題必須為 1 至 160 個字。';
  end if;
  if char_length(coalesce(p_summary, '')) > 2000 then
    raise exception '工作日誌內容不可超過 2000 個字。';
  end if;
  if p_work_type is null or p_work_type not in ('工程施工', '維修紀錄', '維護保養') then
    raise exception '工作類型不正確。';
  end if;

  perform 1
  from public.app_users
  where id = p_reporter_user_id
    and is_active = true;
  if not found then
    raise exception '工作日誌登錄帳號無效或已停用。';
  end if;

  select coalesce(array_agg(distinct worker_id order by worker_id), '{}'::uuid[])
  into v_worker_ids
  from unnest(coalesce(p_worker_user_ids, '{}'::uuid[])) as workers(worker_id)
  where worker_id is not null;

  if cardinality(v_worker_ids) > 30 then
    raise exception '每篇工作日誌最多可選擇 30 位施工人員。';
  end if;

  if cardinality(v_worker_ids) > 0 then
    select count(*)
    into v_worker_count
    from public.app_users users
    where users.id = any(v_worker_ids)
      and (
        users.is_active = true
        or (
          p_id is not null
          and exists (
            select 1
            from public.site_work_log_workers existing_workers
            where existing_workers.work_log_id = p_id
              and existing_workers.user_id = users.id
          )
        )
      );

    if v_worker_count <> cardinality(v_worker_ids) then
      raise exception '部分施工人員不存在或已停用，請重新選擇。';
    end if;
  end if;

  select * into v_site
  from public.ensure_project_site_v1(p_project_id, p_actor);

  if p_id is null then
    insert into public.site_work_logs (
      site_id, log_date, reporter_user_id, title, summary, work_type,
      source, updated_by
    )
    values (
      v_site.id, p_log_date, p_reporter_user_id, btrim(p_title),
      nullif(btrim(coalesce(p_summary, '')), ''), p_work_type,
      'web', nullif(btrim(coalesce(p_actor, '')), '')
    )
    returning * into v_log;
  else
    if p_row_version is null or p_row_version < 1 then
      raise exception '工作日誌版本不正確，請重新整理後再修改。';
    end if;

    select * into v_existing
    from public.site_work_logs
    where id = p_id
      and site_id = v_site.id
    for update;

    if not found then
      raise exception '找不到所選專案的工作日誌。';
    end if;
    if v_existing.row_version <> p_row_version then
      raise exception '工作日誌已被其他使用者更新，請重新載入後再修改。';
    end if;

    update public.site_work_logs
    set log_date = p_log_date,
        reporter_user_id = p_reporter_user_id,
        title = btrim(p_title),
        summary = nullif(btrim(coalesce(p_summary, '')), ''),
        work_type = p_work_type,
        source = 'web',
        updated_by = nullif(btrim(coalesce(p_actor, '')), '')
    where id = p_id
      and row_version = p_row_version
    returning * into v_log;

    if not found then
      raise exception '工作日誌已被其他使用者更新，請重新載入後再修改。';
    end if;
  end if;

  delete from public.site_work_log_workers
  where work_log_id = v_log.id;

  insert into public.site_work_log_workers (work_log_id, user_id)
  select v_log.id, worker_id
  from unnest(v_worker_ids) as workers(worker_id);

  return jsonb_build_object(
    'work_log', to_jsonb(v_log),
    'worker_user_ids', to_jsonb(v_worker_ids)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_project_site_work_log_v2(p_project_id uuid, p_id uuid, p_row_version integer, p_log_date date, p_title text, p_summary text, p_work_type text, p_time_period text, p_status text, p_worker_user_ids uuid[], p_reporter_user_id uuid, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_site public.sites;
  v_existing public.site_work_logs;
  v_log public.site_work_logs;
  v_worker_ids uuid[];
  v_worker_count integer;
begin
  perform public.assert_work_log_access_v1(p_reporter_user_id,p_project_id,p_id,case when p_id is null then 'CREATE' else 'UPDATE' end);
  if p_project_id is null or p_log_date is null or p_reporter_user_id is null then
    raise exception '工作日誌的專案、日期或登錄人員不完整。';
  end if;
  if nullif(btrim(p_title), '') is null or char_length(btrim(p_title)) > 160 then
    raise exception '工作日誌標題必須為 1 至 160 個字。';
  end if;
  if char_length(coalesce(p_summary, '')) > 2000 then
    raise exception '工作日誌內容不可超過 2000 個字。';
  end if;
  if char_length(coalesce(p_time_period, '')) > 80 then
    raise exception '工作日誌時段不可超過 80 個字。';
  end if;
  if p_work_type is null or p_work_type not in ('工程施工', '維修紀錄', '維護保養') then
    raise exception '工作類型不正確。';
  end if;
  if p_status not in ('in_progress', 'completed') then
    raise exception '工作日誌狀態不正確。';
  end if;

  perform 1
  from public.projects
  where id = p_project_id
  for update;
  if not found then
    raise exception '找不到工作日誌所屬專案。';
  end if;

  perform 1
  from public.app_users
  where id = p_reporter_user_id
    and is_active = true;
  if not found then
    raise exception '工作日誌登錄帳號無效或已停用。';
  end if;

  select coalesce(array_agg(distinct worker_id order by worker_id), '{}'::uuid[])
  into v_worker_ids
  from unnest(coalesce(p_worker_user_ids, '{}'::uuid[])) as workers(worker_id)
  where worker_id is not null;

  if cardinality(v_worker_ids) > 30 then
    raise exception '每篇工作日誌最多可選擇 30 位施工人員。';
  end if;

  if cardinality(v_worker_ids) > 0 then
    select count(*)
    into v_worker_count
    from public.app_users users
    where users.id = any(v_worker_ids)
      and (
        users.is_active = true
        or (
          p_id is not null
          and exists (
            select 1
            from public.site_work_log_workers existing_workers
            where existing_workers.work_log_id = p_id
              and existing_workers.user_id = users.id
          )
        )
      );

    if v_worker_count <> cardinality(v_worker_ids) then
      raise exception '部分施工人員不存在或已停用，請重新選擇。';
    end if;
  end if;

  select * into v_site
  from public.ensure_project_site_v1(p_project_id, p_actor);

  if p_id is null then
    insert into public.site_work_logs (
      site_id, log_date, reporter_user_id, title, summary, work_type,
      time_period, status, source, updated_by
    )
    values (
      v_site.id, p_log_date, p_reporter_user_id, btrim(p_title),
      nullif(btrim(coalesce(p_summary, '')), ''), p_work_type,
      nullif(btrim(coalesce(p_time_period, '')), ''), p_status,
      'web', nullif(btrim(coalesce(p_actor, '')), '')
    )
    returning * into v_log;
  else
    if p_row_version is null or p_row_version < 1 then
      raise exception '工作日誌版本不正確，請重新整理後再修改。';
    end if;

    select * into v_existing
    from public.site_work_logs
    where id = p_id
      and site_id = v_site.id
    for update;

    if not found then
      raise exception '找不到所選專案的工作日誌。';
    end if;
    if v_existing.row_version <> p_row_version then
      raise exception '工作日誌已被其他使用者更新，請重新載入後再修改。';
    end if;

    update public.site_work_logs
    set log_date = p_log_date,
        reporter_user_id = p_reporter_user_id,
        title = btrim(p_title),
        summary = nullif(btrim(coalesce(p_summary, '')), ''),
        work_type = p_work_type,
        time_period = nullif(btrim(coalesce(p_time_period, '')), ''),
        status = p_status,
        source = 'web',
        updated_by = nullif(btrim(coalesce(p_actor, '')), '')
    where id = p_id
      and row_version = p_row_version
    returning * into v_log;

    if not found then
      raise exception '工作日誌已被其他使用者更新，請重新載入後再修改。';
    end if;
  end if;

  delete from public.site_work_log_workers
  where work_log_id = v_log.id;

  insert into public.site_work_log_workers (work_log_id, user_id)
  select v_log.id, worker_id
  from unnest(v_worker_ids) as workers(worker_id);

  update public.projects
  set status = p_status,
      source = 'web',
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where id = p_project_id
    and status is distinct from p_status;

  update public.site_work_logs
  set status = p_status,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where project_id = p_project_id
    and id <> v_log.id
    and status is distinct from p_status;

  return jsonb_build_object(
    'work_log', to_jsonb(v_log),
    'worker_user_ids', to_jsonb(v_worker_ids),
    'project_status', p_status
  );
end;
$function$
;


create function public.work_log_scope_v1(p_user_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_projects uuid[]; v_customers uuid[]; v_logs uuid[]; v_events uuid[]; v_sites uuid[];
begin
 if not public.has_app_permission_v1(p_user_id,'worklogs','VIEW') then raise exception '您的帳號沒有執行此操作的權限。'; end if;
 select coalesce(array_agg(p.id),'{}'),coalesce(array_agg(distinct p.customer_id),'{}') into v_projects,v_customers from public.projects p where public.has_project_permission_v1(p_user_id,p.id,'VIEW');
 select coalesce(array_agg(id),'{}') into v_logs from public.site_work_logs where project_id=any(v_projects) and deleted_at is null;
 select coalesce(array_agg(id),'{}') into v_events from public.maintenance_events where work_log_id=any(v_logs);
 select coalesce(array_agg(id),'{}') into v_sites from public.sites where project_id=any(v_projects);
 return jsonb_build_object(
 'projects',(select coalesce(jsonb_agg(to_jsonb(p)-'estimated_cost'-'actual_cost'),'[]') from public.projects p where id=any(v_projects)),
 'customers',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.customers c where id=any(v_customers)),
 'project_workers',(select coalesce(jsonb_agg(to_jsonb(w)),'[]') from public.project_workers w where project_id=any(v_projects) and is_assignee),
 'project_access',(select coalesce(jsonb_agg(to_jsonb(w)),'[]') from public.project_workers w where user_id=p_user_id and can_view),
 'site_work_logs',(select coalesce(jsonb_agg(to_jsonb(l) order by log_date desc,created_at desc),'[]') from public.site_work_logs l where id=any(v_logs)),
 'site_work_log_workers',(select coalesce(jsonb_agg(to_jsonb(w)),'[]') from public.site_work_log_workers w where work_log_id=any(v_logs)),
 'site_workers',(select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'display_name',u.display_name,'is_active',u.is_active)),'[]') from public.app_users u where u.id=p_user_id or u.id in(select user_id from public.project_workers where project_id=any(v_projects) and is_assignee) or u.id in(select user_id from public.site_work_log_workers where work_log_id=any(v_logs))),
 'sites',(select coalesce(jsonb_agg(to_jsonb(s)),'[]') from public.sites s where id=any(v_sites)),
 'site_assets',(select coalesce(jsonb_agg(to_jsonb(a)),'[]') from public.site_assets a where work_log_id=any(v_logs)),
 'maintenance_events',(select coalesce(jsonb_agg(to_jsonb(e)),'[]') from public.maintenance_events e where id=any(v_events)),
 'maintenance_event_equipment',(select coalesce(jsonb_agg(to_jsonb(e)),'[]') from public.maintenance_event_equipment e where event_id=any(v_events)),
 'maintenance_event_workers',(select coalesce(jsonb_agg(to_jsonb(e)),'[]') from public.maintenance_event_workers e where event_id=any(v_events)),
 'equipment_registry',(select coalesce(jsonb_agg(to_jsonb(e)),'[]') from public.equipment_registry e where customer_id=any(v_customers) and status='active'),
 'customer_contract_services',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.customer_contract_services c where customer_id=any(v_customers) and is_active),
 'contract_service_types',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.contract_service_types c where is_active),
 'items',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'inventory_code',i.inventory_code,'category_id',i.category_id,'item_name',i.item_name,'brand',i.brand,'model',i.model,'unit',i.unit)),'[]') from public.inventory_items i),
 'categories',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.product_categories c where is_active),
 'pickups','[]'::jsonb);
end;
$$;
revoke all on function public.work_log_scope_v1(uuid) from public,anon,authenticated;
grant execute on function public.work_log_scope_v1(uuid) to service_role;
commit;
