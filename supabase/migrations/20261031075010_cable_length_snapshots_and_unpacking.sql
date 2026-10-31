-- Preserve the current, known cable conversion as a migration baseline. This
-- is not a reconstruction of original historical specifications. Rows whose
-- item never had a length remain null and are never guessed to be 305 metres.
-- No auth, role, RLS, business identity or transaction quantity is replaced.
alter table public.stock_receipts add column meters_per_unit_snapshot numeric(14,2) check(meters_per_unit_snapshot>0),
 add column package_unit_snapshot text, add column cable_snapshot_source text check(cable_snapshot_source in('recorded','migration_baseline'));
alter table public.pickup_records add column meters_per_unit_snapshot numeric(14,2) check(meters_per_unit_snapshot>0),
 add column package_unit_snapshot text, add column cable_snapshot_source text check(cable_snapshot_source in('recorded','migration_baseline'));
alter table public.site_return_lines add column meters_per_unit_snapshot numeric(14,2) check(meters_per_unit_snapshot>0),
 add column package_unit_snapshot text, add column cable_snapshot_source text check(cable_snapshot_source in('recorded','migration_baseline'));
alter table public.accounting_material_prices add column meters_per_unit_snapshot numeric(14,2) check(meters_per_unit_snapshot>0),
 add column package_unit_snapshot text, add column cable_snapshot_source text check(cable_snapshot_source in('recorded','migration_baseline'));
alter table public.pickup_records add column cable_unit_cost_snapshot numeric check(cable_unit_cost_snapshot>=0), add column cable_cost_source_receipt_ids uuid[] not null default '{}';
alter table public.site_return_lines add column cable_unit_cost_snapshot numeric check(cable_unit_cost_snapshot>=0), add column cable_cost_source_receipt_ids uuid[] not null default '{}', add column cable_cost_project_id_snapshot uuid;
update public.stock_receipts r set meters_per_unit_snapshot=i.meters_per_unit,package_unit_snapshot=i.unit,cable_snapshot_source='migration_baseline'
 from public.inventory_items i where i.id=r.inventory_item_id and i.meters_per_unit is not null;
update public.pickup_records r set meters_per_unit_snapshot=i.meters_per_unit,package_unit_snapshot=i.unit,cable_snapshot_source='migration_baseline'
 from public.inventory_items i where i.id=r.inventory_item_id and i.meters_per_unit is not null;
update public.site_return_lines r set meters_per_unit_snapshot=i.meters_per_unit,package_unit_snapshot=i.unit,cable_snapshot_source='migration_baseline'
 from public.inventory_items i where i.id=r.inventory_item_id and i.meters_per_unit is not null;
update public.accounting_material_prices r set meters_per_unit_snapshot=i.meters_per_unit,package_unit_snapshot=i.unit,cable_snapshot_source='migration_baseline'
 from public.inventory_items i where i.id=r.inventory_item_id and i.meters_per_unit is not null;

