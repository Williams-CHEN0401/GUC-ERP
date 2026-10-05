begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Extend the existing RBAC matrix, without granting existing non-admin roles new writes.
alter table public.role_permissions drop constraint role_permissions_module_check;
alter table public.role_permissions add constraint role_permissions_module_check check
 (module in ('dashboard','worklogs','purchases','pickups','inventory','customers','projects','suppliers','repairs','reports','backup','settings','site','phone','monitoring','equipment','history','credentials','monitoring_import','users','audit','appointments'));
insert into public.role_permissions(role_code,module,can_view,can_create,can_update,can_delete)
select r.code,'appointments',r.code='admin' or coalesce(p.can_view,false),r.code='admin',r.code='admin',r.code='admin'
from public.app_roles r left join public.role_permissions p on p.role_code=r.code and p.module='projects';

create or replace function public.save_app_role_v1(p_actor_user_id uuid,p_code text,p_name text,p_project_scoped boolean,p_row_version integer,p_permissions jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_before jsonb; v_after jsonb; v_row public.app_roles; v_perm jsonb;
begin
 if not exists(select 1 from public.app_users where id=p_actor_user_id and is_active and role='admin') then raise exception '您的帳號沒有執行此操作的權限。'; end if;
 if p_code='admin' then raise exception '管理員權限固定，不可修改。'; end if;
 if p_permissions is null or jsonb_typeof(p_permissions)<>'array' or jsonb_array_length(p_permissions)>100 then raise exception '角色權限格式不正確。'; end if;
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

create function public.delete_app_role_v1(p_actor_user_id uuid,p_code text,p_row_version integer)
returns void language plpgsql security invoker set search_path='' as $$
declare v_role public.app_roles;
begin
 if not exists(select 1 from public.app_users where id=p_actor_user_id and is_active and role='admin') then raise exception '您的帳號沒有執行此操作的權限。'; end if;
 select * into v_role from public.app_roles where code=p_code for update;
 if not found then raise exception '找不到角色。'; end if;
 if v_role.is_system then raise exception '系統角色不可刪除。'; end if;
 if p_row_version is distinct from v_role.row_version then raise exception '角色已被其他使用者修改，請重新載入。'; end if;
 if exists(select 1 from public.app_users where role=p_code) then raise exception '此角色仍有使用者使用，請先重新指定角色。'; end if;
 delete from public.app_roles where code=p_code;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,source,actor)
 values('app_roles',p_actor_user_id,'delete',to_jsonb(v_role),'web',(select username from public.app_users where id=p_actor_user_id));
end $$;
revoke all on function public.delete_app_role_v1(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.delete_app_role_v1(uuid,text,integer) to service_role;

alter table public.work_assignments add column reminder_days integer not null default 3 check(reminder_days between 0 and 365);
alter table public.work_assignments drop constraint work_assignments_appointment_check;
alter table public.work_assignments add constraint work_assignments_appointment_check check (
 (assignment_type='appointment' and project_id is null and customer_id is not null
  and appointment_type is not null and appointment_type in ('repair','site_visit','quotation','construction') and appointment_date is not null)
 or (assignment_type<>'appointment' and project_id is not null and customer_id is null
  and department_id is null and appointment_type is null and appointment_date is null
  and contact_name is null and contact_phone is null and notes is null));

create function public.upsert_customer_appointment_v2(
  p_id uuid,p_row_version integer,p_customer_id uuid,p_department_id uuid,
  p_appointment_type text,p_appointment_date date,p_contact_name text,p_contact_phone text,
  p_instructions text,p_assignee_user_id uuid,p_status text,p_notes text,p_reminder_days integer,p_actor_user_id uuid,p_actor text
) returns public.work_assignments language plpgsql security invoker set search_path='' as $$
declare v_old public.work_assignments; v_row public.work_assignments;
begin
  -- Page/action permission is independent from appointment row visibility.
  if not public.has_app_permission_v1(p_actor_user_id,'appointments',case when p_id is null then 'CREATE' else 'UPDATE' end) then
    raise exception '您的帳號沒有執行此操作的權限。';
  end if;
  if p_id is not null then
    select * into v_old from public.work_assignments where id=p_id and assignment_type='appointment' for update;
    if not found then raise exception '找不到客戶預約事項。'; end if;
    if p_row_version is distinct from v_old.row_version then raise exception '預約事項已被更新，請重新整理。'; end if;
  end if;
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
      contact_name,contact_phone,instructions,assignee_user_id,created_by_user_id,status,completed_at,notes,reminder_days,updated_by)
    values('appointment',p_customer_id,p_department_id,p_appointment_type,p_appointment_date,
      nullif(btrim(p_contact_name),''),nullif(btrim(p_contact_phone),''),btrim(p_instructions),p_assignee_user_id,p_actor_user_id,
      p_status,case when p_status='completed' then statement_timestamp() end,nullif(btrim(p_notes),''),coalesce(p_reminder_days,3),p_actor) returning * into v_row;
  else
    update public.work_assignments set customer_id=p_customer_id,department_id=p_department_id,
      appointment_type=p_appointment_type,appointment_date=p_appointment_date,contact_name=nullif(btrim(p_contact_name),''),
      contact_phone=nullif(btrim(p_contact_phone),''),instructions=btrim(p_instructions),assignee_user_id=p_assignee_user_id,
      status=p_status,completed_at=case when p_status='completed' then coalesce(v_old.completed_at,statement_timestamp()) end,
      completion_acknowledged_at=case when p_status='completed' and v_old.assignee_user_id=p_assignee_user_id then v_old.completion_acknowledged_at end,
      notes=nullif(btrim(p_notes),''),reminder_days=coalesce(p_reminder_days,v_old.reminder_days),updated_at=statement_timestamp(),updated_by=p_actor,row_version=row_version+1
    where id=p_id returning * into v_row;
  end if;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
  values('work_assignment',v_row.id,case when p_id is null then 'insert' else 'update' end,to_jsonb(v_old),to_jsonb(v_row),'web',p_actor);
  return v_row;
end $$;
revoke all on function public.upsert_customer_appointment_v2(uuid,integer,uuid,uuid,text,date,text,text,text,uuid,text,text,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.upsert_customer_appointment_v2(uuid,integer,uuid,uuid,text,date,text,text,text,uuid,text,text,integer,uuid,text) to service_role;
-- Older Gateway versions keep the same signature and preserve a row's reminder setting.
create or replace function public.upsert_customer_appointment_v1(
 p_id uuid,p_row_version integer,p_customer_id uuid,p_department_id uuid,
 p_appointment_type text,p_appointment_date date,p_contact_name text,p_contact_phone text,
 p_instructions text,p_assignee_user_id uuid,p_status text,p_notes text,p_actor_user_id uuid,p_actor text
) returns public.work_assignments language sql security invoker set search_path='' as $$
 select public.upsert_customer_appointment_v2(p_id,p_row_version,p_customer_id,p_department_id,p_appointment_type,
 p_appointment_date,p_contact_name,p_contact_phone,p_instructions,p_assignee_user_id,p_status,p_notes,null,p_actor_user_id,p_actor);
$$;
commit;
