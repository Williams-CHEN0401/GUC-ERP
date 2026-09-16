begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Work contents remain available to historical logs and pickup records after
-- removal, while active ERP selectors can consistently hide them.
alter table public.projects
  add column if not exists deleted_at timestamptz,
  add column if not exists delete_reason text;

create index if not exists projects_active_updated_idx
  on public.projects(updated_at desc, id desc)
  where deleted_at is null;

create table if not exists public.work_assignments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  assignee_user_id uuid not null references public.app_users(id) on delete restrict,
  created_by_user_id uuid not null references public.app_users(id) on delete restrict,
  assignment_type text not null default 'general'
    check (assignment_type in ('general', 'pickup')),
  instructions text not null
    check (char_length(btrim(instructions)) between 1 and 2000),
  inventory_item_id uuid references public.inventory_items(id) on delete restrict,
  pickup_quantity numeric,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'cancelled')),
  completed_at timestamptz,
  completion_acknowledged_at timestamptz,
  row_version integer not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint work_assignments_pickup_fields_check check (
    (assignment_type = 'general' and inventory_item_id is null and pickup_quantity is null)
    or
    (assignment_type = 'pickup' and inventory_item_id is not null and pickup_quantity > 0)
  ),
  constraint work_assignments_completion_check check (
    (status = 'completed' and completed_at is not null)
    or
    (status <> 'completed' and completed_at is null and completion_acknowledged_at is null)
  )
);

alter table public.work_assignments enable row level security;
revoke all on table public.work_assignments from public, anon, authenticated;
grant select, insert, update, delete on table public.work_assignments to service_role;

create index if not exists work_assignments_assignee_pending_idx
  on public.work_assignments(assignee_user_id, created_at desc, id desc)
  where status = 'pending';
create index if not exists work_assignments_creator_notice_idx
  on public.work_assignments(created_by_user_id, completed_at desc, id desc)
  where status = 'completed' and completion_acknowledged_at is null;
create index if not exists work_assignments_project_idx
  on public.work_assignments(project_id, created_at desc, id desc);

alter table public.pickup_records
  add column if not exists work_assignment_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pickup_records'::regclass
      and conname = 'pickup_records_work_assignment_id_fkey'
  ) then
    alter table public.pickup_records
      add constraint pickup_records_work_assignment_id_fkey
      foreign key (work_assignment_id)
      references public.work_assignments(id)
      on delete restrict
      not valid;
  end if;
end;
$$;

alter table public.pickup_records
  validate constraint pickup_records_work_assignment_id_fkey;

create unique index if not exists pickup_records_work_assignment_uidx
  on public.pickup_records(work_assignment_id)
  where work_assignment_id is not null;

create or replace function public.create_work_assignment_v1(
  p_project_id uuid,
  p_assignee_user_id uuid,
  p_assignment_type text,
  p_instructions text,
  p_inventory_item_id uuid,
  p_pickup_quantity numeric,
  p_created_by_user_id uuid,
  p_actor text
)
returns public.work_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assignment public.work_assignments;
begin
  if not exists (
    select 1 from public.app_users
    where id = p_created_by_user_id and role = 'admin' and is_active
  ) then
    raise exception '只有啟用中的管理員可以建立工作指派。';
  end if;
  if not exists (
    select 1 from public.projects
    where id = p_project_id and deleted_at is null and status <> 'completed'
  ) then
    raise exception '請選擇有效且尚未完成的工作內容。';
  end if;
  if not exists (
    select 1 from public.app_users
    where id = p_assignee_user_id and is_active
  ) then
    raise exception '請選擇啟用中的責任人。';
  end if;
  if p_assignment_type not in ('general', 'pickup') then
    raise exception '工作指派類型不正確。';
  end if;
  if nullif(btrim(coalesce(p_instructions, '')), '') is null
     or char_length(btrim(p_instructions)) > 2000 then
    raise exception '工作內容須為 1 至 2000 個字。';
  end if;
  if p_assignment_type = 'pickup' then
    if p_inventory_item_id is null or p_pickup_quantity is null or p_pickup_quantity <= 0 then
      raise exception '領料工作必須選擇品項並輸入大於 0 的數量。';
    end if;
    if not exists (select 1 from public.inventory_items where id = p_inventory_item_id) then
      raise exception '找不到指定領料品項。';
    end if;
  elsif p_inventory_item_id is not null or p_pickup_quantity is not null then
    raise exception '一般工作不可包含領料品項。';
  end if;

  insert into public.work_assignments (
    project_id, assignee_user_id, created_by_user_id, assignment_type,
    instructions, inventory_item_id, pickup_quantity, updated_by
  ) values (
    p_project_id, p_assignee_user_id, p_created_by_user_id, p_assignment_type,
    btrim(p_instructions), p_inventory_item_id,
    case when p_pickup_quantity is null then null else round(p_pickup_quantity, 2) end,
    nullif(btrim(coalesce(p_actor, '')), '')
  ) returning * into v_assignment;

  insert into public.audit_logs (
    entity_type, entity_id, action, after_data, source, actor
  ) values (
    'work_assignment', v_assignment.id, 'insert',
    jsonb_build_object(
      'project_id', v_assignment.project_id,
      'assignee_user_id', v_assignment.assignee_user_id,
      'assignment_type', v_assignment.assignment_type,
      'status', v_assignment.status
    ),
    'web', nullif(btrim(coalesce(p_actor, '')), '')
  );
  return v_assignment;
