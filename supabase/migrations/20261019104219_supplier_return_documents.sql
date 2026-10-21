-- Supplier returns are transaction documents, using the existing master data,
-- purchase permissions, receipt money calculator and immutable adjustment ledger.
alter table public.stock_transaction_documents drop constraint stock_transaction_documents_kind_check;
alter table public.stock_transaction_documents add constraint stock_transaction_documents_kind_check check(kind in ('receipt','pickup','site_return','supplier_return'));
create table public.supplier_return_documents (
 id uuid primary key,kind text not null default 'supplier_return' check(kind='supplier_return'),
 return_date date not null,supplier_id uuid not null references public.suppliers(id),
 project_id uuid references public.projects(id),tax_mode text check(tax_mode in('exclusive','inclusive')),
 tax_rate_basis_points integer check(tax_rate_basis_points between 0 and 10000),
 discount_amount numeric not null default 0 check(discount_amount>=0 and discount_amount<100000000000000 and discount_amount=trunc(discount_amount)),
 deleted_at timestamptz,row_version integer not null default 1,
 created_by_user_id uuid not null references public.app_users(id),updated_by_user_id uuid not null references public.app_users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check((tax_mode is null)=(tax_rate_basis_points is null)),
 foreign key(kind,id) references public.stock_transaction_documents(kind,id)
);
create index supplier_return_supplier_date_idx on public.supplier_return_documents(supplier_id,return_date);
create index supplier_return_project_idx on public.supplier_return_documents(project_id);
create index supplier_return_creator_idx on public.supplier_return_documents(created_by_user_id);
create index supplier_return_updater_idx on public.supplier_return_documents(updated_by_user_id);
create table public.supplier_return_lines (
 id uuid primary key default gen_random_uuid(),document_id uuid not null references public.supplier_return_documents(id),
 line_no integer not null,inventory_item_id uuid not null references public.inventory_items(id),
 quantity numeric(14,2) not null check(quantity>0 and quantity=trunc(quantity)),
 unit_price numeric(14,2) check(unit_price>=0),note text not null default '' check(length(note)<=500)
);
create index supplier_return_lines_doc_idx on public.supplier_return_lines(document_id,line_no);
create index supplier_return_lines_item_idx on public.supplier_return_lines(inventory_item_id);
create table public.supplier_return_customers (
 document_id uuid not null references public.supplier_return_documents(id),customer_id uuid not null references public.customers(id),
 department_id uuid references public.customer_departments(id),primary key(document_id,customer_id)
);
create index supplier_return_customers_customer_idx on public.supplier_return_customers(customer_id);
create index supplier_return_customers_department_idx on public.supplier_return_customers(department_id);
create table public.supplier_return_requests (
 request_id uuid primary key,document_id uuid not null references public.supplier_return_documents(id),
 actor_user_id uuid not null references public.app_users(id),payload jsonb not null,result jsonb not null,created_at timestamptz not null default now()
);
create index supplier_return_requests_doc_idx on public.supplier_return_requests(document_id);
create index supplier_return_requests_actor_idx on public.supplier_return_requests(actor_user_id);
alter table public.stock_adjustments add column supplier_return_document_id uuid references public.supplier_return_documents(id),add column supplier_return_version integer;
create unique index stock_adjustments_supplier_return_version_uidx on public.stock_adjustments(supplier_return_document_id,supplier_return_version,inventory_item_id) where supplier_return_document_id is not null;
alter table public.stock_adjustments add constraint supplier_return_adjustment_source_check check(
 (supplier_return_document_id is null and supplier_return_version is null and source<>'supplier_return') or
 (supplier_return_document_id is not null and supplier_return_version>0 and source='supplier_return' and site_return_line_id is null));
alter table public.supplier_return_documents enable row level security;
alter table public.supplier_return_lines enable row level security;
alter table public.supplier_return_customers enable row level security;
alter table public.supplier_return_requests enable row level security;
revoke all on public.supplier_return_documents,public.supplier_return_lines,public.supplier_return_customers,public.supplier_return_requests from public,anon,authenticated;
grant select,insert,update on public.supplier_return_documents to service_role;
grant select,insert,update,delete on public.supplier_return_lines,public.supplier_return_customers to service_role;
grant select,insert on public.supplier_return_requests to service_role;

