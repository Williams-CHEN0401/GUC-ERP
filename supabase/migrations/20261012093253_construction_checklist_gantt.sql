begin;
set local lock_timeout='5s';

-- The existing log writer inserts site_id; its project link must be populated
-- before construction and ownership guards inspect project_id (trigger order).
alter trigger site_work_logs_project_link_v1 on public.site_work_logs rename to a_site_work_logs_project_link_v1;

create table public.construction_plan_items (
 id uuid primary key default gen_random_uuid(),
 construction_plan_id uuid not null references public.construction_plans(id) on delete restrict,
 title text not null check(length(btrim(title)) between 1 and 200),
 sort_order integer not null check(sort_order between 0 and 99),
 start_day integer not null default 1 check(start_day between 1 and 3650),
 planned_days integer not null default 1 check(planned_days between 1 and 3650),
 is_completed boolean not null default false,
 completed_at timestamptz,
 completed_by_user_id uuid references public.app_users(id) on delete restrict,
 row_version integer not null default 1,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
 unique(construction_plan_id,id),
 check(start_day+planned_days-1<=3650),
 check(is_completed=(completed_at is not null and completed_by_user_id is not null))
);
create index construction_plan_items_active_idx on public.construction_plan_items(construction_plan_id,sort_order,id) where deleted_at is null;
create index construction_plan_items_completer_idx on public.construction_plan_items(completed_by_user_id);
alter table public.construction_plan_items enable row level security;
revoke all on public.construction_plan_items from public,anon,authenticated;
grant select,insert,update,delete on public.construction_plan_items to service_role;
alter table public.site_work_logs add column construction_item_id uuid;
alter table public.site_work_logs add constraint site_work_logs_construction_item_fk
 foreign key(construction_plan_id,construction_item_id) references public.construction_plan_items(construction_plan_id,id) on delete restrict;
alter table public.site_work_logs add constraint site_work_logs_item_requires_plan check(construction_item_id is null or construction_plan_id is not null);
create index site_work_logs_construction_item_idx on public.site_work_logs(construction_item_id,log_date) where construction_item_id is not null;
create or replace view public.erp_private_site_work_logs with(security_invoker=true) as
 select r.* from public.site_work_logs r where public.erp_private_json_visible_v1(to_jsonb(r));

