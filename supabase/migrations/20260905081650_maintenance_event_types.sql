-- Expand storage compatibility without rewriting any historical events.
-- Apply this migration, then the gateway, then the frontend when publishing.
begin;
alter table public.maintenance_events drop constraint maintenance_events_type_check;
alter table public.maintenance_events add constraint maintenance_events_type_check
  check (event_type in ('SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','REPAIR','REPLACEMENT',
    'INSTALLATION','MAINTENANCE','PROGRAM_CONFIG','INSPECTION','OTHER'));

create or replace function public.upsert_customer_project_work_log_with_maintenance_v1(
  p_id uuid,
  p_row_version integer,
  p_project_id uuid,
  p_customer_id uuid,
  p_project_name text,
  p_log_date date,
  p_work_type text,
  p_summary text,
  p_time_period text,
  p_status text,
  p_worker_user_ids uuid[],
  p_reporter_user_id uuid,
  p_maintenance_events jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_work_log_id uuid;
  v_event_json jsonb;
  v_event public.maintenance_events;
  v_before public.maintenance_events;
  v_event_id uuid;
  v_event_type text;
  v_service_id uuid;
  v_occurred_at date;
  v_description text;
  v_cause text;
  v_event_result text;
  v_notes text;
  v_equipment_ids uuid[];
  v_worker_ids uuid[];
  v_event_ids uuid[] := '{}'::uuid[];
  v_before_equipment_ids uuid[];
  v_before_worker_ids uuid[];
  v_equipment_count integer;
  v_worker_count integer;
  v_version integer;
  v_category_id uuid;
  v_inventory_item_id uuid;
  v_repair public.repair_items;
  v_repair_ids uuid[] := '{}'::uuid[];
  v_register_repair boolean;
begin
  if p_maintenance_events is null or jsonb_typeof(p_maintenance_events) <> 'array' or jsonb_array_length(p_maintenance_events) > 20 then
    raise exception '設備維修事件必須是 0 至 20 筆的陣列。';
  end if;

  v_result := public.upsert_customer_project_work_log_v3(
    p_id,p_row_version,p_project_id,p_customer_id,p_project_name,p_log_date,p_work_type,p_summary,
    p_time_period,p_status,p_worker_user_ids,p_reporter_user_id,p_actor
  );
  v_work_log_id := (v_result->'work_log'->>'id')::uuid;

  for v_event_json in select value from jsonb_array_elements(p_maintenance_events)
  loop
    if jsonb_typeof(v_event_json) <> 'object' then raise exception '設備維修事件格式不正確。'; end if;
    v_event_id := nullif(v_event_json->>'id','')::uuid;
    v_version := nullif(v_event_json->>'row_version','')::integer;
    v_event_type := upper(btrim(coalesce(v_event_json->>'event_type','')));
    v_service_id := nullif(v_event_json->>'service_id','')::uuid;
    v_occurred_at := coalesce(nullif(v_event_json->>'occurred_at','')::date,p_log_date);
    v_description := btrim(coalesce(v_event_json->>'description',''));
    v_cause := nullif(btrim(coalesce(v_event_json->>'cause','')),'');
    v_event_result := btrim(coalesce(v_event_json->>'result',''));
    v_category_id := nullif(v_event_json->>'inventory_category_id','')::uuid;
    v_inventory_item_id := nullif(v_event_json->>'inventory_item_id','')::uuid;
    v_register_repair := false;
    v_notes := nullif(btrim(coalesce(v_event_json->>'notes','')),'');

    if v_event_type not in ('SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','REPAIR','REPLACEMENT','INSTALLATION','MAINTENANCE','PROGRAM_CONFIG','INSPECTION','OTHER')
      or v_service_id is null or v_occurred_at is null
      or char_length(v_description) not between 1 and 4000
      or char_length(v_event_result) not between 1 and 2000
      or char_length(coalesce(v_cause,'')) > 2000 or char_length(coalesce(v_notes,'')) > 2000 then
      raise exception '設備維修事件內容、日期、類型或處理結果不完整。';
    end if;

    perform 1 from public.customer_contract_services
    where customer_id = p_customer_id and service_type_id = v_service_id;
    if not found then raise exception '維修事件所選承攬內容不屬於此客戶。'; end if;

    select coalesce(array_agg(distinct equipment_id order by equipment_id),'{}'::uuid[])
    into v_equipment_ids
    from (
      select value::uuid as equipment_id
      from jsonb_array_elements_text(coalesce(v_event_json->'equipment_ids','[]'::jsonb))
    ) equipment;
    if cardinality(v_equipment_ids) > 100 then
      raise exception '每筆設備維修事件最多可選擇 100 台設備。';
    end if;
    select count(*) into v_equipment_count from public.equipment_registry registry
    where registry.id = any(v_equipment_ids) and registry.customer_id = p_customer_id
      and registry.service_id = v_service_id and registry.status = 'active';
    if v_equipment_count <> cardinality(v_equipment_ids) then
      raise exception '部分設備不屬於所選客戶／承攬內容，或設備已停用。';
    end if;

    select coalesce(array_agg(distinct worker_id order by worker_id),'{}'::uuid[])
    into v_worker_ids
    from (
      select value::uuid as worker_id
      from jsonb_array_elements_text(coalesce(v_event_json->'worker_user_ids','[]'::jsonb))
    ) workers;
    if cardinality(v_worker_ids) = 0 then v_worker_ids := coalesce(p_worker_user_ids,'{}'::uuid[]); end if;
    if cardinality(v_worker_ids) > 30 then raise exception '每筆維修事件最多可選擇 30 位處理人員。'; end if;
    select count(*) into v_worker_count from public.app_users users
    where users.id = any(v_worker_ids) and users.is_active = true;
    if v_worker_count <> cardinality(v_worker_ids) then raise exception '部分維修處理人員不存在或已停用。'; end if;

    -- Omitted keys from older clients preserve a previously registered source selection.
    if v_event_id is not null then
      select * into v_before from public.maintenance_events
      where id=v_event_id and work_log_id=v_work_log_id for update;
      if not found then raise exception '找不到此工作日誌的維修事件。'; end if;
      if not (v_event_json ? 'inventory_category_id') then v_category_id := v_before.inventory_category_id; end if;
      if not (v_event_json ? 'inventory_item_id') then v_inventory_item_id := v_before.inventory_item_id; end if;
      if v_before.inventory_item_id is not null and
        (v_inventory_item_id is distinct from v_before.inventory_item_id or v_category_id is distinct from v_before.inventory_category_id) then
        raise exception '此明細已登錄維修品，品項請至維修品管理修改。';
      end if;
    end if;
    -- Deprecated types may only be retained on their original, locked event.
    if v_event_type not in ('SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','REPAIR','REPLACEMENT')
      and (v_event_id is null or v_event_type is distinct from v_before.event_type) then
      raise exception '請選擇新的五種事件類型；舊分類僅可保留原紀錄。';
    end if;
    if v_category_id is not null and not exists (
      select 1 from public.product_categories where id=v_category_id
        and (is_active or (v_event_id is not null and v_before.inventory_category_id=v_category_id))
    ) then raise exception '請選擇有效的設備種類。'; end if;
    if v_inventory_item_id is not null then
      v_register_repair := v_event_id is null or v_before.inventory_item_id is null;
      if v_register_repair and (v_category_id is null or not exists (
        select 1 from public.inventory_items where id=v_inventory_item_id and category_id=v_category_id
      )) then raise exception '設備品項不屬於所選設備種類。'; end if;
    end if;

    if v_event_id is null then
      insert into public.maintenance_events(work_log_id,service_id,event_type,occurred_at,description,cause,result,notes,created_by,updated_by,inventory_category_id,inventory_item_id)
      values(v_work_log_id,v_service_id,v_event_type,v_occurred_at,v_description,v_cause,v_event_result,v_notes,p_reporter_user_id,p_reporter_user_id,v_category_id,v_inventory_item_id)
      returning * into v_event;
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_events',v_event.id,'insert',null,to_jsonb(v_event),'web',p_actor);
    else
      if v_event_id = any(v_event_ids) then raise exception '維修事件資料重複。'; end if;
      select * into v_before from public.maintenance_events where id = v_event_id and work_log_id = v_work_log_id for update;
      if not found then raise exception '找不到此工作日誌的維修事件。'; end if;
      if v_before.status = 'voided' then raise exception '已作廢的維修事件不可修改。'; end if;
      if v_version is null or v_before.row_version <> v_version then raise exception '維修事件已被其他使用者更新，請重新載入。'; end if;
      select coalesce(array_agg(equipment_id order by equipment_id),'{}'::uuid[]) into v_before_equipment_ids
      from public.maintenance_event_equipment where event_id = v_event_id;
      select coalesce(array_agg(user_id order by user_id),'{}'::uuid[]) into v_before_worker_ids
      from public.maintenance_event_workers where event_id = v_event_id;
      update public.maintenance_events
      set service_id=v_service_id,event_type=v_event_type,occurred_at=v_occurred_at,description=v_description,
          cause=v_cause,result=v_event_result,notes=v_notes,inventory_category_id=v_category_id,inventory_item_id=v_inventory_item_id,updated_by=p_reporter_user_id,updated_at=now()
      where id=v_event_id and row_version=v_version returning * into v_event;
      if not found then raise exception '維修事件已被其他使用者更新，請重新載入。'; end if;
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_events',v_event.id,'update',to_jsonb(v_before),to_jsonb(v_event),'web',p_actor);
      if v_before.result is distinct from v_event.result then
        insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
        values('maintenance_event_result',v_event.id,'update',jsonb_build_object('result',v_before.result),jsonb_build_object('result',v_event.result),'web',p_actor);
      end if;
      delete from public.maintenance_event_equipment where event_id = v_event.id;
      delete from public.maintenance_event_workers where event_id = v_event.id;
      if v_before_equipment_ids is distinct from v_equipment_ids then
        insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
        values('maintenance_event_equipment',v_event.id,'update',jsonb_build_object('work_log_id',v_work_log_id,'equipment_ids',v_before_equipment_ids),jsonb_build_object('work_log_id',v_work_log_id,'equipment_ids',v_equipment_ids),'web',p_actor);
      end if;
    end if;

    insert into public.maintenance_event_equipment(event_id,equipment_id)
    select v_event.id,equipment_id from unnest(v_equipment_ids) equipment(equipment_id);
    insert into public.maintenance_event_workers(event_id,user_id)
    select v_event.id,worker_id from unnest(v_worker_ids) workers(worker_id);
    if v_event_id is null then
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_event_equipment',v_event.id,'insert',null,jsonb_build_object('work_log_id',v_work_log_id,'equipment_ids',v_equipment_ids),'web',p_actor);
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_event_workers',v_event.id,'insert',null,jsonb_build_object('work_log_id',v_work_log_id,'user_ids',v_worker_ids),'web',p_actor);
    elsif v_before_worker_ids is distinct from v_worker_ids then
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('maintenance_event_workers',v_event.id,'update',jsonb_build_object('work_log_id',v_work_log_id,'user_ids',v_before_worker_ids),jsonb_build_object('work_log_id',v_work_log_id,'user_ids',v_worker_ids),'web',p_actor);
    end if;
    if v_register_repair then
      insert into public.repair_items(
        customer_id,inventory_item_id,notes,received_on,quantity,status,issue_description,
        source_maintenance_event_id,source,updated_by
      ) values(
        p_customer_id,v_inventory_item_id,v_notes,null,null,null,null,
        v_event.id,'work_log',p_actor
      ) returning * into v_repair;
      insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('repair_items',v_repair.id,'CREATE_REPAIR_ITEM',null,to_jsonb(v_repair),'work_log',p_actor);
      v_repair_ids := array_append(v_repair_ids,v_repair.id);
    end if;
    v_event_ids := array_append(v_event_ids,v_event.id);
  end loop;

  return v_result || jsonb_build_object(
    'maintenance_event_ids',to_jsonb(v_event_ids),
    'maintenance_event_count',cardinality(v_event_ids),
    'created_repair_item_ids',to_jsonb(v_repair_ids)
  );
end;
$$;

revoke all on function public.upsert_customer_project_work_log_with_maintenance_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text) from public, anon, authenticated;
grant execute on function public.upsert_customer_project_work_log_with_maintenance_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text) to service_role;

commit;
