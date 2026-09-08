begin;
set local lock_timeout='5s';
create function public.monitoring_customer_filters_v1(p_customer_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
 'types',coalesce(jsonb_agg(distinct d.device_type order by d.device_type) filter(where d.device_type is not null),'[]'),
 'brands',coalesce(jsonb_agg(distinct d.device_brand order by d.device_brand) filter(where nullif(btrim(d.device_brand),'') is not null),'[]'),
 'models',coalesce(jsonb_agg(distinct d.device_model order by d.device_model) filter(where nullif(btrim(d.device_model),'') is not null),'[]'),
 'cabinets',coalesce(jsonb_agg(distinct d.cabinet order by d.cabinet) filter(where nullif(btrim(d.cabinet),'') is not null),'[]'),
 'network_cables',coalesce(jsonb_agg(distinct d.network_cable_no order by d.network_cable_no) filter(where nullif(btrim(d.network_cable_no),'') is not null),'[]'))
 from public.site_devices d join public.sites s on s.id=d.site_id
 join public.contract_service_types t on t.id=s.contract_service_type_id and t.code='surveillance' and t.is_active
 join public.customer_contract_services c on c.customer_id=s.customer_id and c.service_type_id=t.id and c.is_active
 where s.customer_id=p_customer_id and s.status<>'closed' and d.deleted_at is null and d.device_type is not null;
$$;

