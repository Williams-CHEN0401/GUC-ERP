-- Guard the exact deployed baseline before changing existing business functions.
do $guard$ begin
 if md5(replace(pg_get_functiondef('save_site_return_v1(uuid,uuid,uuid,integer,text,date,uuid,uuid,jsonb,text)'::regprocedure),chr(13),''))<>'8054cd98d9010f0bc0e517767c8ef158' then raise exception 'Unexpected baseline save_site_return_v1';end if;
 if md5(replace(pg_get_functiondef('erp_stock_totals_v1(uuid)'::regprocedure),chr(13),''))<>'c2c2a81a20d28c2a367b2c3149a3946c' then raise exception 'Unexpected baseline erp_stock_totals_v1';end if;
 if md5(replace(pg_get_functiondef('site_return_list_v1(uuid)'::regprocedure),chr(13),''))<>'7eec9b378e916ea699f92b382fd9d53c' then raise exception 'Unexpected baseline site_return_list_v1';end if;
 if md5(replace(pg_get_functiondef('unpack_cable_for_pickup_v1()'::regprocedure),chr(13),''))<>'45fc9569bd76e791ce87847d6ed8f0da' then raise exception 'Unexpected baseline unpack_cable_for_pickup_v1';end if;
 if md5(replace(pg_get_functiondef('reserve_inventory_meters_v1(uuid,numeric,text,text)'::regprocedure),chr(13),''))<>'33b4a8b5e5377540a3ce6dbf1c12e1b5' then raise exception 'Unexpected baseline reserve_inventory_meters_v1';end if;
 if md5(replace(pg_get_functiondef('create_pickup_records_batch_v2(jsonb,uuid,text,uuid,uuid,text)'::regprocedure),chr(13),''))<>'ca25932a86b1fb99c44437895187db2c' then raise exception 'Unexpected baseline create_pickup_records_batch_v2';end if;
 if md5(replace(pg_get_functiondef('save_pickup_document_v1(uuid,jsonb,date,uuid,jsonb,uuid)'::regprocedure),chr(13),''))<>'7886da8cd8f337fc1e20eef636394deb' then raise exception 'Unexpected baseline save_pickup_document_v1';end if;
 if md5(replace(pg_get_functiondef('save_supplier_return_v1(uuid,text,jsonb)'::regprocedure),chr(13),''))<>'03b7d3308f77b0a0e6c3b84562d4f8b3' then raise exception 'Unexpected baseline save_supplier_return_v1';end if;
end $guard$;

-- Physical remnants are existing return lines, not another inventory master.
-- Existing lines remain unboxed; no historical quantities or accounts are rewritten.
alter table public.site_return_lines
 add column is_remnant_box boolean not null default false,
 add column box_label text not null default '' check(char_length(box_label)<=80),
 add column line_no integer not null default 0 check(line_no>=0);
alter table public.site_return_lines drop constraint site_return_lines_document_id_inventory_item_id_key;
alter table public.pickup_records add column remnant_line_id uuid references public.site_return_lines(id) on delete restrict;
alter table public.supplier_return_lines add column remnant_line_id uuid references public.site_return_lines(id) on delete restrict;
alter table public.site_return_lines add constraint site_return_lines_remnant_unit_check check(not is_remnant_box or quantity_unit='meter');
alter table public.pickup_records add constraint pickup_records_remnant_unit_check check(remnant_line_id is null or quantity_unit='meter');
alter table public.supplier_return_lines add constraint supplier_return_lines_remnant_unit_check check(remnant_line_id is null or quantity_unit='meter');
alter table public.stock_adjustments
 add column remnant_line_id uuid references public.site_return_lines(id) on delete restrict,
 add column remnant_count_target numeric check(remnant_count_target>=0),
 add column remnant_count_scope text check(remnant_count_scope in('box','unboxed')),
 add constraint stock_adjustments_remnant_count_check check(
  (remnant_count_scope is null and remnant_count_target is null and (remnant_line_id is null or (source='supplier_return' and quantity_unit='meter')))
  or (remnant_count_scope='box' and remnant_line_id is not null and remnant_count_target is not null and quantity_unit='meter' and source='web')
  or (remnant_count_scope='unboxed' and remnant_line_id is null and remnant_count_target is not null and quantity_unit='meter' and source='web'));