create function public.supplier_return_visible_v1(p_actor_user_id uuid,p_document_id uuid) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.supplier_return_documents d join public.suppliers s on s.id=d.supplier_id
 join public.app_users u on u.id=p_actor_user_id and u.is_active join public.app_roles role on role.code=u.role
 where d.id=p_document_id and public.erp_private_json_visible_v1(to_jsonb(s))
 and not exists(select 1 from public.supplier_return_customers x join public.customers c on c.id=x.customer_id where x.document_id=d.id and not public.erp_private_json_visible_v1(to_jsonb(c)))
 and (d.project_id is null or exists(select 1 from public.projects p where p.id=d.project_id and public.erp_private_json_visible_v1(to_jsonb(p))))
 and (not role.project_scoped or d.project_id is not null and exists(select 1 from public.project_workers w where w.project_id=d.project_id and w.user_id=u.id and (w.can_view or w.is_assignee))));
$$;
create function public.supplier_return_list_v1(p_actor_user_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare prices boolean;result jsonb;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') then raise exception '沒有退貨查看權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 prices:=public.has_app_permission_v1(p_actor_user_id,'purchase_prices','VIEW');
 select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'document_no',r.document_no,'return_date',d.return_date,'supplier_id',d.supplier_id,'project_id',d.project_id,'row_version',d.row_version,
 'customer_departments',coalesce((select jsonb_agg(jsonb_build_object('customer_id',c.customer_id,'department_id',c.department_id) order by c.customer_id) from public.supplier_return_customers c where c.document_id=d.id),'[]'),
 'lines',coalesce((select jsonb_agg((to_jsonb(l)-'unit_price')||case when prices then jsonb_build_object('unit_price',l.unit_price) else '{}'::jsonb end order by l.line_no) from public.supplier_return_lines l where l.document_id=d.id),'[]'))
 ||case when prices then jsonb_build_object('financials',public.receipt_money_totals_v2((select jsonb_agg(jsonb_build_object('quantity',l.quantity,'unit_price',l.unit_price)) from public.supplier_return_lines l where l.document_id=d.id),d.tax_mode,d.tax_rate_basis_points,d.discount_amount)) else '{}'::jsonb end
 order by d.return_date desc,d.created_at desc),'[]') into result
 from public.supplier_return_documents d join public.stock_transaction_documents r on r.kind=d.kind and r.id=d.id
 where d.deleted_at is null and public.supplier_return_visible_v1(p_actor_user_id,d.id);
 return jsonb_build_object('supplier_return_documents',result);
end $$;