end;
$$;

revoke all on function public.create_work_assignment_v1(
  uuid, uuid, text, text, uuid, numeric, uuid, text
) from public, anon, authenticated;
grant execute on function public.create_work_assignment_v1(
  uuid, uuid, text, text, uuid, numeric, uuid, text
) to service_role;

create or replace function public.complete_work_assignment_v1(
  p_id uuid,
  p_row_version integer,
  p_actor_user_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assignment public.work_assignments;
  v_actor_user public.app_users;
  v_pickup public.pickup_records;
begin
  select * into v_actor_user
  from public.app_users
  where id = p_actor_user_id and is_active;
  if not found then raise exception '登入帳號不存在或已停用。'; end if;

  select * into v_assignment
  from public.work_assignments
  where id = p_id
  for update;
  if not found then raise exception '找不到工作指派。'; end if;
  if v_assignment.assignee_user_id <> p_actor_user_id and v_actor_user.role <> 'admin' then
    raise exception '只能由責任人或管理員完成此工作。';
  end if;
  if v_assignment.status = 'cancelled' then raise exception '此工作指派已取消。'; end if;

  if v_assignment.status = 'completed' then
    select * into v_pickup from public.pickup_records
    where work_assignment_id = v_assignment.id;
    return jsonb_build_object('assignment', to_jsonb(v_assignment), 'pickup', to_jsonb(v_pickup));
  end if;
  if p_row_version is null or p_row_version <> v_assignment.row_version then
    raise exception '工作指派已被其他使用者更新，請重新整理。';
  end if;

  if v_assignment.assignment_type = 'pickup' then
    perform 1 from public.inventory_items
    where id = v_assignment.inventory_item_id
    for update;
    if not found then raise exception '找不到領料品項。'; end if;

    insert into public.pickup_records (
      pickup_date, project_id, inventory_item_id, quantity,
      source, updated_by, created_by_user_id, created_by_username,
      work_assignment_id
    ) values (
      (statement_timestamp() at time zone 'Asia/Taipei')::date,
      v_assignment.project_id, v_assignment.inventory_item_id,
      round(v_assignment.pickup_quantity, 2), 'web',
      nullif(btrim(coalesce(p_actor, '')), ''),
      v_actor_user.id, v_actor_user.username, v_assignment.id
    )
    on conflict (work_assignment_id) where work_assignment_id is not null
    do update set
      pickup_date = excluded.pickup_date,
      project_id = excluded.project_id,
      inventory_item_id = excluded.inventory_item_id,
      quantity = excluded.quantity,
      updated_by = excluded.updated_by
    returning * into v_pickup;
  end if;

  update public.work_assignments
  set status = 'completed',
      completed_at = statement_timestamp(),
      updated_at = statement_timestamp(),
      updated_by = nullif(btrim(coalesce(p_actor, '')), ''),
      row_version = row_version + 1
  where id = v_assignment.id and row_version = p_row_version
  returning * into v_assignment;
  if not found then raise exception '工作指派已被其他使用者更新，請重新整理。'; end if;

  insert into public.audit_logs (
    entity_type, entity_id, action, before_data, after_data, source, actor
  ) values (
    'work_assignment', v_assignment.id, 'complete',
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'completed', 'pickup_record_id', v_pickup.id),
    'web', nullif(btrim(coalesce(p_actor, '')), '')
  );
  return jsonb_build_object('assignment', to_jsonb(v_assignment), 'pickup', to_jsonb(v_pickup));