create table public.stock_receipt_customers(
 stock_receipt_id uuid not null references public.stock_receipts(id) on delete cascade,
 customer_id uuid not null references public.customers(id) on delete restrict,
 created_by uuid references public.app_users(id),created_at timestamptz not null default now(),
 primary key(stock_receipt_id,customer_id)
);
create index stock_receipt_customers_customer_idx on public.stock_receipt_customers(customer_id,stock_receipt_id);
create function public.set_receipt_customers_v1(p_receipt_id uuid,p_customer_ids uuid[],p_actor_user_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare v_before jsonb;v_after jsonb;
begin
 if not (public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE') or public.has_app_permission_v1(p_actor_user_id,'purchases','UPDATE')) then raise exception '您的帳號沒有執行此操作的權限。';end if;
 if p_customer_ids is null or cardinality(p_customer_ids)>2000 or array_position(p_customer_ids,null) is not null then raise exception '訂貨客戶格式不正確。';end if;
 if cardinality(p_customer_ids)<>(select count(distinct id) from unnest(p_customer_ids) id) then raise exception '訂貨客戶不可重複。';end if;
 if cardinality(p_customer_ids)<>(select count(*) from public.customers where id=any(p_customer_ids)) then raise exception '部分訂貨客戶不存在。';end if;
 select coalesce(jsonb_agg(customer_id order by customer_id),'[]') into v_before from public.stock_receipt_customers where stock_receipt_id=p_receipt_id;
 delete from public.stock_receipt_customers where stock_receipt_id=p_receipt_id and not(customer_id=any(p_customer_ids));
 insert into public.stock_receipt_customers(stock_receipt_id,customer_id,created_by) select p_receipt_id,id,p_actor_user_id from unnest(p_customer_ids) id on conflict do nothing;
 select coalesce(jsonb_agg(customer_id order by customer_id),'[]') into v_after from public.stock_receipt_customers where stock_receipt_id=p_receipt_id;
 if v_before is distinct from v_after then insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor) values('stock_receipt_customers',p_receipt_id,'update',jsonb_build_object('customer_ids',v_before),jsonb_build_object('customer_ids',v_after),'web',(select username from public.app_users where id=p_actor_user_id));end if;
end;
$$;

create function public.create_stock_receipts_with_customers_v1(p_rows jsonb,p_customer_ids uuid[],p_actor_user_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_row jsonb; v_receipt uuid;v_ids uuid[]:='{}';v_actor text;v_supplier public.suppliers;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE') then raise exception '您的帳號沒有執行此操作的權限。';end if;
 if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 20 then raise exception '每次必須登錄 1 至 20 筆進貨資料。';end if;
 select username into v_actor from public.app_users where id=p_actor_user_id;
 perform 1 from public.inventory_items where id in(select (value->>'inventory_item_id')::uuid from jsonb_array_elements(p_rows)) order by id for update;
 for v_row in select value from jsonb_array_elements(p_rows) loop
  select * into v_supplier from public.suppliers where id=(v_row->>'supplier_id')::uuid;
  if not found or coalesce((v_row->>'quantity')::numeric,0)<=0 or (v_row->>'quantity')::numeric<>trunc((v_row->>'quantity')::numeric) then raise exception '進貨供應商或數量不正確。';end if;
  insert into public.stock_receipts(receipt_date,inventory_item_id,quantity,supplier_id,supplier,note,source,updated_by) values((v_row->>'receipt_date')::date,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,v_supplier.id,v_supplier.name,nullif(btrim(v_row->>'note'),''),'web',v_actor) returning id into v_receipt;
  perform public.set_receipt_customers_v1(v_receipt,p_customer_ids,p_actor_user_id);
  v_ids:=array_append(v_ids,v_receipt);
 end loop;
 return jsonb_build_object('ids',v_ids,'created',cardinality(v_ids));
end;
$$;
create function public.update_stock_receipt_with_customers_v1(p_id uuid,p_row_version integer,p_receipt_date date,p_inventory_item_id uuid,p_quantity numeric,p_supplier_id uuid,p_note text,p_customer_ids uuid[],p_actor_user_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_receipt public.stock_receipts;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','UPDATE') then raise exception '您的帳號沒有執行此操作的權限。';end if;
 select * into v_receipt from public.update_stock_receipt_record_v2(p_id,p_row_version,p_receipt_date,p_inventory_item_id,p_quantity,p_supplier_id,p_note,(select username from public.app_users where id=p_actor_user_id));
 if p_customer_ids is not null then perform public.set_receipt_customers_v1(p_id,p_customer_ids,p_actor_user_id);end if;
 return to_jsonb(v_receipt);
end;
$$;

create table public.phone_terminal_versions(
 id uuid primary key default gen_random_uuid(),customer_id uuid not null references public.customers(id),
 service_id uuid not null references public.contract_service_types(id),version_no integer not null check(version_no>0),
 name text not null check(length(btrim(name)) between 1 and 120),effective_date date not null,note text check(length(note)<=2000),
 is_current boolean not null default true,created_by uuid references public.app_users(id),created_at timestamptz not null default now(),
 unique(customer_id,service_id,version_no)
);
create unique index phone_terminal_current_idx on public.phone_terminal_versions(customer_id,service_id) where is_current;
create index phone_terminal_effective_idx on public.phone_terminal_versions(customer_id,service_id,effective_date desc,version_no desc);
create table public.phone_terminal_version_items(
 version_id uuid not null references public.phone_terminal_versions(id),terminal_id uuid not null,snapshot jsonb not null,
 primary key(version_id,terminal_id)
);
alter table public.maintenance_events add column phone_terminal_version_id uuid references public.phone_terminal_versions(id);

create function public.prevent_terminal_snapshot_change_v1() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_table_name='phone_terminal_versions' and tg_op='UPDATE' and (to_jsonb(new)-'is_current')=(to_jsonb(old)-'is_current') then return new;end if;
 raise exception '歷史版本為唯讀快照，不可修改或刪除。';
end;
$$;
create trigger phone_version_immutable before update or delete on public.phone_terminal_versions for each row execute function public.prevent_terminal_snapshot_change_v1();
create trigger phone_version_items_immutable before update or delete on public.phone_terminal_version_items for each row execute function public.prevent_terminal_snapshot_change_v1();

create function public.create_phone_terminal_version_v1(p_customer_id uuid,p_service_id uuid,p_name text,p_effective_date date,p_note text,p_actor_user_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_version public.phone_terminal_versions;v_number integer;v_count integer;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'site','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'phone','CREATE') then raise exception '您的帳號沒有執行此操作的權限。';end if;
 perform 1 from public.customers where id=p_customer_id for update;
 if not found or not exists(select 1 from public.customer_contract_services c join public.contract_service_types s on s.id=c.service_type_id where c.customer_id=p_customer_id and c.service_type_id=p_service_id and c.is_active and s.is_active and s.code='phone_system') then raise exception '找不到有效電話承攬。';end if;
 if p_effective_date is null or p_effective_date>current_date then raise exception '生效日期不可晚於今天。';end if;
 select coalesce(max(version_no),0)+1 into v_number from public.phone_terminal_versions where customer_id=p_customer_id and service_id=p_service_id;
 if exists(select 1 from public.phone_terminal_versions where customer_id=p_customer_id and service_id=p_service_id and effective_date>p_effective_date) then raise exception '新版本生效日期不可早於既有版本。';end if;
 update public.phone_terminal_versions set is_current=false where customer_id=p_customer_id and service_id=p_service_id and is_current;
 insert into public.phone_terminal_versions(customer_id,service_id,version_no,name,effective_date,note,created_by) values(p_customer_id,p_service_id,v_number,p_name,p_effective_date,nullif(btrim(p_note),''),p_actor_user_id) returning * into v_version;
 insert into public.phone_terminal_version_items(version_id,terminal_id,snapshot)
 select v_version.id,t.id,jsonb_build_object('terminal',to_jsonb(t)-'updated_at'-'created_at'-'row_version'-'updated_by','extension',to_jsonb(e)-'updated_at'-'created_at'-'row_version'-'updated_by')
 from public.phone_terminal_points t left join public.phone_extensions e on e.id=t.phone_extension_id where t.customer_id=p_customer_id and t.contract_service_type_id=p_service_id;
 get diagnostics v_count=row_count;
 insert into public.audit_logs(entity_type,entity_id,action,after_data,source,actor) values('phone_terminal_versions',v_version.id,'insert',to_jsonb(v_version)||jsonb_build_object('item_count',v_count),'web',(select username from public.app_users where id=p_actor_user_id));
 return to_jsonb(v_version)||jsonb_build_object('item_count',v_count);
end;
$$;

create function public.attach_phone_version_to_maintenance_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare v_customer uuid;v_service uuid;v_date date;v_event uuid;v_version uuid;
begin
 if tg_table_name='maintenance_events' then
  if new.work_log_id is null or new.phone_terminal_version_id is not null then return new;end if;
  select p.customer_id into v_customer from public.site_work_logs l join public.projects p on p.id=l.project_id where l.id=new.work_log_id;
  v_service:=new.service_id;v_date:=new.occurred_at;
 else
  select e.customer_id,m.service_id,m.occurred_at,m.id into v_customer,v_service,v_date,v_event from public.equipment_registry e join public.maintenance_events m on m.id=new.event_id where e.id=new.equipment_id and m.phone_terminal_version_id is null and e.source_table like 'phone_%';
 end if;
 select id into v_version from public.phone_terminal_versions where customer_id=v_customer and service_id=v_service and effective_date<=v_date order by effective_date desc,version_no desc limit 1;
 if tg_table_name='maintenance_events' then new.phone_terminal_version_id:=v_version;
 elsif v_version is not null then update public.maintenance_events set phone_terminal_version_id=v_version where id=v_event and phone_terminal_version_id is null;end if;
 return new;
end;
$$;
create trigger attach_phone_version_log before insert on public.maintenance_events for each row execute function public.attach_phone_version_to_maintenance_v1();
create trigger attach_phone_version_equipment after insert on public.maintenance_event_equipment for each row execute function public.attach_phone_version_to_maintenance_v1();

alter table public.stock_receipt_customers enable row level security;
alter table public.phone_terminal_versions enable row level security;
alter table public.phone_terminal_version_items enable row level security;
revoke all on public.stock_receipt_customers,public.phone_terminal_versions,public.phone_terminal_version_items from public,anon,authenticated;
grant all on public.stock_receipt_customers,public.phone_terminal_versions,public.phone_terminal_version_items to service_role;
revoke all on function public.monitoring_customer_filters_v1(uuid),public.set_receipt_customers_v1(uuid,uuid[],uuid),public.create_stock_receipts_with_customers_v1(jsonb,uuid[],uuid),public.update_stock_receipt_with_customers_v1(uuid,integer,date,uuid,numeric,uuid,text,uuid[],uuid),public.prevent_terminal_snapshot_change_v1(),public.create_phone_terminal_version_v1(uuid,uuid,text,date,text,uuid),public.attach_phone_version_to_maintenance_v1() from public,anon,authenticated;
grant execute on function public.monitoring_customer_filters_v1(uuid),public.set_receipt_customers_v1(uuid,uuid[],uuid),public.create_stock_receipts_with_customers_v1(jsonb,uuid[],uuid),public.update_stock_receipt_with_customers_v1(uuid,integer,date,uuid,numeric,uuid,text,uuid[],uuid),public.prevent_terminal_snapshot_change_v1(),public.create_phone_terminal_version_v1(uuid,uuid,text,date,text,uuid),public.attach_phone_version_to_maintenance_v1() to service_role;
CREATE OR REPLACE FUNCTION public.get_equipment_history_v1(p_source_table text, p_source_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_equipment public.equipment_registry; v_events jsonb; v_total integer; v_last date;
begin
  if p_source_table not in ('site_devices','phone_systems','phone_extensions','phone_terminal_points') or p_source_id is null then
    raise exception '設備來源資料不正確。';
  end if;
  select * into v_equipment from public.equipment_registry
  where source_table=p_source_table and source_id=p_source_id;
  if not found then
    return jsonb_build_object('equipment',null,'events','[]'::jsonb,'summary',jsonb_build_object('total',0,'last_maintenance',null));
  end if;
  select count(*),max(events.occurred_at) into v_total,v_last
  from public.maintenance_event_equipment links
  join public.maintenance_events events on events.id=links.event_id
  where links.equipment_id=v_equipment.id and events.status='active';
  select coalesce(jsonb_agg(to_jsonb(history) order by history.occurred_at desc,history.created_at desc),'[]'::jsonb)
  into v_events
  from (
    select events.id,events.work_log_id,events.service_id,events.event_type,events.occurred_at,
      events.description,events.cause,events.result,events.notes,events.phone_terminal_version_id,(select version_no from public.phone_terminal_versions where id=events.phone_terminal_version_id) as phone_terminal_version_no,events.status,events.row_version,events.created_at,events.updated_at,
      coalesce((select jsonb_agg(jsonb_build_object('id',users.id,'display_name',users.display_name) order by users.display_name)
        from public.maintenance_event_workers workers join public.app_users users on users.id=workers.user_id
        where workers.event_id=events.id),'[]'::jsonb) as workers
    from public.maintenance_event_equipment links
    join public.maintenance_events events on events.id=links.event_id
    where links.equipment_id=v_equipment.id and events.status='active'
    order by events.occurred_at desc,events.created_at desc
    limit 100
  ) history;
  return jsonb_build_object('equipment',to_jsonb(v_equipment),'events',v_events,'summary',jsonb_build_object('total',v_total,'last_maintenance',v_last));
end;
$function$
;


-- Apply the same role permission matrix inside existing service-only mutations.
CREATE OR REPLACE FUNCTION public.save_equipment_history_v1(p_equipment_id uuid, p_event jsonb, p_actor_user_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_user public.app_users; v_equipment public.equipment_registry; v_before public.maintenance_events; v_event public.maintenance_events;
  v_id uuid := nullif(p_event->>'id','')::uuid; v_type text := p_event->>'event_type'; v_workers uuid[]; v_worker_count integer; v_result jsonb;
begin
  select * into v_user from public.app_users where id=p_actor_user_id and is_active and public.has_app_permission_v1(p_actor_user_id,'site','VIEW') and public.has_app_permission_v1(p_actor_user_id,'history',case when nullif(p_event->>'id','') is null then 'CREATE' else 'UPDATE' end);
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
end $function$
;;

-- Apply the same role permission matrix inside existing service-only mutations.
CREATE OR REPLACE FUNCTION public.manage_customer_service_v1(p_customer_id uuid, p_service_id uuid, p_action text, p_row_version integer, p_is_active boolean, p_notes text, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_user public.app_users; v_link public.customer_contract_services; v_related boolean;
begin
  select * into v_user from public.app_users where id=p_actor_user_id and is_active and public.has_app_permission_v1(p_actor_user_id,'customers',upper(p_action));
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
end $function$
;;

-- Apply the same role permission matrix inside existing service-only mutations.
CREATE OR REPLACE FUNCTION public.save_monitoring_device_v4(p_id uuid, p_row_version integer, p_customer_id uuid, p_values jsonb, p_credential jsonb, p_actor_user_id uuid)
 RETURNS site_devices
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_user public.app_users; v_old public.site_devices; v_service uuid; v_result public.site_devices;
begin
  select * into v_user from public.app_users where id=p_actor_user_id and is_active and public.has_app_permission_v1(p_actor_user_id,'site','VIEW') and public.has_app_permission_v1(p_actor_user_id,'monitoring',case when p_id is null then 'CREATE' else 'UPDATE' end);
  if not found or (p_credential is not null and not public.has_app_permission_v1(p_actor_user_id,'credentials','UPDATE')) then raise exception '您沒有執行設備修改的權限。'; end if;
  if p_values is null or jsonb_typeof(p_values)<>'object' or exists(select 1 from jsonb_object_keys(p_values) k where k not in ('device_name','ip_address','device_type','network_cable_no','cabinet','device_brand','device_model','details','http_port','supports_audio','manual_url','status')) then raise exception '設備修改欄位不正確。'; end if;
  if nullif(btrim(p_values->>'device_name'),'') is null or nullif(btrim(p_values->>'device_brand'),'') is null or nullif(btrim(p_values->>'device_model'),'') is null
    or coalesce(p_values->>'device_type','') not in ('camera','monitoring_host','hub') or coalesce(p_values->>'status','') not in ('active','inactive','maintenance') then raise exception '設備名稱、類型、品牌、型號與狀態必須填寫。'; end if;
  select t.id into v_service from public.contract_service_types t join public.customer_contract_services c on c.service_type_id=t.id
    where c.customer_id=p_customer_id and c.is_active and t.is_active and t.code='surveillance' for share of c,t;
  if v_service is null then raise exception '此客戶沒有有效的監控承攬關聯。'; end if;
  if p_id is not null then
    select d.* into v_old from public.site_devices d join public.sites s on s.id=d.site_id
      where d.id=p_id and d.deleted_at is null and s.customer_id=p_customer_id and s.contract_service_type_id=v_service and s.status<>'closed' for update of d;
    if not found or p_row_version is null or v_old.row_version<>p_row_version then raise exception '設備已被其他使用者更新，或不屬於目前客戶，請重新載入。'; end if;
  end if;
  v_result:=public.upsert_monitoring_device_v3(p_id,p_row_version,p_customer_id,
    p_values->>'device_name',p_values->>'ip_address',p_values->>'device_type',p_values->>'network_cable_no',p_values->>'cabinet',p_values->>'device_brand',p_values->>'device_model',p_values->>'details',
    nullif(p_values->>'http_port','')::integer,nullif(p_values->>'supports_audio','')::boolean,
    v_old.resolution_width,v_old.resolution_height,v_old.fps,p_values->>'manual_url',p_values->>'status',p_credential,v_user.username);
  return v_result;
end $function$
;;

-- Apply the same role permission matrix inside existing service-only mutations.
CREATE OR REPLACE FUNCTION public.batch_update_monitoring_devices_v1(p_customer_id uuid, p_rows jsonb, p_patch jsonb, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_row jsonb; v_old public.site_devices; v_values jsonb; v_saved public.site_devices; v_count integer:=0; v_ids uuid[];
begin
  if not exists(select 1 from public.app_users where id=p_actor_user_id and is_active and public.has_app_permission_v1(p_actor_user_id,'site','VIEW') and public.has_app_permission_v1(p_actor_user_id,'monitoring','UPDATE')) then raise exception '您沒有執行設備批次修改的權限。'; end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 200 then raise exception '每次請選擇 1 至 200 筆設備。'; end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb or exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('device_type','device_brand','device_model','network_cable_no','cabinet','http_port','supports_audio','status','manual_url','details')) then raise exception '請選擇有效的批次修改欄位。'; end if;
  select array_agg((value->>'id')::uuid) into v_ids from jsonb_array_elements(p_rows);
  if array_position(v_ids,null) is not null or cardinality(v_ids)<>(select count(distinct x) from unnest(v_ids) x) then raise exception '設備清單含重複或無效編號。'; end if;
  -- Stable lock order; any validation or version failure rolls back the entire call.
  for v_row in select value from jsonb_array_elements(p_rows) order by value->>'id' loop
    select d.* into v_old from public.site_devices d join public.sites s on s.id=d.site_id
      where d.id=(v_row->>'id')::uuid and d.deleted_at is null and s.customer_id=p_customer_id for update of d;
    if not found then raise exception '找不到所選客戶的設備。'; end if;
    v_values:=jsonb_build_object('device_name',v_old.device_name,'ip_address',v_old.ip_address,'device_type',v_old.device_type,
      'device_brand',v_old.device_brand,'device_model',v_old.device_model,'network_cable_no',v_old.network_cable_no,'cabinet',v_old.cabinet,
      'http_port',v_old.http_port,'supports_audio',v_old.supports_audio,'status',v_old.status,'manual_url',v_old.manual_url,'details',v_old.details)||p_patch;
    v_saved:=public.save_monitoring_device_v4(v_old.id,(v_row->>'row_version')::integer,p_customer_id,v_values,null,p_actor_user_id);
    v_count:=v_count+1;
  end loop;
  return jsonb_build_object('updated',v_count);
end $function$
;;

commit;