alter table public.stock_adjustments drop constraint stock_adjustments_after_quantity_check;
alter table public.stock_adjustments add constraint stock_adjustments_after_quantity_check
 check(after_quantity>=0 or source='site_return' or remnant_count_scope is not null);
create index pickup_records_remnant_line_idx on public.pickup_records(remnant_line_id) where remnant_line_id is not null;
create index stock_adjustments_remnant_line_idx on public.stock_adjustments(remnant_line_id) where remnant_line_id is not null;
create index site_return_lines_remnant_item_idx on public.site_return_lines(inventory_item_id) where is_remnant_box;
drop index public.stock_adjustments_supplier_return_version_uidx;
create unique index stock_adjustments_supplier_return_version_uidx on public.stock_adjustments
 (supplier_return_document_id,supplier_return_version,inventory_item_id,quantity_unit,coalesce(remnant_line_id,'00000000-0000-0000-0000-000000000000'::uuid))
 where supplier_return_document_id is not null;

create function public.inventory_remnant_balance_v1(p_line uuid)
returns numeric language sql stable set search_path='' as $$
 select coalesce((select sum(difference_quantity) from public.stock_adjustments where site_return_line_id=p_line and quantity_unit='meter'),0)
 +coalesce((select sum(difference_quantity) from public.stock_adjustments where remnant_line_id=p_line and quantity_unit='meter'),0)
 -coalesce((select sum(quantity) from public.pickup_records where remnant_line_id=p_line and quantity_unit='meter'),0);
$$;
create function public.inventory_remnant_allocated_v1(p_item uuid)
returns numeric language sql stable set search_path='' as $$
 select coalesce(sum(public.inventory_remnant_balance_v1(id)),0) from public.site_return_lines where inventory_item_id=p_item and is_remnant_box;
$$;
create function public.inventory_unboxed_meters_v1(p_item uuid)
returns numeric language sql stable set search_path='' as $$
 select public.current_inventory_meters_v1(p_item)-public.inventory_remnant_allocated_v1(p_item);
$$;
create function public.inventory_remnant_boxes_v1(p_item uuid)
returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'label',coalesce(nullif(l.box_label,''),d.document_no||'／第'||l.line_no::text||'箱'),
 'remaining_meters',public.inventory_remnant_balance_v1(l.id),'received_meters',l.quantity,
 'document_no',d.document_no,'return_date',d.return_date,'line_no',l.line_no,'status',d.status) order by d.return_date,d.created_at,l.line_no,l.id),'[]')
 from public.site_return_lines l join public.site_return_documents d on d.id=l.document_id
 where l.inventory_item_id=p_item and l.is_remnant_box
 and (public.inventory_remnant_balance_v1(l.id)<>0 or (d.status='active' and l.quantity>0));
$$;

create function public.guard_remnant_pickup_v1() returns trigger language plpgsql set search_path='' as $$
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
 if new.quantity>available then raise exception '所選餘料箱剩餘 % 米，不能超過該箱米數。',available;end if;
 return new;
end $$;
create trigger a_remnant_pickup before insert or update on public.pickup_records for each row execute function public.guard_remnant_pickup_v1();
create function public.guard_remnant_pickup_balance_v1() returns trigger language plpgsql set search_path='' as $$
begin
 if new.remnant_line_id is null then return null;end if;
 if tg_op='UPDATE' and old.remnant_line_id=new.remnant_line_id and old.inventory_item_id=new.inventory_item_id
  and old.quantity_unit='meter' and new.quantity<=old.quantity then return null;end if;
 if public.inventory_remnant_balance_v1(new.remnant_line_id)<0 then raise exception '所選餘料箱米數不足，請重新讀取庫存。';end if;
 return null;
end $$;
create constraint trigger pickup_remnant_balance after insert or update on public.pickup_records
 deferrable initially deferred for each row execute function public.guard_remnant_pickup_balance_v1();