end;
$$;

revoke all on function public.complete_work_assignment_v1(
  uuid, integer, uuid, text
) from public, anon, authenticated;
grant execute on function public.complete_work_assignment_v1(
  uuid, integer, uuid, text
) to service_role;

create or replace function public.acknowledge_work_assignment_v1(
  p_id uuid,
  p_row_version integer,
  p_actor_user_id uuid,
  p_actor text
)
returns public.work_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assignment public.work_assignments;
  v_actor_role text;
begin
  select role into v_actor_role from public.app_users
  where id = p_actor_user_id and is_active;
  if not found then raise exception '登入帳號不存在或已停用。'; end if;

  select * into v_assignment from public.work_assignments
  where id = p_id for update;
  if not found then raise exception '找不到工作指派。'; end if;
  if v_assignment.created_by_user_id <> p_actor_user_id and v_actor_role <> 'admin' then
    raise exception '只有建立者或管理員可以確認完成通知。';
  end if;
  if v_assignment.status <> 'completed' then raise exception '此工作尚未完成。'; end if;
  if p_row_version is null or p_row_version <> v_assignment.row_version then
    raise exception '工作指派已被其他使用者更新，請重新整理。';
  end if;

  update public.work_assignments
  set completion_acknowledged_at = coalesce(completion_acknowledged_at, statement_timestamp()),
      updated_at = statement_timestamp(),
      updated_by = nullif(btrim(coalesce(p_actor, '')), ''),
      row_version = row_version + 1
  where id = p_id and row_version = p_row_version
  returning * into v_assignment;
  return v_assignment;
end;
$$;

revoke all on function public.acknowledge_work_assignment_v1(
  uuid, integer, uuid, text
) from public, anon, authenticated;
grant execute on function public.acknowledge_work_assignment_v1(
  uuid, integer, uuid, text
) to service_role;

