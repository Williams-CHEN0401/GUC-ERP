-- Run against a test database seeded with an active app_user.
-- All created projects, customers, owners, audit rows and counters roll back.
begin;
do $$
declare
  customer uuid := gen_random_uuid();
  owner_id uuid;
  actor_name text;
  kind text;
  result jsonb;
  v_project_id uuid;
  version integer;
  code text;
  codes text[] := '{}';
begin
  select id,username into owner_id,actor_name from public.app_users where is_active order by id limit 1;
  if owner_id is null then raise exception 'Test requires an active user fixture'; end if;
  insert into public.customers(id,customer_code,name,customer_category)
  values(customer,'TEST-'||customer::text,'Project creation regression','government');
  foreach kind in array array['construction','repair','maintenance'] loop
    result := public.upsert_erp_project_with_workers_v2(
      p_id=>null,p_row_version=>null,p_name=>'Test '||kind,p_customer_id=>customer,
      p_project_type=>kind,p_status=>'in_progress',p_description=>'Create regression',
      p_estimated_cost=>null,p_note=>null,p_worker_user_ids=>array[owner_id],p_actor=>actor_name);
    v_project_id := (result->'project'->>'id')::uuid;
    code := result->'project'->>'project_code';
    if v_project_id is null or code !~ '^[0-9]{7}$' or code=any(codes) then raise exception 'Invalid or duplicate generated code: %',code; end if;
    codes := array_append(codes,code);
    if not exists(select 1 from public.projects where id=v_project_id and project_type=kind and description='Create regression') then raise exception 'Created project did not persist: %',kind; end if;
    if not exists(select 1 from public.project_workers where project_workers.project_id=v_project_id and user_id=owner_id and is_assignee) then raise exception 'Owner did not persist: %',kind; end if;
    select row_version into version from public.projects where id=v_project_id;
    result := public.upsert_erp_project_with_workers_v2(
      p_id=>v_project_id,p_row_version=>version,p_name=>'Updated '||kind,p_customer_id=>customer,
      p_project_type=>kind,p_status=>'completed',p_description=>'Update regression',
      p_estimated_cost=>null,p_note=>null,p_worker_user_ids=>'{}'::uuid[],p_actor=>actor_name);
    if not exists(select 1 from public.projects where id=v_project_id and project_type=kind and status='completed' and description='Update regression' and row_version>version) then raise exception 'Update did not persist: %',kind; end if;
    if exists(select 1 from public.project_workers where project_workers.project_id=v_project_id and is_assignee) then raise exception 'Owner removal did not persist: %',kind; end if;
  end loop;
  begin
    perform public.create_project_auto_number_v1('Invalid type',customer,'invalid','in_progress',null,null,null,null,actor_name);
    raise exception 'Invalid project type unexpectedly accepted';
  exception when raise_exception then
    if sqlerrm <> '專案類型不正確。' then raise; end if;
  end;
end;
$$;
rollback;
