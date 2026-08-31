begin;

create table if not exists public.project_workers (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

alter table public.project_workers enable row level security;
revoke all on table public.project_workers from public, anon, authenticated;
grant select, insert, update, delete on table public.project_workers to service_role;

create index if not exists project_workers_user_id_idx
  on public.project_workers(user_id);

create or replace function public.upsert_erp_project_with_workers_v1(
  p_id uuid,
  p_row_version integer,
  p_name text,
  p_customer_id uuid,
  p_project_type text,
  p_status text,
  p_description text,
  p_estimated_cost numeric,
  p_note text,
  p_worker_user_ids uuid[],
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.projects;
  v_project public.projects;
  v_worker_ids uuid[];
  v_worker_count integer;
  v_assigned_to text;
begin
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 120 then
    raise exception '專案名稱必須為 1 至 120 個字。';
  end if;
  if p_customer_id is null or not exists(select 1 from public.customers where id = p_customer_id) then
    raise exception '找不到指定客戶。';
  end if;
  if p_project_type not in ('construction', 'maintenance') then
    raise exception '專案類型不正確。';
  end if;
  if nullif(btrim(p_status), '') is null or char_length(btrim(p_status)) > 40 then
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
            select 1 from public.project_workers existing_workers
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
      btrim(p_name), p_customer_id, p_project_type, btrim(p_status),
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
        status = btrim(p_status),
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

  delete from public.project_workers where project_id = v_project.id;
  insert into public.project_workers(project_id, user_id)
  select v_project.id, worker_id from unnest(v_worker_ids) as workers(worker_id);

  return jsonb_build_object(
    'project', to_jsonb(v_project),
    'worker_user_ids', to_jsonb(v_worker_ids)
  );
end;
$$;

revoke all on function public.upsert_erp_project_with_workers_v1(
  uuid, integer, text, uuid, text, text, text, numeric, text, uuid[], text
) from public, anon, authenticated;
grant execute on function public.upsert_erp_project_with_workers_v1(
  uuid, integer, text, uuid, text, text, text, numeric, text, uuid[], text
) to service_role;

commit;