create function public.count_inventory_remnant_v1(p_actor_user_id uuid,p_item uuid,p_line uuid,p_after numeric,p_reason text,p_request uuid)
returns jsonb language plpgsql set search_path='' as $$
declare actor text;before_qty numeric;total_qty numeric;scope text;entry public.stock_adjustments;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'inventory','UPDATE') then raise exception '沒有庫存校正權限。';end if;
 if p_after is null or p_after<0 or p_after>=1e12 or p_after<>round(p_after,2) or length(coalesce(p_reason,''))>500 or p_request is null then raise exception '請填寫有效的盤點米數。';end if;
 select username into actor from public.app_users where id=p_actor_user_id and is_active;
 if actor is null then raise exception '無法確認操作帳號。';end if;
 perform 1 from public.inventory_items where id=p_item for update;if not found then raise exception '找不到指定品項。';end if;
 if not public.inventory_loose_meter_allowed_v1(p_item) then raise exception '此貨品種類不能使用散料(米)。';end if;
 scope:=case when p_line is null then 'unboxed' else 'box' end;
 if p_line is not null and not exists(select 1 from public.site_return_lines where id=p_line and inventory_item_id=p_item and is_remnant_box) then raise exception '所選餘料箱不屬於此品項。';end if;
 select * into entry from public.stock_adjustments where idempotency_key=p_request;
 if found then
  if entry.inventory_item_id<>p_item or entry.remnant_line_id is distinct from p_line or entry.remnant_count_scope is distinct from scope
   or entry.remnant_count_target is distinct from p_after or coalesce(entry.reason,'')<>coalesce(p_reason,'') or entry.updated_by is distinct from actor then raise exception '重試識別碼已用於不同內容。';end if;
  return jsonb_build_object('inventory_item_id',p_item,'verified_quantity',p_after,'remnant_line_id',p_line);
 end if;
 before_qty:=case when p_line is null then public.inventory_unboxed_meters_v1(p_item) else public.inventory_remnant_balance_v1(p_line) end;
 total_qty:=public.current_inventory_meters_v1(p_item);
 insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit,remnant_line_id,remnant_count_target,remnant_count_scope)
 values(p_item,total_qty,total_qty+p_after-before_qty,nullif(p_reason,''),p_request,'web',actor,'meter',p_line,p_after,scope);
 if (case when p_line is null then public.inventory_unboxed_meters_v1(p_item) else public.inventory_remnant_balance_v1(p_line) end) is distinct from p_after then raise exception '餘料盤點校正驗證失敗。';end if;
 return jsonb_build_object('inventory_item_id',p_item,'verified_quantity',p_after,'remnant_line_id',p_line);
end $$;

revoke all on function public.inventory_remnant_balance_v1(uuid),public.inventory_remnant_allocated_v1(uuid),
 public.inventory_unboxed_meters_v1(uuid),public.inventory_remnant_boxes_v1(uuid),public.guard_remnant_pickup_v1(),
 public.guard_remnant_pickup_balance_v1(),public.count_inventory_remnant_v1(uuid,uuid,uuid,numeric,text,uuid) from public,anon,authenticated;
grant execute on function public.inventory_remnant_balance_v1(uuid),public.inventory_remnant_allocated_v1(uuid),
 public.inventory_unboxed_meters_v1(uuid),public.inventory_remnant_boxes_v1(uuid),public.guard_remnant_pickup_v1(),
 public.guard_remnant_pickup_balance_v1(),public.count_inventory_remnant_v1(uuid,uuid,uuid,numeric,text,uuid) to service_role;





