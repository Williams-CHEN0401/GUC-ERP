begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Reuse the established project/department/numbering and assignment writers.
-- Both writes share one transaction: a rejected assignment leaves no project.
create function public.create_work_assignment_with_project_v1(
  p_project_name text,
  p_customer_id uuid,
  p_department_id uuid,
  p_project_type text,
  p_project_date date,
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
security invoker
set search_path = ''
as $$
declare
  v_project jsonb;
  v_assignment public.work_assignments;
begin
  if not exists (select 1 from public.app_users
    where id = p_created_by_user_id and role = 'admin' and is_active) then
    raise exception '只有啟用中的管理員可以建立工作指派。';
  end if;
  if nullif(btrim(coalesce(p_project_name, '')), '') is null
    or char_length(btrim(p_project_name)) > 120
    or p_project_date is null
    or p_project_type is null
    or p_project_type not in ('construction','repair','maintenance','delivery','clerical','site_survey') then
    raise exception '請填寫有效的工作內容名稱、日期與類型。';
  end if;
  -- Same lock order as the common department/project writer.
  perform 1 from public.customers where id = p_customer_id for update;
  if not found then raise exception '請選擇有效客戶。'; end if;
  if exists (select 1 from public.projects where customer_id = p_customer_id
    and lower(btrim(name)) = lower(btrim(p_project_name))) then
    raise exception '此客戶已有同名工作內容，請選擇既有工作或使用不同名稱。';
  end if;
  v_project := public.upsert_erp_project_department_v1(
    p_id => null, p_row_version => null, p_name => btrim(p_project_name),
    p_customer_id => p_customer_id, p_project_type => p_project_type,
    p_status => 'in_progress', p_description => null, p_estimated_cost => null,
    p_note => null, p_worker_user_ids => array[p_assignee_user_id], p_actor => p_actor,
    p_project_date => p_project_date, p_construction_category => null,
    p_department_id => p_department_id, p_construction_category_provided => true
  );
  select * into v_assignment from public.create_work_assignment_v1(
    (v_project #>> '{project,id}')::uuid, p_assignee_user_id, p_assignment_type,
    p_instructions, p_inventory_item_id, p_pickup_quantity, p_created_by_user_id, p_actor
  );
  return v_assignment;
end;
$$;

revoke all on function public.create_work_assignment_with_project_v1(text,uuid,uuid,text,date,uuid,text,text,uuid,numeric,uuid,text) from public,anon,authenticated;
grant execute on function public.create_work_assignment_with_project_v1(text,uuid,uuid,text,date,uuid,text,text,uuid,numeric,uuid,text) to service_role;
commit;
