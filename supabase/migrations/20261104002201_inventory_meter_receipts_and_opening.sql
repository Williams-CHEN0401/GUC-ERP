-- Meter receipts and opening loose stock extend the existing inventory ledger.
-- No historical quantities, identities, Auth, RLS or function grants are rewritten.
do $baseline$ begin
 if md5(replace(pg_get_functiondef('current_inventory_quantity(uuid)'::regprocedure),chr(13),''))<>'4111ca5448dfd06ef295f5791606157b' then raise exception 'Unexpected baseline: current_inventory_quantity';end if;
 if md5(replace(pg_get_functiondef('erp_stock_totals_v1(uuid)'::regprocedure),chr(13),''))<>'46cedf042dd1656353aab63421523d27' then raise exception 'Unexpected baseline: erp_stock_totals_v1';end if;
 if md5(replace(pg_get_functiondef('current_inventory_meters_v1(uuid)'::regprocedure),chr(13),''))<>'488625f23c611a8c1fae31c839910e6f' then raise exception 'Unexpected baseline: current_inventory_meters_v1';end if;
 if md5(replace(pg_get_functiondef('guard_cable_pickup_v1()'::regprocedure),chr(13),''))<>'fd6e31a336c373ff34a7d1d5d8f43f3b' then raise exception 'Unexpected baseline: guard_cable_pickup_v1';end if;
 if md5(replace(pg_get_functiondef('unpack_cable_for_pickup_v1()'::regprocedure),chr(13),''))<>'7327b8103d421a6212c918c58ffc82a1' then raise exception 'Unexpected baseline: unpack_cable_for_pickup_v1';end if;
 if md5(replace(pg_get_functiondef('create_inventory_items_batch_v1(jsonb,text)'::regprocedure),chr(13),''))<>'54a78e102fe621e26645514b4452d127' then raise exception 'Unexpected baseline: create_inventory_items_batch_v1';end if;
 if md5(replace(pg_get_functiondef('save_stock_receipt_document_v1(uuid,boolean,jsonb,date,uuid,jsonb,uuid[],jsonb,uuid)'::regprocedure),chr(13),''))<>'d9243171d8e43c5bdbea9674bcba656e' then raise exception 'Unexpected baseline: save_stock_receipt_document_v1';end if;
 if md5(replace(pg_get_functiondef('create_stock_receipts_with_customers_v1(jsonb,uuid[],uuid)'::regprocedure),chr(13),''))<>'94081f3ea27ec5794568d8f389fdbac6' then raise exception 'Unexpected baseline: create_stock_receipts_with_customers_v1';end if;
 if md5(replace(pg_get_functiondef('stamp_cable_transaction_v1()'::regprocedure),chr(13),''))<>'9ae32cc55ee145f016d45f2b0ebf0559' then raise exception 'Unexpected baseline: stamp_cable_transaction_v1';end if;
 if md5(replace(pg_get_functiondef('guard_cable_historical_package_v1()'::regprocedure),chr(13),''))<>'d47f36c96fc4e9123990d6c05faf18e5' then raise exception 'Unexpected baseline: guard_cable_historical_package_v1';end if;
 if md5(replace(pg_get_functiondef('sync_receipt_delivery_pickups_v1(uuid,uuid)'::regprocedure),chr(13),''))<>'1988f7de37ca9331841278d568b62f17' then raise exception 'Unexpected baseline: sync_receipt_delivery_pickups_v1';end if;
 if md5(replace(pg_get_functiondef('receipt_money_totals_v1(jsonb,text,integer)'::regprocedure),chr(13),''))<>'b741b0806b1e56930b34b0c64a5ffee3' then raise exception 'Unexpected baseline: receipt_money_totals_v1';end if;
 if md5(replace(pg_get_functiondef('stock_receipt_financials_v1(uuid)'::regprocedure),chr(13),''))<>'f82a3f9d64d2e51b0057dd7be4ea7c9d' then raise exception 'Unexpected baseline: stock_receipt_financials_v1';end if;
 if md5(replace(pg_get_functiondef('accounting_receipt_unit_net_v1(uuid)'::regprocedure),chr(13),''))<>'09d093f6cd58c37e4d7104ebf705b9f1' then raise exception 'Unexpected baseline: accounting_receipt_unit_net_v1';end if;
 if md5(replace(pg_get_functiondef('cable_reference_cost_snapshot_v1(uuid,uuid,uuid)'::regprocedure),chr(13),''))<>'7c003b609ebde72b4cd5ea940eaae130' then raise exception 'Unexpected baseline: cable_reference_cost_snapshot_v1';end if;
 if md5(replace(pg_get_functiondef('work_content_report_v1(uuid,uuid,date,date,text,boolean)'::regprocedure),chr(13),''))<>'23bbde8147891f8811e88f01bea1a3e0' then raise exception 'Unexpected baseline: work_content_report_v1';end if;