-- Preserve the existing function signature used by the gateway, but replace
-- hard deletion with auditable soft deletion and cancel only pending tasks.
create or replace function public.delete_project_record(
  p_id uuid,
  p_row_version integer,
  p_actor text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.projects;
begin
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception '缺少操作者資訊。';
  end if;
  select * into v_project from public.projects
  where id = p_id and deleted_at is null for update;
  if not found then raise exception '找不到工作內容資料。'; end if;
  if v_project.row_version <> p_row_version then
    raise exception '工作內容資料已被其他使用者更新，請重新載入後再刪除。';
  end if;

  update public.work_assignments
  set status = 'cancelled', updated_at = statement_timestamp(),
      updated_by = p_actor, row_version = row_version + 1
  where project_id = p_id and status = 'pending';

  update public.projects
  set deleted_at = statement_timestamp(), delete_reason = '使用者刪除',
      updated_by = p_actor, updated_at = statement_timestamp(),
      row_version = row_version + 1
  where id = p_id and row_version = p_row_version and deleted_at is null;
  if not found then
    raise exception '工作內容資料已被其他使用者更新，請重新載入後再刪除。';
  end if;
  insert into public.audit_logs (
    entity_type, entity_id, action, before_data, after_data, source, actor
  ) values (
    'project', p_id, 'soft_delete',
    jsonb_build_object('status', v_project.status, 'row_version', v_project.row_version),
    jsonb_build_object('deleted_at', statement_timestamp(), 'delete_reason', '使用者刪除'),
    'web', p_actor
  );
  return 1;
end;
$$;

revoke all on function public.delete_project_record(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.delete_project_record(uuid, integer, text)
  to service_role;

-- Project-scoped accounts must receive the same active-project boundary as
-- unrestricted accounts. Historical work logs remain queryable by ID.
create or replace function public.work_log_scope_v1(p_user_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_projects uuid[];
  v_log_projects uuid[];
  v_customers uuid[];
  v_logs uuid[];
  v_events uuid[];
  v_sites uuid[];
begin
  if not public.has_app_permission_v1(p_user_id, 'worklogs', 'VIEW') then
    raise exception '您的帳號沒有執行此操作的權限。';
  end if;
  select coalesce(array_agg(p.id), '{}'), coalesce(array_agg(distinct p.customer_id), '{}')
  into v_log_projects, v_customers
  from public.projects p
  where public.has_project_permission_v1(p_user_id, p.id, 'VIEW');
  select coalesce(array_agg(p.id), '{}') into v_projects
  from public.projects p
  where p.id = any(v_log_projects) and p.deleted_at is null;
  select coalesce(array_agg(id), '{}') into v_logs
  from public.site_work_logs where project_id = any(v_log_projects) and deleted_at is null;
  select coalesce(array_agg(id), '{}') into v_events
  from public.maintenance_events where work_log_id = any(v_logs);
  select coalesce(array_agg(id), '{}') into v_sites
  from public.sites where project_id = any(v_projects);
  return jsonb_build_object(
    'projects', (select coalesce(jsonb_agg(to_jsonb(p)-'estimated_cost'-'actual_cost'), '[]') from public.projects p where id = any(v_projects) and deleted_at is null),
    'customers', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from public.customers c where id = any(v_customers)),
    'project_workers', (select coalesce(jsonb_agg(to_jsonb(w)), '[]') from public.project_workers w where project_id = any(v_projects) and is_assignee),
    'project_access', (select coalesce(jsonb_agg(to_jsonb(w)), '[]') from public.project_workers w where user_id = p_user_id and can_view and project_id = any(v_projects)),
    'site_work_logs', (select coalesce(jsonb_agg(to_jsonb(l) order by log_date desc, created_at desc), '[]') from public.site_work_logs l where id = any(v_logs)),
    'site_work_log_workers', (select coalesce(jsonb_agg(to_jsonb(w)), '[]') from public.site_work_log_workers w where work_log_id = any(v_logs)),
    'site_workers', (select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'display_name',u.display_name,'is_active',u.is_active)), '[]') from public.app_users u where u.id = p_user_id or u.id in(select user_id from public.project_workers where project_id = any(v_projects) and is_assignee) or u.id in(select user_id from public.site_work_log_workers where work_log_id = any(v_logs))),
    'sites', (select coalesce(jsonb_agg(to_jsonb(s)), '[]') from public.sites s where id = any(v_sites)),
    'site_assets', (select coalesce(jsonb_agg(to_jsonb(a)), '[]') from public.site_assets a where work_log_id = any(v_logs)),
    'maintenance_events', (select coalesce(jsonb_agg(to_jsonb(e)), '[]') from public.maintenance_events e where id = any(v_events)),
    'maintenance_event_equipment', (select coalesce(jsonb_agg(to_jsonb(e)), '[]') from public.maintenance_event_equipment e where event_id = any(v_events)),
    'maintenance_event_workers', (select coalesce(jsonb_agg(to_jsonb(e)), '[]') from public.maintenance_event_workers e where event_id = any(v_events)),
    'equipment_registry', (select coalesce(jsonb_agg(to_jsonb(e)), '[]') from public.equipment_registry e where customer_id = any(v_customers) and status = 'active'),
    'customer_contract_services', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from public.customer_contract_services c where customer_id = any(v_customers) and is_active),
    'contract_service_types', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from public.contract_service_types c where is_active),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'inventory_code',i.inventory_code,'category_id',i.category_id,'item_name',i.item_name,'brand',i.brand,'model',i.model,'unit',i.unit)), '[]') from public.inventory_items i),
    'categories', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from public.product_categories c where is_active),
    'pickups', '[]'::jsonb
  );
end;
$$;

revoke all on function public.work_log_scope_v1(uuid) from public, anon, authenticated;
grant execute on function public.work_log_scope_v1(uuid) to service_role;

commit;
