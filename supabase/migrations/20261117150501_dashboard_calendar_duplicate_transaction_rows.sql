-- Preserve permissions, historical quantities, per-line audit and request idempotency.
begin;
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
      'remnant_line_id',nullif(v_row->>'remnant_line_id','')::uuid,'note', v_note
    ));
  end loop;

  -- Repeated product lines are independent; stable line IDs and request keys still prevent replay.

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
              or existing.remnant_line_id is distinct from nullif(expected.value->>'remnant_line_id','')::uuid
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
      work_log_id, request_id, request_row,quantity_unit,remnant_line_id
    ) values (
      (v_row ->> 'pickup_date')::date,
      (v_row ->> 'project_id')::uuid,
      (v_row ->> 'inventory_item_id')::uuid,
      (v_row ->> 'quantity')::numeric,
      v_row ->> 'note',
      'web', nullif(p_actor, ''), p_created_by_user_id, p_created_by_username,
      p_work_log_id, p_request_id,
      case when p_request_id is null then null else (v_row ->> 'request_row')::integer end,v_row->>'quantity_unit',nullif(v_row->>'remnant_line_id','')::uuid
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
  v_actor text;v_creator uuid;v_username text;v_log uuid;v_context text;v_remnant uuid;v_request_row integer;v_ids uuid[]:='{}';
begin
  if p_document_id is null or p_pickup_date is null or p_project_id is null or not public.has_app_permission_v1(p_actor_user_id,'pickups','UPDATE') then raise exception '沒有有效的取貨單資料或操作權限。';end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 50
    or p_existing is null or jsonb_typeof(p_existing)<>'array' or jsonb_array_length(p_existing) not between 1 and 50 then raise exception '取貨明細資料不完整。';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r)<>'object' or nullif(r->>'inventory_item_id','') is null
    or coalesce((r->>'quantity')::numeric,0)<=0 or (r->>'quantity')::numeric<>round((r->>'quantity')::numeric,2) or coalesce(r->>'quantity_unit','package') not in('package','meter') or (coalesce(r->>'quantity_unit','package')='package' and (r->>'quantity')::numeric<>trunc((r->>'quantity')::numeric)) or char_length(coalesce(r->>'note',''))>500)
    then raise exception '取貨明細品項、數量或備註不正確。';end if;
  -- Repeated product lines are independent; stable line IDs and request keys still prevent replay.
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
      insert into public.pickup_records(pickup_date,project_id,inventory_item_id,quantity,note,source,updated_by,created_by_user_id,created_by_username,work_log_id,quantity_unit,remnant_line_id)
      values(p_pickup_date,p_project_id,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,nullif(btrim(v_row->>'note'),''),'web',v_actor,v_creator,v_username,v_log,coalesce(v_row->>'quantity_unit','package'),nullif(v_row->>'remnant_line_id','')::uuid) returning id into v_id;
    else

      select row_version into v_version from public.pickup_records where id=v_id;
      select case when v_row?'remnant_line_id' then nullif(v_row->>'remnant_line_id','')::uuid else remnant_line_id end into v_remnant from public.pickup_records where id=v_id;
      if exists(select 1 from public.pickup_records where id=v_id and (quantity_unit<>coalesce(v_row->>'quantity_unit','package') or remnant_line_id is distinct from v_remnant)) then
        -- A correction keeps the original row, author, assignment, length and
        -- cost provenance. It is one UPDATE, so triggers see the final unit and
        -- quantity together; no delete/recreate or temporary quantity is used.
        if exists(select 1 from public.pickup_records where id=v_id and quantity_unit<>coalesce(v_row->>'quantity_unit','package')) and exists(select 1 from public.pickup_records p join public.inventory_items i on i.id=p.inventory_item_id
          where p.id=v_id and p.inventory_item_id=(v_row->>'inventory_item_id')::uuid
          and p.meters_per_unit_snapshot is distinct from i.meters_per_unit)
          then raise exception '此歷史單據的包裝長度與現行規格不同，不能直接切換計量單位。';end if;
        update public.pickup_records p set pickup_date=p_pickup_date,project_id=p_project_id,
          work_log_id=case when p.project_id=p_project_id or exists(select 1 from public.site_work_logs l join public.sites s on s.id=l.site_id
            where l.id=p.work_log_id and coalesce(l.project_id,s.project_id)=p_project_id) then p.work_log_id else null end,
          inventory_item_id=(v_row->>'inventory_item_id')::uuid,quantity=(v_row->>'quantity')::numeric,
          quantity_unit=coalesce(v_row->>'quantity_unit','package'),remnant_line_id=v_remnant,note=nullif(btrim(v_row->>'note'),''),source='web',updated_by=v_actor
          where p.id=v_id and p.row_version=v_version;
        if not found then raise exception '此取貨紀錄已被其他使用者更新，請重新載入。';end if;
      else
      perform public.update_pickup_record_v2(v_id,v_version,p_pickup_date,p_project_id,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,v_row->>'note',v_actor);
      end if;
    end if;
    v_ids:=array_append(v_ids,v_id);
  end loop;
  perform set_config('app.pickup_document_id',coalesce(v_context,''),true);
  return jsonb_build_object('document_id',p_document_id,'ids',v_ids,'saved',cardinality(v_ids));