create function public.save_supplier_return_v1(p_actor_user_id uuid,p_action text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare did uuid:=(p_payload->>'document_id')::uuid;req uuid:=(p_payload->>'request_id')::uuid;
 old_doc public.supplier_return_documents;doc public.supplier_return_documents;reg public.stock_transaction_documents;old_req public.supplier_return_requests;
 old_customers jsonb;rows jsonb:=p_payload->'rows';meta jsonb:=coalesce(p_payload->'receipt_metadata','{}');old_lines jsonb;customers jsonb:=p_payload->'customer_departments';
 customer_ids uuid[];old_ids uuid[];submitted_ids uuid[];v_row jsonb;line public.supplier_return_lines;cid uuid;dep uuid;legacy_dep uuid;
 v_supplier uuid;project uuid;day date;mode text;rate integer;discount numeric;price numeric;needed text;num text;actor text;
 item uuid;before_qty numeric;old_qty numeric;new_qty numeric;issued numeric;returned numeric;version integer;v_line_number integer:=0;result jsonb;financials jsonb;
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
  if exists(select 1 from jsonb_array_elements(rows) r where jsonb_typeof(r)<>'object' or nullif(r->>'inventory_item_id','') is null or jsonb_typeof(r->'quantity') is distinct from 'number' or (r->>'quantity')::numeric<=0 or (r->>'quantity')::numeric>=1000000000000 or (r->>'quantity')::numeric<>trunc((r->>'quantity')::numeric) or length(coalesce(r->>'note',''))>500) then raise exception '退貨數量須為正整數，備註最多 500 字。';end if;
  if (select count(*) from jsonb_array_elements(rows))<>(select count(distinct(r->>'inventory_item_id',lower(btrim(coalesce(r->>'note',''))))) from jsonb_array_elements(rows) r) then raise exception '同一張退貨單有重複明細，請合併數量。';end if;
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
   insert into public.supplier_return_lines(id,document_id,line_no,inventory_item_id,quantity,unit_price,note)
   values(coalesce(line.id,gen_random_uuid()),did,v_line_number,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,price,coalesce(v_row->>'note',''))
   on conflict(id) do update set line_no=excluded.line_no,inventory_item_id=excluded.inventory_item_id,quantity=excluded.quantity,unit_price=excluded.unit_price,note=excluded.note;
  end loop;
  delete from public.supplier_return_customers where document_id=did;
  insert into public.supplier_return_customers(document_id,customer_id,department_id) select did,(r->>'customer_id')::uuid,nullif(r->>'department_id','')::uuid from jsonb_array_elements(customers) r;
 end if;
 update public.supplier_return_documents set return_date=day,supplier_id=v_supplier,project_id=project,tax_mode=mode,tax_rate_basis_points=rate,discount_amount=discount,
 row_version=version,deleted_at=case when p_action='delete' then now() end,updated_at=now(),updated_by_user_id=p_actor_user_id where id=did returning * into doc;
 for item in select (r->>'inventory_item_id')::uuid from jsonb_array_elements(old_lines) r union select inventory_item_id from public.supplier_return_lines where document_id=did loop
  select coalesce(sum((r->>'quantity')::numeric),0) into old_qty from jsonb_array_elements(old_lines) r where (r->>'inventory_item_id')::uuid=item;
  select coalesce(sum(quantity),0) into new_qty from public.supplier_return_lines where document_id=did and inventory_item_id=item and p_action<>'delete';
  if p_action<>'delete' then
   select coalesce(sum(quantity),0) into issued from public.stock_receipts where supplier_id=v_supplier and inventory_item_id=item;
   select coalesce(sum(l.quantity),0) into returned from public.supplier_return_lines l join public.supplier_return_documents d on d.id=l.document_id where d.supplier_id=v_supplier and d.deleted_at is null and l.inventory_item_id=item;
   if returned>issued then raise exception '退貨數量超過此供應商的可退進貨量，請核對進貨紀錄及其他退貨單。';end if;
  end if;
  if old_qty<>new_qty then
   before_qty:=public.current_inventory_quantity(item);
   if before_qty+old_qty-new_qty<0 then raise exception '庫存不足，無法退貨；請減少數量或先處理取貨紀錄。';end if;
   insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,supplier_return_document_id,supplier_return_version)
   values(item,before_qty,before_qty+old_qty-new_qty,'供應商退貨 '||reg.document_no,gen_random_uuid(),'supplier_return',actor,did,version);
  end if;
 end loop;
 financials:=public.receipt_money_totals_v2((select jsonb_agg(jsonb_build_object('quantity',quantity,'unit_price',unit_price)) from public.supplier_return_lines where document_id=did),mode,rate,discount);
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('supplier_return_documents',did,case p_action when 'create' then 'insert' else p_action end,case when old_doc.id is not null then to_jsonb(old_doc)||jsonb_build_object('lines',old_lines,'customer_departments',old_customers) end,to_jsonb(doc)||jsonb_build_object('lines',(select jsonb_agg(to_jsonb(l)) from public.supplier_return_lines l where document_id=did),'customer_departments',(select jsonb_agg(to_jsonb(c)) from public.supplier_return_customers c where document_id=did)),'web',actor);
 result:=jsonb_build_object('document_id',did,'document_no',reg.document_no,'row_version',version);
 insert into public.supplier_return_requests(request_id,document_id,actor_user_id,payload,result) values(req,did,p_actor_user_id,jsonb_build_object('action',p_action,'payload',p_payload),result);
 return result;
end $$;

create function public.guard_supplier_return_receipts_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare s uuid;i uuid;received numeric;returned numeric;
begin
 for s,i in select old.supplier_id,old.inventory_item_id union select new.supplier_id,new.inventory_item_id loop
  if s is null or i is null then continue;end if;
  perform 1 from public.inventory_items where id=i for update;
  select coalesce(sum(quantity),0) into received from public.stock_receipts where supplier_id=s and inventory_item_id=i;
  select coalesce(sum(l.quantity),0) into returned from public.supplier_return_lines l join public.supplier_return_documents d on d.id=l.document_id where d.supplier_id=s and d.deleted_at is null and l.inventory_item_id=i;
  if returned>received then raise exception '此供應商已有退貨，請先調整退貨單，不能使進貨量低於已退貨量。';end if;
 end loop;
 return null;
