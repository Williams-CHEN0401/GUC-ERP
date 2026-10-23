-- Package stock remains in its original unit. Loose lengths have their own
-- ledger dimension; no fractional boxes and no historical transaction rewrite.
alter table public.inventory_items add column meters_per_unit numeric(14,2) check(meters_per_unit>0);
alter table public.pickup_records add column quantity_unit text not null default 'package' check(quantity_unit in('package','meter'));
alter table public.site_return_lines add column quantity_unit text not null default 'package' check(quantity_unit in('package','meter')),
 add column lengths jsonb not null default '[]' check(jsonb_typeof(lengths)='array' and jsonb_array_length(lengths)<=100);
alter table public.stock_adjustments add column quantity_unit text not null default 'package' check(quantity_unit in('package','meter'));

-- All three dates are optional independently of status. Compare only supplied
-- milestones, always against receipt and the last supplied earlier milestone.
alter table public.repair_items drop constraint repair_items_sent_date_check,
 drop constraint repair_items_supplier_return_date_check,drop constraint repair_items_customer_return_date_check,
 drop constraint repair_items_date_order_check;
alter table public.repair_items add constraint repair_items_date_order_check check(
 (sent_to_supplier_on is null or sent_to_supplier_on>=received_on) and
 (returned_from_supplier_on is null or returned_from_supplier_on>=greatest(received_on,sent_to_supplier_on)) and
 (returned_to_customer_on is null or returned_to_customer_on>=greatest(received_on,sent_to_supplier_on,returned_from_supplier_on)));
CREATE OR REPLACE FUNCTION public.upsert_repair_item_v1(p_id uuid, p_row_version integer, p_received_on date, p_customer_id uuid, p_inventory_item_id uuid, p_quantity integer, p_serial_number text, p_issue_description text, p_supplier_id uuid, p_sent_to_supplier_on date, p_returned_from_supplier_on date, p_returned_to_customer_on date, p_status text, p_supplier_reference text, p_notes text, p_actor text)
 RETURNS repair_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_before public.repair_items;
  v_result public.repair_items;
  v_actor text := btrim(coalesce(p_actor, ''));
  -- Transaction-local input from the existing department wrapper. No new RPC/grant.
  v_selection jsonb := nullif(current_setting('app.repair_department_selection',true),'')::jsonb;
  v_department_id uuid;
begin
  if v_selection is not null then
    perform set_config('app.repair_department_selection','',true);
    if jsonb_typeof(v_selection)<>'object'
      or not(v_selection ? 'department_id')
      or (v_selection->>'customer_id')::uuid is distinct from p_customer_id
      or nullif(v_selection->>'id','')::uuid is distinct from p_id then
      raise exception '維修品科室選擇與儲存資料不一致。';
    end if;
    v_department_id:=nullif(v_selection->>'department_id','')::uuid;
    perform 1 from public.customers where id=p_customer_id for update;
  end if;
  if p_received_on is null or p_customer_id is null or p_inventory_item_id is null
     or p_quantity is null or p_quantity < 1
     or btrim(coalesce(p_issue_description, '')) = ''
     or char_length(btrim(p_issue_description)) > 2000
     or p_status is null
     or p_status not in ('received', 'sent_to_supplier', 'supplier_returned', 'returned_to_customer', 'cancelled')
     or char_length(coalesce(p_serial_number, '')) > 160
     or char_length(coalesce(p_supplier_reference, '')) > 160
     or char_length(coalesce(p_notes, '')) > 2000
     or char_length(v_actor) not between 1 and 100 then
    raise exception '請完整填寫有效的維修品資料。';
  end if;

  if p_status not in ('received', 'cancelled') and p_supplier_id is null then
    raise exception '此維修狀態必須選擇送修供應商。';
  end if;
  if (p_sent_to_supplier_on is not null and p_sent_to_supplier_on < p_received_on)
     or (p_returned_from_supplier_on is not null and p_returned_from_supplier_on < greatest(p_received_on,p_sent_to_supplier_on))
     or (p_returned_to_customer_on is not null and p_returned_to_customer_on < greatest(p_received_on,p_sent_to_supplier_on,p_returned_from_supplier_on)) then
    raise exception '維修流程日期順序不正確。';
  end if;

  if p_id is null then
    if p_row_version is not null then
      raise exception '新增維修品不應包含資料版本。';
    end if;
    if v_selection is not null then
      perform public.assert_customer_department_v1(p_customer_id,v_department_id);
    end if;
    insert into public.repair_items (
      received_on, customer_id, department_id, inventory_item_id, quantity, serial_number,
      issue_description, supplier_id, sent_to_supplier_on, returned_from_supplier_on,
      returned_to_customer_on, status, supplier_reference, notes, source, updated_by
    ) values (
      p_received_on, p_customer_id, v_department_id, p_inventory_item_id, p_quantity, nullif(btrim(coalesce(p_serial_number, '')), ''),
      btrim(p_issue_description), p_supplier_id, p_sent_to_supplier_on, p_returned_from_supplier_on,
      p_returned_to_customer_on, p_status, nullif(btrim(coalesce(p_supplier_reference, '')), ''),
      nullif(btrim(coalesce(p_notes, '')), ''), 'web', v_actor
    ) returning * into v_result;

    insert into public.audit_logs(entity_type, entity_id, action, before_data, after_data, source, actor)
    values ('repair_items', v_result.id, 'CREATE_REPAIR_ITEM', null, to_jsonb(v_result), 'web', v_actor);
  else
    if p_row_version is null or p_row_version < 1 then
      raise exception '維修品資料版本不正確。';
    end if;
    select * into v_before from public.repair_items where id = p_id for update;
    if not found or v_before.row_version <> p_row_version then
      raise exception '維修品資料已被其他使用者更新，請重新載入後再修改。';
    end if;

    if v_selection is not null then
      perform public.assert_customer_department_v1(p_customer_id,v_department_id,v_before.department_id,
        v_before.customer_id=p_customer_id);
    else
      v_department_id:=v_before.department_id;
    end if;
    update public.repair_items
    set received_on = p_received_on,
        customer_id = p_customer_id,
        department_id = v_department_id,
        inventory_item_id = p_inventory_item_id,
        quantity = p_quantity,
        serial_number = nullif(btrim(coalesce(p_serial_number, '')), ''),
        issue_description = btrim(p_issue_description),
        supplier_id = p_supplier_id,
        sent_to_supplier_on = p_sent_to_supplier_on,
        returned_from_supplier_on = p_returned_from_supplier_on,
        returned_to_customer_on = p_returned_to_customer_on,
        status = p_status,
        supplier_reference = nullif(btrim(coalesce(p_supplier_reference, '')), ''),
        notes = nullif(btrim(coalesce(p_notes, '')), ''),
        source = 'web',
        updated_by = v_actor
    where id = p_id and row_version = p_row_version
    returning * into v_result;
    if not found then
      raise exception '維修品資料已被其他使用者更新，請重新載入後再修改。';
    end if;

    insert into public.audit_logs(entity_type, entity_id, action, before_data, after_data, source, actor)
    values ('repair_items', v_result.id, 'UPDATE_REPAIR_ITEM', to_jsonb(v_before), to_jsonb(v_result), 'web', v_actor);
  end if;

  return v_result;
exception
  when foreign_key_violation then
    raise exception '客戶、商品或供應商資料不存在，請重新載入後再試。';
  when check_violation then
    raise exception '維修品資料未符合流程或欄位限制。';