end $baseline$;
alter table public.inventory_items add column opening_meters numeric not null default 0 check(opening_meters>=0 and opening_meters<1000000000000 and opening_meters=round(opening_meters,2));
alter table public.stock_receipts add column quantity_unit text not null default 'package' check(quantity_unit in('package','meter'));
CREATE OR REPLACE FUNCTION public.current_inventory_quantity(p_inventory_item_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result numeric;
begin
 select coalesce(i.opening_quantity,0)
 +coalesce((select sum(s.quantity) from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id where s.inventory_item_id=i.id and s.quantity_unit='package' and d.receipt_delivery_state is distinct from 'pending'),0)
 -coalesce((select sum(p.quantity) from public.pickup_records p where p.inventory_item_id=i.id and p.quantity_unit='package'),0)
 +coalesce((select sum(a.difference_quantity) from public.stock_adjustments a where a.inventory_item_id=i.id and a.quantity_unit='package'),0)
 into result from public.inventory_items i where i.id=p_inventory_item_id;
 if not found then raise exception '找不到指定品項。';end if;
 return result;
end $function$;

CREATE OR REPLACE FUNCTION public.erp_stock_totals_v1(p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
begin
 if not exists(select 1 from unnest(array['inventory','purchases','pickups','worklogs','repairs','reports']) m where public.has_app_permission_v1(p_actor_user_id,m,'VIEW')) then raise exception '沒有庫存查看權限。';end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'loose_meters',public.current_inventory_meters_v1(i.id),'quantity',coalesce(i.opening_quantity,0)+coalesce(r.q,0)-coalesce(p.q,0)+coalesce(a.q,0))),'[]') from public.inventory_items i
 left join (select s.inventory_item_id,sum(s.quantity) q from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id where s.quantity_unit='package' and d.receipt_delivery_state is distinct from 'pending' group by s.inventory_item_id) r on r.inventory_item_id=i.id
 left join (select inventory_item_id,sum(quantity) q from public.pickup_records where quantity_unit='package' group by inventory_item_id) p on p.inventory_item_id=i.id
 left join (select inventory_item_id,sum(difference_quantity) q from public.stock_adjustments where quantity_unit='package' group by inventory_item_id) a on a.inventory_item_id=i.id);
end $function$;