end $function$;

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
  -- Repeated product lines are independent; stable line IDs and request keys still prevent replay.
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

CREATE OR REPLACE FUNCTION public.save_supplier_return_v1(p_actor_user_id uuid, p_action text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare did uuid:=(p_payload->>'document_id')::uuid;req uuid:=(p_payload->>'request_id')::uuid;
 old_doc public.supplier_return_documents;doc public.supplier_return_documents;reg public.stock_transaction_documents;old_req public.supplier_return_requests;
 old_customers jsonb;rows jsonb:=p_payload->'rows';meta jsonb:=coalesce(p_payload->'receipt_metadata','{}');old_lines jsonb;customers jsonb:=p_payload->'customer_departments';
 customer_ids uuid[];old_ids uuid[];submitted_ids uuid[];v_row jsonb;line public.supplier_return_lines;cid uuid;dep uuid;legacy_dep uuid;
 v_supplier uuid;project uuid;day date;mode text;rate integer;discount numeric;price numeric;needed text;num text;actor text;
 item uuid;lot uuid;unit_mode text;unit_factor numeric;unknown_count numeric;before_qty numeric;old_qty numeric;new_qty numeric;issued numeric;returned numeric;version integer;v_line_number integer:=0;result jsonb;financials jsonb;
begin
 if p_action is null or p_action not in('create','update','delete') or did is null or req is null then raise exception '退貨單操作資料不完整。';end if;
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'purchases',upper(p_action)) then raise exception '沒有退貨操作權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform pg_advisory_xact_lock(hashtextextended('supplier-return-request:'||req::text,0));
 perform pg_advisory_xact_lock(hashtextextended('supplier-return-document:'||did::text,0));
 select * into old_doc from public.supplier_return_documents where id=did for update;
 if old_doc.id is not null and not public.supplier_return_visible_v1(p_actor_user_id,did) then raise exception '找不到退貨單或沒有存取權限。';end if;
 select * into old_req from public.supplier_return_requests where request_id=req;
 if found then
  if old_req.actor_user_id<>p_actor_user_id or old_req.document_id<>did or old_req.payload is distinct from jsonb_build_object('action',p_action,'payload',p_payload) then raise exception '重試識別碼已用於不同內容，請重新讀取後儲存。';end if;
  return old_req.result;
 end if;
 if p_action='create' then
  if old_doc.id is not null or p_payload->>'row_version' is not null then raise exception '退貨單已建立，請重新讀取。';end if;
 elsif old_doc.id is null or old_doc.deleted_at is not null or old_doc.row_version is distinct from (p_payload->>'row_version')::integer then raise exception '退貨單已被更新或刪除，請重新讀取後操作。';end if;
 select coalesce(jsonb_agg(to_jsonb(l)),'[]'),coalesce(array_agg(id),'{}') into old_lines,old_ids from public.supplier_return_lines l where document_id=did;
 select coalesce(jsonb_agg(to_jsonb(c)),'[]') into old_customers from public.supplier_return_customers c where document_id=did;
 v_supplier:=old_doc.supplier_id;project:=old_doc.project_id;day:=old_doc.return_date;mode:=old_doc.tax_mode;rate:=old_doc.tax_rate_basis_points;discount:=coalesce(old_doc.discount_amount,0);
 if p_action<>'delete' then
  v_supplier:=(p_payload->>'supplier_id')::uuid;day:=(p_payload->>'return_date')::date;
  if day is null or v_supplier is null or not exists(select 1 from public.suppliers s where id=v_supplier and public.erp_private_json_visible_v1(to_jsonb(s))) then raise exception '請選擇有效的退貨日期及供應商。';end if;
  if rows is null or jsonb_typeof(rows)<>'array' or jsonb_array_length(rows) not between 1 and 20 then raise exception '每張退貨單必須有 1 至 20 筆明細。';end if;
  if exists(select 1 from jsonb_array_elements(rows) r where jsonb_typeof(r)<>'object' or nullif(r->>'inventory_item_id','') is null or jsonb_typeof(r->'quantity') is distinct from 'number' or (r->>'quantity')::numeric<=0 or (r->>'quantity')::numeric>=1000000000000 or ((coalesce(r->>'quantity_unit','package')='package' and (r->>'quantity')::numeric<>trunc((r->>'quantity')::numeric)) or (r->>'quantity')::numeric<>round((r->>'quantity')::numeric,2) or coalesce(r->>'quantity_unit','package') not in('package','meter')) or length(coalesce(r->>'note',''))>500) then raise exception '退貨數量須為正數；散料最多兩位小數，備註最多500字。';end if;
  -- Repeated product lines are independent; stable line IDs and request keys still prevent replay.
  select coalesce(array_agg((r->>'id')::uuid),'{}') into submitted_ids from jsonb_array_elements(rows) r where nullif(r->>'id','') is not null;
  if not(submitted_ids<@old_ids) or cardinality(submitted_ids)<>(select count(distinct x) from unnest(submitted_ids) x) then raise exception '退貨明細不屬於這張單據。';end if;
  if exists(select 1 from unnest(old_ids) x where not(x=any(submitted_ids))) and not public.has_app_permission_v1(p_actor_user_id,'purchases','DELETE') then raise exception '沒有刪除退貨明細的權限。';end if;
  if exists(select 1 from jsonb_array_elements(rows) r where nullif(r->>'id','') is null) and not public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE') then raise exception '沒有新增退貨明細的權限。';end if;
  if jsonb_typeof(meta) is distinct from 'object' or exists(select 1 from jsonb_object_keys(meta) k where k not in('project_id','tax_mode','tax_rate_basis_points','discount_amount')) then raise exception '退貨單設定不正確。';end if;
  if meta ? 'tax_mode' or meta ? 'tax_rate_basis_points' then
   if meta->>'tax_mode' is null or meta->>'tax_mode' not in('exclusive','inclusive') or jsonb_typeof(meta->'tax_rate_basis_points') is distinct from 'number' or (meta->>'tax_rate_basis_points')::numeric<>trunc((meta->>'tax_rate_basis_points')::numeric) or (meta->>'tax_rate_basis_points')::numeric not between 0 and 10000 then raise exception '計價模式或稅率不正確。';end if;
   mode:=meta->>'tax_mode';rate:=(meta->>'tax_rate_basis_points')::integer;
  end if;
  if meta ? 'discount_amount' then
   if jsonb_typeof(meta->'discount_amount') is distinct from 'number' then raise exception '折扣須為非負整數金額。';end if;
   discount:=(meta->>'discount_amount')::numeric;
   if discount<0 or discount>=100000000000000 or discount<>trunc(discount) then raise exception '折扣須為非負整數金額。';end if;
  end if;
  if (mode,rate,discount) is distinct from (old_doc.tax_mode,old_doc.tax_rate_basis_points,coalesce(old_doc.discount_amount,0)) then
   needed:=case when old_doc.tax_mode is null then 'CREATE' else 'UPDATE' end;
   if not public.has_app_permission_v1(p_actor_user_id,'purchase_prices','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'purchase_prices',needed) then raise exception '沒有退貨價格操作權限。';end if;
  end if;
  if meta ? 'project_id' then project:=nullif(meta->>'project_id','')::uuid;end if;
  if jsonb_typeof(p_payload->'customer_ids') is distinct from 'array' or jsonb_typeof(customers) is distinct from 'array' then raise exception '客戶與科室資料不完整。';end if;
  select coalesce(array_agg(value::uuid),'{}') into customer_ids from jsonb_array_elements_text(p_payload->'customer_ids');
  if cardinality(customer_ids)>2000 or cardinality(customer_ids)<>(select count(distinct x) from unnest(customer_ids) x) or cardinality(customer_ids)<>jsonb_array_length(customers)
   or (select count(distinct(r->>'customer_id')::uuid) from jsonb_array_elements(customers) r)<>cardinality(customer_ids) then raise exception '客戶不可重複或遺漏科室對應。';end if;
  for v_row in select value from jsonb_array_elements(customers) loop
   cid:=(v_row->>'customer_id')::uuid;dep:=nullif(v_row->>'department_id','')::uuid;
   if cid is null or not(cid=any(customer_ids)) or not exists(select 1 from public.customers c where c.id=cid and public.erp_private_json_visible_v1(to_jsonb(c)) and (c.deleted_at is null or exists(select 1 from public.supplier_return_customers x where x.document_id=did and x.customer_id=cid))) then raise exception '客戶已停用或沒有存取權限。';end if;
   select department_id into legacy_dep from public.supplier_return_customers where document_id=did and customer_id=cid;
   if dep is not null and not exists(select 1 from public.customer_departments where id=dep and customer_id=cid and (is_active or dep=legacy_dep)) then raise exception '科室不屬於此客戶或已停用。';end if;
   if dep is null and not exists(select 1 from public.supplier_return_customers where document_id=did and customer_id=cid and department_id is null) and exists(select 1 from public.customer_departments where customer_id=cid and is_active) then raise exception '請選擇客戶科室。';end if;
  end loop;
  if project is not null and (not public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') or not public.site_return_project_visible_v1(p_actor_user_id,project) or not exists(select 1 from public.projects where id=project and customer_id=any(customer_ids))) then raise exception '工作內容不屬於所選客戶或沒有查看權限。';end if;
  if exists(select 1 from public.app_users u join public.app_roles role on role.code=u.role where u.id=p_actor_user_id and role.project_scoped) and project is null then raise exception '請關聯有權限的工作內容。';end if;
 end if;
 -- Use the same inventory row locks as receipts, pickups and physical counts.
 perform 1 from public.inventory_items where id in(select (r->>'inventory_item_id')::uuid from jsonb_array_elements(old_lines) r union select (r->>'inventory_item_id')::uuid from jsonb_array_elements(case when p_action='delete' then '[]'::jsonb else rows end) r) order by id for update;
 if p_action<>'delete' and exists(select 1 from jsonb_array_elements(rows) r left join public.inventory_items i on i.id=(r->>'inventory_item_id')::uuid where i.id is null or i.inventory_status<>'active') then raise exception '部分品項已不存在或停用。';end if;
 version:=coalesce(old_doc.row_version,0)+1;
 select username into actor from public.app_users where id=p_actor_user_id and is_active;
 if p_action='create' then
  reg:=public.ensure_stock_document_v1('supplier_return',did,day,v_supplier);
  insert into public.supplier_return_documents(id,return_date,supplier_id,created_by_user_id,updated_by_user_id) values(did,day,v_supplier,p_actor_user_id,p_actor_user_id);
 else select * into reg from public.stock_transaction_documents where kind='supplier_return' and id=did;end if;
 if p_action<>'delete' then
  num:=nullif(btrim(p_payload->>'document_no'),'');
  if num is not null and (length(num)>64 or num~'[[:cntrl:]]') then raise exception '退貨單號最多 64 字，不能包含控制字元。';end if;
  perform pg_advisory_xact_lock(hashtextextended('supplier-return-number-scope:'||reg.numbering_scope_id::text,0));
  if num is not null and num is distinct from reg.document_no then
   if exists(select 1 from public.stock_transaction_documents where kind='supplier_return' and numbering_scope_id=reg.numbering_scope_id and id<>did and lower(document_no)=lower(num)) then raise exception '退貨單號已使用，請輸入同一編號廠商下不重複的單號。';end if;
   update public.stock_transaction_documents set document_no=num where kind='supplier_return' and id=did;reg.document_no:=num;
  end if;
  delete from public.supplier_return_lines where document_id=did and not(id=any(submitted_ids));
  for v_row in select value from jsonb_array_elements(rows) loop
   v_line_number:=v_line_number+1;select * into line from public.supplier_return_lines where document_id=did and id=nullif(v_row->>'id','')::uuid;
   price:=line.unit_price;
   if v_row ? 'unit_price' then
    if jsonb_typeof(v_row->'unit_price') not in('number','null') then raise exception '單價須為數字或空白。';end if;
    price:=(v_row->>'unit_price')::numeric;
    if price<0 or price>=1000000000000 or price<>round(price,2) then raise exception '單價須為非負數，最多兩位小數。';end if;
    if price is distinct from line.unit_price then
     needed:=case when price is null then 'DELETE' when line.unit_price is null then 'CREATE' else 'UPDATE' end;
     if not public.has_app_permission_v1(p_actor_user_id,'purchase_prices','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'purchase_prices',needed) then raise exception '沒有退貨價格操作權限。';end if;
    end if;
   end if;
   insert into public.supplier_return_lines(id,document_id,line_no,inventory_item_id,quantity,unit_price,note,quantity_unit,remnant_line_id)
   values(coalesce(line.id,gen_random_uuid()),did,v_line_number,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,price,coalesce(v_row->>'note',''),coalesce(v_row->>'quantity_unit','package'),nullif(v_row->>'remnant_line_id','')::uuid)
   on conflict(id) do update set line_no=excluded.line_no,inventory_item_id=excluded.inventory_item_id,quantity=excluded.quantity,unit_price=excluded.unit_price,note=excluded.note,quantity_unit=excluded.quantity_unit,remnant_line_id=excluded.remnant_line_id;
  end loop;
  delete from public.supplier_return_customers where document_id=did;
  insert into public.supplier_return_customers(document_id,customer_id,department_id) select did,(r->>'customer_id')::uuid,nullif(r->>'department_id','')::uuid from jsonb_array_elements(customers) r;
 end if;
 update public.supplier_return_documents set return_date=day,supplier_id=v_supplier,project_id=project,tax_mode=mode,tax_rate_basis_points=rate,discount_amount=discount,
 row_version=version,deleted_at=case when p_action='delete' then now() end,updated_at=now(),updated_by_user_id=p_actor_user_id where id=did returning * into doc;
 for item,unit_mode,lot in select (r->>'inventory_item_id')::uuid,coalesce(r->>'quantity_unit','package'),nullif(r->>'remnant_line_id','')::uuid from jsonb_array_elements(old_lines) r union select inventory_item_id,quantity_unit,remnant_line_id from public.supplier_return_lines where document_id=did order by 1,2 desc,3 loop
  select coalesce(sum((r->>'quantity')::numeric),0) into old_qty from jsonb_array_elements(old_lines) r where (r->>'inventory_item_id')::uuid=item and coalesce(r->>'quantity_unit','package')=unit_mode and nullif(r->>'remnant_line_id','')::uuid is not distinct from lot;
  select coalesce(sum(quantity),0) into new_qty from public.supplier_return_lines where document_id=did and inventory_item_id=item and quantity_unit=unit_mode and remnant_line_id is not distinct from lot and p_action<>'delete';
  if p_action<>'delete' then
   if unit_mode='meter' then
    select coalesce(sum(case when r.quantity_unit='meter' then r.quantity else r.quantity*r.meters_per_unit_snapshot end),0) into issued from public.stock_receipts r left join public.stock_transaction_documents d on d.id=r.receipt_document_id and d.kind='receipt' where r.supplier_id=v_supplier and r.inventory_item_id=item and d.receipt_delivery_state is distinct from 'pending';
    select coalesce(sum(case when l.quantity_unit='meter' then l.quantity else l.quantity*l.meters_per_unit_snapshot end),0) into returned from public.supplier_return_lines l join public.supplier_return_documents d on d.id=l.document_id where d.supplier_id=v_supplier and d.deleted_at is null and l.inventory_item_id=item;
    select coalesce((select sum(r.quantity) from public.stock_receipts r left join public.stock_transaction_documents d on d.id=r.receipt_document_id and d.kind='receipt' where r.supplier_id=v_supplier and r.inventory_item_id=item and r.quantity_unit='package' and r.meters_per_unit_snapshot is null and d.receipt_delivery_state is distinct from 'pending'),0)-coalesce((select sum(l.quantity) from public.supplier_return_lines l join public.supplier_return_documents d on d.id=l.document_id where d.supplier_id=v_supplier and d.deleted_at is null and l.inventory_item_id=item and l.quantity_unit='package' and l.meters_per_unit_snapshot is null),0) into unknown_count;
    if returned>issued and unknown_count<=0 then raise exception '退貨米數超過此供應商的可退進貨米數。';end if;
   else
    select coalesce(sum(quantity),0) into issued from public.stock_receipts where supplier_id=v_supplier and inventory_item_id=item and quantity_unit='package';
    select coalesce(sum(l.quantity),0) into returned from public.supplier_return_lines l join public.supplier_return_documents d on d.id=l.document_id where d.supplier_id=v_supplier and d.deleted_at is null and l.inventory_item_id=item and l.quantity_unit='package';
    if returned>issued then raise exception '退貨數量超過此供應商的可退進貨量，請核對進貨紀錄及其他退貨單。';end if;
   end if;
  end if;
  if old_qty<>new_qty then
   if lot is not null and (unit_mode<>'meter' or not exists(select 1 from public.site_return_lines where id=lot and inventory_item_id=item and is_remnant_box)) then raise exception '所選餘料箱不屬於此退貨品項。';end if;
   if unit_mode='meter' and new_qty>old_qty then
    if lot is null then perform public.reserve_inventory_meters_v1(item,new_qty-old_qty,actor,'供應商退貨拆包 '||reg.document_no);
    elsif new_qty-old_qty>public.inventory_remnant_balance_v1(lot) then raise exception '所選餘料箱米數不足，不能跨箱退貨。';end if;
   end if;
   before_qty:=case when unit_mode='meter' then public.current_inventory_meters_v1(item) else public.current_inventory_quantity(item) end;
   if before_qty+old_qty-new_qty<0 then raise exception '庫存不足，無法退貨；請減少數量或先處理取貨紀錄。';end if;
   insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,supplier_return_document_id,supplier_return_version,quantity_unit,remnant_line_id)
   values(item,before_qty,before_qty+old_qty-new_qty,'供應商退貨 '||reg.document_no,gen_random_uuid(),'supplier_return',actor,did,version,unit_mode,lot);
  end if;
 end loop;
 financials:=public.receipt_money_totals_v2((select jsonb_agg(jsonb_build_object('quantity',quantity,'unit_price',unit_price,'quantity_unit',quantity_unit)) from public.supplier_return_lines where document_id=did),mode,rate,discount);
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('supplier_return_documents',did,case p_action when 'create' then 'insert' else p_action end,case when old_doc.id is not null then to_jsonb(old_doc)||jsonb_build_object('lines',old_lines,'customer_departments',old_customers) end,to_jsonb(doc)||jsonb_build_object('lines',(select jsonb_agg(to_jsonb(l)) from public.supplier_return_lines l where document_id=did),'customer_departments',(select jsonb_agg(to_jsonb(c)) from public.supplier_return_customers c where document_id=did)),'web',actor);
 result:=jsonb_build_object('document_id',did,'document_no',reg.document_no,'row_version',version);
 insert into public.supplier_return_requests(request_id,document_id,actor_user_id,payload,result) values(req,did,p_actor_user_id,jsonb_build_object('action',p_action,'payload',p_payload),result);
 return result;
end $function$;

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
 -- Permit recorded withdrawals below zero; item/box identity and locking remain enforced.
 end loop;
 return null;
end $function$;

CREATE OR REPLACE FUNCTION public.guard_remnant_pickup_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare l public.site_return_lines;available numeric;
begin
 if new.remnant_line_id is null then return new;end if;
 if tg_op='UPDATE' and new.inventory_item_id<>old.inventory_item_id and new.remnant_line_id=old.remnant_line_id then
  new.remnant_line_id:=null;return new;
 end if;
 if new.quantity_unit<>'meter' then raise exception '餘料箱必須以米取貨。';end if;
 perform 1 from public.inventory_items where id=new.inventory_item_id for update;
 select * into l from public.site_return_lines where id=new.remnant_line_id;
 if l.id is null or not l.is_remnant_box or l.inventory_item_id<>new.inventory_item_id then raise exception '所選餘料箱不屬於此品項，請重新選擇。';end if;
 -- A correction can reduce an old withdrawal even after its source was reversed.
 if tg_op='UPDATE' and old.remnant_line_id=new.remnant_line_id and old.inventory_item_id=new.inventory_item_id
  and old.quantity_unit='meter' and new.quantity<=old.quantity then return new;end if;
 available:=public.inventory_remnant_balance_v1(new.remnant_line_id);
 if tg_op='UPDATE' and old.remnant_line_id=new.remnant_line_id and old.quantity_unit='meter' then available:=available+old.quantity;end if;
 -- Permit recorded withdrawals below zero; item/box identity and locking remain enforced.
 return new;
end $function$;

CREATE OR REPLACE FUNCTION public.guard_remnant_pickup_balance_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 if new.remnant_line_id is null then return null;end if;
 if tg_op='UPDATE' and old.remnant_line_id=new.remnant_line_id and old.inventory_item_id=new.inventory_item_id
  and old.quantity_unit='meter' and new.quantity<=old.quantity then return null;end if;
 -- Permit recorded withdrawals below zero; item/box identity and locking remain enforced.
 return null;
end $function$;

CREATE OR REPLACE FUNCTION public.unpack_cable_for_pickup_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare factor numeric;loose numeric;packages numeric;available numeric;actor text;
begin
 if new.quantity_unit<>'meter' or new.remnant_line_id is not null then return new;end if;
 if tg_op='INSERT' or old.inventory_item_id is distinct from new.inventory_item_id or old.quantity_unit<>'meter' then
  if not public.inventory_loose_meter_allowed_v1(new.inventory_item_id) and not(tg_op='UPDATE' and old.inventory_item_id=new.inventory_item_id and old.quantity_unit='meter') then raise exception '此貨品請使用原單位取貨。';end if;
 end if;
 select meters_per_unit into factor from public.inventory_items where id=new.inventory_item_id for update;

 loose:=public.inventory_unboxed_meters_v1(new.inventory_item_id);
 if tg_op='UPDATE' and old.inventory_item_id=new.inventory_item_id and old.quantity_unit='meter' and old.remnant_line_id is null then loose:=loose+old.quantity;end if;
 if new.quantity>loose then
  if factor is null then
   return new; -- Unknown length is not guessed; record negative meters for later reconciliation.
  end if;
  packages:=ceil((new.quantity-loose)/factor);available:=public.current_inventory_quantity(new.inventory_item_id);
  -- The BEFORE trigger still sees the old package withdrawal. Those packages
  -- are released by this same UPDATE and may supply the corrected meter row.
  if tg_op='UPDATE' and old.inventory_item_id=new.inventory_item_id and old.quantity_unit='package' then
    available:=available+old.quantity;
  end if;
  if available<packages then
    -- Unpack only actual whole packages; missing material remains a visible
    -- negative meter balance rather than an invented package or stock receipt.
    packages:=greatest(0,least(packages,floor(available)));
    if packages=0 then return new;end if;

  end if;
  actor:=coalesce(new.updated_by,new.created_by_username,'system');
  insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
   values(new.inventory_item_id,available,available-packages,'米數取貨拆包：'||new.id::text||'；每包 '||factor::text||' 米',gen_random_uuid(),'web',actor,'package');
  insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
   values(new.inventory_item_id,public.current_inventory_meters_v1(new.inventory_item_id),public.current_inventory_meters_v1(new.inventory_item_id)+packages*factor,'米數取貨拆包：'||new.id::text||'；'||packages::text||' 包',gen_random_uuid(),'web',actor,'meter');
 end if;
 return new;
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
 select r.*,case when public.cable_cost_sources_visible_v1(r.cable_cost_source_receipt_ids) then r.cable_unit_cost_snapshot end visible_cable_cost,case when r.quantity_unit='meter' then r.quantity else r.quantity*coalesce(r.meters_per_unit_snapshot,1) end report_quantity,i.item_name,i.brand,i.model,case when r.quantity_unit='meter' or r.meters_per_unit_snapshot is not null then '米' else coalesce(r.package_unit_snapshot,i.legacy_unit,i.unit) end unit,i.category_id,
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
 select l.id,l.inventory_item_id,case when l.quantity_unit='meter' or l.meters_per_unit_snapshot is not null then '米' else coalesce(l.package_unit_snapshot,i.legacy_unit,i.unit) end unit,case when public.cable_cost_sources_visible_v1(l.cable_cost_source_receipt_ids) then l.cable_unit_cost_snapshot end visible_cable_cost,case when l.quantity_unit='meter' then l.quantity else l.quantity*coalesce(l.meters_per_unit_snapshot,1) end quantity,d.return_date,d.document_no,d.id document_id,u.display_name account
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
 left join public.accounting_material_prices manual on manual.project_id=p_project_id and manual.inventory_item_id=m.id and (m.unit<>'米' or manual.meters_per_unit_snapshot is not null or lower(btrim(coalesce(manual.package_unit_snapshot,(select coalesce(i.legacy_unit,i.unit) from public.inventory_items i where i.id=m.id)))) in('米','m','公尺'))
 left join lateral(select s.id,s.receipt_date,s.receipt_document_id,s.unit_price input_unit_price,s.meters_per_unit_snapshot,
 d.receipt_tax_mode,d.receipt_tax_rate_basis_points,
 public.accounting_receipt_unit_net_v1(s.id) unit_price
 from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id
 where s.inventory_item_id=m.id and d.receipt_delivery_state is distinct from 'pending' and s.unit_price is not null and ((m.unit='米' and (s.meters_per_unit_snapshot is not null or lower(btrim(coalesce(s.package_unit_snapshot,(select coalesce(i.legacy_unit,i.unit) from public.inventory_items i where i.id=m.id)))) in('米','m','公尺'))) or (m.unit<>'米' and s.quantity_unit='package' and s.meters_per_unit_snapshot is null)) and public.erp_private_json_visible_v1(to_jsonb(s))
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
 union all select 'subcontractor','代工','代工',true,count(*),sum(records),min(log_date),max(log_date),max(log_date) from contractor_days having count(*)>0),
 labor_days as (
 select user_id::text worker_id,max(display_name) worker_name,log_date,1::bigint headcount from workers group by user_id,log_date
 union all select 'subcontractor','代工',log_date,headcount from contractor_days),
 labor_costs as (
 select d.*,c.daily_wage,round(d.headcount*c.daily_wage,2) labor_amount,c.row_version wage_row_version
 from labor_days d left join public.accounting_worker_wages c on price_visible and c.project_id=p_project_id
 and coalesce(c.worker_user_id::text,'subcontractor')=d.worker_id and c.work_date=d.log_date),
 worker_json as (select w.*,to_jsonb(w)||jsonb_build_object('unit','人次','personCount',case when w.id='subcontractor' then (select coalesce(sum(headcount),0) from contractor_days) else w."constructionDays" end)
 ||case when price_visible then (select jsonb_build_object('labor_amount',sum(c.labor_amount),'unpricedDayCount',count(*) filter(where c.daily_wage is null)) from labor_costs c where c.worker_id=w.id) else '{}'::jsonb end data
 from worker_stats w)
 select result||jsonb_build_object('report',jsonb_build_object('error','',
 'materialStats',coalesce((select jsonb_agg(data order by (data->>'recordCount')::int desc,data->>'id') from material_stats),'[]'),
 'materialCategoryStats',coalesce((select jsonb_agg(data order by data->>'name',data->>'id') from category_json),'[]'),
 'workerStats',coalesce((select jsonb_agg(w.data order by w."constructionDays" desc,w.id) from worker_json w),'[]'),
 'returnRows',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'date',r.return_date,'documentId',r.document_id,'documentNo',r.document_no,'itemId',r.inventory_item_id,'categoryId',i.category_id,'quantity',r.quantity,'account',r.account,'item',jsonb_build_object('name',i.item_name,'brand',i.brand,'model',i.model,'unit',r.unit)) order by r.return_date desc,r.id) from returned r join public.inventory_items i on i.id=r.inventory_item_id),'[]'),
 'quantityBasis','issued_minus_returns',
 'materialRows',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'date',m.pickup_date,'itemId',m.inventory_item_id,
 'categoryId',m.category_id,'categoryName',m.category_name,'quantity',m.report_quantity,'sourceQuantity',m.quantity,'sourceQuantityUnit',m.quantity_unit,'metersPerUnitSnapshot',m.meters_per_unit_snapshot,'sourceUnit',case when m.quantity_unit='meter' then '米' else coalesce(m.package_unit_snapshot,'原單位') end,'account',m.created_by_username,'item',jsonb_build_object('name',m.item_name,'brand',m.brand,'model',m.model,'unit',m.unit)) order by m.pickup_date desc,m.id) from materials m),'[]'),
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
      'id',s.id,'itemId',s.inventory_item_id,'name',i.item_name,'quantity',s.quantity,'unit',case when s.quantity_unit='meter' then '米' else coalesce(s.package_unit_snapshot,i.legacy_unit,i.unit) end,
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