end;
$function$;
CREATE OR REPLACE FUNCTION public.current_inventory_quantity(p_inventory_item_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result numeric;
begin
 select coalesce(i.opening_quantity,0)
 +coalesce((select sum(s.quantity) from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id where s.inventory_item_id=i.id and d.receipt_delivery_state is distinct from 'pending'),0)
 -coalesce((select sum(p.quantity) from public.pickup_records p where p.inventory_item_id=i.id and p.quantity_unit='package'),0)
 +coalesce((select sum(a.difference_quantity) from public.stock_adjustments a where a.inventory_item_id=i.id and a.quantity_unit='package'),0)
 into result from public.inventory_items i where i.id=p_inventory_item_id;
 if not found then raise exception '找不到指定品項。';end if;
 return result;
end $function$;
create function public.current_inventory_meters_v1(p_inventory_item_id uuid) returns numeric
language sql stable security invoker set search_path='' as $$
 select coalesce((select sum(difference_quantity) from public.stock_adjustments where inventory_item_id=p_inventory_item_id and quantity_unit='meter'),0)
 -coalesce((select sum(quantity) from public.pickup_records where inventory_item_id=p_inventory_item_id and quantity_unit='meter'),0);
$$;
create function public.guard_cable_profile_v1() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.meters_per_unit is not null and new.unit in('米','m','公尺') then raise exception '原單位已是米，不需要設定每包裝米數。';end if;
 if tg_op='UPDATE' and (new.meters_per_unit is distinct from old.meters_per_unit or new.unit is distinct from old.unit) and
 (exists(select 1 from public.pickup_records where inventory_item_id=old.id and quantity_unit='meter') or
 exists(select 1 from public.site_return_lines where inventory_item_id=old.id and quantity_unit='meter')) then
 raise exception '已有散料歷史，不能改變包裝單位或每包裝米數，以免歷史成本失真。';end if;
 return new;
end $$;
create trigger inventory_cable_profile_guard before insert or update of meters_per_unit,unit on public.inventory_items for each row execute function public.guard_cable_profile_v1();

create function public.guard_cable_pickup_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare i uuid;q numeric;factor numeric;
begin
 for i in select old.inventory_item_id union select new.inventory_item_id loop
  if i is null then continue;end if;
  select meters_per_unit into factor from public.inventory_items where id=i for update;
  if tg_op<>'DELETE' and new.inventory_item_id=i and new.quantity_unit='meter' and factor is null then raise exception '請先設定此品項的每箱／捲米數。';end if;
  q:=public.current_inventory_meters_v1(i);
  if q<0 then raise exception '散料米數不足，不能超領；整箱／整捲庫存不會自動拆用。';end if;
 end loop;
 return null;
end $$;
create constraint trigger pickup_cable_meter_balance after insert or update or delete on public.pickup_records deferrable initially deferred for each row execute function public.guard_cable_pickup_v1();
CREATE OR REPLACE FUNCTION public.erp_stock_totals_v1(p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
begin
 if not exists(select 1 from unnest(array['inventory','purchases','pickups','worklogs','repairs','reports']) m where public.has_app_permission_v1(p_actor_user_id,m,'VIEW')) then raise exception '沒有庫存查看權限。';end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'loose_meters',public.current_inventory_meters_v1(i.id),'quantity',coalesce(i.opening_quantity,0)+coalesce(r.q,0)-coalesce(p.q,0)+coalesce(a.q,0))),'[]') from public.inventory_items i
 left join (select s.inventory_item_id,sum(s.quantity) q from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id where d.receipt_delivery_state is distinct from 'pending' group by s.inventory_item_id) r on r.inventory_item_id=i.id
 left join (select inventory_item_id,sum(quantity) q from public.pickup_records where quantity_unit='package' group by inventory_item_id) p on p.inventory_item_id=i.id
 left join (select inventory_item_id,sum(difference_quantity) q from public.stock_adjustments where quantity_unit='package' group by inventory_item_id) a on a.inventory_item_id=i.id);