-- BEGIN GENERATED EXISTING FUNCTIONS
CREATE OR REPLACE FUNCTION public.save_site_return_v1(p_actor_user_id uuid, p_document_id uuid, p_request_id uuid, p_row_version integer, p_action text, p_return_date date, p_customer_id uuid, p_project_id uuid, p_rows jsonb, p_note text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare old_doc public.site_return_documents;new_doc public.site_return_documents;reg public.stock_transaction_documents;
 old_request public.site_return_requests;request_payload jsonb;v_result jsonb;v_actor text;row_data jsonb;line public.site_return_lines;
 v_item uuid;v_line uuid;v_before numeric;v_old numeric;v_new numeric;v_delta numeric;v_old_unit text;v_ledger_unit text;v_old_package_unit text;v_new_package_unit text;v_version integer;v_status text;v_unit text;v_lengths jsonb;v_rows jsonb;v_order integer;v_next_line integer;v_box boolean;
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
  if exists(select 1 from jsonb_array_elements(p_rows) r left join public.inventory_items i on i.id=(r->>'inventory_item_id')::uuid where i.id is null or i.inventory_status<>'active') then raise exception '部分品項已不存在或停用，請重新選擇。';end if;
 end if;
 -- Preserve line IDs; an item/unit/source change starts a new physical line.
 v_rows:='[]';
 if p_action in('create','update') then
  select coalesce(max(line_no),0) into v_next_line from public.site_return_lines where document_id=p_document_id;
  if (select count(*) from jsonb_array_elements(p_rows) r where nullif(r->>'id','') is not null)<>
     (select count(distinct r->>'id') from jsonb_array_elements(p_rows) r where nullif(r->>'id','') is not null) then raise exception '入庫明細識別碼重複。';end if;
  for row_data in select value from jsonb_array_elements(p_rows) loop
   v_line:=nullif(row_data->>'id','')::uuid;line:=null;
   if v_line is not null then
    select * into line from public.site_return_lines where id=v_line;
    if line.id is not null and line.document_id<>p_document_id then raise exception '入庫明細不屬於此單據。';end if;
   elsif p_action='update' then
    if (select count(*)from public.site_return_lines where document_id=p_document_id and inventory_item_id=(row_data->>'inventory_item_id')::uuid and quantity>0)=1 then
     select * into line from public.site_return_lines where document_id=p_document_id and inventory_item_id=(row_data->>'inventory_item_id')::uuid and quantity>0;
     v_line:=line.id;
    elsif exists(select 1 from public.site_return_lines where document_id=p_document_id and inventory_item_id=(row_data->>'inventory_item_id')::uuid and quantity>0) then
     raise exception '同品項有多箱餘料，請重新讀取後逐箱修改。';
    end if;
   end if;
   if length(coalesce(row_data->>'box_label',''))>80 or (row_data?'is_remnant_box' and jsonb_typeof(row_data->'is_remnant_box')<>'boolean') then raise exception '餘料箱號格式不正確。';end if;
   v_box:=coalesce((row_data->>'is_remnant_box')::boolean,line.is_remnant_box,false);
   if v_box and coalesce(row_data->>'quantity_unit','package')<>'meter' then raise exception '餘料箱請填寫個別米數。';end if;
   if line.id is not null and (line.inventory_item_id<>(row_data->>'inventory_item_id')::uuid or line.quantity_unit<>coalesce(row_data->>'quantity_unit','package') or line.is_remnant_box<>v_box) then v_line:=gen_random_uuid();end if;
   v_line:=coalesce(v_line,gen_random_uuid());
   if line.id is not null and v_line=line.id then v_order:=line.line_no;
   else v_next_line:=v_next_line+1;v_order:=v_next_line;end if;
   v_rows:=v_rows||jsonb_build_array(row_data||jsonb_build_object('id',v_line,'is_remnant_box',v_box,'line_no',v_order));
  end loop;
 end if;
 -- Same inventory locks as all other stock writes, in a stable order.
 perform 1 from public.inventory_items where id in(select inventory_item_id from public.site_return_lines where document_id=p_document_id
 union select (r->>'inventory_item_id')::uuid from jsonb_array_elements(v_rows) r) order by id for update;
 for row_data in select value from jsonb_array_elements(v_rows) loop
  v_item:=(row_data->>'inventory_item_id')::uuid;v_line:=(row_data->>'id')::uuid;
  if coalesce(row_data->>'quantity_unit','package')='meter' and not public.inventory_loose_meter_allowed_v1(v_item)
   and not exists(select 1 from public.site_return_lines where id=v_line and inventory_item_id=v_item and quantity_unit='meter') then raise exception '此貨品種類不能使用散料(米)。';end if;
 end loop;
 v_status:=case p_action when 'cancel' then 'cancelled' when 'delete' then 'deleted' else 'active' end;
 v_version:=coalesce(old_doc.row_version,0)+1;
 select username into v_actor from public.app_users where id=p_actor_user_id and is_active;
 if p_action='create' then
  reg:=public.ensure_stock_document_v1('site_return',p_document_id,p_return_date,'00000000-0000-0000-0000-000000000001'::uuid);
  insert into public.site_return_documents(id,document_no,return_date,customer_id,project_id,note,created_by_user_id,updated_by_user_id)
  values(p_document_id,reg.document_no,p_return_date,p_customer_id,p_project_id,coalesce(p_note,''),p_actor_user_id,p_actor_user_id) returning * into new_doc;
 else
  update public.site_return_documents set return_date=case when p_action='update' then p_return_date else return_date end,
  customer_id=case when p_action='update' then p_customer_id else customer_id end,project_id=case when p_action='update' then p_project_id else project_id end,
  note=case when p_action='update' then coalesce(p_note,'') else note end,status=v_status,row_version=v_version,updated_at=now(),updated_by_user_id=p_actor_user_id
  where id=p_document_id returning * into new_doc;
 end if;
 for v_line in select id from public.site_return_lines where document_id=p_document_id
 union select (r->>'id')::uuid from jsonb_array_elements(v_rows) r loop
  select * into line from public.site_return_lines where id=v_line;
  select r into row_data from jsonb_array_elements(v_rows) r where (r->>'id')::uuid=v_line;
  v_order:=(row_data->>'line_no')::integer;
  v_item:=coalesce((row_data->>'inventory_item_id')::uuid,line.inventory_item_id);
  v_old:=case when old_doc.status='active' then coalesce(line.quantity,0) else 0 end;
  v_old_unit:=coalesce(line.quantity_unit,'package');
  select coalesce(line.package_unit_snapshot,i.legacy_unit,i.unit) into v_old_package_unit from public.inventory_items i where i.id=v_item;
  v_new:=coalesce((row_data->>'quantity')::numeric,0);v_unit:=coalesce(row_data->>'quantity_unit',v_old_unit);
  v_lengths:=coalesce(row_data->'lengths','[]');
  if row_data is not null then
   if line.id is null then
    insert into public.site_return_lines(id,document_id,inventory_item_id,quantity,quantity_unit,lengths,is_remnant_box,box_label,line_no)
    values(v_line,p_document_id,v_item,v_new,v_unit,v_lengths,(row_data->>'is_remnant_box')::boolean,coalesce(row_data->>'box_label',''),v_order)
    returning package_unit_snapshot into v_new_package_unit;
   else
    update public.site_return_lines set quantity=v_new,lengths=v_lengths,box_label=coalesce(row_data->>'box_label',box_label),line_no=v_order
    where id=v_line returning package_unit_snapshot into v_new_package_unit;
   end if;
  elsif p_action='update' then
   update public.site_return_lines set quantity=0 where id=v_line returning package_unit_snapshot into v_new_package_unit;
  else v_new_package_unit:=line.package_unit_snapshot;end if;
  select coalesce(v_new_package_unit,i.unit) into v_new_package_unit from public.inventory_items i where i.id=v_item;
  for v_ledger_unit in select v_old_unit union select v_unit loop
   v_delta:=(case when v_unit=v_ledger_unit then v_new else 0 end)-(case when v_old_unit=v_ledger_unit then v_old else 0 end);
   if v_delta<>0 then
    v_before:=case when v_ledger_unit='meter' then public.current_inventory_meters_v1(v_item) else public.current_inventory_quantity(v_item) end;
    insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,site_return_line_id,site_return_version,quantity_unit,package_unit_snapshot)
    values(v_item,v_before,v_before+v_delta,'案場餘料入庫 '||new_doc.document_no,gen_random_uuid(),'site_return',v_actor,v_line,v_version,v_ledger_unit,
    case when v_ledger_unit=v_old_unit and v_old>0 then v_old_package_unit else v_new_package_unit end);
   end if;
  end loop;
 end loop;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('site_return_documents',p_document_id,case p_action when 'create' then 'insert' when 'cancel' then 'update' else p_action end,
 case when old_doc.id is not null then to_jsonb(old_doc) end,to_jsonb(new_doc),'web',v_actor);
 v_result:=jsonb_build_object('document_id',p_document_id,'document_no',new_doc.document_no,'row_version',v_version,'status',v_status);
 insert into public.site_return_requests(request_id,document_id,actor_user_id,payload,result) values(p_request_id,p_document_id,p_actor_user_id,request_payload,v_result);
 return v_result;
