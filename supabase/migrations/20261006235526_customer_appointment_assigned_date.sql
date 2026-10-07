begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Separate business date from immutable creation metadata. No historical backfill.
alter table public.work_assignments add column assigned_date date;
alter table public.work_assignments add constraint work_assignments_assigned_date_check check (
 assigned_date is null or (assignment_type='appointment' and assigned_date between date '0001-01-01' and date '9999-12-31'));
comment on column public.work_assignments.assigned_date is 'Editable customer appointment assignment date; legacy NULL displays created_at in Asia/Taipei.';

create function public.upsert_customer_appointment_v3(
 p_id uuid,p_row_version integer,p_customer_id uuid,p_department_id uuid,
 p_appointment_type text,p_appointment_date date,p_contact_name text,p_contact_phone text,
 p_instructions text,p_assignee_user_id uuid,p_status text,p_notes text,p_reminder_days integer,p_actor_user_id uuid,p_actor text,
 p_assigned_date date default null
) returns public.work_assignments language plpgsql security invoker set search_path='' as $$
declare v_old public.work_assignments; v_row public.work_assignments; v_assigned_date date;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'appointments',case when p_id is null then 'CREATE' else 'UPDATE' end) then
  raise exception '您的帳號沒有執行此操作的權限。';
 end if;
 if p_id is not null then
  select * into v_old from public.work_assignments where id=p_id and assignment_type='appointment' for update;
  if not found then raise exception '找不到客戶預約事項。'; end if;
  if p_row_version is distinct from v_old.row_version then raise exception '預約事項已被更新，請重新整理。'; end if;
 end if;
 v_assigned_date:=coalesce(p_assigned_date,v_old.assigned_date,(v_old.created_at at time zone 'Asia/Taipei')::date,(statement_timestamp() at time zone 'Asia/Taipei')::date);
 if v_assigned_date not between date '0001-01-01' and date '9999-12-31' then raise exception '請填寫有效的指派日期。'; end if;
 if p_reminder_days is not null and p_reminder_days not between 0 and 365 then raise exception '提醒天數須為 0 至 365 的整數。'; end if;
 if not exists(select 1 from public.customers where id=p_customer_id) then raise exception '請選擇有效客戶。'; end if;
 if p_department_id is not null and not exists(select 1 from public.customer_departments
  where id=p_department_id and customer_id=p_customer_id and (is_active or id=v_old.department_id)) then
  raise exception '科室不屬於此客戶或已停用。';
 end if;
 if not exists(select 1 from public.app_users where id=p_assignee_user_id and is_active) then raise exception '請選擇啟用中的責任人。'; end if;
 if p_appointment_type is null or p_appointment_type not in ('repair','site_visit','quotation','construction')
  or p_status is null or p_status not in ('pending','in_progress','completed','cancelled')
  or p_appointment_date is null or char_length(btrim(coalesce(p_instructions,''))) not between 1 and 2000
  or char_length(coalesce(p_contact_name,''))>120 or char_length(coalesce(p_contact_phone,''))>50
  or char_length(coalesce(p_notes,''))>2000 then raise exception '請完整填寫有效的預約資料。'; end if;
 if p_id is null then
  insert into public.work_assignments(assignment_type,customer_id,department_id,appointment_type,appointment_date,
   contact_name,contact_phone,instructions,assignee_user_id,created_by_user_id,status,completed_at,notes,reminder_days,updated_by,assigned_date)
  values('appointment',p_customer_id,p_department_id,p_appointment_type,p_appointment_date,
   nullif(btrim(p_contact_name),''),nullif(btrim(p_contact_phone),''),btrim(p_instructions),p_assignee_user_id,p_actor_user_id,
   p_status,case when p_status='completed' then statement_timestamp() end,nullif(btrim(p_notes),''),coalesce(p_reminder_days,3),p_actor,v_assigned_date) returning * into v_row;
 else
  update public.work_assignments set customer_id=p_customer_id,department_id=p_department_id,
   appointment_type=p_appointment_type,appointment_date=p_appointment_date,contact_name=nullif(btrim(p_contact_name),''),
   contact_phone=nullif(btrim(p_contact_phone),''),instructions=btrim(p_instructions),assignee_user_id=p_assignee_user_id,
   status=p_status,completed_at=case when p_status='completed' then coalesce(v_old.completed_at,statement_timestamp()) end,
   completion_acknowledged_at=case when p_status='completed' and v_old.assignee_user_id=p_assignee_user_id then v_old.completion_acknowledged_at end,
   notes=nullif(btrim(p_notes),''),reminder_days=coalesce(p_reminder_days,v_old.reminder_days),assigned_date=v_assigned_date,
   updated_at=statement_timestamp(),updated_by=p_actor,row_version=row_version+1
  where id=p_id returning * into v_row;
 end if;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('work_assignment',v_row.id,case when p_id is null then 'insert' else 'update' end,to_jsonb(v_old),to_jsonb(v_row),'web',p_actor);
 return v_row;
end $$;
revoke all on function public.upsert_customer_appointment_v3(uuid,integer,uuid,uuid,text,date,text,text,text,uuid,text,text,integer,uuid,text,date) from public,anon,authenticated;
grant execute on function public.upsert_customer_appointment_v3(uuid,integer,uuid,uuid,text,date,text,text,text,uuid,text,text,integer,uuid,text,date) to service_role;

-- Preserve both older RPC signatures, including their service-only ACLs.
create or replace function public.upsert_customer_appointment_v2(
 p_id uuid,p_row_version integer,p_customer_id uuid,p_department_id uuid,
 p_appointment_type text,p_appointment_date date,p_contact_name text,p_contact_phone text,
 p_instructions text,p_assignee_user_id uuid,p_status text,p_notes text,p_reminder_days integer,p_actor_user_id uuid,p_actor text
) returns public.work_assignments language sql security invoker set search_path='' as $$
 select public.upsert_customer_appointment_v3(p_id,p_row_version,p_customer_id,p_department_id,p_appointment_type,
  p_appointment_date,p_contact_name,p_contact_phone,p_instructions,p_assignee_user_id,p_status,p_notes,p_reminder_days,p_actor_user_id,p_actor,null);
$$;
commit;