end $function$;
CREATE OR REPLACE FUNCTION public.site_return_list_v1(p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare allowed uuid[];
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') then raise exception '沒有案場餘料入庫查看權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 select coalesce(array_agg(p.id),'{}') into allowed from public.projects p where public.site_return_project_visible_v1(p_actor_user_id,p.id);
 return jsonb_build_object(
 'documents',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object('account',u.display_name,'lines',
  coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from public.site_return_lines l where l.document_id=d.id and l.quantity>0),'[]')) order by d.return_date desc,d.created_at desc)
  from public.site_return_documents d join public.app_users u on u.id=d.created_by_user_id where d.status<>'deleted' and d.project_id=any(allowed)),'[]'),
 'projects',coalesce((select jsonb_agg(jsonb_build_object('id',id,'customer_id',customer_id,'name',name,'code',project_code,'department_id',department_id) order by project_code) from public.projects where id=any(allowed)),'[]'),
 'customers',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'code',c.customer_code,'category',c.customer_category) order by c.customer_code) from public.customers c where c.id in(select customer_id from public.projects where id=any(allowed))),'[]'),
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'code',i.inventory_code,'name',i.item_name,'brand',i.brand,'model',i.model,'unit',i.unit,'meters_per_unit',i.meters_per_unit,'category_id',i.category_id,'category',coalesce(c.name,'未分類'),'active',i.inventory_status='active') order by i.inventory_code) from public.inventory_items i left join public.product_categories c on c.id=i.category_id),'[]'),
 'permissions',jsonb_build_object('create',public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE'),'update',public.has_app_permission_v1(p_actor_user_id,'purchases','UPDATE'),'delete',public.has_app_permission_v1(p_actor_user_id,'purchases','DELETE')));
end $function$;
CREATE OR REPLACE FUNCTION public.save_site_return_v1(p_actor_user_id uuid, p_document_id uuid, p_request_id uuid, p_row_version integer, p_action text, p_return_date date, p_customer_id uuid, p_project_id uuid, p_rows jsonb, p_note text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare old_doc public.site_return_documents;new_doc public.site_return_documents;reg public.stock_transaction_documents;
 old_request public.site_return_requests;request_payload jsonb;v_result jsonb;v_actor text;row_data jsonb;line public.site_return_lines;
 v_item uuid;v_line uuid;v_before numeric;v_old numeric;v_new numeric;v_delta numeric;v_issued numeric;v_other numeric;v_version integer;v_status text;v_unit text;v_lengths jsonb;v_factor numeric;
begin
 if p_action is null or p_action not in ('create','update','cancel','delete') or p_document_id is null or p_request_id is null then raise exception '入庫單操作資料不完整。';end if;
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'purchases',case p_action when 'create' then 'CREATE' when 'update' then 'UPDATE' else 'DELETE' end) then raise exception '沒有案場餘料入庫操作權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform pg_advisory_xact_lock(hashtextextended('site-return-request:'||p_request_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('site-return-document:'||p_document_id::text,0));
 select * into old_doc from public.site_return_documents where id=p_document_id for update;
 if old_doc.id is not null and not public.site_return_project_visible_v1(p_actor_user_id,old_doc.project_id) then raise exception '找不到入庫單或沒有存取權限。';end if;
 request_payload:=jsonb_build_object('action',p_action,'date',p_return_date,'customer',p_customer_id,'project',p_project_id,'rows',p_rows,'note',p_note,'version',p_row_version);
 select * into old_request from public.site_return_requests where request_id=p_request_id;
 if found then
  if old_request.actor_user_id<>p_actor_user_id or old_request.document_id<>p_document_id or old_request.payload is distinct from request_payload then raise exception '重試識別碼已用於不同內容，請重新讀取後儲存。';end if;
  return old_request.result;
 end if;
 if p_action='create' then
  if old_doc.id is not null or p_row_version is not null then raise exception '入庫單已建立，請重新讀取，不可重複新增。';end if;
 elsif old_doc.id is null or old_doc.row_version is distinct from p_row_version or old_doc.status<>'active' then
  raise exception '入庫單已變更、取消或刪除，請重新讀取後操作。';
 end if;
 if p_action in ('create','update') then
  if p_return_date is null or p_customer_id is null or p_project_id is null or not public.site_return_project_visible_v1(p_actor_user_id,p_project_id) then raise exception '請選擇可存取的客戶與工作案名。';end if;
  perform 1 from public.projects where id=p_project_id and customer_id=p_customer_id for key share;
  if not found then raise exception '工作案名與客戶不符。';end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 50 or length(coalesce(p_note,''))>500 then raise exception '請填寫 1 至 50 筆材料，備註最多 500 字。';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r)<>'object' or nullif(r->>'inventory_item_id','') is null or (r->>'quantity') is null or (r->>'quantity')::numeric<=0 or (r->>'quantity')::numeric>=1000000000000 or (r->>'quantity')::numeric<>round((r->>'quantity')::numeric,2)) then raise exception '入庫數量須為大於 0、最多兩位小數的有效數字。';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where coalesce(r->>'quantity_unit','package') not in('package','meter')) then raise exception '入庫計量單位不正確。';end if;
  for row_data in select value from jsonb_array_elements(p_rows) loop
   v_unit:=coalesce(row_data->>'quantity_unit','package');
   v_lengths:=coalesce(row_data->'lengths','[]');
   if jsonb_typeof(v_lengths)<>'array' or jsonb_array_length(v_lengths)>100 then raise exception '餘料長度最多 100 段。';end if;
   if exists(select 1 from jsonb_array_elements(v_lengths) n where jsonb_typeof(n)<>'number' or (n::text)::numeric<=0 or (n::text)::numeric<>round((n::text)::numeric,2)) then raise exception '每段米數須為正數，最多兩位小數。';end if;
   if jsonb_array_length(v_lengths)>0 and (v_unit<>'meter' or (select sum((n::text)::numeric) from jsonb_array_elements(v_lengths)n)<>(row_data->>'quantity')::numeric) then raise exception '各段米數合計與入庫米數不符。';end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_rows))<>(select count(distinct r->>'inventory_item_id') from jsonb_array_elements(p_rows) r) then raise exception '同一張入庫單的重複品項請合併數量。';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r left join public.inventory_items i on i.id=(r->>'inventory_item_id')::uuid where i.id is null or i.inventory_status<>'active') then raise exception '部分品項已不存在或停用，請重新選擇。';end if;
 end if;
 -- Same row locks as pickup/receipt/physical count writes; serialize all stock changes.
 perform 1 from public.inventory_items where id in(select inventory_item_id from public.site_return_lines where document_id=p_document_id
 union select (r->>'inventory_item_id')::uuid from jsonb_array_elements(case when p_action in ('create','update') then p_rows else '[]'::jsonb end) r) order by id for update;
 if p_action in ('create','update') then
  for row_data in select value from jsonb_array_elements(p_rows) loop
   v_item:=(row_data->>'inventory_item_id')::uuid;
   v_unit:=coalesce(row_data->>'quantity_unit','package');
   select meters_per_unit into v_factor from public.inventory_items where id=v_item;
   if v_unit='meter' and v_factor is null then raise exception '請先設定此品項的每箱／捲米數。';end if;
   if exists(select 1 from public.site_return_lines where document_id=p_document_id and inventory_item_id=v_item and quantity>0 and quantity_unit<>v_unit) then raise exception '既有入庫明細不能切換計量單位，請取消原單後重新建立。';end if;
   select coalesce(sum(case when quantity_unit='meter' then quantity else quantity*coalesce(v_factor,1) end),0) into v_issued from public.pickup_records where project_id=p_project_id and inventory_item_id=v_item;
   select coalesce(sum(case when l.quantity_unit='meter' then l.quantity else l.quantity*coalesce(v_factor,1) end),0) into v_other from public.site_return_lines l join public.site_return_documents d on d.id=l.document_id where d.project_id=p_project_id and d.status='active' and d.id<>p_document_id and l.inventory_item_id=v_item;
   if (row_data->>'quantity')::numeric*(case when v_unit='meter' then 1 else coalesce(v_factor,1) end)+v_other>v_issued then raise exception '退回數量超過此工作內容可退的領用數量，請核對領料與其他退料單。';end if;
  end loop;
 end if;
 v_status:=case p_action when 'cancel' then 'cancelled' when 'delete' then 'deleted' else 'active' end;
 v_version:=coalesce(old_doc.row_version,0)+1;
 select username into v_actor from public.app_users where id=p_actor_user_id and is_active;
 if p_action='create' then
  -- Global namespace only for return numbering; not a customer or identity record.
  reg:=public.ensure_stock_document_v1('site_return',p_document_id,p_return_date,'00000000-0000-0000-0000-000000000001'::uuid);
  insert into public.site_return_documents(id,document_no,return_date,customer_id,project_id,note,created_by_user_id,updated_by_user_id)
  values(p_document_id,reg.document_no,p_return_date,p_customer_id,p_project_id,coalesce(p_note,''),p_actor_user_id,p_actor_user_id) returning * into new_doc;
 else
  update public.site_return_documents set return_date=case when p_action='update' then p_return_date else return_date end,
  customer_id=case when p_action='update' then p_customer_id else customer_id end,project_id=case when p_action='update' then p_project_id else project_id end,
  note=case when p_action='update' then coalesce(p_note,'') else note end,status=v_status,row_version=v_version,updated_at=now(),updated_by_user_id=p_actor_user_id where id=p_document_id returning * into new_doc;
 end if;
 for v_item in select inventory_item_id from public.site_return_lines where document_id=p_document_id
 union select (r->>'inventory_item_id')::uuid from jsonb_array_elements(case when p_action in ('create','update') then p_rows else '[]'::jsonb end) r loop
  select * into line from public.site_return_lines where document_id=p_document_id and inventory_item_id=v_item;
  v_old:=case when old_doc.status='active' then coalesce(line.quantity,0) else 0 end;
  select coalesce((select (r->>'quantity')::numeric from jsonb_array_elements(p_rows) r where (r->>'inventory_item_id')::uuid=v_item),0) into v_new;
  if p_action not in ('create','update') then v_new:=0;end if;
  v_delta:=v_new-v_old;
  select coalesce((select r->>'quantity_unit' from jsonb_array_elements(p_rows) r where (r->>'inventory_item_id')::uuid=v_item),line.quantity_unit,'package') into v_unit;
  select coalesce((select r->'lengths' from jsonb_array_elements(p_rows) r where (r->>'inventory_item_id')::uuid=v_item),'[]') into v_lengths;
  if p_action in ('create','update') then
   insert into public.site_return_lines(document_id,inventory_item_id,quantity,quantity_unit,lengths) values(p_document_id,v_item,v_new,v_unit,v_lengths)
   on conflict(document_id,inventory_item_id) do update set quantity=excluded.quantity,quantity_unit=excluded.quantity_unit,lengths=excluded.lengths returning id into v_line;
  else v_line:=line.id;end if;
  if v_delta<>0 then
   v_before:=case when v_unit='meter' then public.current_inventory_meters_v1(v_item) else public.current_inventory_quantity(v_item) end;
   if v_before+v_delta<0 then raise exception '退料已被後續領用，回沖會造成負庫存；請先處理後續取貨。';end if;
   insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,site_return_line_id,site_return_version,quantity_unit)
   values(v_item,v_before,v_before+v_delta,'案場餘料入庫 '||new_doc.document_no,gen_random_uuid(),'site_return',v_actor,v_line,v_version,v_unit);
  end if;
 end loop;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('site_return_documents',p_document_id,case p_action when 'create' then 'insert' when 'cancel' then 'update' else p_action end,case when old_doc.id is not null then to_jsonb(old_doc) end,to_jsonb(new_doc),'web',v_actor);
 v_result:=jsonb_build_object('document_id',p_document_id,'document_no',new_doc.document_no,'row_version',v_version,'status',v_status);
 insert into public.site_return_requests(request_id,document_id,actor_user_id,payload,result) values(p_request_id,p_document_id,p_actor_user_id,request_payload,v_result);
 return v_result;