end $$;
create constraint trigger receipt_supplier_return_guard after update or delete on public.stock_receipts deferrable initially deferred for each row execute function public.guard_supplier_return_receipts_v1();
revoke all on function public.supplier_return_visible_v1(uuid,uuid),public.supplier_return_list_v1(uuid),public.save_supplier_return_v1(uuid,text,jsonb),public.guard_supplier_return_receipts_v1() from public,anon,authenticated;
grant execute on function public.supplier_return_visible_v1(uuid,uuid),public.supplier_return_list_v1(uuid),public.save_supplier_return_v1(uuid,text,jsonb),public.guard_supplier_return_receipts_v1() to service_role;
CREATE OR REPLACE FUNCTION public.ensure_stock_document_v1(p_kind text, p_id uuid, p_date date, p_scope uuid, p_request uuid DEFAULT NULL::uuid)
 RETURNS stock_transaction_documents
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_doc public.stock_transaction_documents;v_id uuid:=p_id;v_sequence integer;
begin
  if p_kind not in ('receipt','pickup','site_return','supplier_return') or p_id is null or p_date is null then raise exception '單據識別資料不完整。';end if;
  -- The request lock also protects mixed-project/date batches from older clients.
  perform pg_advisory_xact_lock(hashtextextended('stock-document:'||p_kind||':'||coalesce(p_request,p_id)::text,0));
  if p_request is not null then
    select * into v_doc from public.stock_transaction_documents where kind=p_kind and source_request_id=p_request
      and numbering_scope_id is not distinct from p_scope and numbering_date=p_date;
    if found then return v_doc;end if;
    if exists(select 1 from public.stock_transaction_documents where kind=p_kind and id=v_id) then v_id:=gen_random_uuid();end if;
  else
    select * into v_doc from public.stock_transaction_documents where kind=p_kind and id=v_id;
    if found then return v_doc;end if;
  end if;
  if p_scope is not null then
    -- Allocation is inside the caller's transaction, serialized per ID + actual date.
    -- Registry rows are retained after deletion, so issued numbers are never recycled.
    if p_kind in ('receipt','supplier_return') then perform pg_advisory_xact_lock(hashtextextended(case when p_kind='receipt' then 'receipt-number-scope:' else 'supplier-return-number-scope:' end||p_scope::text,0));end if;
perform pg_advisory_xact_lock(hashtextextended('stock-number:'||p_kind||':'||p_scope::text||':'||p_date::text,0));
    select coalesce(max(sequence_no),0)+1 into v_sequence from public.stock_transaction_documents
      where kind=p_kind and numbering_scope_id=p_scope and numbering_date=p_date;

    if p_kind in ('receipt','supplier_return') then
      while exists(select 1 from public.stock_transaction_documents where kind=p_kind and numbering_scope_id=p_scope
        and lower(document_no)=lower(to_char(p_date,'YYYYMMDD')||case when v_sequence>1 then '-'||v_sequence else '' end)) loop
        v_sequence:=v_sequence+1;
      end loop;
    end if;
  end if;
  insert into public.stock_transaction_documents(kind,id,numbering_scope_id,numbering_date,sequence_no,document_no,source_request_id)
  values(p_kind,v_id,p_scope,p_date,v_sequence,case when v_sequence is not null then case when p_kind='site_return' then 'RET-' else '' end||to_char(p_date,'YYYYMMDD')||case when v_sequence>1 then '-'||v_sequence else '' end end,p_request)
  returning * into v_doc;
  return v_doc;
end $function$
;

