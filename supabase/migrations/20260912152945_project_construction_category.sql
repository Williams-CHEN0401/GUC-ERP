begin;
alter table public.projects add column construction_category text
  constraint projects_construction_category_check check (construction_category in ('small_purchase','tender'));
comment on column public.projects.construction_category is '工程施工細分類；NULL 為未分類，既有資料不自動判定。';

-- The established v3 RPC remains compatible; its permissions, version checks,
-- numbering and work-log synchronization run in this same transaction.
create function public.upsert_erp_project_with_workers_v4(
  p_id uuid, p_row_version integer, p_name text, p_customer_id uuid, p_project_type text,
  p_status text, p_description text, p_estimated_cost numeric, p_note text,
  p_worker_user_ids uuid[], p_actor text, p_project_date date, p_construction_category text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_project public.projects;
begin
  if p_construction_category is not null and
    (p_construction_category not in ('small_purchase','tender') or p_project_type <> 'construction') then
    raise exception '工程施工分類不正確。';
  end if;
  v_result := public.upsert_erp_project_with_workers_v3(p_id,p_row_version,p_name,p_customer_id,p_project_type,p_status,p_description,p_estimated_cost,p_note,p_worker_user_ids,p_actor,p_project_date);
  update public.projects set construction_category=p_construction_category,updated_by=p_actor
    where id=(v_result#>>'{project,id}')::uuid and construction_category is distinct from p_construction_category;
  select * into v_project from public.projects where id=(v_result#>>'{project,id}')::uuid;
  return v_result || jsonb_build_object('project',to_jsonb(v_project));
end;
$$;
revoke all on function public.upsert_erp_project_with_workers_v4(uuid,integer,text,uuid,text,text,text,numeric,text,uuid[],text,date,text) from public,anon,authenticated;
grant execute on function public.upsert_erp_project_with_workers_v4(uuid,integer,text,uuid,text,text,text,numeric,text,uuid[],text,date,text) to service_role;
commit;