end $function$;
create or replace function public.guard_site_return_pickups_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare p uuid;i uuid;issued numeric;returned numeric;factor numeric;
begin
 for p,i in select old.project_id,old.inventory_item_id union select new.project_id,new.inventory_item_id loop
  if p is null or i is null then continue;end if;
  select coalesce(meters_per_unit,1) into factor from public.inventory_items where id=i for update;
  select coalesce(sum(case when quantity_unit='meter' then quantity else quantity*factor end),0) into issued from public.pickup_records where project_id=p and inventory_item_id=i;
  select coalesce(sum(case when l.quantity_unit='meter' then l.quantity else l.quantity*factor end),0) into returned from public.site_return_lines l join public.site_return_documents d on d.id=l.document_id where d.project_id=p and d.status='active' and l.inventory_item_id=i;
  if returned>issued then raise exception '此工作內容已有餘料退回，請先調整退料單，不能使領用數量低於退料數量。';end if;
 end loop;
 return null;
end $$;
CREATE OR REPLACE FUNCTION public.create_pickup_records_batch_v2(p_rows jsonb, p_created_by_user_id uuid, p_created_by_username text, p_work_log_id uuid, p_request_id uuid, p_actor text DEFAULT 'system'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_number_scope record;v_row jsonb;
  v_normalized jsonb := '[]'::jsonb;
  v_row_number integer := 0;
  v_pickup_date date;
  v_project_id uuid;
  v_inventory_item_id uuid;
  v_quantity numeric;
  v_note text;
  v_item_ids uuid[] := '{}'::uuid[];
  v_project_ids uuid[] := '{}'::uuid[];
  v_locked integer;
  v_existing_count integer;
  v_work_log_project_id uuid;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '取貨批次資料格式不正確。';
  end if;
  if jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 50 then
    raise exception '每次必須登錄 1 至 50 筆取貨資料。';
  end if;
  if p_created_by_user_id is null or p_created_by_username is null then
    raise exception '取貨必須由已登入帳號建立。';
  end if;
  if p_work_log_id is not null and p_request_id is null then
    raise exception '工作日誌取貨缺少防重複識別碼。';
  end if;

  perform 1
  from public.app_users
  where id = p_created_by_user_id
    and username = p_created_by_username
    and is_active = true;
  if not found then
    raise exception '取貨登錄帳號無效或已停用。';
  end if;

  p_request_id:=coalesce(p_request_id,gen_random_uuid());
for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_row_number := v_row_number + 1;
    if jsonb_typeof(v_row) <> 'object' then
      raise exception '第 % 筆取貨資料格式不正確。', v_row_number;
    end if;
    begin
      v_pickup_date := nullif(btrim(v_row ->> 'pickup_date'), '')::date;
      v_project_id := nullif(btrim(v_row ->> 'project_id'), '')::uuid;
      v_inventory_item_id := nullif(btrim(v_row ->> 'inventory_item_id'), '')::uuid;
      v_quantity := nullif(btrim(v_row ->> 'quantity'), '')::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
        raise exception '第 % 筆取貨資料的日期、專案、品項或數量格式不正確。', v_row_number;
    end;
    if v_pickup_date is null or v_project_id is null or v_inventory_item_id is null then
      raise exception '第 % 筆取貨資料不完整。', v_row_number;
    end if;
    if v_quantity is null or v_quantity <= 0 then
      raise exception '第 % 筆取貨數量必須大於 0。', v_row_number;
    end if;

    if v_row ? 'note' and jsonb_typeof(v_row -> 'note') not in ('string', 'null') then
      raise exception '第 % 筆取貨備註須為文字。', v_row_number;
    end if;
    v_note := nullif(btrim(v_row ->> 'note'), '');
    if char_length(v_note) > 500 then
      raise exception '第 % 筆取貨備註不可超過 500 個字。', v_row_number;
    end if;

    v_item_ids := array_append(v_item_ids, v_inventory_item_id);
    v_project_ids := array_append(v_project_ids, v_project_id);
    v_normalized := v_normalized || jsonb_build_array(jsonb_build_object(
      'request_row', v_row_number,
      'pickup_date', v_pickup_date,
      'project_id', v_project_id,
      'inventory_item_id', v_inventory_item_id,
      'quantity', round(v_quantity, 2),'quantity_unit',coalesce(v_row->>'quantity_unit','package'),
      'note', v_note
    ));
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(v_normalized) as rows(value)
    group by value ->> 'pickup_date', value ->> 'project_id', value ->> 'inventory_item_id'
    having count(*) > 1
  ) then
    raise exception '同一批取貨有重複列，請合併數量。';
  end if;

  -- Same request -> log -> inventory lock order as the work-log writer.
  if p_request_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,0));
  end if;
  if p_work_log_id is not null then
    -- A linked batch must belong to exactly one work content. Lock its target
    -- before the log, rather than acquiring the FK lock later while inserting.
    if (select count(distinct id) from unnest(v_project_ids) id) <> 1 then
      raise exception '取貨專案與工作日誌不相符，請重新選擇。';
    end if;
    perform 1 from public.projects where id=any(v_project_ids) for key share;
    select sites.project_id
    into v_work_log_project_id
    from public.site_work_logs logs
    join public.sites sites on sites.id = logs.site_id
    where logs.id = p_work_log_id
    for share of logs;

    if not found or v_work_log_project_id is null then
      raise exception '找不到工作日誌所屬專案。';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(v_normalized) as rows(value)
      where (value ->> 'project_id')::uuid <> v_work_log_project_id
    ) then
      raise exception '取貨專案與工作日誌不相符，請重新選擇。';
    end if;
  end if;

  if p_request_id is not null then
    select count(*)
    into v_existing_count
    from public.pickup_records
    where request_id = p_request_id;

    if v_existing_count > 0 then
      if v_existing_count <> jsonb_array_length(v_normalized)
         or exists (
           select 1
           from jsonb_array_elements(v_normalized) with ordinality as expected(value, row_number)
           full join (
             select *
             from public.pickup_records
             where request_id = p_request_id
           ) existing
             on existing.request_row = expected.row_number
           where expected.value is null
              or existing.id is null
              or existing.pickup_date is distinct from (expected.value ->> 'pickup_date')::date
              or existing.project_id is distinct from (expected.value ->> 'project_id')::uuid
              or existing.inventory_item_id is distinct from (expected.value ->> 'inventory_item_id')::uuid
              or existing.quantity is distinct from (expected.value ->> 'quantity')::numeric
              or existing.quantity_unit is distinct from (expected.value->>'quantity_unit')
              or existing.note is distinct from (expected.value ->> 'note')
              or existing.work_log_id is distinct from p_work_log_id
              or existing.created_by_user_id is distinct from p_created_by_user_id
              or existing.created_by_username is distinct from p_created_by_username
         ) then
        raise exception '此取貨請求識別碼已被其他資料使用，請重新整理後再試。';
      end if;
      return v_existing_count;
    end if;
  end if;

  if exists(select 1 from public.stock_transaction_documents where kind='pickup' and source_request_id=p_request_id) then raise exception '此取貨請求已處理或刪除，請重新建立新單據。';end if;
  select array_agg(distinct ids.value order by ids.value)
  into v_item_ids
  from unnest(v_item_ids) as ids(value);
  select array_agg(distinct ids.value order by ids.value)
  into v_project_ids
  from unnest(v_project_ids) as ids(value);

  perform 1
  from public.inventory_items
  where id = any(v_item_ids)
  order by id
  for update;
  get diagnostics v_locked = row_count;
  if v_locked <> cardinality(v_item_ids) then
    raise exception '部分取貨品項不存在，請重新載入。';
  end if;

  select count(*)
  into v_locked
  from public.projects
  where id = any(v_project_ids);
  if v_locked <> cardinality(v_project_ids) then
    raise exception '部分取貨專案不存在，請重新載入。';
  end if;

  for v_number_scope in select distinct (value->>'project_id')::uuid scope,(value->>'pickup_date')::date actual_date from jsonb_array_elements(v_normalized) order by scope,actual_date loop perform public.ensure_stock_document_v1('pickup',p_request_id,v_number_scope.actual_date,v_number_scope.scope,p_request_id);end loop;