-- Price basis stays the existing net-of-tax material reference cost; no FIFO
-- accounting is introduced. Future default-length edits cannot change this.
create function public.cable_reference_cost_snapshot_v1(p_item_id uuid,p_project_id uuid,p_actor_user_id uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 if p_actor_user_id is not null then perform public.erp_private_prepare_v1(p_actor_user_id);end if;
 select jsonb_build_object('unit_cost',p.unit_price/coalesce(p.meters_per_unit_snapshot,1),'source_receipt_ids','[]'::jsonb) into result
 from public.accounting_material_prices p where p.project_id=p_project_id and p.inventory_item_id=p_item_id;
 if result is not null then return result;end if;
 select jsonb_build_object('unit_cost',(case when d.receipt_tax_mode='inclusive' then round(r.unit_price*10000/(10000+d.receipt_tax_rate_basis_points),2) else r.unit_price end)/coalesce(r.meters_per_unit_snapshot,1),'source_receipt_ids',jsonb_build_array(r.id)) into result
   from public.stock_receipts r left join public.stock_transaction_documents d on d.kind='receipt' and d.id=r.receipt_document_id
   where r.inventory_item_id=p_item_id and r.unit_price is not null and d.receipt_delivery_state is distinct from 'pending'
   and (p_actor_user_id is null or public.erp_private_json_visible_v1(to_jsonb(r)))
   order by r.receipt_date desc,r.created_at desc,r.id desc limit 1;
 return coalesce(result,jsonb_build_object('unit_cost',null,'source_receipt_ids','[]'::jsonb));
end $$;
-- Missing/deleted source receipts are also hidden: losing provenance must never
-- turn a private price snapshot into public accounting data.
create function public.cable_cost_sources_visible_v1(p_source_ids uuid[]) returns boolean
language sql stable security invoker set search_path='' as $$
 select not exists(select 1 from unnest(p_source_ids) sources(source_id) where not exists(
  select 1 from public.stock_receipts r where r.id=sources.source_id and public.erp_private_json_visible_v1(to_jsonb(r))));
$$;
create function public.cable_reference_unit_cost_v1(p_item_id uuid,p_project_id uuid) returns numeric
language sql security invoker set search_path='' as $$
 select (public.cable_reference_cost_snapshot_v1(p_item_id,p_project_id,nullif(current_setting('app.private_actor',true),'')::uuid)->>'unit_cost')::numeric;
$$;
with baseline as materialized(select p.id,public.cable_reference_cost_snapshot_v1(p.inventory_item_id,p.project_id) data from public.pickup_records p where p.meters_per_unit_snapshot is not null)
update public.pickup_records p set cable_unit_cost_snapshot=(b.data->>'unit_cost')::numeric,cable_cost_source_receipt_ids=array(select jsonb_array_elements_text(b.data->'source_receipt_ids')::uuid) from baseline b where b.id=p.id;
with baseline as materialized(select l.id,public.cable_reference_cost_snapshot_v1(l.inventory_item_id,d.project_id) data from public.site_return_lines l join public.site_return_documents d on d.id=l.document_id where l.meters_per_unit_snapshot is not null)
update public.site_return_lines l set cable_unit_cost_snapshot=(b.data->>'unit_cost')::numeric,cable_cost_source_receipt_ids=array(select jsonb_array_elements_text(b.data->'source_receipt_ids')::uuid),cable_cost_project_id_snapshot=(select project_id from public.site_return_documents where id=l.document_id) from baseline b where b.id=l.id;
set constraints all immediate;

create function public.stamp_cable_transaction_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare profile public.inventory_items;project uuid;cost numeric;reference jsonb;actor uuid;
begin
 select * into profile from public.inventory_items where id=new.inventory_item_id for update;
 if tg_op='UPDATE' and new.inventory_item_id=old.inventory_item_id then
  -- Editing date/quantity/notes does not revalue the historical conversion.
  new.meters_per_unit_snapshot:=old.meters_per_unit_snapshot;
  new.package_unit_snapshot:=old.package_unit_snapshot;
  new.cable_snapshot_source:=old.cable_snapshot_source;
  if tg_table_name in('pickup_records','site_return_lines') then new.cable_unit_cost_snapshot:=old.cable_unit_cost_snapshot;new.cable_cost_source_receipt_ids:=old.cable_cost_source_receipt_ids;end if;
 else
  new.meters_per_unit_snapshot:=profile.meters_per_unit;
  new.package_unit_snapshot:=profile.unit;
  new.cable_snapshot_source:='recorded';
  if tg_table_name='pickup_records' then
   if profile.meters_per_unit is not null then
    select id into actor from public.app_users where username=new.updated_by and is_active;
    actor:=coalesce(actor,new.created_by_user_id);
    if actor is null then raise exception '無法確認領料者，不能建立成本快照。';end if;
    reference:=public.cable_reference_cost_snapshot_v1(new.inventory_item_id,new.project_id,actor);
    new.cable_unit_cost_snapshot:=(reference->>'unit_cost')::numeric;
    new.cable_cost_source_receipt_ids:=array(select jsonb_array_elements_text(reference->'source_receipt_ids')::uuid);
   end if;
  end if;
 end if;
 if tg_table_name='site_return_lines' then
   select project_id into project from public.site_return_documents where id=new.document_id;
   if tg_op='UPDATE' and new.inventory_item_id=old.inventory_item_id and new.quantity=old.quantity and project=old.cable_cost_project_id_snapshot then
    new.cable_cost_project_id_snapshot:=old.cable_cost_project_id_snapshot;
   else
    new.cable_cost_project_id_snapshot:=project;
   if profile.meters_per_unit is not null then
    with movements as (
     select (case when p.quantity_unit='meter' then p.quantity else p.quantity*coalesce(p.meters_per_unit_snapshot,1) end) qty,p.cable_unit_cost_snapshot price
     from public.pickup_records p where p.project_id=project and p.inventory_item_id=new.inventory_item_id
     union all
     select -(case when l.quantity_unit='meter' then l.quantity else l.quantity*coalesce(l.meters_per_unit_snapshot,1) end),l.cable_unit_cost_snapshot
     from public.site_return_lines l join public.site_return_documents d on d.id=l.document_id
     where d.project_id=project and d.status='active' and l.inventory_item_id=new.inventory_item_id and l.document_id<>new.document_id and l.quantity>0)
    select case when count(*) filter(where price is null)>0 then null else sum(qty*price)/nullif(sum(qty),0) end into cost from movements;
    new.cable_unit_cost_snapshot:=cost;
    new.cable_cost_source_receipt_ids:=array(select distinct unnest(p.cable_cost_source_receipt_ids) from public.pickup_records p where p.project_id=project and p.inventory_item_id=new.inventory_item_id);
   end if;
   end if;
 end if;
 -- Explicit accounting price edits intentionally establish a new package quote
 -- at the current specification; unrelated item profile edits do not.
 if tg_table_name='accounting_material_prices' then
  if tg_op='INSERT' or new.unit_price is distinct from old.unit_price then
   new.meters_per_unit_snapshot:=profile.meters_per_unit;new.package_unit_snapshot:=profile.unit;new.cable_snapshot_source:='recorded';
  end if;
 end if;
 return new;
end $$;
create trigger a_cable_transaction_snapshot before insert or update on public.stock_receipts for each row execute function public.stamp_cable_transaction_v1();
create trigger a_cable_transaction_snapshot before insert or update on public.pickup_records for each row execute function public.stamp_cable_transaction_v1();
create trigger a_cable_transaction_snapshot before insert or update on public.site_return_lines for each row execute function public.stamp_cable_transaction_v1();
create trigger a_cable_transaction_snapshot before insert or update on public.accounting_material_prices for each row execute function public.stamp_cable_transaction_v1();
create or replace function public.guard_cable_profile_v1() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.meters_per_unit is not null and new.unit in('米','m','公尺') then raise exception '原單位已是米，不需要設定預設長度。';end if;
 if tg_op='UPDATE' then
  if new.unit is distinct from old.unit and (exists(select 1 from public.stock_receipts where inventory_item_id=old.id) or exists(select 1 from public.pickup_records where inventory_item_id=old.id) or exists(select 1 from public.stock_adjustments where inventory_item_id=old.id)) then raise exception '此品項已有交易，包裝單位不可改變；不同包裝請建立新貨品。';end if;
  if new.meters_per_unit is distinct from old.meters_per_unit then
   if old.meters_per_unit is not null and public.current_inventory_quantity(old.id)<>0 then raise exception '尚有原規格的整包庫存，不能直接改變預設長度；請先用完原包裝，或為新規格建立不同品項。';end if;
   if exists(select 1 from public.stock_receipts r join public.stock_transaction_documents d on d.id=r.receipt_document_id and d.kind='receipt' where r.inventory_item_id=old.id and d.receipt_delivery_state='pending') then raise exception '尚有待確認送達的原規格進貨，請先處理該進貨單，再調整預設長度。';end if;
   if new.meters_per_unit is null and (exists(select 1 from public.pickup_records where inventory_item_id=old.id and meters_per_unit_snapshot is not null) or public.current_inventory_meters_v1(old.id)<>0) then raise exception '此品項已有米數交易，不能移除預設長度。';end if;
   if old.meters_per_unit is null and (exists(select 1 from public.stock_receipts where inventory_item_id=old.id) or exists(select 1 from public.pickup_records where inventory_item_id=old.id) or exists(select 1 from public.stock_adjustments where inventory_item_id=old.id)) then raise exception '舊交易尚無長度快照，不能推測歷史規格；請為後續米數交易建立已設定長度的新貨品。';end if;
  end if;
 end if;
 return new;
end $$;

-- Open only the number of packages required for this meter withdrawal. Both
-- ledger entries and the pickup share the same transaction and item lock.
create function public.unpack_cable_for_pickup_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare factor numeric;loose numeric;packages numeric;available numeric;actor text;
begin
 if new.quantity_unit<>'meter' then return new;end if;
 select meters_per_unit into factor from public.inventory_items where id=new.inventory_item_id for update;
 if factor is null then raise exception '請先設定此品項的預設長度。';end if;
 loose:=public.current_inventory_meters_v1(new.inventory_item_id);
 if tg_op='UPDATE' and old.inventory_item_id=new.inventory_item_id and old.quantity_unit='meter' then loose:=loose+old.quantity;end if;
 if new.quantity>loose then
  packages:=ceil((new.quantity-loose)/factor);available:=public.current_inventory_quantity(new.inventory_item_id);
  if available<packages then raise exception '可用米數不足，散料及整包庫存不足以供應本次取貨。';end if;
  actor:=coalesce(new.updated_by,new.created_by_username,'system');
  insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
   values(new.inventory_item_id,available,available-packages,'米數取貨拆包：'||new.id::text||'；每包 '||factor::text||' 米',gen_random_uuid(),'web',actor,'package');
  insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
   values(new.inventory_item_id,loose,loose+packages*factor,'米數取貨拆包：'||new.id::text||'；'||packages::text||' 包',gen_random_uuid(),'web',actor,'meter');
 end if;
 return new;
end $$;
create trigger b_cable_unpack before insert or update of inventory_item_id,quantity,quantity_unit on public.pickup_records for each row execute function public.unpack_cable_for_pickup_v1();

-- A historical package cannot be returned to today's stock under a different
-- length. Existing rows remain readable/editable for notes and dates; changing
-- their stock quantity requires resolving the old specification explicitly.
create function public.guard_cable_historical_package_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare factor numeric;
begin
 if tg_table_name='pickup_records' then if old.quantity_unit='meter' then return coalesce(new,old);end if;end if;
 select meters_per_unit into factor from public.inventory_items where id=old.inventory_item_id for update;
 if old.meters_per_unit_snapshot is not null and old.meters_per_unit_snapshot is distinct from factor then
  if tg_op='DELETE' then raise exception '此歷史單據的包裝長度與現行規格不同，不能直接刪除並回沖整包庫存；請先核對原規格。';end if;
  if (new.inventory_item_id,new.quantity) is distinct from (old.inventory_item_id,old.quantity) then raise exception '此歷史單據的包裝長度與現行規格不同，不能直接修改庫存數量；備註及日期仍可修改。';end if;
 end if;
 return coalesce(new,old);
end $$;
create trigger a0_cable_historical_package before update or delete on public.stock_receipts for each row execute function public.guard_cable_historical_package_v1();
create trigger a0_cable_historical_package before update or delete on public.pickup_records for each row execute function public.guard_cable_historical_package_v1();
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
   select coalesce((select meters_per_unit_snapshot from public.site_return_lines where document_id=p_document_id and inventory_item_id=v_item),v_factor) into v_factor;
   if v_unit='meter' and v_factor is null then raise exception '請先設定此品項的每箱／捲米數。';end if;
   if v_unit='package' and exists(select 1 from public.pickup_records where project_id=p_project_id and inventory_item_id=v_item and meters_per_unit_snapshot is distinct from v_factor) then raise exception '原領料含不同包裝長度，請按實際剩餘米數退料。';end if;
   if exists(select 1 from public.site_return_lines where document_id=p_document_id and inventory_item_id=v_item and quantity>0 and quantity_unit<>v_unit) then raise exception '既有入庫明細不能切換計量單位，請取消原單後重新建立。';end if;
   select coalesce(sum(case when quantity_unit='meter' then quantity else quantity*coalesce(meters_per_unit_snapshot,1) end),0) into v_issued from public.pickup_records where project_id=p_project_id and inventory_item_id=v_item;
   select coalesce(sum(case when l.quantity_unit='meter' then l.quantity else l.quantity*coalesce(l.meters_per_unit_snapshot,1) end),0) into v_other from public.site_return_lines l join public.site_return_documents d on d.id=l.document_id where d.project_id=p_project_id and d.status='active' and d.id<>p_document_id and l.inventory_item_id=v_item;
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
  if v_delta<>0 and v_unit='package' and line.meters_per_unit_snapshot is not null and line.meters_per_unit_snapshot is distinct from (select meters_per_unit from public.inventory_items where id=v_item) then raise exception '此退料單的包裝長度與現行規格不同，不能直接回沖整包庫存；請先核對原規格。';end if;
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
  select coalesce(sum(case when quantity_unit='meter' then quantity else quantity*coalesce(meters_per_unit_snapshot,1) end),0) into issued from public.pickup_records where project_id=p and inventory_item_id=i;
  select coalesce(sum(case when l.quantity_unit='meter' then l.quantity else l.quantity*coalesce(l.meters_per_unit_snapshot,1) end),0) into returned from public.site_return_lines l join public.site_return_documents d on d.id=l.document_id where d.project_id=p and d.status='active' and l.inventory_item_id=i;
  if returned>issued then raise exception '此工作內容已有餘料退回，請先調整退料單，不能使領用數量低於退料數量。';end if;
 end loop;
 return null;
end $$;
CREATE OR REPLACE FUNCTION public.create_inventory_items_batch_v1(p_rows jsonb, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_row jsonb;
  v_row_number integer := 0;
  v_category_id uuid;
  v_category public.product_categories;
  v_item_name text;
  v_brand text;
  v_model text;
  v_unit text;
  v_opening_quantity numeric;
  v_number bigint;
  v_inventory_code text;
  v_inserted public.inventory_items;
  v_result jsonb := '[]'::jsonb;
  v_key text;
  v_keys text[] := '{}'::text[];
  v_existing_code text;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '品項批次資料格式不正確。';
  end if;
  if jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 20 then
    raise exception '每次必須建立 1 至 20 筆品項。';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_row_number := v_row_number + 1;
    if jsonb_typeof(v_row) <> 'object' then
      raise exception '第 % 筆品項格式不正確。', v_row_number;
    end if;

    begin
      v_category_id := nullif(btrim(v_row ->> 'category_id'),'')::uuid;
      v_opening_quantity := nullif(btrim(v_row ->> 'opening_quantity'),'')::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception '第 % 筆品項種類或期初庫存格式不正確。', v_row_number;
    end;

    v_item_name := btrim(coalesce(v_row ->> 'item_name',''));
    v_brand := btrim(coalesce(v_row ->> 'brand',''));
    v_model := nullif(btrim(coalesce(v_row ->> 'model','')),'');
    if nullif(v_row->>'meters_per_unit','') is not null and ((v_row->>'meters_per_unit')::numeric<=0 or (v_row->>'meters_per_unit')::numeric>=1000000000000 or (v_row->>'meters_per_unit')::numeric<>round((v_row->>'meters_per_unit')::numeric,2)) then raise exception '預設長度須為正數，最多兩位小數。';end if;
    v_unit := btrim(coalesce(v_row ->> 'unit',''));

    if v_category_id is null
       or v_item_name = '' or char_length(v_item_name) > 200
       or v_brand = '' or char_length(v_brand) > 120
       or char_length(coalesce(v_model,'')) > 120
       or v_unit = '' or char_length(v_unit) > 30
       or v_opening_quantity is null
       or v_opening_quantity < 0
       or v_opening_quantity <> trunc(v_opening_quantity)
    then
      raise exception '第 % 筆品項資料不完整，期初庫存須為 0 以上整數。', v_row_number;
    end if;

    select * into v_category
    from public.product_categories
    where id = v_category_id and is_active = true;
    if not found then
      raise exception '第 % 筆請選擇有效的貨品種類。', v_row_number;
    end if;

    v_key := v_category_id::text || '|' || lower(v_item_name) || '|' || lower(v_brand) || '|' || lower(coalesce(v_model,''));
    if v_key = any(v_keys) then
      raise exception '第 % 筆與同批其他品項重複。', v_row_number;
    end if;
    v_keys := array_append(v_keys, v_key);

    select inventory_code into v_existing_code
    from public.inventory_items
    where category_id = v_category_id
      and lower(btrim(item_name)) = lower(v_item_name)
      and lower(btrim(brand)) = lower(v_brand)
      and lower(btrim(coalesce(model,''))) = lower(coalesce(v_model,''))
    limit 1;
    if found then
      raise exception '第 % 筆與既有品項 % 重複。', v_row_number, v_existing_code;
    end if;

    v_number := public.next_business_number_value_v1('inventory:'||v_category.code_prefix);
    if v_number > 999 then
      raise exception '第 % 筆所屬貨品種類的三位數編號已用完。', v_row_number;
    end if;
    v_inventory_code := v_category.code_prefix||lpad(v_number::text,3,'0');

    insert into public.inventory_items(
      inventory_code, category_id, item_type, model, brand, item_name, unit,
      opening_quantity, meters_per_unit, source, updated_by
    )
    values (
      v_inventory_code, v_category.id, v_category.name, v_model, v_brand,
      v_item_name, v_unit, v_opening_quantity, nullif(v_row->>'meters_per_unit','')::numeric, 'web', nullif(p_actor,'')
    )
    returning * into v_inserted;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'id', v_inserted.id,
      'inventory_code', v_inserted.inventory_code
    ));
  end loop;

  return v_result;