-- Extend the existing privacy graph, preserving its established Auth/RBAC rules.
CREATE OR REPLACE FUNCTION public.erp_private_scope_v1(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_config public.erp_private_access; v_direct boolean; v_filters jsonb:='{}'; v_ids jsonb; v_prior jsonb; v_complete boolean:=false;
 v_blocked uuid[]:='{}'; v_document_ids uuid[]:='{}'; v_logs uuid[]:='{}'; v_fk record; v_doc record; v_round integer; v_requests jsonb; v_metadata jsonb; v_mutation_projects uuid[]:='{}';
 v_tables text[]:=array['customers','customer_contacts','customer_departments','customer_contract_services','projects','project_workers',
 'construction_plans','construction_plan_assignees','construction_details','maintenance_details','project_costs','sites','site_floors','site_locations','site_routes','site_route_segments',
 'site_devices','site_work_logs','site_work_log_workers','site_assets','site_notes','phone_systems','phone_extensions','phone_terminal_points',
 'phone_terminal_versions','phone_credential_access_logs','equipment_registry','maintenance_events','maintenance_event_equipment',
 'maintenance_event_workers','repair_items','pickup_records','stock_receipts','stock_receipt_customers','work_assignments',
 'work_log_save_requests','monitoring_device_imports','monitoring_device_import_rows','phone_terminal_import_logs',
 'phone_terminal_version_items','quotations','quotation_versions','quotation_items','quotation_status_history',
 'supplier_return_documents','supplier_return_lines','supplier_return_customers','supplier_return_requests','stock_adjustments',
 'quotation_billing_history','quotation_audit_log','quotation_work_links','quotation_warranty_work','quotation_unquoted_deletions'];
begin
 if not exists(select 1 from public.app_users where id=p_user_id and is_active) then raise exception '沒有資料存取權限。'; end if;
 select * into v_config from public.erp_private_access;
 v_direct:=public.is_erp_private_viewer_v1(p_user_id);
 if v_config.singleton is not null and not v_direct then
  select coalesce(jsonb_agg(id),'[]') into v_ids from public.customers where is_private;
  v_filters:=jsonb_build_object('customers',jsonb_build_object('id',v_ids));
  select coalesce(jsonb_agg(distinct stock_receipt_id order by stock_receipt_id),'[]') into v_ids
  from public.stock_receipt_customers where customer_id in(select value::uuid from jsonb_array_elements_text(v_filters#>'{customers,id}'));
  v_filters:=v_filters||jsonb_build_object('stock_receipts',jsonb_build_object('id',v_ids));
  -- Supplier returns are whole documents; private customer links protect the
  -- header, lines, stock adjustments and audit history through existing FK traversal.
  select coalesce(jsonb_agg(distinct document_id),'[]') into v_ids from public.supplier_return_customers
   where customer_id in(select value::uuid from jsonb_array_elements_text(v_filters#>'{customers,id}'));
  v_filters:=v_filters||jsonb_build_object('supplier_return_documents',jsonb_build_object('id',v_ids));
  -- Legacy creation evidence: first audit before/after reporter ID, then legacy reporter
  -- when no creation evidence survives. Immutable creator is authoritative for new logs.
  select coalesce(array_agg(l.id),'{}') into v_logs from public.site_work_logs l
  where coalesce(l.access_creator_user_id,
   (select (coalesce(a.before_data->>'reporter_user_id',a.after_data->>'reporter_user_id'))::uuid
    from public.audit_logs a where a.entity_id=l.id and a.entity_type='site_work_logs'
    and coalesce(a.before_data->>'reporter_user_id',a.after_data->>'reporter_user_id') ~ '^[0-9a-fA-F-]{36}$'
    order by a.created_at asc,a.id asc limit 1),l.reporter_user_id)=v_config.owner_user_id;
  v_filters:=v_filters||jsonb_build_object('site_work_logs',jsonb_build_object('id',to_jsonb(v_logs)));
  -- Automatically created repair work names mirror log titles. A work containing
  -- only private logs must not reveal that title through projects/search/dashboard.
  -- Mixed work stays visible for its public logs; shared writes are guarded separately.
  select coalesce(jsonb_agg(p.id),'[]') into v_ids from public.projects p
  where exists(select 1 from public.site_work_logs l where l.project_id=p.id and l.id=any(v_logs))
   and not exists(select 1 from public.site_work_logs l where l.project_id=p.id and l.deleted_at is null and not(l.id=any(v_logs)));
  v_filters:=v_filters||jsonb_build_object('projects',jsonb_build_object('id',v_ids));
  for v_round in 1..30 loop
   v_prior:=v_filters;
   -- Polymorphic equipment sources and multi-work quotation links do not have a
   -- simple parent->child UUID FK. Preserve the entire quotation as one boundary.
   select coalesce(jsonb_agg(e.id),'[]') into v_ids from public.equipment_registry e
   where e.source_id in(select value::uuid from jsonb_array_elements_text(coalesce(v_filters#>array[e.source_table,'id'],'[]')))
      or e.id in(select value::uuid from jsonb_array_elements_text(coalesce(v_filters#>'{equipment_registry,id}','[]')));
   v_filters:=v_filters||jsonb_build_object('equipment_registry',jsonb_build_object('id',v_ids));
   if to_regclass('public.quotation_work_links') is not null then
    execute 'select coalesce(jsonb_agg(distinct quotation_id),''[]''::jsonb) from public.quotation_work_links
     where project_id in(select value::uuid from jsonb_array_elements_text($1))
        or quotation_id in(select value::uuid from jsonb_array_elements_text($2))'
     into v_ids using coalesce(v_filters#>'{projects,id}','[]'),coalesce(v_filters#>'{quotations,id}','[]');
    v_filters:=v_filters||jsonb_build_object('quotations',jsonb_build_object('id',v_ids));
   end if;
   -- Historical quote snapshots can retain private customer/work data after an
   -- ERP reassignment. Their existing audit UUIDs remain authoritative evidence.
   if to_regclass('public.quotation_audit_log') is not null then
    select coalesce(array_agg(distinct x.value::uuid),'{}') into v_blocked
     from jsonb_each(v_filters) t cross join lateral jsonb_each(t.value) c cross join lateral jsonb_array_elements_text(c.value) x;
    execute 'select coalesce(jsonb_agg(distinct quotation_id),''[]''::jsonb) from public.quotation_audit_log a
     where quotation_id in(select value::uuid from jsonb_array_elements_text($1))
       or exists(select 1 from regexp_matches(lower(to_jsonb(a)::text),''[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'',''g'') m where m[1]::uuid=any($2::uuid[]))'
     into v_ids using coalesce(v_filters#>'{quotations,id}','[]'),v_blocked;
    v_filters:=v_filters||jsonb_build_object('quotations',jsonb_build_object('id',v_ids));
   end if;
   for v_fk in
    select child.relname child_table,ca.attname child_column,parent.relname parent_table,
     exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=child.oid and a.attname='id' and a.atttypid='uuid'::regtype and not a.attisdropped) has_id
    from pg_catalog.pg_constraint f
    join pg_catalog.pg_class child on child.oid=f.conrelid join pg_catalog.pg_namespace n on n.oid=child.relnamespace
    join pg_catalog.pg_class parent on parent.oid=f.confrelid
    join pg_catalog.pg_attribute ca on ca.attrelid=child.oid and ca.attnum=f.conkey[1]
    join pg_catalog.pg_attribute pa on pa.attrelid=parent.oid and pa.attnum=f.confkey[1]
    where f.contype='f' and cardinality(f.conkey)=1 and cardinality(f.confkey)=1
     and n.nspname='public' and pa.attname='id' and ca.atttypid='uuid'::regtype
     and child.relname=any(v_tables) and jsonb_array_length(coalesce(v_filters#>array[parent.relname,'id'],'[]'))>0
   loop
    if v_fk.has_id then
     execute format('select coalesce(jsonb_agg(distinct id order by id),''[]''::jsonb) from public.%I where %I in (select value::uuid from jsonb_array_elements_text($1)) or id in (select value::uuid from jsonb_array_elements_text($2))',v_fk.child_table,v_fk.child_column)
      into v_ids using v_filters#>array[v_fk.parent_table,'id'],coalesce(v_filters#>array[v_fk.child_table,'id'],'[]');
     v_filters:=v_filters||jsonb_build_object(v_fk.child_table,jsonb_build_object('id',v_ids));
    else
     v_filters:=v_filters||jsonb_build_object(v_fk.child_table,coalesce(v_filters->v_fk.child_table,'{}')||
      jsonb_build_object(v_fk.child_column,v_filters#>array[v_fk.parent_table,'id']));
    end if;
   end loop;
   -- A document is edited atomically. Hide/block the complete document rather than
   -- exposing a partial set of lines whose save could alter a private line.
   for v_doc in select * from (values('stock_receipts','receipt_document_id'),('pickup_records','pickup_document_id')) x(tbl,col) loop
    if exists(select 1 from pg_catalog.pg_attribute where attrelid=to_regclass('public.'||v_doc.tbl) and attname=v_doc.col and not attisdropped) then
     execute format('select coalesce(jsonb_agg(distinct %I),''[]''::jsonb) from public.%I where id in (select value::uuid from jsonb_array_elements_text($1)) and %I is not null',v_doc.col,v_doc.tbl,v_doc.col)
     into v_ids using coalesce(v_filters#>array[v_doc.tbl,'id'],'[]');
     select array_agg(distinct id) into v_document_ids from (select unnest(v_document_ids) id union all select value::uuid from jsonb_array_elements_text(v_ids)) d;
     execute format('select coalesce(jsonb_agg(distinct id order by id),''[]''::jsonb) from public.%I where %I in(select value::uuid from jsonb_array_elements_text($1)) or id in(select value::uuid from jsonb_array_elements_text($2))',v_doc.tbl,v_doc.col)
     into v_ids using v_ids,coalesce(v_filters#>array[v_doc.tbl,'id'],'[]');
     v_filters:=v_filters||jsonb_build_object(v_doc.tbl,jsonb_build_object('id',v_ids));
    end if;
   end loop;
   if v_filters=v_prior then v_complete:=true;exit;end if;
  end loop;
  if not v_complete then raise exception '私人資料關聯檢查未完成，請稍後重試。'; end if;
  select coalesce(array_agg(distinct x.value::uuid),'{}') into v_blocked
  from jsonb_each(v_filters) t cross join lateral jsonb_each(t.value) c cross join lateral jsonb_array_elements_text(c.value) x;
  v_blocked:=v_blocked||coalesce(v_document_ids,'{}');
  -- Audit JSON contains historical copies. Filter matching entries before pagination,
  -- without hiding unrelated administrators' audit records.
  if cardinality(v_blocked)>0 then
   for v_doc in select unnest(array['audit_logs','data_conflicts']) tbl loop
    if to_regclass('public.'||v_doc.tbl) is not null then
     execute format('select coalesce(jsonb_agg(id),''[]''::jsonb) from public.%I a where exists(select 1 from regexp_matches(lower(to_jsonb(a)::text),''[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'',''g'') m where m[1]::uuid=any($1::uuid[]))',v_doc.tbl)
      into v_ids using v_blocked;
     v_filters:=v_filters||jsonb_build_object(v_doc.tbl,jsonb_build_object('id',v_ids));
    end if;
   end loop;
  end if;
  select coalesce(array_agg(distinct project_id) filter(where project_id is not null),'{}') into v_mutation_projects
  from public.site_work_logs where id in(select value::uuid from jsonb_array_elements_text(coalesce(v_filters#>'{site_work_logs,id}','[]')));
 end if;
 if public.has_app_permission_v1(p_user_id,'worklogs','VIEW') then
  select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'status',r.status,'request_id',r.id)),'[]') into v_metadata
  from public.site_work_logs l left join public.work_log_access_requests r on r.work_log_id=l.id and r.applicant_user_id=p_user_id
  where l.id=any(v_logs) and l.deleted_at is null and public.has_project_permission_v1(p_user_id,l.project_id,'VIEW');
 end if;
 select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('applicant',u.display_name)||
  case when v_direct then jsonb_build_object('log_title',l.title,'log_date',l.log_date) else '{}'::jsonb end order by r.requested_at,r.id),'[]') into v_requests
 from public.work_log_access_requests r join public.app_users u on u.id=r.applicant_user_id
 join public.site_work_logs l on l.id=r.work_log_id and l.deleted_at is null
 where (v_direct and r.status='pending' and public.has_app_permission_v1(p_user_id,'worklogs','VIEW') and public.has_project_permission_v1(p_user_id,l.project_id,'VIEW'))
 or (r.applicant_user_id=p_user_id and r.status<>'pending' and r.acknowledged_at is null);
 return jsonb_build_object('configured',v_config.singleton is not null,'visibility_version',v_config.row_version,'direct',v_direct,'filters',v_filters,'blocked_ids',v_blocked,
 'protected_user_ids',array_remove(array_prepend(v_config.owner_user_id,coalesce(v_config.viewer_user_ids,'{}')),null),'mutation_project_ids',v_mutation_projects,
 'restricted_logs',coalesce(v_metadata,'[]'),'requests',v_requests,
 'configuration',case when v_config.owner_user_id=p_user_id or exists(select 1 from public.app_users where id=p_user_id and role='admin') then to_jsonb(v_config) else null end,
 'configuration_users',case when v_config.owner_user_id=p_user_id or (v_config.singleton is null and exists(select 1 from public.app_users where id=p_user_id and role='admin'))
  then (select coalesce(jsonb_agg(jsonb_build_object('id',id,'username',username,'display_name',display_name) order by username),'[]') from public.app_users where is_active) else '[]'::jsonb end,
 'can_configure',case when v_config.singleton is null then exists(select 1 from public.app_users where id=p_user_id and role='admin') else v_config.owner_user_id=p_user_id end);
end $function$;