CREATE OR REPLACE FUNCTION public.current_inventory_meters_v1(p_inventory_item_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select coalesce((select opening_meters from public.inventory_items where id=p_inventory_item_id),0)
 +coalesce((select sum(s.quantity) from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id where s.inventory_item_id=p_inventory_item_id and s.quantity_unit='meter' and d.receipt_delivery_state is distinct from 'pending'),0)
 +coalesce((select sum(difference_quantity) from public.stock_adjustments where inventory_item_id=p_inventory_item_id and quantity_unit='meter'),0)
 -coalesce((select sum(quantity) from public.pickup_records where inventory_item_id=p_inventory_item_id and quantity_unit='meter'),0);
$function$;

CREATE OR REPLACE FUNCTION public.guard_cable_pickup_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare i uuid;q numeric;factor numeric;
begin
 for i in select old.inventory_item_id union select new.inventory_item_id loop
  if i is null then continue;end if;
  select meters_per_unit into factor from public.inventory_items where id=i for update;

  q:=public.current_inventory_meters_v1(i);
  if q<0 then raise exception '散料米數不足，不能超領；整箱／整捲庫存不會自動拆用。';end if;
 end loop;
 return null;
end $function$;

CREATE OR REPLACE FUNCTION public.unpack_cable_for_pickup_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare factor numeric;loose numeric;packages numeric;available numeric;actor text;
begin
 if new.quantity_unit<>'meter' then return new;end if;
 if tg_op='INSERT' or old.inventory_item_id is distinct from new.inventory_item_id or old.quantity_unit<>'meter' then
  if not exists(select 1 from public.inventory_items i join public.product_categories c on c.id=i.category_id where i.id=new.inventory_item_id and replace(btrim(c.name),'＆','&') in('弱電線材','電線&電纜類') and lower(btrim(i.unit)) not in('米','m','公尺')) then raise exception '此貨品請使用原單位取貨。';end if;
 end if;
 select meters_per_unit into factor from public.inventory_items where id=new.inventory_item_id for update;

 loose:=public.current_inventory_meters_v1(new.inventory_item_id);
 if tg_op='UPDATE' and old.inventory_item_id=new.inventory_item_id and old.quantity_unit='meter' then loose:=loose+old.quantity;end if;
 if new.quantity>loose then
  if factor is null then raise exception '可用米數不足；請先以散料(米)進貨，或設定實際每箱／捲米數後再取貨。';end if;
  packages:=ceil((new.quantity-loose)/factor);available:=public.current_inventory_quantity(new.inventory_item_id);
  -- The BEFORE trigger still sees the old package withdrawal. Those packages
  -- are released by this same UPDATE and may supply the corrected meter row.
  if tg_op='UPDATE' and old.inventory_item_id=new.inventory_item_id and old.quantity_unit='package' then
    available:=available+old.quantity;
  end if;
  if available<packages then raise exception '可用米數不足，散料及整包庫存不足以供應本次取貨。';end if;
  actor:=coalesce(new.updated_by,new.created_by_username,'system');
  insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
   values(new.inventory_item_id,available,available-packages,'米數取貨拆包：'||new.id::text||'；每包 '||factor::text||' 米',gen_random_uuid(),'web',actor,'package');
  insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
   values(new.inventory_item_id,loose,loose+packages*factor,'米數取貨拆包：'||new.id::text||'；'||packages::text||' 包',gen_random_uuid(),'web',actor,'meter');
 end if;
 return new;
end $function$;

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
      opening_quantity, opening_meters, meters_per_unit, source, updated_by
    )
    values (
      v_inventory_code, v_category.id, v_category.name, v_model, v_brand,
      v_item_name, v_unit, v_opening_quantity, coalesce((v_row->>'opening_meters')::numeric,0), nullif(v_row->>'meters_per_unit','')::numeric, 'web', nullif(p_actor,'')
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

CREATE OR REPLACE FUNCTION public.save_stock_receipt_document_v1(p_document_id uuid, p_create boolean, p_existing jsonb, p_receipt_date date, p_supplier_id uuid, p_rows jsonb, p_customer_ids uuid[], p_customer_departments jsonb, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_current uuid[];v_expected uuid[];v_submitted uuid[];v_removed uuid[];v_row jsonb;v_id uuid;
  v_created jsonb;v_line integer:=0;v_ids uuid[]:='{}';v_version integer;v_context text;v_actor text;v_meter_context text;v_quantity_unit text;
begin
  if p_create is null or p_document_id is null or p_receipt_date is null or p_supplier_id is null
    or not public.has_app_permission_v1(p_actor_user_id,'purchases',case when p_create then 'CREATE' else 'UPDATE' end) then
    raise exception '沒有有效的進貨單資料或操作權限。';end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 20
    or p_existing is null or jsonb_typeof(p_existing)<>'array' or jsonb_array_length(p_existing)>50 then raise exception '每張進貨單必須有 1 至 20 筆明細。';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r)<>'object' or nullif(r->>'inventory_item_id','') is null
    or coalesce((r->>'quantity')::numeric,0)<=0 or (r->>'quantity')::numeric<>round((r->>'quantity')::numeric,2)
    or char_length(coalesce(r->>'note',''))>500) then raise exception '進貨明細品項、數量或備註不正確。';end if;
  if (select count(*) from jsonb_array_elements(p_rows))<>(select count(distinct (r->>'inventory_item_id',coalesce(r->>'quantity_unit','package'),lower(btrim(coalesce(r->>'note',''))))) from jsonb_array_elements(p_rows) r) then
    raise exception '同一張進貨單有重複明細，請合併數量。';end if;
  perform pg_advisory_xact_lock(hashtextextended(p_document_id::text,0));
  perform 1 from public.stock_receipts where receipt_document_id=p_document_id order by id for update;
  select coalesce(array_agg(id order by id),'{}') into v_current from public.stock_receipts where receipt_document_id=p_document_id;
  select coalesce(array_agg((r->>'id')::uuid order by (r->>'id')::uuid),'{}') into v_expected from jsonb_array_elements(p_existing) r;
  select coalesce(array_agg((r->>'id')::uuid order by (r->>'id')::uuid),'{}') into v_submitted from jsonb_array_elements(p_rows) r where nullif(r->>'id','') is not null;
  if (p_create and (cardinality(v_current)>0 or exists(select 1 from public.stock_transaction_documents where kind='receipt' and id=p_document_id)))
    or (not p_create and cardinality(v_current)=0) or v_current is distinct from v_expected or not(v_submitted<@v_current)
    or cardinality(v_submitted)<>(select count(distinct id) from unnest(v_submitted) id)
    or exists(select 1 from jsonb_array_elements(p_existing) e join public.stock_receipts s on s.id=(e->>'id')::uuid where (e->>'row_version')::integer is distinct from s.row_version)
    then raise exception '進貨單已被更新，請重新整理後再修改；原單據未變更。';end if;
  perform 1 from public.inventory_items where id in(select (r->>'inventory_item_id')::uuid from jsonb_array_elements(p_rows) r
    union select inventory_item_id from public.stock_receipts where id=any(v_current)) order by id for update;
  select coalesce(array_agg(id),'{}') into v_removed from unnest(v_current) id where not(id=any(v_submitted));
  select username into v_actor from public.app_users where id=p_actor_user_id and is_active;
  if cardinality(v_removed)>0 then
    if not public.has_app_permission_v1(p_actor_user_id,'purchases','DELETE') then raise exception '沒有刪除進貨明細的權限。';end if;
    perform public.delete_stock_receipt_records(v_removed,v_actor);
  end if;
  v_meter_context:=current_setting('app.receipt_quantity_unit',true);v_context:=current_setting('app.receipt_document_id',true);perform set_config('app.receipt_document_id',p_document_id::text,true);
  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_line:=v_line+1;v_id:=nullif(v_row->>'id','')::uuid;
    v_quantity_unit:=coalesce(v_row->>'quantity_unit',(select quantity_unit from public.stock_receipts where id=v_id),'package');
    if v_quantity_unit not in('package','meter') or (v_quantity_unit='package' and (v_row->>'quantity')::numeric<>trunc((v_row->>'quantity')::numeric)) then raise exception '進貨計量單位或數量不正確。';end if;
    -- Reuse the existing transaction-local document context through the same
    -- customer/department writers; no parallel writer or authorization route.
    perform set_config('app.receipt_quantity_unit',v_quantity_unit,true);
    if v_id is null then
      if not public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE') then raise exception '沒有新增進貨明細的權限。';end if;
      v_created:=public.create_stock_receipts_department_v1(jsonb_build_array(jsonb_build_object('receipt_date',p_receipt_date,'supplier_id',p_supplier_id,
        'inventory_item_id',v_row->>'inventory_item_id','quantity',v_row->'quantity','note',v_row->>'note')),p_customer_ids,p_customer_departments,p_actor_user_id);
      v_id:=(v_created->'ids'->>0)::uuid;
    else
      select row_version into v_version from public.stock_receipts where id=v_id;
      perform public.update_stock_receipt_department_v1(v_id,v_version,p_receipt_date,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,
        p_supplier_id,v_row->>'note',p_customer_ids,p_customer_departments,p_actor_user_id);
    end if;
    update public.stock_receipts set receipt_line_no=v_line where id=v_id and receipt_line_no is distinct from v_line;
    v_ids:=array_append(v_ids,v_id);
  end loop;
  perform set_config('app.receipt_quantity_unit',coalesce(v_meter_context,''),true);perform set_config('app.receipt_document_id',coalesce(v_context,''),true);
  return jsonb_build_object('document_id',p_document_id,'ids',v_ids,'saved',cardinality(v_ids));