for v_row in select value from jsonb_array_elements(v_normalized)
  loop
    insert into public.pickup_records (
      pickup_date, project_id, inventory_item_id, quantity, note,
      source, updated_by, created_by_user_id, created_by_username,
      work_log_id, request_id, request_row,quantity_unit
    ) values (
      (v_row ->> 'pickup_date')::date,
      (v_row ->> 'project_id')::uuid,
      (v_row ->> 'inventory_item_id')::uuid,
      (v_row ->> 'quantity')::numeric,
      v_row ->> 'note',
      'web', nullif(p_actor, ''), p_created_by_user_id, p_created_by_username,
      p_work_log_id, p_request_id,
      case when p_request_id is null then null else (v_row ->> 'request_row')::integer end,v_row->>'quantity_unit'
    );
  end loop;

  return jsonb_array_length(v_normalized);
end;
$function$;
CREATE OR REPLACE FUNCTION public.save_pickup_document_v1(p_document_id uuid, p_existing jsonb, p_pickup_date date, p_project_id uuid, p_rows jsonb, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_current uuid[];v_expected uuid[];v_submitted uuid[];v_removed uuid[];v_row jsonb;v_id uuid;v_version integer;
  v_actor text;v_creator uuid;v_username text;v_log uuid;v_context text;v_request_row integer;v_ids uuid[]:='{}';
begin
  if p_document_id is null or p_pickup_date is null or p_project_id is null or not public.has_app_permission_v1(p_actor_user_id,'pickups','UPDATE') then raise exception '沒有有效的取貨單資料或操作權限。';end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 50
    or p_existing is null or jsonb_typeof(p_existing)<>'array' or jsonb_array_length(p_existing) not between 1 and 50 then raise exception '取貨明細資料不完整。';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r)<>'object' or nullif(r->>'inventory_item_id','') is null
    or coalesce((r->>'quantity')::numeric,0)<=0 or (r->>'quantity')::numeric<>round((r->>'quantity')::numeric,2) or coalesce(r->>'quantity_unit','package') not in('package','meter') or (coalesce(r->>'quantity_unit','package')='package' and (r->>'quantity')::numeric<>trunc((r->>'quantity')::numeric)) or char_length(coalesce(r->>'note',''))>500)
    then raise exception '取貨明細品項、數量或備註不正確。';end if;
  if (select count(*) from jsonb_array_elements(p_rows))<>(select count(distinct r->>'inventory_item_id') from jsonb_array_elements(p_rows) r) then raise exception '同一張取貨單有重複品項，請合併數量。';end if;
  perform pg_advisory_xact_lock(hashtextextended(p_document_id::text,0));
  perform 1 from public.projects where id=p_project_id for key share;
  if not found then raise exception '找不到指定工作內容。';end if;
  perform 1 from public.site_work_logs where id in(select work_log_id from public.pickup_records where pickup_document_id=p_document_id) order by id for share;
  perform 1 from public.pickup_records where pickup_document_id=p_document_id order by id for update;
  select coalesce(array_agg(id order by id),'{}') into v_current from public.pickup_records where pickup_document_id=p_document_id;
  select coalesce(array_agg((r->>'id')::uuid order by (r->>'id')::uuid),'{}') into v_expected from jsonb_array_elements(p_existing) r;
  select coalesce(array_agg((r->>'id')::uuid order by (r->>'id')::uuid),'{}') into v_submitted from jsonb_array_elements(p_rows) r where nullif(r->>'id','') is not null;
  if cardinality(v_current)=0 or v_current is distinct from v_expected or not(v_submitted<@v_current)
    or cardinality(v_submitted)<>(select count(distinct id) from unnest(v_submitted) id)
    or exists(select 1 from jsonb_array_elements(p_existing) e join public.pickup_records s on s.id=(e->>'id')::uuid where (e->>'row_version')::integer is distinct from s.row_version)
    then raise exception '取貨單已被更新，請重新整理後再修改；原單據未變更。';end if;
  perform 1 from public.inventory_items where id in(select (r->>'inventory_item_id')::uuid from jsonb_array_elements(p_rows) r
    union select inventory_item_id from public.pickup_records where id=any(v_current)) order by id for update;
  select username into v_actor from public.app_users where id=p_actor_user_id and is_active;
  select created_by_user_id,created_by_username,work_log_id into v_creator,v_username,v_log from public.pickup_records where id=any(v_current) order by id limit 1;
  if exists(select 1 from public.pickup_records where id=any(v_current) and (work_log_id is distinct from v_log or project_id<>p_project_id)) then v_log:=null;end if;
  select coalesce(array_agg(id),'{}') into v_removed from unnest(v_current) id where not(id=any(v_submitted));
  if cardinality(v_removed)>0 then
    if not public.has_app_permission_v1(p_actor_user_id,'pickups','DELETE') then raise exception '沒有刪除取貨明細的權限。';end if;
    perform public.delete_pickup_records(v_removed,v_actor);
  end if;
  v_context:=current_setting('app.pickup_document_id',true);perform set_config('app.pickup_document_id',p_document_id::text,true);
  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_id:=nullif(v_row->>'id','')::uuid;
    if v_id is null then
      if not public.has_app_permission_v1(p_actor_user_id,'pickups','CREATE') then raise exception '沒有新增取貨明細的權限。';end if;
      -- New lines retain the original account/log context, not another assignment ID.
      insert into public.pickup_records(pickup_date,project_id,inventory_item_id,quantity,note,source,updated_by,created_by_user_id,created_by_username,work_log_id,quantity_unit)
      values(p_pickup_date,p_project_id,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,nullif(btrim(v_row->>'note'),''),'web',v_actor,v_creator,v_username,v_log,coalesce(v_row->>'quantity_unit','package')) returning id into v_id;
    else
      if exists(select 1 from public.pickup_records where id=v_id and quantity_unit<>coalesce(v_row->>'quantity_unit','package')) then raise exception '既有取貨明細不能切換計量單位，請刪除該列再新增。';end if;
      select row_version into v_version from public.pickup_records where id=v_id;
      perform public.update_pickup_record_v2(v_id,v_version,p_pickup_date,p_project_id,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,v_row->>'note',v_actor);
    end if;
    v_ids:=array_append(v_ids,v_id);
  end loop;
  perform set_config('app.pickup_document_id',coalesce(v_context,''),true);
  return jsonb_build_object('document_id',p_document_id,'ids',v_ids,'saved',cardinality(v_ids));
