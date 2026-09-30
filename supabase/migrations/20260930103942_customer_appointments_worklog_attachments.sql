begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Appointments ARE work assignments. No mirrored status or duplicate customer master.
alter table public.work_assignments
  alter column project_id drop not null,
  add column customer_id uuid references public.customers(id) on delete restrict,
  add column department_id uuid references public.customer_departments(id) on delete restrict,
  add column appointment_type text,
  add column appointment_date date,
  add column contact_name text,
  add column contact_phone text,
  add column notes text;
alter table public.work_assignments drop constraint work_assignments_assignment_type_check;
alter table public.work_assignments drop constraint work_assignments_status_check;
alter table public.work_assignments drop constraint work_assignments_pickup_fields_check;
alter table public.work_assignments add constraint work_assignments_assignment_type_check
  check (assignment_type in ('general','pickup','appointment'));
alter table public.work_assignments add constraint work_assignments_status_check
  check (status in ('pending','completed','cancelled') or (assignment_type='appointment' and status='in_progress'));
alter table public.work_assignments add constraint work_assignments_pickup_fields_check check (
  (assignment_type in ('general','appointment') and inventory_item_id is null and pickup_quantity is null)
  or (assignment_type='pickup' and inventory_item_id is not null and pickup_quantity>0));
alter table public.work_assignments add constraint work_assignments_appointment_check check (
  (assignment_type='appointment' and project_id is null and customer_id is not null
    and appointment_type is not null and appointment_type in ('repair','site_visit','quotation') and appointment_date is not null)
  or (assignment_type<>'appointment' and project_id is not null and customer_id is null
    and department_id is null and appointment_type is null and appointment_date is null
    and contact_name is null and contact_phone is null and notes is null));
create index work_assignments_appointment_customer_idx on public.work_assignments(customer_id) where customer_id is not null;
create index work_assignments_appointment_department_idx on public.work_assignments(department_id) where department_id is not null;
create index work_assignments_appointment_date_idx on public.work_assignments(appointment_date,id) where assignment_type='appointment';
create index work_assignments_assignee_active_idx on public.work_assignments(assignee_user_id,created_at,id) where status in ('pending','in_progress');

create function public.upsert_customer_appointment_v1(
  p_id uuid,p_row_version integer,p_customer_id uuid,p_department_id uuid,
  p_appointment_type text,p_appointment_date date,p_contact_name text,p_contact_phone text,
  p_instructions text,p_assignee_user_id uuid,p_status text,p_notes text,p_actor_user_id uuid,p_actor text
) returns public.work_assignments language plpgsql security invoker set search_path='' as $$
declare v_old public.work_assignments; v_row public.work_assignments;
begin
  -- Same creation/management authority as existing work assignments.
  if not exists(select 1 from public.app_users where id=p_actor_user_id and is_active and role='admin') then
    raise exception '只有啟用中的管理員可以管理客戶預約事項。';
  end if;
  if p_id is not null then
    select * into v_old from public.work_assignments where id=p_id and assignment_type='appointment' for update;
    if not found then raise exception '找不到客戶預約事項。'; end if;
    if p_row_version is distinct from v_old.row_version then raise exception '預約事項已被更新，請重新整理。'; end if;
  end if;
  if not exists(select 1 from public.customers where id=p_customer_id) then raise exception '請選擇有效客戶。'; end if;
  if p_department_id is not null and not exists(select 1 from public.customer_departments
    where id=p_department_id and customer_id=p_customer_id and (is_active or id=v_old.department_id)) then
    raise exception '科室不屬於此客戶或已停用。';
  end if;
  if not exists(select 1 from public.app_users where id=p_assignee_user_id and is_active) then raise exception '請選擇啟用中的責任人。'; end if;
  if p_appointment_type is null or p_appointment_type not in ('repair','site_visit','quotation')
    or p_status is null or p_status not in ('pending','in_progress','completed','cancelled')
    or p_appointment_date is null or char_length(btrim(coalesce(p_instructions,''))) not between 1 and 2000
    or char_length(coalesce(p_contact_name,''))>120 or char_length(coalesce(p_contact_phone,''))>50
    or char_length(coalesce(p_notes,''))>2000 then raise exception '請完整填寫有效的預約資料。'; end if;
  if p_id is null then
    insert into public.work_assignments(assignment_type,customer_id,department_id,appointment_type,appointment_date,
      contact_name,contact_phone,instructions,assignee_user_id,created_by_user_id,status,completed_at,notes,updated_by)
    values('appointment',p_customer_id,p_department_id,p_appointment_type,p_appointment_date,
      nullif(btrim(p_contact_name),''),nullif(btrim(p_contact_phone),''),btrim(p_instructions),p_assignee_user_id,p_actor_user_id,
      p_status,case when p_status='completed' then statement_timestamp() end,nullif(btrim(p_notes),''),p_actor) returning * into v_row;
  else
    update public.work_assignments set customer_id=p_customer_id,department_id=p_department_id,
      appointment_type=p_appointment_type,appointment_date=p_appointment_date,contact_name=nullif(btrim(p_contact_name),''),
      contact_phone=nullif(btrim(p_contact_phone),''),instructions=btrim(p_instructions),assignee_user_id=p_assignee_user_id,
      status=p_status,completed_at=case when p_status='completed' then coalesce(v_old.completed_at,statement_timestamp()) end,
      completion_acknowledged_at=case when p_status='completed' and v_old.assignee_user_id=p_assignee_user_id then v_old.completion_acknowledged_at end,
      notes=nullif(btrim(p_notes),''),updated_at=statement_timestamp(),updated_by=p_actor,row_version=row_version+1
    where id=p_id returning * into v_row;
  end if;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
  values('work_assignment',v_row.id,case when p_id is null then 'insert' else 'update' end,to_jsonb(v_old),to_jsonb(v_row),'web',p_actor);
  return v_row;
end $$;
revoke all on function public.upsert_customer_appointment_v1(uuid,integer,uuid,uuid,text,date,text,text,text,uuid,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.upsert_customer_appointment_v1(uuid,integer,uuid,uuid,text,date,text,text,text,uuid,text,text,uuid,text) to service_role;

-- Optional relation for new worklog uploads; old contract uploads keep v2 unchanged.
create function public.register_work_log_attachments_v1(p_customer_id uuid,p_service_type_id uuid,p_project_id uuid,
  p_work_log_id uuid,p_rows jsonb,p_actor text) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_result jsonb; v_ids uuid[];
begin
  perform 1 from public.site_work_logs where id=p_work_log_id and project_id=p_project_id and deleted_at is null for share;
  if not found then raise exception '工作日誌與工作內容不相符，請重新整理。'; end if;
  if exists(select 1 from public.site_assets a join jsonb_array_elements(p_rows) r on a.nas_path=r->>'nas_path'
    where a.work_log_id is not null and a.work_log_id<>p_work_log_id) then
    raise exception '同名檔案已關聯其他工作日誌，請選擇另存新檔。';
  end if;
  v_result:=public.register_contract_site_attachments_v2(p_customer_id,p_service_type_id,p_project_id,p_rows,p_actor);
  select array_agg((r->>'id')::uuid) into v_ids from jsonb_array_elements(v_result) r;
  update public.site_assets set work_log_id=p_work_log_id where id=any(v_ids);
  return (select coalesce(jsonb_agg(to_jsonb(a)),'[]') from public.site_assets a where id=any(v_ids));
end $$;
revoke all on function public.register_work_log_attachments_v1(uuid,uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.register_work_log_attachments_v1(uuid,uuid,uuid,uuid,jsonb,text) to service_role;
commit;