end $function$;

CREATE OR REPLACE FUNCTION public.create_stock_receipts_with_customers_v1(p_rows jsonb, p_customer_ids uuid[], p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_previous_batch text;v_number_scope record;v_row jsonb; v_receipt uuid;v_ids uuid[]:='{}';v_actor text;v_supplier public.suppliers;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE') then raise exception '您的帳號沒有執行此操作的權限。';end if;
 if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 20 then raise exception '每次必須登錄 1 至 20 筆進貨資料。';end if;
 select username into v_actor from public.app_users where id=p_actor_user_id;
 perform 1 from public.inventory_items where id in(select (value->>'inventory_item_id')::uuid from jsonb_array_elements(p_rows)) order by id for update;
 v_previous_batch:=current_setting('app.receipt_batch_id',true);perform set_config('app.receipt_batch_id',gen_random_uuid()::text,true);
if nullif(current_setting('app.receipt_document_id',true),'') is null then for v_number_scope in select distinct (value->>'supplier_id')::uuid scope,(value->>'receipt_date')::date actual_date from jsonb_array_elements(p_rows) order by scope,actual_date loop perform public.ensure_stock_document_v1('receipt',current_setting('app.receipt_batch_id')::uuid,v_number_scope.actual_date,v_number_scope.scope,current_setting('app.receipt_batch_id')::uuid);end loop;end if;
for v_row in select value from jsonb_array_elements(p_rows) loop
  select * into v_supplier from public.suppliers where id=(v_row->>'supplier_id')::uuid;
  if not found or coalesce((v_row->>'quantity')::numeric,0)<=0 or (v_row->>'quantity')::numeric<>(case when current_setting('app.receipt_quantity_unit',true)='meter' then round((v_row->>'quantity')::numeric,2) else trunc((v_row->>'quantity')::numeric) end) then raise exception '進貨供應商或數量不正確。';end if;
  insert into public.stock_receipts(receipt_date,inventory_item_id,quantity,supplier_id,supplier,note,source,updated_by) values((v_row->>'receipt_date')::date,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,v_supplier.id,v_supplier.name,nullif(btrim(v_row->>'note'),''),'web',v_actor) returning id into v_receipt;
  perform public.set_receipt_customers_v1(v_receipt,p_customer_ids,p_actor_user_id);
  v_ids:=array_append(v_ids,v_receipt);
 end loop;
 perform set_config('app.receipt_batch_id',coalesce(v_previous_batch,''),true);return jsonb_build_object('ids',v_ids,'created',cardinality(v_ids));
end;
$function$;

CREATE OR REPLACE FUNCTION public.stamp_cable_transaction_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare profile public.inventory_items;project uuid;cost numeric;reference jsonb;actor uuid;
begin
 select * into profile from public.inventory_items where id=new.inventory_item_id for update;
 if tg_table_name='stock_receipts' then
  if new.quantity_unit='meter' then
   new.meters_per_unit_snapshot:=1;new.package_unit_snapshot:='米';new.cable_snapshot_source:='recorded';return new;
  elsif tg_op='UPDATE' and old.quantity_unit is distinct from new.quantity_unit then
   new.meters_per_unit_snapshot:=profile.meters_per_unit;new.package_unit_snapshot:=profile.unit;new.cable_snapshot_source:='recorded';return new;
  end if;
 end if;
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
   if profile.meters_per_unit is not null or new.quantity_unit='meter' then
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
end $function$;

CREATE OR REPLACE FUNCTION public.guard_cable_historical_package_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare factor numeric;
begin
 if tg_table_name='stock_receipts' then if old.quantity_unit='meter' then return coalesce(new,old);end if;end if;
 if tg_table_name='pickup_records' then if old.quantity_unit='meter' then return coalesce(new,old);end if;end if;
 select meters_per_unit into factor from public.inventory_items where id=old.inventory_item_id for update;
 if old.meters_per_unit_snapshot is not null and old.meters_per_unit_snapshot is distinct from factor then
  if tg_op='DELETE' then raise exception '此歷史單據的包裝長度與現行規格不同，不能直接刪除並回沖整包庫存；請先核對原規格。';end if;
  if (new.inventory_item_id,new.quantity) is distinct from (old.inventory_item_id,old.quantity) then raise exception '此歷史單據的包裝長度與現行規格不同，不能直接修改庫存數量；備註及日期仍可修改。';end if;
 end if;
 return coalesce(new,old);
end $function$;

CREATE OR REPLACE FUNCTION public.sync_receipt_delivery_pickups_v1(p_document_id uuid, p_actor_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare d public.stock_transaction_documents;r public.stock_receipts;actor text;line_no integer:=0;
begin
 select * into strict d from public.stock_transaction_documents where kind='receipt' and id=p_document_id and receipt_delivery_state='site';
 if current_setting('app.receipt_delivery_sync',true) is distinct from d.id::text then raise exception '送達同步必須在進貨交易內執行。';end if;
 select username into strict actor from public.app_users where id=p_actor_user_id and is_active;
 perform public.ensure_stock_document_v1('pickup',d.receipt_delivery_pickup_id,d.receipt_delivery_date,d.receipt_delivery_project_id,d.id);
 select coalesce(max(request_row),0) into line_no from public.pickup_records where request_id=d.id;
 for r in select * from public.stock_receipts where receipt_document_id=d.id order by receipt_line_no,id loop
  line_no:=line_no+1;
  insert into public.pickup_records(pickup_document_id,pickup_date,project_id,inventory_item_id,quantity,quantity_unit,note,source,updated_by,created_by_user_id,created_by_username,request_id,request_row,source_receipt_line_id)
  values(d.receipt_delivery_pickup_id,d.receipt_delivery_date,d.receipt_delivery_project_id,r.inventory_item_id,r.quantity,r.quantity_unit,r.note,'web',actor,p_actor_user_id,actor,d.id,line_no,r.id)
  on conflict(source_receipt_line_id) do update set inventory_item_id=excluded.inventory_item_id,quantity=excluded.quantity,quantity_unit=excluded.quantity_unit,note=excluded.note,updated_by=excluded.updated_by
  where (pickup_records.inventory_item_id,pickup_records.quantity,pickup_records.quantity_unit,pickup_records.note) is distinct from (excluded.inventory_item_id,excluded.quantity,excluded.quantity_unit,excluded.note);
 end loop;
end $function$;

CREATE OR REPLACE FUNCTION public.receipt_money_totals_v1(p_lines jsonb, p_mode text, p_rate integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare input_amount numeric; net numeric; tax numeric; total numeric; missing integer;
begin
 if p_mode is not null and p_mode not in ('exclusive','inclusive') then raise exception '計價模式不正確。'; end if;
 if (p_mode is null)<>(p_rate is null) or p_rate<0 or p_rate>10000 then raise exception '稅率設定不正確。'; end if;
 if exists(select 1 from jsonb_array_elements(p_lines) r where
   jsonb_typeof(r->'quantity')<>'number' or (r->>'quantity')::numeric<=0
   or (r->>'quantity')::numeric<>(case when r->>'quantity_unit'='meter' then round((r->>'quantity')::numeric,2) else trunc((r->>'quantity')::numeric) end)
   or (r->>'unit_price')::numeric<0 or (r->>'unit_price')::numeric>=1000000000000
   or (r->>'unit_price')::numeric<>round((r->>'unit_price')::numeric,2)) then raise exception '進貨數量或單價格式不正確。'; end if;
 select coalesce(sum(round((r->>'quantity')::numeric*(r->>'unit_price')::numeric,0)),0),
 count(*) filter(where r->>'unit_price' is null) into input_amount,missing from jsonb_array_elements(p_lines) r;
 if p_mode is not null and missing=0 then
  if p_mode='inclusive' then total:=input_amount;net:=round(total*10000/(10000+p_rate),0);tax:=total-net;
  else net:=input_amount;tax:=round(net*p_rate/10000,0);total:=net+tax;end if;
 end if;
 if input_amount>9007199254740991 or total>9007199254740991 then raise exception '單據金額超過可精確計算的上限。';end if;
 return jsonb_build_object('mode',p_mode,'tax_rate_basis_points',p_rate,'currency','TWD','currency_scale',0,
 'input_amount',input_amount,'net_amount',net,'tax_amount',tax,'total_amount',total,'missing_price_count',missing);
end $function$;

CREATE OR REPLACE FUNCTION public.stock_receipt_financials_v1(p_document_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select public.receipt_money_totals_v2(
 coalesce((select jsonb_agg(jsonb_build_object('quantity',s.quantity,'quantity_unit',s.quantity_unit,'unit_price',s.unit_price))
 from public.stock_receipts s where s.receipt_document_id=d.id),'[]'),d.receipt_tax_mode,d.receipt_tax_rate_basis_points,d.receipt_discount_amount)
 from public.stock_transaction_documents d where d.kind='receipt' and d.id=p_document_id;
$function$;

CREATE OR REPLACE FUNCTION public.accounting_receipt_unit_net_v1(p_receipt uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 with source as(select r.*,d.receipt_tax_mode,d.receipt_tax_rate_basis_points,d.receipt_discount_amount from public.stock_receipts r
 join public.stock_transaction_documents d on d.kind='receipt' and d.id=r.receipt_document_id where r.id=p_receipt),
 sums as(select s.id,s.unit_price,s.quantity,
 public.receipt_money_totals_v2(jsonb_agg(jsonb_build_object('quantity',r.quantity,'quantity_unit',r.quantity_unit,'unit_price',r.unit_price)),s.receipt_tax_mode,s.receipt_tax_rate_basis_points,coalesce(s.receipt_discount_amount,0)) totals,
 sum(round(r.quantity*r.unit_price,0)) subtotal
 from source s join public.stock_receipts r on r.receipt_document_id=s.receipt_document_id
 group by s.id,s.unit_price,s.quantity,s.receipt_tax_mode,s.receipt_tax_rate_basis_points,s.receipt_discount_amount)
 select case when subtotal=0 and totals->>'net_amount' is not null then 0 when quantity>0 then (totals->>'net_amount')::numeric * round(quantity*unit_price,0) / nullif(subtotal,0) / quantity end from sums;
$function$;

CREATE OR REPLACE FUNCTION public.cable_reference_cost_snapshot_v1(p_item_id uuid, p_project_id uuid, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare result jsonb;
begin
 if p_actor_user_id is not null then perform public.erp_private_prepare_v1(p_actor_user_id);end if;
 select jsonb_build_object('unit_cost',p.unit_price/coalesce(p.meters_per_unit_snapshot,1),'source_receipt_ids','[]'::jsonb) into result
 from public.accounting_material_prices p where p.project_id=p_project_id and p.inventory_item_id=p_item_id and (p.meters_per_unit_snapshot is not null or exists(select 1 from public.inventory_items i where i.id=p_item_id and lower(btrim(i.unit)) in('米','m','公尺')));
 if result is not null then return result;end if;
 select jsonb_build_object('unit_cost',public.accounting_receipt_unit_net_v1(r.id)/coalesce(r.meters_per_unit_snapshot,1),'source_receipt_ids',jsonb_build_array(r.id)) into result
   from public.stock_receipts r left join public.stock_transaction_documents d on d.kind='receipt' and d.id=r.receipt_document_id
   where r.inventory_item_id=p_item_id and r.unit_price is not null and d.receipt_delivery_state is distinct from 'pending' and (r.meters_per_unit_snapshot is not null or exists(select 1 from public.inventory_items i where i.id=p_item_id and lower(btrim(i.unit)) in('米','m','公尺')))
   and (p_actor_user_id is null or public.erp_private_json_visible_v1(to_jsonb(r)))
   order by r.receipt_date desc,r.created_at desc,r.id desc limit 1;
 return coalesce(result,jsonb_build_object('unit_cost',null,'source_receipt_ids','[]'::jsonb));
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
 select r.*,case when public.cable_cost_sources_visible_v1(r.cable_cost_source_receipt_ids) then r.cable_unit_cost_snapshot end visible_cable_cost,case when r.quantity_unit='meter' then r.quantity else r.quantity*coalesce(r.meters_per_unit_snapshot,1) end report_quantity,i.item_name,i.brand,i.model,case when r.quantity_unit='meter' or r.meters_per_unit_snapshot is not null then '米' else i.unit end unit,i.category_id,
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
 select l.id,l.inventory_item_id,case when l.quantity_unit='meter' or l.meters_per_unit_snapshot is not null then '米' else i.unit end unit,case when public.cable_cost_sources_visible_v1(l.cable_cost_source_receipt_ids) then l.cable_unit_cost_snapshot end visible_cable_cost,case when l.quantity_unit='meter' then l.quantity else l.quantity*coalesce(l.meters_per_unit_snapshot,1) end quantity,d.return_date,d.document_no,d.id document_id,u.display_name account
 from public.site_return_lines l join public.inventory_items i on i.id=l.inventory_item_id join public.site_return_documents d on d.id=l.document_id
 join public.app_users u on u.id=d.created_by_user_id
 where d.project_id=p_project_id and d.status='active' and l.quantity>0
 and (p_from is null or d.return_date>=p_from) and (p_to is null or d.return_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(d))),
 issued_totals as (select inventory_item_id,unit,sum(report_quantity) quantity,sum(report_quantity*visible_cable_cost) cable_amount,count(*) filter(where visible_cable_cost is null) unpriced,count(*) records,min(pickup_date) first_date,max(pickup_date) recent_date from materials group by inventory_item_id,unit),
 returned_totals as (select inventory_item_id,unit,sum(quantity) quantity,sum(quantity*visible_cable_cost) cable_amount,count(*) filter(where visible_cable_cost is null) unpriced,count(*) records,min(return_date) first_date,max(return_date) recent_date from returned group by inventory_item_id,unit),
 mat as (
 select i.id,i.item_name name,i.brand,i.model,coalesce(issued.unit,ret.unit,nullif(i.unit,''),'未標示單位') unit,
 i.unit package_unit,coalesce(i.meters_per_unit,1) meters_per_unit,
 i.category_id "categoryId",coalesce(nullif(btrim(c.name),''),'未分類') "categoryName",
 coalesce(issued.quantity,0) "issuedQuantity",coalesce(ret.quantity,0) "returnedQuantity",
 coalesce(issued.quantity,0)-coalesce(ret.quantity,0) quantity,
 coalesce(issued.cable_amount,0)-coalesce(ret.cable_amount,0) cable_amount,coalesce(issued.unpriced,0)+coalesce(ret.unpriced,0) cable_unpriced,
 coalesce(issued.records,0) "recordCount",coalesce(ret.records,0) "returnRecordCount",
 least(issued.first_date,ret.first_date) "firstDate",greatest(issued.recent_date,ret.recent_date) "recentDate"
 from issued_totals issued full join returned_totals ret using(inventory_item_id,unit)
 join public.inventory_items i on i.id=coalesce(issued.inventory_item_id,ret.inventory_item_id)
 left join public.product_categories c on c.id=i.category_id),
 material_stats as (
 select m."categoryId",m."categoryName",m.unit,m.quantity,m."recordCount",
 (to_jsonb(m)-'cable_amount'-'cable_unpriced')||case when price_visible then jsonb_build_object('unit_price',pricing.unit_price,'package_unit_price',case when m.unit='米' and m.package_unit not in('米','m','公尺') and (select meters_per_unit from public.inventory_items where id=m.id) is null then null else pricing.unit_price*m.meters_per_unit end,
 'amount',round(case when manual.unit_price is null and m.unit='米' and m.cable_unpriced=0 then m.cable_amount else m.quantity*pricing.unit_price end,2),
 'price_source',case when manual.unit_price is not null then 'manual' when m.unit='米' and m.cable_unpriced=0 then 'snapshot' when latest.id is not null then 'receipt' else 'missing' end,
 'price_date',case when manual.unit_price is not null then (manual.updated_at at time zone 'Asia/Taipei')::date when m.unit='米' and m.cable_unpriced=0 then m."recentDate" else latest.receipt_date end,
 'source_receipt_id',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.id end,
 'source_document_id',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.receipt_document_id end,
 'source_tax_mode',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.receipt_tax_mode end,
 'source_tax_rate_basis_points',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.receipt_tax_rate_basis_points end,
 'source_input_unit_price',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.input_unit_price end,
 'price_row_version',manual.row_version) else '{}'::jsonb end data from mat m
 left join public.accounting_material_prices manual on manual.project_id=p_project_id and manual.inventory_item_id=m.id and (m.unit<>'米' or manual.meters_per_unit_snapshot is not null or lower(btrim(m.package_unit)) in('米','m','公尺'))
 left join lateral(select s.id,s.receipt_date,s.receipt_document_id,s.unit_price input_unit_price,s.meters_per_unit_snapshot,
 d.receipt_tax_mode,d.receipt_tax_rate_basis_points,
 public.accounting_receipt_unit_net_v1(s.id) unit_price
 from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id
 where s.inventory_item_id=m.id and d.receipt_delivery_state is distinct from 'pending' and s.unit_price is not null and ((m.unit='米' and (s.meters_per_unit_snapshot is not null or lower(btrim(m.package_unit)) in('米','m','公尺'))) or (m.unit<>'米' and s.quantity_unit='package' and s.meters_per_unit_snapshot is null)) and public.erp_private_json_visible_v1(to_jsonb(s))
 order by s.receipt_date desc,s.created_at desc,s.id desc limit 1) latest on true
 cross join lateral(select case when manual.unit_price is not null then manual.unit_price/coalesce(manual.meters_per_unit_snapshot,1)
 when m.unit='米' and m.cable_unpriced=0 then case when m.quantity<>0 then m.cable_amount/m.quantity else 0 end
 else latest.unit_price/coalesce(latest.meters_per_unit_snapshot,1) end unit_price) pricing),
 category_stats as (
 select s."categoryId" id,max(s."categoryName") name,count(distinct (s.data->>'id')) "itemCount",sum(s."recordCount") "recordCount",
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
 'returnRows',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'date',r.return_date,'documentId',r.document_id,'documentNo',r.document_no,'itemId',r.inventory_item_id,'categoryId',i.category_id,'quantity',r.quantity,'account',r.account,'item',jsonb_build_object('name',i.item_name,'brand',i.brand,'model',i.model,'unit',r.unit)) order by r.return_date desc,r.id) from returned r join public.inventory_items i on i.id=r.inventory_item_id),'[]'),
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
 'kpis',jsonb_build_object('materialTypeCount',(select count(distinct id) from mat),'materialRecordCount',(select count(*) from materials),
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
      'id',s.id,'itemId',s.inventory_item_id,'name',i.item_name,'quantity',s.quantity,'unit',case when s.quantity_unit='meter' then '米' else i.unit end,
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

create function public.stamp_receipt_quantity_unit_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare mode text;category_name text;
begin
 mode:=current_setting('app.receipt_quantity_unit',true);
 if mode in('package','meter') then new.quantity_unit:=mode;end if;
 if new.quantity_unit='meter' then
  select c.name into category_name from public.inventory_items i join public.product_categories c on c.id=i.category_id where i.id=new.inventory_item_id;
  if replace(btrim(category_name),'＆','&') not in('弱電線材','電線&電纜類') or category_name is null then raise exception '此貨品種類不能使用散料(米)。';end if;
  if exists(select 1 from public.inventory_items where id=new.inventory_item_id and lower(btrim(unit)) in('米','m','公尺')) then raise exception '原單位已是米，請使用原單位進貨。';end if;
  if new.quantity<>round(new.quantity,2) then raise exception '米數最多兩位小數。';end if;
 end if;
 return new;
end $$;
create trigger a0_receipt_quantity_unit before insert or update on public.stock_receipts for each row execute function public.stamp_receipt_quantity_unit_v1();
create function public.guard_inventory_opening_meters_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare category_name text;
begin
 if new.opening_meters<>0 then
  select name into category_name from public.product_categories where id=new.category_id;
  if replace(btrim(category_name),'＆','&') not in('弱電線材','電線&電纜類') or category_name is null or lower(btrim(new.unit)) in('米','m','公尺') then raise exception '只有以箱／捲等包裝計量的線材可另填期初散料；單位為米時請填期初米數。';end if;
 end if;
 return new;
end $$;
create trigger inventory_opening_meters_guard before insert or update on public.inventory_items for each row execute function public.guard_inventory_opening_meters_v1();
create function public.guard_meter_stock_balance_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare item_id uuid;items uuid[];
begin
 if tg_table_name='inventory_items' then
  if tg_op='UPDATE' and new.opening_meters is not distinct from old.opening_meters then return null;end if;
  items:=array[new.id];
 else
  if tg_op='INSERT' and new.quantity_unit<>'meter' or tg_op='DELETE' and old.quantity_unit<>'meter' or tg_op='UPDATE' and old.quantity_unit<>'meter' and new.quantity_unit<>'meter' then return null;end if;
  items:=array[old.inventory_item_id,new.inventory_item_id];
 end if;
 for item_id in select distinct x from unnest(items)x where x is not null order by x loop
  perform 1 from public.inventory_items where id=item_id for update;
  if public.current_inventory_meters_v1(item_id)<0 then raise exception '散料米數不足，不能移除或減少已領用的入庫米數。';end if;
 end loop;
 return null;
end $$;
create constraint trigger receipt_meter_balance after insert or update or delete on public.stock_receipts deferrable initially deferred for each row execute function public.guard_meter_stock_balance_v1();
create constraint trigger opening_meter_balance after insert or update on public.inventory_items deferrable initially deferred for each row execute function public.guard_meter_stock_balance_v1();
revoke all on function public.stamp_receipt_quantity_unit_v1(),public.guard_inventory_opening_meters_v1(),public.guard_meter_stock_balance_v1() from public,anon,authenticated;
grant execute on function public.stamp_receipt_quantity_unit_v1(),public.guard_inventory_opening_meters_v1(),public.guard_meter_stock_balance_v1() to service_role;
notify pgrst,'reload schema';
