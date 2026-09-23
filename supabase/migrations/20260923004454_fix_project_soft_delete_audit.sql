begin;
set local lock_timeout = '5s';
-- Soft deletion is an UPDATE. Keep the existing action constraint and all
-- ownership/history, cancellation, row-version and service-only ACL behavior.
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
    'project', p_id, 'update',
    jsonb_build_object('status', v_project.status, 'row_version', v_project.row_version),
    jsonb_build_object('deleted_at', statement_timestamp(), 'delete_reason', '使用者刪除'),
    'web', p_actor
  );
  return 1;
end;
$$;
commit;