end $function$;

CREATE OR REPLACE FUNCTION public.erp_stock_totals_v1(p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
begin
 if not exists(select 1 from unnest(array['inventory','purchases','pickups','worklogs','repairs','reports']) m where public.has_app_permission_v1(p_actor_user_id,m,'VIEW')) then raise exception '沒有庫存查看權限。';end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'can_use_meter',public.inventory_loose_meter_allowed_v1(i.id),'loose_meters',public.current_inventory_meters_v1(i.id),'unboxed_meters',public.inventory_unboxed_meters_v1(i.id),'remnant_boxes',public.inventory_remnant_boxes_v1(i.id),'quantity',coalesce(i.opening_quantity,0)+coalesce(r.q,0)-coalesce(p.q,0)+coalesce(a.q,0))),'[]') from public.inventory_items i
 left join (select s.inventory_item_id,sum(s.quantity) q from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id where s.quantity_unit='package' and d.receipt_delivery_state is distinct from 'pending' group by s.inventory_item_id) r on r.inventory_item_id=i.id
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
  coalesce((select jsonb_agg(to_jsonb(l)-'cable_unit_cost_snapshot'-'cable_cost_source_receipt_ids' order by l.line_no,l.id) from public.site_return_lines l where l.document_id=d.id and l.quantity>0),'[]')) order by d.return_date desc,d.created_at desc)
  from public.site_return_documents d join public.app_users u on u.id=d.created_by_user_id where d.status<>'deleted' and d.project_id=any(allowed)),'[]'),
 'projects',coalesce((select jsonb_agg(jsonb_build_object('id',id,'customer_id',customer_id,'name',name,'code',project_code,'department_id',department_id) order by project_code) from public.projects where id=any(allowed)),'[]'),
 'customers',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'code',c.customer_code,'category',c.customer_category) order by c.customer_code) from public.customers c where c.id in(select customer_id from public.projects where id=any(allowed))),'[]'),
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'code',i.inventory_code,'name',i.item_name,'brand',i.brand,'model',i.model,'unit',i.unit,'meters_per_unit',i.meters_per_unit,'can_use_meter',public.inventory_loose_meter_allowed_v1(i.id),'legacy_unit',i.legacy_unit,'category_id',i.category_id,'category',coalesce(c.name,'未分類'),'active',i.inventory_status='active') order by i.inventory_code) from public.inventory_items i left join public.product_categories c on c.id=i.category_id),'[]'),
 'permissions',jsonb_build_object('create',public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE'),'update',public.has_app_permission_v1(p_actor_user_id,'purchases','UPDATE'),'delete',public.has_app_permission_v1(p_actor_user_id,'purchases','DELETE')));
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
  if factor is null then raise exception '未分箱散料不足；請選擇餘料箱，或以散料(米)進貨後再取貨。';end if;
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
   values(new.inventory_item_id,public.current_inventory_meters_v1(new.inventory_item_id),public.current_inventory_meters_v1(new.inventory_item_id)+packages*factor,'米數取貨拆包：'||new.id::text||'；'||packages::text||' 包',gen_random_uuid(),'web',actor,'meter');
 end if;
 return new;
end $function$;

CREATE OR REPLACE FUNCTION public.reserve_inventory_meters_v1(p_item uuid, p_needed numeric, p_actor text, p_reference text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare loose numeric;factor numeric;packages numeric;available numeric;
begin
 select meters_per_unit into factor from public.inventory_items where id=p_item for update;
 loose:=public.inventory_unboxed_meters_v1(p_item);
 if p_needed<=loose then return;end if;
 if factor is null then raise exception '散料米數不足；尚未設定包裝長度，無法自動拆包。';end if;
 packages:=ceil((p_needed-loose)/factor);available:=public.current_inventory_quantity(p_item);
 if packages>available then raise exception '可用米數不足，散料及整包庫存不足以供應本次領用。';end if;
 insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
 values(p_item,available,available-packages,p_reference||'；每包 '||factor::text||' 米',gen_random_uuid(),'web',p_actor,'package');
 insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
 values(p_item,public.current_inventory_meters_v1(p_item),public.current_inventory_meters_v1(p_item)+packages*factor,p_reference||'；'||packages::text||' 包',gen_random_uuid(),'web',p_actor,'meter');
end $function$;

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

  if exists (
    select 1
    from jsonb_array_elements(v_normalized) as rows(value)
    group by value ->> 'pickup_date', value ->> 'project_id', value ->> 'inventory_item_id',value->>'quantity_unit',value->>'remnant_line_id'
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
  if (select count(*) from jsonb_array_elements(p_rows))<>(select count(distinct jsonb_build_array(r->>'inventory_item_id',coalesce(r->>'quantity_unit','package'),r->>'remnant_line_id')) from jsonb_array_elements(p_rows) r) then raise exception '同一張取貨單有重複品項，請合併數量。';end if;
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
  if (select count(*) from jsonb_array_elements(rows))<>(select count(distinct(r->>'inventory_item_id',coalesce(r->>'quantity_unit','package'),r->>'remnant_line_id',lower(btrim(coalesce(r->>'note',''))))) from jsonb_array_elements(rows) r) then raise exception '同一張退貨單有重複明細，請合併數量。';end if;
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
notify pgrst,'reload schema';
