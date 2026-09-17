begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Use the existing audit action vocabulary. Preserve ownership, locking,
-- atomic pickup creation, idempotency, signature and service_role-only ACL.
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
    'work_assignment', v_assignment.id, 'update',
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

commit;