create or replace function public.dashboard_calendar_v1(p_actor_user_id uuid,p_from date,p_to date)
returns jsonb language plpgsql security invoker set search_path='' as $calendar$
declare manager boolean; scoped boolean; result jsonb;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'dashboard','VIEW') then raise exception '沒有首頁查看權限。';end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>42 then raise exception '行事曆日期範圍不正確。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 manager:=public.has_app_permission_v1(p_actor_user_id,'projects','CREATE') or public.has_app_permission_v1(p_actor_user_id,'projects','UPDATE') or public.has_app_permission_v1(p_actor_user_id,'projects','DELETE');
 select r.project_scoped into scoped from public.app_users u join public.app_roles r on r.code=u.role where u.id=p_actor_user_id;
 select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('calendar_date',coalesce(case when a.assignment_type='appointment' then a.appointment_date else a.assigned_date end,(a.created_at at time zone 'Asia/Taipei')::date),'date_source',case when a.assignment_type='appointment' and a.appointment_date is not null then '預約日期' when a.assigned_date is not null and a.assignment_type<>'appointment' then '指派日期' else '建立日期' end,'project',case when a.assignment_type='appointment' then coalesce(a.instructions,'客戶預約事項') else p.name end,'project_code',p.project_code,'customer',c.name,'assignee',u.display_name,'creator',creator.display_name,'item',i.item_name) order by a.created_at,a.id),'[]') into result
 from public.work_assignments a left join public.projects p on p.id=a.project_id
 left join public.customers c on c.id=coalesce(a.customer_id,p.customer_id)
 left join public.app_users u on u.id=a.assignee_user_id left join public.app_users creator on creator.id=a.created_by_user_id
 left join public.inventory_items i on i.id=a.inventory_item_id
 where coalesce(case when a.assignment_type='appointment' then a.appointment_date else a.assigned_date end,(a.created_at at time zone 'Asia/Taipei')::date) between p_from and p_to
 and a.status<>'cancelled' and public.erp_private_json_visible_v1(to_jsonb(a))
 and ((a.assignment_type='appointment' and public.has_app_permission_v1(p_actor_user_id,'appointments','VIEW'))
 or (a.assignment_type in ('general','pickup')
 and (case when a.assignment_type='pickup' then public.has_app_permission_v1(p_actor_user_id,'pickups','VIEW') else public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') or public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW') end)
 and (a.assignee_user_id=p_actor_user_id or (manager and public.has_app_permission_v1(p_actor_user_id,'appointments','VIEW') and public.has_app_permission_v1(p_actor_user_id,'projects','VIEW')))
 and (not coalesce(scoped,false) or a.assignee_user_id=p_actor_user_id or public.construction_project_access_v1(p_actor_user_id,p.id,false))));
 return jsonb_build_object('records',result,'from',p_from,'to',p_to);
end $calendar$;
revoke all on function public.dashboard_calendar_v1(uuid,date,date) from public,anon,authenticated;
grant execute on function public.dashboard_calendar_v1(uuid,date,date) to service_role;
notify pgrst,'reload schema';
commit;
