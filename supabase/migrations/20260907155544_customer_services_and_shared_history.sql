begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.customer_contract_services
  add column if not exists is_active boolean not null default true,
  add column if not exists notes text not null default '',
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists row_version integer not null default 1;

create or replace function public.manage_customer_service_v1(
  p_customer_id uuid, p_service_id uuid, p_action text, p_row_version integer,
  p_is_active boolean, p_notes text, p_actor_user_id uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_user public.app_users; v_link public.customer_contract_services; v_related boolean;
begin
  select * into v_user from public.app_users where id=p_actor_user_id and is_active and role='admin';
  if not found then raise exception '您沒有執行承攬內容管理的權限。'; end if;
  if p_action not in ('create','update','delete') or p_is_active is null or char_length(coalesce(p_notes,''))>2000 then raise exception '承攬內容資料不正確。'; end if;
  -- Serialize changes with customer editing and related site creation.
  perform 1 from public.customers where id=p_customer_id for update;
  if not found then raise exception '找不到客戶。'; end if;
  perform 1 from public.contract_service_types where id=p_service_id;
  if not found then raise exception '找不到承攬內容。'; end if;
  -- Invalidate concurrently opened legacy customer forms as well as link editors.
  update public.customers set updated_at=now() where id=p_customer_id;
  if p_is_active and p_action<>'delete' and not exists(select 1 from public.contract_service_types where id=p_service_id and is_active) then raise exception '承攬內容類型已停用。'; end if;
  select * into v_link from public.customer_contract_services where customer_id=p_customer_id and service_type_id=p_service_id for update;
  if p_action='create' then
    if found then raise exception '此客戶已有相同承攬內容，請修改既有項目。'; end if;
    insert into public.customer_contract_services(customer_id,service_type_id,is_active,notes,created_by)
      values(p_customer_id,p_service_id,p_is_active,btrim(coalesce(p_notes,'')),v_user.id) returning * into v_link;
    return jsonb_build_object('record',to_jsonb(v_link),'action','created');
  end if;
  if v_link.customer_id is null then raise exception '找不到客戶承攬內容。'; end if;
  if p_row_version is null or v_link.row_version<>p_row_version then raise exception '承攬內容已被其他使用者更新，請重新載入。'; end if;
  if p_action='delete' then
    select exists(select 1 from public.sites where customer_id=p_customer_id and contract_service_type_id=p_service_id)
      or exists(select 1 from public.projects where customer_id=p_customer_id)
      or exists(select 1 from public.equipment_registry where customer_id=p_customer_id and service_id=p_service_id)
      or exists(select 1 from public.phone_systems where customer_id=p_customer_id and contract_service_type_id=p_service_id)
      or exists(select 1 from public.phone_extensions where customer_id=p_customer_id and contract_service_type_id=p_service_id)
      into v_related;
    if not v_related then
      delete from public.customer_contract_services where customer_id=p_customer_id and service_type_id=p_service_id;
      return jsonb_build_object('action','deleted');
    end if;
  end if;
  update public.customer_contract_services set is_active=case when p_action='delete' then false else p_is_active end,
    notes=case when p_action='delete' then notes else btrim(coalesce(p_notes,'')) end,
    updated_at=now(),row_version=row_version+1
    where customer_id=p_customer_id and service_type_id=p_service_id returning * into v_link;
  return jsonb_build_object('record',to_jsonb(v_link),'action',case when p_action='delete' then 'deactivated' else 'updated' end);
end $$;
revoke all on function public.manage_customer_service_v1(uuid,uuid,text,integer,boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.manage_customer_service_v1(uuid,uuid,text,integer,boolean,text,uuid) to service_role;

-- Preserve old customer form compatibility without deleting historical associations.
do $$
declare v_definition text;
begin
  select pg_get_functiondef(oid) into v_definition from pg_proc where pronamespace='public'::regnamespace and proname='update_customer_with_contracts_v1';
  if v_definition is null then raise exception 'Missing customer update function'; end if;
  v_definition := replace(v_definition,
    'delete from public.customer_contract_services where customer_id = p_id;',
    'update public.customer_contract_services set is_active=false,updated_at=now(),row_version=row_version+1 where customer_id=p_id and is_active and service_type_id not in (select id from public.contract_service_types where code=any(v_codes));');
  v_definition := replace(v_definition,'where types.code = any(v_codes);',
    'where types.code = any(v_codes) on conflict(customer_id,service_type_id) do update set is_active=true,updated_at=now(),row_version=customer_contract_services.row_version+1 where not customer_contract_services.is_active;');
  execute v_definition;
end $$;

create or replace function public.search_equipment_history_v1(p_customer_id uuid,p_service_id uuid,p_search text default '',p_type text default '',p_page integer default 1)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with matched as (
    select * from public.equipment_registry where customer_id=p_customer_id and service_id=p_service_id and status='active'
      and (coalesce(p_type,'')='' or equipment_type=p_type)
      and (coalesce(p_search,'')='' or position(lower(p_search) in lower(search_key || ' ' || display_name))>0)
  ), page as (select * from matched order by display_name,id limit 50 offset (greatest(1,least(10000,p_page))-1)*50),
  summary as (
    select links.equipment_id,count(*) as total,max(events.occurred_at) as last_maintenance
    from page join public.maintenance_event_equipment links on links.equipment_id=page.id
    join public.maintenance_events events on events.id=links.event_id and events.status='active' group by links.equipment_id
  ) select jsonb_build_object('records',coalesce((select jsonb_agg(to_jsonb(page)||jsonb_build_object('total',coalesce(summary.total,0),'last_maintenance',summary.last_maintenance) order by page.display_name,page.id) from page left join summary on summary.equipment_id=page.id),'[]'::jsonb),
    'total',(select count(*) from matched),'page',greatest(1,p_page),'page_size',50,
    'types',(select coalesce(jsonb_agg(distinct equipment_type),'[]'::jsonb) from public.equipment_registry where customer_id=p_customer_id and service_id=p_service_id and status='active'));
$$;
revoke all on function public.search_equipment_history_v1(uuid,uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.search_equipment_history_v1(uuid,uuid,text,text,integer) to service_role;

create or replace function public.save_equipment_history_v1(p_equipment_id uuid,p_event jsonb,p_actor_user_id uuid,p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_user public.app_users; v_equipment public.equipment_registry; v_before public.maintenance_events; v_event public.maintenance_events;
  v_id uuid := nullif(p_event->>'id','')::uuid; v_type text := p_event->>'event_type'; v_workers uuid[]; v_worker_count integer; v_result jsonb;
begin
  select * into v_user from public.app_users where id=p_actor_user_id and is_active and role in ('admin','operator');
  if not found then raise exception '您沒有執行履歷修改的權限。'; end if;
  select * into v_equipment from public.equipment_registry where id=p_equipment_id and status='active' for share;
  if not found then raise exception '找不到有效設備。'; end if;
  if not exists(select 1 from public.customer_contract_services where customer_id=v_equipment.customer_id and service_type_id=v_equipment.service_id and is_active)
    or not exists(select 1 from public.contract_service_types where id=v_equipment.service_id and is_active) then raise exception '設備承攬內容已停用。'; end if;
  if jsonb_typeof(p_event->'worker_user_ids') is distinct from 'array' then raise exception '請選擇處理人員。'; end if;
  select coalesce(array_agg(distinct value::uuid),'{}'::uuid[]) into v_workers from jsonb_array_elements_text(p_event->'worker_user_ids');
  select count(*) into v_worker_count from public.app_users where id=any(v_workers) and is_active;
  if cardinality(v_workers)=0 or cardinality(v_workers)>30 or v_worker_count<>cardinality(v_workers) then raise exception '請選擇有效處理人員。'; end if;
  if v_id is null then
    if p_request_id is null then raise exception '缺少送出識別碼。'; end if;
    if v_type not in ('SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','REPAIR','REPLACEMENT') then raise exception '事件類型不正確。'; end if;
    -- Reuse the existing transactional work-log / maintenance / repair-item pipeline.
    v_result := public.upsert_customer_project_work_log_with_maintenance_v2(
      null,null,null,v_equipment.customer_id,left(v_equipment.display_name||'｜維修／設定',120),
      (p_event->>'occurred_at')::date,'維修紀錄',left(p_event->>'description',2000),null,'completed',v_workers,v_user.id,
      jsonb_build_array(p_event||jsonb_build_object('service_id',v_equipment.service_id,'equipment_ids',jsonb_build_array(v_equipment.id))),v_user.username,p_request_id);
    return v_result;
  end if;
  select events.* into v_before from public.maintenance_events events
    join public.maintenance_event_equipment links on links.event_id=events.id
    where events.id=v_id and links.equipment_id=v_equipment.id and events.service_id=v_equipment.service_id and events.status='active' for update of events;
  if not found then raise exception '找不到此設備的有效履歷。'; end if;
  if nullif(p_event->>'row_version','')::integer is distinct from v_before.row_version then raise exception '履歷已被其他使用者更新，請重新載入。'; end if;
  if v_type not in ('SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','REPAIR','REPLACEMENT') and v_type is distinct from v_before.event_type then raise exception '事件類型不正確。'; end if;
  update public.maintenance_events set event_type=v_type,occurred_at=(p_event->>'occurred_at')::date,
    description=btrim(p_event->>'description'),cause=nullif(btrim(p_event->>'cause'),''),result=btrim(p_event->>'result'),notes=nullif(btrim(p_event->>'notes'),''),updated_by=v_user.id,updated_at=now()
    where id=v_id returning * into v_event;
  delete from public.maintenance_event_workers where event_id=v_id;
  insert into public.maintenance_event_workers(event_id,user_id) select v_id,unnest(v_workers);
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
    values('maintenance_events',v_id,'update',to_jsonb(v_before),to_jsonb(v_event),'web',v_user.username);
  return jsonb_build_object('record',to_jsonb(v_event));
end $$;
revoke all on function public.save_equipment_history_v1(uuid,jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.save_equipment_history_v1(uuid,jsonb,uuid,uuid) to service_role;
commit;