exception
  when unique_violation then
    raise exception '品項已存在，請重新載入後檢查種類、名稱、品牌與型號。';
end;
$function$;
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
  coalesce((select jsonb_agg(to_jsonb(l)-'cable_unit_cost_snapshot'-'cable_cost_source_receipt_ids' order by l.id) from public.site_return_lines l where l.document_id=d.id and l.quantity>0),'[]')) order by d.return_date desc,d.created_at desc)
  from public.site_return_documents d join public.app_users u on u.id=d.created_by_user_id where d.status<>'deleted' and d.project_id=any(allowed)),'[]'),
 'projects',coalesce((select jsonb_agg(jsonb_build_object('id',id,'customer_id',customer_id,'name',name,'code',project_code,'department_id',department_id) order by project_code) from public.projects where id=any(allowed)),'[]'),
 'customers',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'code',c.customer_code,'category',c.customer_category) order by c.customer_code) from public.customers c where c.id in(select customer_id from public.projects where id=any(allowed))),'[]'),
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'code',i.inventory_code,'name',i.item_name,'brand',i.brand,'model',i.model,'unit',i.unit,'meters_per_unit',i.meters_per_unit,'category_id',i.category_id,'category',coalesce(c.name,'未分類'),'active',i.inventory_status='active') order by i.inventory_code) from public.inventory_items i left join public.product_categories c on c.id=i.category_id),'[]'),
 'permissions',jsonb_build_object('create',public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE'),'update',public.has_app_permission_v1(p_actor_user_id,'purchases','UPDATE'),'delete',public.has_app_permission_v1(p_actor_user_id,'purchases','DELETE')));
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
 result:=result||jsonb_build_object('managerPerformanceVisible',public.has_app_permission_v1(p_actor_user_id,'projects','UPDATE'),
 'managerPerformance',public.construction_manager_performance_v1(p_actor_user_id,allowed));
 if p_project_id is null then return result; end if;
 with logs as materialized (
 select l.* from public.site_work_logs l where l.project_id=p_project_id and l.deleted_at is null
 and l.work_type not in ('文書作業','場勘') and l.status in ('in_progress','completed') and l.log_date<=(now() at time zone 'Asia/Taipei')::date
 and (p_from is null or l.log_date>=p_from) and (p_to is null or l.log_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(l))),
 materials as materialized (
 select r.*,case when public.cable_cost_sources_visible_v1(r.cable_cost_source_receipt_ids) then r.cable_unit_cost_snapshot end visible_cable_cost,case when r.quantity_unit='meter' then r.quantity else r.quantity*coalesce(r.meters_per_unit_snapshot,1) end report_quantity,i.item_name,i.brand,i.model,case when i.meters_per_unit is not null then '米' else i.unit end unit,i.category_id,
 coalesce(nullif(btrim(c.name),''),'未分類') category_name
 from public.pickup_records r join public.inventory_items i on i.id=r.inventory_item_id
 left join public.product_categories c on c.id=i.category_id
 where r.project_id=p_project_id and (p_from is null or r.pickup_date>=p_from) and (p_to is null or r.pickup_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(r)-'cable_cost_source_receipt_ids')),
 workers as materialized (
 select w.user_id,l.id,l.log_date,u.display_name,u.is_active from logs l
 join public.site_work_log_workers w on w.work_log_id=l.id join public.app_users u on u.id=w.user_id where l.reporter_on_site or w.user_id is distinct from l.reporter_user_id),
 contractor_days as (select log_date,max(subcontractor_count) headcount,count(*) records from logs where subcontractor_count>0 group by log_date),
 returned as materialized (
 select l.id,l.inventory_item_id,case when public.cable_cost_sources_visible_v1(l.cable_cost_source_receipt_ids) then l.cable_unit_cost_snapshot end visible_cable_cost,case when l.quantity_unit='meter' then l.quantity else l.quantity*coalesce(l.meters_per_unit_snapshot,1) end quantity,d.return_date,d.document_no,d.id document_id,u.display_name account
 from public.site_return_lines l join public.inventory_items i on i.id=l.inventory_item_id join public.site_return_documents d on d.id=l.document_id
 join public.app_users u on u.id=d.created_by_user_id
 where d.project_id=p_project_id and d.status='active' and l.quantity>0
 and (p_from is null or d.return_date>=p_from) and (p_to is null or d.return_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(d))),
 issued_totals as (select inventory_item_id,sum(report_quantity) quantity,sum(report_quantity*visible_cable_cost) cable_amount,count(*) filter(where visible_cable_cost is null) unpriced,count(*) records,min(pickup_date) first_date,max(pickup_date) recent_date from materials group by inventory_item_id),
 returned_totals as (select inventory_item_id,sum(quantity) quantity,sum(quantity*visible_cable_cost) cable_amount,count(*) filter(where visible_cable_cost is null) unpriced,count(*) records,min(return_date) first_date,max(return_date) recent_date from returned group by inventory_item_id),
 mat as (
 select i.id,i.item_name name,i.brand,i.model,case when i.meters_per_unit is not null then '米' else coalesce(nullif(i.unit,''),'未標示單位') end unit,
 i.unit package_unit,coalesce(i.meters_per_unit,1) meters_per_unit,
 i.category_id "categoryId",coalesce(nullif(btrim(c.name),''),'未分類') "categoryName",
 coalesce(issued.quantity,0) "issuedQuantity",coalesce(ret.quantity,0) "returnedQuantity",
 coalesce(issued.quantity,0)-coalesce(ret.quantity,0) quantity,
 coalesce(issued.cable_amount,0)-coalesce(ret.cable_amount,0) cable_amount,coalesce(issued.unpriced,0)+coalesce(ret.unpriced,0) cable_unpriced,
 coalesce(issued.records,0) "recordCount",coalesce(ret.records,0) "returnRecordCount",
 least(issued.first_date,ret.first_date) "firstDate",greatest(issued.recent_date,ret.recent_date) "recentDate"
 from issued_totals issued full join returned_totals ret using(inventory_item_id)
 join public.inventory_items i on i.id=coalesce(issued.inventory_item_id,ret.inventory_item_id)
 left join public.product_categories c on c.id=i.category_id),
 material_stats as (
 select m."categoryId",m."categoryName",m.unit,m.quantity,m."recordCount",
 (to_jsonb(m)-'cable_amount'-'cable_unpriced')||case when price_visible then jsonb_build_object('unit_price',pricing.unit_price,'package_unit_price',pricing.unit_price*m.meters_per_unit,
 'amount',round(case when manual.unit_price is null and m.unit='米' and m.cable_unpriced=0 then m.cable_amount else m.quantity*pricing.unit_price end,2),
 'price_source',case when manual.unit_price is not null then 'manual' when m.unit='米' and m.cable_unpriced=0 then 'snapshot' when latest.id is not null then 'receipt' else 'missing' end,
 'price_date',case when manual.unit_price is not null then (manual.updated_at at time zone 'Asia/Taipei')::date when m.unit='米' and m.cable_unpriced=0 then m."recentDate" else latest.receipt_date end,
 'source_receipt_id',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.id end,
 'source_document_id',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.receipt_document_id end,
 'source_tax_mode',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.receipt_tax_mode end,
 'source_tax_rate_basis_points',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.receipt_tax_rate_basis_points end,
 'source_input_unit_price',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.input_unit_price end,
 'price_row_version',manual.row_version) else '{}'::jsonb end data from mat m
 left join public.accounting_material_prices manual on manual.project_id=p_project_id and manual.inventory_item_id=m.id
 left join lateral(select s.id,s.receipt_date,s.receipt_document_id,s.unit_price input_unit_price,s.meters_per_unit_snapshot,
 d.receipt_tax_mode,d.receipt_tax_rate_basis_points,
 case when d.receipt_tax_mode='inclusive' then round(s.unit_price*10000/(10000+d.receipt_tax_rate_basis_points),2) else s.unit_price end unit_price
 from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id
 where s.inventory_item_id=m.id and d.receipt_delivery_state is distinct from 'pending' and s.unit_price is not null and public.erp_private_json_visible_v1(to_jsonb(s))
 order by s.receipt_date desc,s.created_at desc,s.id desc limit 1) latest on true
 cross join lateral(select case when manual.unit_price is not null then manual.unit_price/coalesce(manual.meters_per_unit_snapshot,1)
 when m.unit='米' and m.cable_unpriced=0 then case when m.quantity<>0 then m.cable_amount/m.quantity else 0 end
 else latest.unit_price/coalesce(latest.meters_per_unit_snapshot,1) end unit_price) pricing),
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
  where l.deleted_at is null and l.work_type='工程施工' and l.status in ('in_progress','completed') and l.log_date<=(now() at time zone 'Asia/Taipei')::date
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
   'remaining_days',case when p.planned_days>0 then greatest(p.planned_days-p.worked_days,0) end,
   'item_count',jsonb_array_length(p.items),
   'warning_after_days',p.warning_work_days,'needs_attention',alert->'progress_alert','progress_alert',alert->'progress_alert','progress_gap',alert->'progress_gap',
   'contract_start_date',(select contract_start_date from public.projects where id=p.project_id),
   'contract_end_date',(select contract_end_date from public.projects where id=p.project_id),
   'overrun_days',case when p.planned_days>0 then greatest(p.worked_days-p.planned_days,0) else 0 end,
   'progress_percent',p.completion_percent,
   'can_open',public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') and public.construction_project_access_v1(p_actor_user_id,p.project_id,false),
   'completed_item_count',(select count(*) from item_stats i where i.construction_plan_id=p.id and i.is_completed)) data from plan_stats p cross join lateral(select public.construction_progress_alert_v1(p.worked_days,jsonb_array_length(p.items),
   (select count(*)::integer from item_stats i where i.construction_plan_id=p.id and i.is_completed),p.warning_work_days,p.warning_min_progress,p.status) alert) a
 )
 select result||jsonb_build_object('report',(result->'report')||jsonb_build_object(
  'managerPerformanceVisible',result->'managerPerformanceVisible','managerPerformance',result->'managerPerformance',
  'project', (select jsonb_build_object('id',p.id,'code',p.project_code,'name',p.name,'type',t.label,'status',p.status,
   'customer',c.name,'owner',coalesce(nullif(p.assigned_to,''),(select string_agg(u.display_name,'、' order by u.id) from public.project_workers w join public.app_users u on u.id=w.user_id where w.project_id=p.id and w.is_assignee)),
   'createdAt',p.created_at,'completedOn',p.completed_on,'date',p.project_date,
   'contractStartDate',p.contract_start_date,'contractEndDate',p.contract_end_date,
   'remainingContractDays',p.contract_end_date-(now() at time zone 'Asia/Taipei')::date,
   'contractOverdue',coalesce(p.contract_end_date<(now() at time zone 'Asia/Taipei')::date
    and ((p.status<>'completed' and not exists(select 1 from item_stats i join plans c on c.id=i.construction_plan_id where c.status<>'cancelled'))
     or exists(select 1 from item_stats i join plans c on c.id=i.construction_plan_id where c.status<>'cancelled' and not i.is_completed)),false))
   from public.projects p join public.customers c on c.id=p.customer_id left join public.erp_work_content_types_v1() t on t.code=p.project_type where p.id=p_project_id),
  'constructionPlans',coalesce((select jsonb_agg(data order by data->>'construction_date',data->>'id') from enriched),'[]'),
  'constructionSummary',jsonb_build_object(
   'planCount',(select count(*) from plans),
   'plannedDays',(select coalesce(sum(planned_days),0) from plan_stats where status<>'cancelled'),
   'completedDays',(select coalesce(sum(completed_days),0) from plan_stats where status<>'cancelled'),
   'remainingDays',(select coalesce(sum(greatest(planned_days-worked_days,0)),0) from plan_stats where status<>'cancelled' and planned_days>0),
   'unsetPlanCount',(select count(*) from plans where status<>'cancelled' and coalesce(planned_days,0)=0),
   'workedDays',(select coalesce(sum(worked_days),0) from plan_stats where status<>'cancelled'),
   'progressPercent',(select case when count(*)>0 then round(100.0*count(*) filter(where i.is_completed)/count(*),1) end from item_stats i join plans c on c.id=i.construction_plan_id where c.status<>'cancelled'),
   'totalItemCount',(select count(*) from item_stats i join plans c on c.id=i.construction_plan_id where c.status<>'cancelled'),
   'completedItemCount',(select count(*) from item_stats i join plans c on c.id=i.construction_plan_id where c.status<>'cancelled' and i.is_completed),
   'delayedPlanCount',(select count(*) from enriched where (data->>'progress_alert')::boolean),
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
revoke all on function public.cable_reference_cost_snapshot_v1(uuid,uuid,uuid),public.cable_cost_sources_visible_v1(uuid[]),public.cable_reference_unit_cost_v1(uuid,uuid),public.stamp_cable_transaction_v1(),public.unpack_cable_for_pickup_v1(),public.guard_cable_historical_package_v1() from public,anon,authenticated;
grant execute on function public.cable_reference_cost_snapshot_v1(uuid,uuid,uuid),public.cable_cost_sources_visible_v1(uuid[]),public.cable_reference_unit_cost_v1(uuid,uuid),public.stamp_cable_transaction_v1(),public.unpack_cable_for_pickup_v1(),public.guard_cable_historical_package_v1() to service_role;
comment on column public.pickup_records.cable_unit_cost_snapshot is '每米未稅參考成本快照；原有人工價格優先／最近已收貨單價，含稅先依既有規則換未稅。';
notify pgrst,'reload schema';