alter function public.save_construction_plan_v1(uuid,jsonb,boolean) rename to save_construction_plan_without_items_v1;
create function public.save_construction_plan_v1(p_actor_user_id uuid,p_payload jsonb,p_delete boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; entry jsonb; item public.construction_plan_items; ids uuid[]:='{}'; plan_id uuid;
 ordinal integer:=0; duration integer; begin_day integer; new_id uuid; before_items jsonb;
begin
 -- Existing writer supplies private-scope authorization, optimistic lock and audit.
 result:=public.save_construction_plan_without_items_v1(p_actor_user_id,p_payload,p_delete);
 plan_id:=(result->>'id')::uuid;
 if not p_delete and p_payload ? 'items' then
  if jsonb_typeof(p_payload->'items') is distinct from 'array' or jsonb_array_length(p_payload->'items')>100 then raise exception '子項目須為清單，最多 100 項。'; end if;
  if jsonb_array_length(p_payload->'items')>0 and result->>'planned_days' is null then raise exception '使用子項目時請設定預計施工天數。'; end if;
  select coalesce(jsonb_agg(to_jsonb(i) order by sort_order,id),'[]') into before_items from public.construction_plan_items i where construction_plan_id=plan_id and deleted_at is null;
  for entry in select value from jsonb_array_elements(p_payload->'items') loop
   new_id:=(entry->>'id')::uuid;
   if new_id is null or new_id=any(ids) then raise exception '子項目編號缺少或重複。'; end if;
   ids:=array_append(ids,new_id);
   select * into item from public.construction_plan_items where id=new_id for update;
   if item.id is not null and (item.construction_plan_id<>plan_id or item.deleted_at is not null) then raise exception '子項目不屬於此施工規劃。'; end if;
   if nullif(btrim(entry->>'title'),'') is null or length(entry->>'title')>200 then raise exception '子項目名稱須為 1 至 200 字。'; end if;
   begin_day:=(entry->>'start_day')::integer; duration:=(entry->>'planned_days')::integer;
   if begin_day is null or duration is null or begin_day<1 or duration<1 or begin_day::bigint+duration-1>(result->>'planned_days')::integer then raise exception '子項目的預計起始日及天數須在總工期內。'; end if;
   if item.id is null then
    insert into public.construction_plan_items(id,construction_plan_id,title,sort_order,start_day,planned_days)
    values(new_id,plan_id,btrim(entry->>'title'),ordinal,begin_day,duration);
   else
    -- Completion has its own permission checked endpoint, never trust a form flag.
    update public.construction_plan_items set title=btrim(entry->>'title'),sort_order=ordinal,start_day=begin_day,planned_days=duration,updated_at=now(),row_version=row_version+1 where id=new_id;
   end if;
   ordinal:=ordinal+1;
  end loop;
  if exists(select 1 from public.construction_plan_items i where i.construction_plan_id=plan_id and i.deleted_at is null and not(i.id=any(ids))
    and (i.is_completed or exists(select 1 from public.site_work_logs l where l.construction_item_id=i.id))) then raise exception '已有日誌或已完成的子項目不能移除，請保留施工紀錄。'; end if;
  update public.construction_plan_items set deleted_at=now(),updated_at=now(),row_version=row_version+1 where construction_plan_id=plan_id and deleted_at is null and not(id=any(ids));
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
  values('construction_plan_items',plan_id,'update',jsonb_build_object('items',before_items),
   jsonb_build_object('items',(select coalesce(jsonb_agg(to_jsonb(i) order by sort_order,id),'[]') from public.construction_plan_items i where construction_plan_id=plan_id and deleted_at is null)),
   'web',(select username from public.app_users where id=p_actor_user_id));
 end if;
 if not p_delete and result->>'status'<>'cancelled' and exists(select 1 from public.construction_plan_items where construction_plan_id=plan_id and deleted_at is null) then
  if exists(select 1 from public.construction_plan_items where construction_plan_id=plan_id and deleted_at is null and not is_completed) then
   if result->>'status'='completed' then raise exception '請先勾選完成所有子項目，再完成施工規劃。'; end if;
  else
   update public.construction_plans set status='completed' where id=plan_id;
   result:=jsonb_set(result,'{status}','"completed"');
  end if;
 end if;
 return result;
end $$;

create function public.set_construction_item_completed_v1(p_actor_user_id uuid,p_item_id uuid,p_row_version integer,p_completed boolean)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare item public.construction_plan_items; plan public.construction_plans; project public.projects; previous jsonb;
begin
 select * into item from public.construction_plan_items where id=p_item_id;
 if not found then raise exception '找不到施工子項目。'; end if;
 -- Same lock order as plan editing and log saves: plan before item.
 select * into plan from public.construction_plans where id=item.construction_plan_id for update;
 select * into project from public.projects where id=plan.project_id for update;
 select * into item from public.construction_plan_items where id=p_item_id for update;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform public.erp_private_assert_v1(to_jsonb(project));
 if plan.deleted_at is not null or plan.status='cancelled' or project.deleted_at is not null or item.deleted_at is not null then raise exception '此施工規劃或子項目已取消或刪除。'; end if;
 if not (public.construction_project_access_v1(p_actor_user_id,project.id,true)
  or public.has_app_permission_v1(p_actor_user_id,'worklogs','UPDATE') and exists(select 1 from public.construction_plan_assignees where construction_plan_id=plan.id and user_id=p_actor_user_id)) then raise exception '只有專案負責人、管理員或被指派且具修改權限的施工人員可勾選完成。'; end if;
 if p_completed is null or item.row_version is distinct from p_row_version then raise exception '子項目已被其他使用者更新，請重新讀取。'; end if;
 previous:=to_jsonb(item);
 update public.construction_plan_items set is_completed=p_completed,completed_at=case when p_completed then now() end,
  completed_by_user_id=case when p_completed then p_actor_user_id end,row_version=row_version+1,updated_at=now() where id=item.id returning * into item;
 update public.construction_plans set status=case
  when not exists(select 1 from public.construction_plan_items where construction_plan_id=plan.id and deleted_at is null and not is_completed) then 'completed'
  when status='completed' or p_completed then 'in_progress' else status end,updated_at=now(),row_version=row_version+1 where id=plan.id;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('construction_plan_items',item.id,'update',previous,to_jsonb(item),'web',(select username from public.app_users where id=p_actor_user_id));
 return to_jsonb(item);
end $$;

-- Stamp links within the existing writer so audit and idempotent replies agree.
create function public.preserve_construction_item_v1() returns trigger
language plpgsql security invoker set search_path='' as $$
declare expected uuid:=nullif(current_setting('app.construction_item_id',true),'')::uuid;
begin
 if TG_OP='INSERT' then
  if new.construction_item_id is not null and new.construction_item_id is distinct from expected then raise exception '子項目關聯需由施工日誌流程建立。'; end if;
  new.construction_item_id:=expected;
 elsif new.construction_item_id is distinct from old.construction_item_id then
  raise exception '不能變更施工日誌的子項目關聯。';
 end if;
 if new.construction_item_id is not null and not exists(select 1 from public.construction_plan_items where id=new.construction_item_id and construction_plan_id=new.construction_plan_id and deleted_at is null) then raise exception '日誌與施工子項目不相符。'; end if;
 return new;
end $$;
-- Alphabetically after preserve_construction_log, which supplies the plan ID.
create trigger preserve_construction_subitem before insert or update on public.site_work_logs for each row execute function public.preserve_construction_item_v1();
alter function public.save_construction_work_log_v1(uuid,uuid,jsonb) rename to save_construction_work_log_without_item_v1;
create function public.save_construction_work_log_v1(p_actor_user_id uuid,p_plan_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare item_id uuid:=(p_payload->>'construction_item_id')::uuid; log_id uuid:=(p_payload->>'id')::uuid; old_item uuid; result jsonb;
 old_context text:=current_setting('app.construction_item_id',true);
begin
 perform public.assert_construction_log_access_v1(p_actor_user_id,p_plan_id,log_id,case when log_id is null then 'CREATE' else 'UPDATE' end);
 if log_id is not null then
  select construction_item_id into old_item from public.site_work_logs where id=log_id;
  if p_payload ? 'construction_item_id' and item_id is distinct from old_item then raise exception '不能變更施工日誌的子項目關聯。'; end if;
  item_id:=old_item;
 elsif exists(select 1 from public.construction_plan_items where construction_plan_id=p_plan_id and deleted_at is null) and item_id is null then
  raise exception '請選擇工作日誌所屬的施工子項目。';
 end if;
 if item_id is not null and not exists(select 1 from public.construction_plan_items where id=item_id and construction_plan_id=p_plan_id and deleted_at is null) then raise exception '子項目不屬於此施工規劃。'; end if;
 perform set_config('app.construction_item_id',coalesce(item_id::text,''),true);
 result:=public.save_construction_work_log_without_item_v1(p_actor_user_id,p_plan_id,p_payload);
 if (result#>>'{work_log,construction_item_id}')::uuid is distinct from item_id then raise exception '送出識別碼已用於其他子項目，請重新載入。'; end if;
 perform set_config('app.construction_item_id',coalesce(old_context,''),true);
 return result;
end $$;

create or replace function public.construction_scope_v1(p_actor_user_id uuid,p_project_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare data jsonb; plans jsonb; today date:=(now() at time zone 'Asia/Taipei')::date;
begin
 data:=public.construction_scope_without_progress_v1(p_actor_user_id,p_project_id);
 -- Aggregate only already-authorized plans and non-private rows. Raw worker
 -- notes continue to use the original ownership filter in the base projection.
 with authorized as (select value p from jsonb_array_elements(data->'construction_plans')),
 logs as (
  select l.* from public.site_work_logs l join authorized a on l.construction_plan_id=(a.p->>'id')::uuid
  where l.deleted_at is null and l.work_type='工程施工' and l.log_date<=today and public.erp_private_json_visible_v1(to_jsonb(l))
 ), enriched as (
 select p,coalesce((select jsonb_agg(log_day order by log_day) from (select distinct l.log_date as log_day from logs l where l.construction_plan_id=(p->>'id')::uuid) d),'[]') dates,
  coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object(
   'worked_days',(select count(distinct l.log_date) from logs l where l.construction_item_id=i.id),
   'log_dates',coalesce((select jsonb_agg(log_day order by log_day) from (select distinct l.log_date as log_day from logs l where l.construction_item_id=i.id) d),'[]')) order by i.sort_order,i.id)
   from public.construction_plan_items i where i.construction_plan_id=(p->>'id')::uuid and i.deleted_at is null),'[]') items
 from authorized
 ), measured as (
 select *,jsonb_array_length(dates) days,jsonb_array_length(items) total,
 (select count(*)::int from jsonb_array_elements(items) i where (i->>'is_completed')::boolean) done,
 (select coalesce(jsonb_agg(jsonb_build_object('id',i->>'id','title',i->>'title')),'[]') from jsonb_array_elements(items) i where not (i->>'is_completed')::boolean and (i->>'worked_days')::int=0) unstarted
 from enriched)
 select coalesce(jsonb_agg(p||jsonb_build_object(
 'items',items,'worked_days',days,'completed_days',days,'work_dates',dates,'item_count',total,'completed_item_count',done,
 'completion_percent',case when total>0 then round(100.0*done/total,1) end,
 'progress_percent',case when total>0 then round(100.0*done/total,1) when p->>'planned_days' is not null then round(100.0*days/(p->>'planned_days')::int,1) end,
 'remaining_days',case when p->>'planned_days' is not null then greatest((p->>'planned_days')::int-days,0) end,
 'overrun_days',case when p->>'planned_days' is not null then greatest(days-(p->>'planned_days')::int,0) end,
 'warning_after_days',case when p->>'planned_days' is not null then ceil((p->>'planned_days')::numeric*0.8)::int end,
 'unstarted_items',unstarted,
 'needs_attention',coalesce(p->>'status' not in ('cancelled','completed') and p->>'planned_days' is not null and days>=ceil((p->>'planned_days')::numeric*0.8) and jsonb_array_length(unstarted)>0,false),
 'can_complete_items',p->>'status'<>'cancelled' and ((p->>'can_manage')::boolean or public.has_app_permission_v1(p_actor_user_id,'worklogs','UPDATE')
  and exists(select 1 from public.construction_plan_assignees where construction_plan_id=(p->>'id')::uuid and user_id=p_actor_user_id))
 ) order by p->>'construction_date',p->>'created_at',p->>'id'),'[]') into plans from measured;
 return jsonb_set(data,'{construction_plans}',plans);
end $$;

revoke all on function public.save_construction_plan_v1(uuid,jsonb,boolean),public.save_construction_plan_without_items_v1(uuid,jsonb,boolean),
 public.set_construction_item_completed_v1(uuid,uuid,integer,boolean),public.preserve_construction_item_v1(),
 public.save_construction_work_log_v1(uuid,uuid,jsonb),public.save_construction_work_log_without_item_v1(uuid,uuid,jsonb),public.construction_scope_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.save_construction_plan_v1(uuid,jsonb,boolean),public.save_construction_plan_without_items_v1(uuid,jsonb,boolean),
 public.set_construction_item_completed_v1(uuid,uuid,integer,boolean),public.preserve_construction_item_v1(),
 public.save_construction_work_log_v1(uuid,uuid,jsonb),public.save_construction_work_log_without_item_v1(uuid,uuid,jsonb),public.construction_scope_v1(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