end $function$;
CREATE OR REPLACE FUNCTION public.work_content_report_v1(p_actor_user_id uuid, p_project_id uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_work_type text DEFAULT NULL::text, p_accounting boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare allowed uuid[]; result jsonb; price_visible boolean; scope_module text;
begin
 scope_module:=case when p_accounting then 'accounting_reports' else 'reports' end;
 if not public.has_app_permission_v1(p_actor_user_id,scope_module,'VIEW') then raise exception '沒有工作內容統計報表查看權限。'; end if;
 if p_from>p_to then raise exception '起始日期不可晚於結束日期。'; end if;
 if nullif(p_work_type,'') is not null and p_work_type not in ('construction','repair') then raise exception '統計報表僅納入工程施工與維修/查修工作內容。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 select coalesce(array_agg(p.id),'{}') into allowed from public.projects p
 join public.app_users u on u.id=p_actor_user_id and u.is_active
 join public.app_roles role on role.code=u.role
 where p.deleted_at is null and p.project_type in ('construction','repair')
 and (nullif(p_work_type,'') is null or p.project_type=p_work_type)
 and public.erp_private_json_visible_v1(to_jsonb(p))
 and (not role.project_scoped or exists(select 1 from public.project_workers w
 where w.project_id=p.id and w.user_id=u.id and (w.can_view or w.is_assignee)));
 if p_project_id is not null and not(p_project_id=any(allowed)) then raise exception '找不到工作內容或沒有統計查看權限。'; end if;
 price_visible:=p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','VIEW');
 select jsonb_build_object('work_types',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.erp_work_content_types_v1() t where t.code in ('construction','repair')),
 'projects',coalesce((select jsonb_agg(to_jsonb(p) order by p.project_code) from public.projects p where p.id=any(allowed)),'[]'),
 'customers',coalesce((select jsonb_agg(to_jsonb(c)) from public.customers c where c.id in(select customer_id from public.projects where id=any(allowed))),'[]'),
 'customer_departments',coalesce((select jsonb_agg(to_jsonb(d)) from public.customer_departments d where d.customer_id in(select customer_id from public.projects where id=any(allowed))),'[]'),
 'price_permissions',jsonb_build_object('view',price_visible,'create',p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','CREATE'),
 'update',p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','UPDATE'),'delete',p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','DELETE'))) into result;
 if p_project_id is null then return result; end if;
 with logs as materialized (
 select l.* from public.site_work_logs l where l.project_id=p_project_id and l.deleted_at is null
 and l.work_type not in ('文書作業','場勘') and l.status in ('in_progress','completed')
 and (p_from is null or l.log_date>=p_from) and (p_to is null or l.log_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(l))),
 materials as materialized (
 select r.*,case when r.quantity_unit='meter' then r.quantity else r.quantity*coalesce(i.meters_per_unit,1) end report_quantity,i.item_name,i.brand,i.model,case when i.meters_per_unit is not null then '米' else i.unit end unit,i.category_id,
 coalesce(nullif(btrim(c.name),''),'未分類') category_name
 from public.pickup_records r join public.inventory_items i on i.id=r.inventory_item_id
 left join public.product_categories c on c.id=i.category_id
 where r.project_id=p_project_id and (p_from is null or r.pickup_date>=p_from) and (p_to is null or r.pickup_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(r))),
 workers as materialized (
 select w.user_id,l.id,l.log_date,u.display_name,u.is_active from logs l
 join public.site_work_log_workers w on w.work_log_id=l.id join public.app_users u on u.id=w.user_id where l.reporter_on_site or w.user_id is distinct from l.reporter_user_id),
 contractor_days as (select log_date,max(subcontractor_count) headcount,count(*) records from logs where subcontractor_count>0 group by log_date),
 returned as materialized (
 select l.id,l.inventory_item_id,case when l.quantity_unit='meter' then l.quantity else l.quantity*coalesce(i.meters_per_unit,1) end quantity,d.return_date,d.document_no,d.id document_id,u.display_name account
 from public.site_return_lines l join public.inventory_items i on i.id=l.inventory_item_id join public.site_return_documents d on d.id=l.document_id
 join public.app_users u on u.id=d.created_by_user_id
 where d.project_id=p_project_id and d.status='active' and l.quantity>0
 and (p_from is null or d.return_date>=p_from) and (p_to is null or d.return_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(d))),
 issued_totals as (select inventory_item_id,sum(report_quantity) quantity,count(*) records,min(pickup_date) first_date,max(pickup_date) recent_date from materials group by inventory_item_id),
 returned_totals as (select inventory_item_id,sum(quantity) quantity,count(*) records,min(return_date) first_date,max(return_date) recent_date from returned group by inventory_item_id),
 mat as (
 select i.id,i.item_name name,i.brand,i.model,case when i.meters_per_unit is not null then '米' else coalesce(nullif(i.unit,''),'未標示單位') end unit,
 i.unit package_unit,coalesce(i.meters_per_unit,1) meters_per_unit,
 i.category_id "categoryId",coalesce(nullif(btrim(c.name),''),'未分類') "categoryName",
 coalesce(issued.quantity,0) "issuedQuantity",coalesce(ret.quantity,0) "returnedQuantity",
 coalesce(issued.quantity,0)-coalesce(ret.quantity,0) quantity,
 coalesce(issued.records,0) "recordCount",coalesce(ret.records,0) "returnRecordCount",
 least(issued.first_date,ret.first_date) "firstDate",greatest(issued.recent_date,ret.recent_date) "recentDate"
 from issued_totals issued full join returned_totals ret using(inventory_item_id)
 join public.inventory_items i on i.id=coalesce(issued.inventory_item_id,ret.inventory_item_id)
 left join public.product_categories c on c.id=i.category_id),
 material_stats as (
 select m."categoryId",m."categoryName",m.unit,m.quantity,m."recordCount",
 to_jsonb(m)||case when price_visible then jsonb_build_object('unit_price',coalesce(manual.unit_price,latest.unit_price)/m.meters_per_unit,'package_unit_price',coalesce(manual.unit_price,latest.unit_price),
 'amount',round(m.quantity*coalesce(manual.unit_price,latest.unit_price)/m.meters_per_unit,2),
 'price_source',case when manual.unit_price is not null then 'manual' when latest.id is not null then 'receipt' else 'missing' end,
 'price_date',case when manual.unit_price is not null then (manual.updated_at at time zone 'Asia/Taipei')::date else latest.receipt_date end,
 'source_receipt_id',case when manual.unit_price is null then latest.id end,
 'source_document_id',case when manual.unit_price is null then latest.receipt_document_id end,
 'source_tax_mode',case when manual.unit_price is null then latest.receipt_tax_mode end,
 'source_tax_rate_basis_points',case when manual.unit_price is null then latest.receipt_tax_rate_basis_points end,
 'source_input_unit_price',case when manual.unit_price is null then latest.input_unit_price end,
 'price_row_version',manual.row_version) else '{}'::jsonb end data from mat m
 left join public.accounting_material_prices manual on manual.project_id=p_project_id and manual.inventory_item_id=m.id
 left join lateral(select s.id,s.receipt_date,s.receipt_document_id,s.unit_price input_unit_price,
 d.receipt_tax_mode,d.receipt_tax_rate_basis_points,
 case when d.receipt_tax_mode='inclusive' then round(s.unit_price*10000/(10000+d.receipt_tax_rate_basis_points),2) else s.unit_price end unit_price
 from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id
 where s.inventory_item_id=m.id and d.receipt_delivery_state is distinct from 'pending' and s.unit_price is not null and public.erp_private_json_visible_v1(to_jsonb(s))
 order by s.receipt_date desc,s.created_at desc,s.id desc limit 1) latest on true),
 category_stats as (
 select s."categoryId" id,max(s."categoryName") name,count(*) "itemCount",sum(s."recordCount") "recordCount",
 sum((s.data->>'amount')::numeric) amount,
 count(*) filter(where s.data->>'unit_price' is null) "unpricedItemCount"
 from material_stats s group by s."categoryId"
 ),
 category_json as (
 select jsonb_build_object('id',c.id,'name',c.name,'itemCount',c."itemCount",'recordCount',c."recordCount",
 'totalsByUnit',coalesce((select jsonb_agg(to_jsonb(t) order by t.unit) from (
  select m.unit,sum(m.quantity) total from mat m where m."categoryId" is not distinct from c.id group by m.unit
 )t),'[]'))||case when price_visible then jsonb_build_object('amount',c.amount,'unpricedItemCount',c."unpricedItemCount") else '{}'::jsonb end data
 from category_stats c
 ),
 worker_stats as (
 select user_id::text id,max(display_name) name,max(display_name)||'（'||left(user_id::text,8)||'）' label,
 bool_or(is_active) active,count(distinct log_date) "constructionDays",count(distinct id) "recordCount",
 min(log_date) "firstDate",max(log_date) "lastDate",max(log_date) "recentDate" from workers group by user_id
 union all select 'subcontractor','代工','代工（天）',true,sum(headcount),sum(records),min(log_date),max(log_date),max(log_date) from contractor_days having count(*)>0),
 labor_days as (
 select user_id::text worker_id,max(display_name) worker_name,log_date,1::bigint headcount from workers group by user_id,log_date
 union all select 'subcontractor','代工',log_date,headcount from contractor_days),
 labor_costs as (
 select d.*,c.daily_wage,round(d.headcount*c.daily_wage,2) labor_amount,c.row_version wage_row_version
 from labor_days d left join public.accounting_worker_wages c on price_visible and c.project_id=p_project_id
 and coalesce(c.worker_user_id::text,'subcontractor')=d.worker_id and c.work_date=d.log_date),
 worker_json as (select w.*,to_jsonb(w)||jsonb_build_object('unit','天')
 ||case when price_visible then (select jsonb_build_object('labor_amount',sum(c.labor_amount),'unpricedDayCount',count(*) filter(where c.daily_wage is null)) from labor_costs c where c.worker_id=w.id) else '{}'::jsonb end data
 from worker_stats w)
 select result||jsonb_build_object('report',jsonb_build_object('error','',
 'materialStats',coalesce((select jsonb_agg(data order by (data->>'recordCount')::int desc,data->>'id') from material_stats),'[]'),
 'materialCategoryStats',coalesce((select jsonb_agg(data order by data->>'name',data->>'id') from category_json),'[]'),
 'workerStats',coalesce((select jsonb_agg(w.data order by w."constructionDays" desc,w.id) from worker_json w),'[]'),
 'returnRows',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'date',r.return_date,'documentId',r.document_id,'documentNo',r.document_no,'itemId',r.inventory_item_id,'categoryId',i.category_id,'quantity',r.quantity,'account',r.account,'item',jsonb_build_object('name',i.item_name,'brand',i.brand,'model',i.model,'unit',case when i.meters_per_unit is not null then '米' else i.unit end)) order by r.return_date desc,r.id) from returned r join public.inventory_items i on i.id=r.inventory_item_id),'[]'),
 'quantityBasis','issued_minus_returns',
 'materialRows',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'date',m.pickup_date,'itemId',m.inventory_item_id,
 'categoryId',m.category_id,'categoryName',m.category_name,'quantity',m.report_quantity,'account',m.created_by_username,'item',jsonb_build_object('name',m.item_name,'brand',m.brand,'model',m.model,'unit',m.unit)) order by m.pickup_date desc,m.id) from materials m),'[]'),
 'dailyRows',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'date',l.log_date,'timePeriod',l.time_period,'summary',l.summary,'status',l.status,
 'workerIds',coalesce((select jsonb_agg(w.user_id) from workers w where w.id=l.id),'[]'),
 'workerNames',coalesce((select jsonb_agg(w.display_name) from workers w where w.id=l.id),'[]'),
 'subcontractorCount',l.subcontractor_count,'reporterOnSite',l.reporter_on_site,'dailyHeadcount',(select count(distinct w.user_id) from workers w where w.log_date=l.log_date)+coalesce((select headcount from contractor_days d where d.log_date=l.log_date),0)) order by l.log_date desc,l.id) from logs l),'[]'),
 'totalsByUnit',coalesce((select jsonb_agg(to_jsonb(t)) from(select unit,sum(quantity) total from mat group by unit)t),'[]'),
 'laborDailyRows',case when price_visible then coalesce((select jsonb_agg(jsonb_build_object(
 'id',c.worker_id||':'||c.log_date::text,'workerId',c.worker_id,'name',c.worker_name,'date',c.log_date,'headcount',c.headcount,
 'daily_wage',c.daily_wage,'labor_amount',c.labor_amount,'wage_row_version',c.wage_row_version) order by c.log_date desc,c.worker_id) from labor_costs c),'[]'::jsonb) else null end,
 'laborTotals',case when price_visible then (select jsonb_build_object('knownAmount',coalesce(sum(labor_amount),0),
 'unpricedDayCount',count(*) filter(where daily_wage is null),'unpricedPersonDays',coalesce(sum(headcount) filter(where daily_wage is null),0),
 'unpricedWorkerCount',count(distinct worker_id) filter(where daily_wage is null),'personDays',coalesce(sum(headcount),0)) from labor_costs) else null end,
 'kpis',jsonb_build_object('materialTypeCount',(select count(*) from mat),'materialRecordCount',(select count(*) from materials),
 'primaryMaterial',(select data from material_stats order by (data->>'recordCount')::int desc,data->>'id' limit 1),
 'constructionDays',(select count(distinct log_date) from logs),'workerCount',(select count(*) from worker_stats where id<>'subcontractor'),'subcontractorPersonDays',(select coalesce(sum(headcount),0) from contractor_days),
 'workerDays',(select count(distinct(user_id,log_date)) from workers)+(select coalesce(sum(headcount),0) from contractor_days),'recentConstructionDate',(select max(log_date) from logs)))) into result;
 -- Plans are left-joined to completed dates, so zero-log plans/items stay visible.
 -- The report authorization and private scope above remain the single boundary.
 with plans as materialized (
  select c.* from public.construction_plans c where c.project_id=p_project_id and c.deleted_at is null
  and public.erp_private_json_visible_v1(to_jsonb(c))
 ), logs as materialized (
  select l.* from public.site_work_logs l join plans c on c.id=l.construction_plan_id
  where l.deleted_at is null and l.work_type='工程施工' and l.log_date<=(now() at time zone 'Asia/Taipei')::date
  and (p_from is null or l.log_date>=p_from) and (p_to is null or l.log_date<=p_to)
  and public.erp_private_json_visible_v1(to_jsonb(l))
 ),
 item_stats as (
  select i.*,case when i.is_completed then i.planned_days else 0 end completed_days,
   (select count(distinct l.log_date)::int from logs l where l.construction_item_id=i.id) worked_days
  from public.construction_plan_items i join plans p on p.id=i.construction_plan_id where i.deleted_at is null
 ), plan_stats as (
  select c.*,(completion->>'completed_days')::numeric completed_days,(completion->>'completion_percent')::numeric completion_percent,
  (select count(distinct l.log_date)::int from logs l where l.construction_plan_id=c.id) worked_days,
  coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object(
   'remaining_days',case when i.planned_days>0 then greatest(i.planned_days-i.completed_days,0) end,
   'overrun_days',case when i.planned_days>0 then greatest(i.worked_days-i.planned_days,0) else 0 end,
   'progress_percent',case when i.is_completed then 100 else 0 end,
   'logs',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'date',l.log_date,'status',l.status,
    'summary',l.summary,'can_open',public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW')) order by l.log_date,l.id)
    from logs l where l.construction_item_id=i.id and public.construction_log_visible_v1(p_actor_user_id,l)),'[]')) order by i.sort_order,i.id)
   from item_stats i where i.construction_plan_id=c.id),'[]') items,
  coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'name',u.display_name) order by u.display_name,u.id)
   from public.construction_plan_assignees a join public.app_users u on u.id=a.user_id where a.construction_plan_id=c.id),'[]') assignees,
  coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'date',l.log_date,'status',l.status,'item_id',l.construction_item_id,
   'summary',l.summary,'can_open',public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW')) order by l.log_date,l.id)
   from logs l where l.construction_plan_id=c.id and public.construction_log_visible_v1(p_actor_user_id,l)),'[]') logs
  from plans c cross join lateral (select public.construction_completion_totals_v1(
   coalesce((select jsonb_agg(to_jsonb(i)) from item_stats i where i.construction_plan_id=c.id),'[]'),c.planned_days,c.status) completion) metrics
 ), enriched as (
  select to_jsonb(p)||jsonb_build_object(
   'remaining_days',case when p.planned_days>0 then greatest(p.planned_days-p.completed_days,0) end,
   'overrun_days',case when p.planned_days>0 then greatest(p.worked_days-p.planned_days,0) else 0 end,
   'progress_percent',p.completion_percent,
   'can_open',public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') and public.construction_project_access_v1(p_actor_user_id,p.project_id,false),
   'completed_item_count',(select count(*) from item_stats i where i.construction_plan_id=p.id and i.is_completed)) data from plan_stats p
 )
 select result||jsonb_build_object('report',(result->'report')||jsonb_build_object(
  'project', (select jsonb_build_object('id',p.id,'code',p.project_code,'name',p.name,'type',t.label,'status',p.status,
   'customer',c.name,'owner',coalesce(nullif(p.assigned_to,''),(select string_agg(u.display_name,'、' order by u.id) from public.project_workers w join public.app_users u on u.id=w.user_id where w.project_id=p.id and w.is_assignee)),
   'createdAt',p.created_at,'completedOn',p.completed_on,'date',p.project_date)
   from public.projects p join public.customers c on c.id=p.customer_id left join public.erp_work_content_types_v1() t on t.code=p.project_type where p.id=p_project_id),
  'constructionPlans',coalesce((select jsonb_agg(data order by data->>'construction_date',data->>'id') from enriched),'[]'),
  'constructionSummary',jsonb_build_object(
   'planCount',(select count(*) from plans),
   'plannedDays',(select coalesce(sum(planned_days),0) from plan_stats where status<>'cancelled'),
   'completedDays',(select coalesce(sum(completed_days),0) from plan_stats where status<>'cancelled'),
   'remainingDays',(select coalesce(sum(greatest(planned_days-completed_days,0)),0) from plan_stats where status<>'cancelled' and planned_days>0),
   'unsetPlanCount',(select count(*) from plans where status<>'cancelled' and coalesce(planned_days,0)=0),
   'workedDays',(select coalesce(sum(worked_days),0) from plan_stats where status<>'cancelled'),
   'progressPercent',(select case when sum(planned_days)>0 then round(100.0*sum(completed_days)/sum(planned_days),1) end from plan_stats where status<>'cancelled'),
   'projectDays',(select count(distinct l.log_date) from logs l join plans c on c.id=l.construction_plan_id where c.status<>'cancelled'),
   'overdueItemCount',(select count(*) from item_stats i join plans p on p.id=i.construction_plan_id where p.status<>'cancelled' and i.planned_days>0 and i.worked_days>i.planned_days)
    +(select count(*) from plan_stats p where p.status<>'cancelled' and jsonb_array_length(p.items)=0 and p.planned_days>0 and p.worked_days>p.planned_days)
  ))) into result;

 if price_visible then
  with documents as (
   select d.*,public.stock_receipt_financials_v1(d.id) financials from public.stock_transaction_documents d
   where d.kind='receipt' and d.receipt_project_id=p_project_id
   and exists(select 1 from public.stock_receipts s where s.receipt_document_id=d.id
     and (p_from is null or s.receipt_date>=p_from) and (p_to is null or s.receipt_date<=p_to))
   and not exists(select 1 from public.stock_receipts s where s.receipt_document_id=d.id
     and not public.erp_private_json_visible_v1(to_jsonb(s)))
  ), doc_rows as (
   select jsonb_build_object('id',d.id,'documentNo',d.document_no,'projectId',d.receipt_project_id,
    'date',(select min(s.receipt_date) from public.stock_receipts s where s.receipt_document_id=d.id),
    'financials',d.financials,'lines',coalesce((select jsonb_agg(jsonb_build_object(
      'id',s.id,'itemId',s.inventory_item_id,'name',i.item_name,'quantity',s.quantity,'unit',i.unit,
      'categoryId',i.category_id,'categoryName',coalesce(c.name,'未分類'),'unit_price',s.unit_price,
      'input_amount',round(s.quantity*s.unit_price,0)) order by s.receipt_line_no,s.id)
      from public.stock_receipts s join public.inventory_items i on i.id=s.inventory_item_id
      left join public.product_categories c on c.id=i.category_id where s.receipt_document_id=d.id),'[]')) data from documents d
  )
  select jsonb_set(result,'{report}',(result->'report')||jsonb_build_object(
   'receiptDocuments',coalesce((select jsonb_agg(data order by data->>'date' desc,data->>'id') from doc_rows),'[]'),
   'receiptTotals',jsonb_build_object('documentCount',(select count(*) from documents),
    'unpricedDocumentCount',(select count(*) from documents where financials->>'total_amount' is null),
    'netAmount',(select sum((financials->>'net_amount')::numeric) from documents),
    'discountAmount',(select sum((financials->>'discount_amount')::numeric) from documents),
    'taxAmount',(select sum((financials->>'tax_amount')::numeric) from documents),
    'totalAmount',(select sum((financials->>'total_amount')::numeric) from documents)),
   'receiptAssociationNote','僅列出以工作內容 ID 明確關聯的進貨單；未分配單據請至進貨管理補選工作內容。進貨歷史總額與領用量乘參考單價分開呈現，不合併加總。')) into result;
 end if;
 return result;
end $function$;
revoke all on function public.current_inventory_meters_v1(uuid),public.guard_cable_profile_v1(),public.guard_cable_pickup_v1() from public,anon,authenticated;
grant execute on function public.current_inventory_meters_v1(uuid),public.guard_cable_profile_v1(),public.guard_cable_pickup_v1() to service_role;
notify pgrst,'reload schema';
