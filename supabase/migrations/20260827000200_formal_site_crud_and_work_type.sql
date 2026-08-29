-- Align the project-centric site UI with the normalized site tables.
-- No business rows are removed. A site master row is created only when the
-- first structured site entry is saved for a project.

create unique index if not exists sites_project_id_uidx
  on public.sites(project_id)
  where project_id is not null;

update public.site_work_logs
set work_type = case
  when work_type in ('工程施工', '維修紀錄', '維護保養') then work_type
  when work_type in ('維修', '查修') then '維修紀錄'
  when work_type in ('保養', '維護') then '維護保養'
  else '工程施工'
end
where work_type not in ('工程施工', '維修紀錄', '維護保養');

alter table public.site_work_logs
  alter column work_type set default '工程施工';

alter table public.site_work_logs
  drop constraint if exists site_work_logs_work_type_check;

alter table public.site_work_logs
  add constraint site_work_logs_work_type_check
  check (work_type = any (array['工程施工', '維修紀錄', '維護保養']::text[]));

create or replace function public.ensure_project_site_v1(
  p_project_id uuid,
  p_actor text
)
returns public.sites
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site public.sites;
  v_project public.projects;
  v_customer public.customers;
begin
  select * into v_site
  from public.sites
  where project_id = p_project_id
  limit 1;

  if found then
    return v_site;
  end if;

  select * into v_project
  from public.projects
  where id = p_project_id;

  if not found or v_project.customer_id is null then
    raise exception '找不到案場所屬專案或客戶。';
  end if;

  select * into v_customer
  from public.customers
  where id = v_project.customer_id;

  if not found then
    raise exception '找不到案場所屬客戶。';
  end if;

  begin
    select * into v_site
    from public.create_site_auto_number_v1(
      v_project.name,
      v_project.customer_id,
      v_project.id,
      null,
      v_customer.address,
      v_customer.phone,
      case when v_project.status = 'completed' then 'closed' else 'active' end,
      null,
      p_actor
    );
  exception
    when unique_violation then
      select * into v_site
      from public.sites
      where project_id = p_project_id
      limit 1;
  end;

  if v_site.id is null then
    raise exception '無法建立案場與專案的關聯。';
  end if;

  return v_site;
end;
$$;

revoke all on function public.ensure_project_site_v1(uuid, text)
  from public, anon, authenticated;
grant execute on function public.ensure_project_site_v1(uuid, text)
  to service_role;
