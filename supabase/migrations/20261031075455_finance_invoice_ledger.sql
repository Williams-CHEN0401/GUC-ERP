begin;
set local lock_timeout='5s';

-- Extend the immutable existing invoice, rather than infer tax from a quotation.
alter table public.quotation_invoices
 add column tax_basis text not null default 'unconfirmed' check(tax_basis in ('unconfirmed','inclusive','exclusive')),
 add column net_amount numeric(20,2), add column vat_amount numeric(20,2),
 add column tax_evidence text, add column tax_confirmed_at timestamptz,
 add column tax_confirmed_by uuid references public.app_users(id),
 add column finance_row_version integer not null default 1,
 add column canonical_invoice_id uuid references public.quotation_invoices(id),
 add constraint invoice_confirmed_amounts_check check(
  (tax_basis='unconfirmed' and net_amount is null and vat_amount is null) or
  (tax_basis<>'unconfirmed' and net_amount>=0 and vat_amount>=0 and tax_evidence is not null and tax_confirmed_by is not null
   and case when tax_basis='inclusive' then net_amount+vat_amount=amount_twd else net_amount=amount_twd end)),
 add constraint invoice_not_self_duplicate check(canonical_invoice_id is null or canonical_invoice_id<>id);
create index quotation_invoices_canonical_idx on public.quotation_invoices(canonical_invoice_id);

-- Every row is a source voucher linked to existing master/transaction identities.
create table public.quotation_financial_events (
 id uuid primary key default gen_random_uuid(), quotation_id uuid not null references public.quotations(id),
 invoice_id uuid references public.quotation_invoices(id), project_id uuid references public.projects(id),
 kind text not null check(kind in ('allowance','receipt','recognition','billing')),
 event_date date not null, net_amount numeric(20,2), vat_amount numeric(20,2), amount numeric(20,2) not null check(amount>0),
 reference text not null check(length(btrim(reference)) between 2 and 1000),
 method text, policy text, created_by uuid not null references public.app_users(id), created_at timestamptz not null default now(),
 voided_at timestamptz, voided_by uuid references public.app_users(id), void_reason text,
 check(kind<>'allowance' or (invoice_id is not null and net_amount>=0 and vat_amount>=0 and amount=net_amount+vat_amount)),
 check(kind<>'receipt' or (invoice_id is not null and length(btrim(method)) between 1 and 100)),
 check(kind<>'recognition' or (project_id is not null and length(btrim(policy)) between 2 and 2000)),
 check((voided_at is null and voided_by is null and void_reason is null) or (voided_at is not null and voided_by is not null and length(btrim(void_reason)) between 2 and 1000))
);
create unique index quotation_finance_voucher_uidx on public.quotation_financial_events(kind,lower(btrim(reference))) where voided_at is null;
create index quotation_finance_invoice_idx on public.quotation_financial_events(invoice_id,event_date) where voided_at is null;
create index quotation_finance_project_idx on public.quotation_financial_events(project_id,event_date) where voided_at is null;
create index quotation_finance_date_idx on public.quotation_financial_events(event_date,kind) where voided_at is null;

create table public.supplier_invoice_facts (
 document_kind text not null default 'receipt' check(document_kind='receipt'), document_id uuid primary key,
 supplier_id uuid not null references public.suppliers(id), invoice_number text not null, invoice_date date not null,
 net_amount numeric(20,2) not null check(net_amount>=0), vat_amount numeric(20,2) not null check(vat_amount>=0),
 deduction_status text not null check(deduction_status in ('pending','deductible','nondeductible')),
 source_fingerprint text,
 evidence text not null check(length(btrim(evidence)) between 2 and 1000),
 row_version integer not null default 1, updated_by uuid not null references public.app_users(id), updated_at timestamptz not null default now(),
 foreign key(document_kind,document_id) references public.stock_transaction_documents(kind,id)
);
create unique index supplier_invoice_fact_number_idx on public.supplier_invoice_facts(supplier_id,extract(year from invoice_date),upper(regexp_replace(btrim(invoice_number),'[[:space:]-]','','g')));
create table public.supplier_payment_records (
 id uuid primary key default gen_random_uuid(), document_id uuid not null references public.supplier_invoice_facts(document_id),
 payment_date date not null, amount numeric(20,2) not null check(amount>0), method text not null check(length(btrim(method)) between 1 and 100),
 reference text not null check(length(btrim(reference)) between 2 and 1000),
 created_by uuid not null references public.app_users(id), created_at timestamptz not null default now(),
 voided_at timestamptz, voided_by uuid references public.app_users(id), void_reason text,
 check((voided_at is null and voided_by is null and void_reason is null) or (voided_at is not null and voided_by is not null and length(btrim(void_reason)) between 2 and 1000))
);
create unique index supplier_payment_reference_idx on public.supplier_payment_records(lower(btrim(reference))) where voided_at is null;
create index supplier_payment_date_idx on public.supplier_payment_records(payment_date) where voided_at is null;

do $$ declare t text; begin
 foreach t in array array['quotation_financial_events','supplier_invoice_facts','supplier_payment_records'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('alter table public.%I force row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select,insert,update on public.%I to service_role',t);
 end loop;
end $$;
-- Financial source snapshot invalidates a verification when the existing receipt is corrected.
create function public.accounting_supplier_receipt_fingerprint_v1(p_document uuid) returns text
language sql stable security definer set search_path='' as $$
 select md5(jsonb_build_array(d.receipt_tax_mode,d.receipt_tax_rate_basis_points,d.receipt_discount_amount,
 jsonb_agg(jsonb_build_array(r.id,r.inventory_item_id,r.supplier_id,r.receipt_date,r.quantity,r.unit_price) order by r.id))::text)
 from public.stock_transaction_documents d join public.stock_receipts r on r.receipt_document_id=d.id
 where d.kind='receipt' and d.id=p_document group by d.receipt_tax_mode,d.receipt_tax_rate_basis_points,d.receipt_discount_amount;
$$;
create function public.accounting_supplier_invoice_current_v1(p_document uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce((select f.source_fingerprint is not null and f.source_fingerprint=public.accounting_supplier_receipt_fingerprint_v1(f.document_id)
 from public.supplier_invoice_facts f where f.document_id=p_document),false);
$$;
revoke all on function public.accounting_supplier_receipt_fingerprint_v1(uuid),public.accounting_supplier_invoice_current_v1(uuid) from public,anon,authenticated;
grant execute on function public.accounting_supplier_receipt_fingerprint_v1(uuid),public.accounting_supplier_invoice_current_v1(uuid) to service_role;

-- Existing invoices are deliberately not directly readable by service_role.
-- This definer helper is invoked only by authenticated gateways, with actor RBAC and privacy checks.
create function public.accounting_ledger_assert_v1(p_actor uuid,p_scope text,p_action text default 'VIEW') returns void
language plpgsql security definer set search_path='' as $$
declare m text; begin
 m:=case p_scope when 'sales' then 'quotation_invoices' when 'purchases' then 'accounting_payables' else null end;
 if m is null or public.has_app_permission_v1(p_actor,m,'VIEW') is not true or public.has_app_permission_v1(p_actor,m,p_action) is not true
 or public.has_app_permission_v1(p_actor,'accounting_prices','VIEW') is not true then raise exception using errcode='42501',message='沒有此財務資料操作權限。';end if;
 if p_scope='sales' then perform public.quotation_require_access_v1(p_actor);end if;
 perform public.erp_private_prepare_v1(p_actor);
end $$;

create function public.accounting_invoice_identity_v1(p_number text,p_date date) returns text
language sql immutable security invoker set search_path='' as $$
 select upper(regexp_replace(btrim(p_number),'[[:space:]-]','','g'))||':'||coalesce(extract(year from p_date)::text,'unknown')
$$;

create function public.accounting_ledger_command_v1(p_actor uuid,p_operation text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare scope text; action text; req uuid; fingerprint text; prior public.accounting_finance_requests; result jsonb; before_data jsonb;
 i public.quotation_invoices; target public.quotation_invoices; q public.quotations; e public.quotation_financial_events;
 f public.supplier_invoice_facts; pay public.supplier_payment_records; amount numeric; net numeric; vat numeric; total numeric; used numeric;
 entity uuid; reference text; kind text; dt date; document uuid; supplier uuid; fin jsonb; rowjson jsonb;
begin
 if p_operation not in ('invoice_confirm','invoice_duplicate','allowance_create','allowance_void','receipt_create','receipt_void','recognition_create','recognition_void','billing_create','billing_void','supplier_invoice_save','supplier_payment_create','supplier_payment_void') then raise exception '不支援的財務操作。';end if;
 scope:=case when p_operation like 'supplier_%' then 'purchases' else 'sales' end;
 action:=case when p_operation like '%_void' then 'DELETE' when p_operation in ('invoice_confirm','invoice_duplicate','supplier_invoice_save') then 'UPDATE' else 'CREATE' end;
 perform public.accounting_ledger_assert_v1(p_actor,scope,action);
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception '財務資料格式不正確。';end if;
 req:=(p_payload->>'request_id')::uuid;if req is null then raise exception '缺少請求識別。';end if;
 fingerprint:=md5(p_operation||p_payload::text);
 perform pg_advisory_xact_lock(hashtextextended('finance-request:'||p_actor::text||':'||req::text,0));
 select * into prior from public.accounting_finance_requests where actor_id=p_actor and request_id=req;
 if found then if prior.fingerprint<>fingerprint then raise exception '相同請求識別不可用於不同內容。';end if;return public.accounting_ledger_money_json_v1(prior.result);end if;
 reference:=btrim(coalesce(p_payload->>'reference',p_payload->>'evidence',p_payload->>'reason',''));
 if length(reference) not between 2 and 1000 then raise exception '請填寫 2 至 1000 字的原始憑證／調整原因。';end if;
 if p_operation not like '%_void' and p_operation not in ('invoice_confirm','invoice_duplicate','supplier_invoice_save') then
  dt:=(p_payload->>'date')::date;amount:=(p_payload->>'amount')::numeric;
  if dt is null or extract(year from dt) not between 2000 and 2100 or amount is null or amount<=0 or amount>9000000000000000 or amount<>round(amount,2) then raise exception '請填寫有效日期與正數金額（最多小數二位）。';end if;
 end if;
 if scope='sales' then
  if p_operation like '%_void' then
   select * into e from public.quotation_financial_events where id=(p_payload->>'id')::uuid for update;
   if not found or e.voided_at is not null or p_operation<>e.kind||'_void' then raise exception '找不到有效財務紀錄。';end if;
   select * into q from public.quotations where id=e.quotation_id for update;
  else
   if p_operation in ('invoice_confirm','invoice_duplicate','allowance_create','receipt_create') then
    select * into i from public.quotation_invoices where id=(p_payload->>'invoice_id')::uuid for update;
    if not found or i.status<>'active' then raise exception '請選擇有效發票。';end if;
    select * into q from public.quotations where id=i.quotation_id for update;
   else select * into q from public.quotations where id=(p_payload->>'quotation_id')::uuid for update;end if;
  end if;
  if q.id is null then raise exception '找不到報價資料。';end if;
  perform public.erp_private_assert_v1(jsonb_build_array(q.id,q.customer_id));
  if p_operation='invoice_confirm' then
   if i.finance_row_version is distinct from (p_payload->>'row_version')::integer then raise exception '發票財務資料已變更，請重新讀取。';end if;
   if i.canonical_invoice_id is not null then raise exception '重複關聯請至原始發票確認金額。';end if;
   perform pg_advisory_xact_lock(hashtextextended('invoice-identity:'||public.accounting_invoice_identity_v1(i.invoice_number,i.invoice_date),0));
   if exists(select 1 from public.quotation_invoices x where x.id<>i.id and x.status='active' and x.canonical_invoice_id is null and public.accounting_invoice_identity_v1(x.invoice_number,x.invoice_date)=public.accounting_invoice_identity_v1(i.invoice_number,i.invoice_date)) then raise exception '相同發票出現在多張報價，請先核對並標記重複關聯。';end if;
   net:=(p_payload->>'net_amount')::numeric;vat:=(p_payload->>'vat_amount')::numeric;
   if net is null or vat is null or net<0 or vat<0 or net<>round(net,2) or vat<>round(vat,2) or p_payload->>'tax_basis' not in ('inclusive','exclusive') then raise exception '請依原始發票填寫金額與含稅／未稅身分。';end if;
   if (case when p_payload->>'tax_basis'='inclusive' then net+vat else net end)<>i.amount_twd then raise exception '原始快照金額與含稅／未稅金額不一致；請核對原始發票。';end if;
   select coalesce(sum(amount),0) into used from public.quotation_financial_events where invoice_id=i.id and kind='receipt' and voided_at is null;
   if used>net+vat then raise exception '確認金額不可低於已登錄收款。';end if;
   if exists(select 1 from public.quotation_financial_events where invoice_id=i.id and kind='allowance' and voided_at is null) and (i.net_amount is distinct from net or i.vat_amount is distinct from vat) then raise exception '已有折讓，請先作廢折讓再更正發票財務資料。';end if;
   before_data:=to_jsonb(i);
   update public.quotation_invoices set tax_basis=p_payload->>'tax_basis',net_amount=net,vat_amount=vat,tax_evidence=reference,tax_confirmed_by=p_actor,tax_confirmed_at=now(),finance_row_version=finance_row_version+1 where id=i.id returning to_jsonb(quotation_invoices.*) into rowjson;
   entity:=i.id;
  elsif p_operation='invoice_duplicate' then
   if i.finance_row_version is distinct from (p_payload->>'row_version')::integer then raise exception '發票財務資料已變更，請重新讀取。';end if;
   select * into target from public.quotation_invoices where id=(p_payload->>'canonical_invoice_id')::uuid for update;
   if target.id is null or target.id=i.id or target.status<>'active' or target.canonical_invoice_id is not null or target.customer_id<>i.customer_id
    or public.accounting_invoice_identity_v1(target.invoice_number,target.invoice_date)<>public.accounting_invoice_identity_v1(i.invoice_number,i.invoice_date)
    or target.amount_twd<>i.amount_twd then raise exception '只能將同客戶、同年度號碼與同金額的重複發票關聯至原發票。';end if;
   perform public.erp_private_assert_v1(jsonb_build_array(target.quotation_id));
   if exists(select 1 from public.quotation_financial_events where invoice_id=i.id and voided_at is null) or exists(select 1 from public.quotation_invoices where canonical_invoice_id=i.id) then raise exception '此發票已有財務紀錄或被引用，請先核對相關紀錄。';end if;
   before_data:=to_jsonb(i);
   update public.quotation_invoices set canonical_invoice_id=target.id,finance_row_version=finance_row_version+1 where id=i.id returning to_jsonb(quotation_invoices.*) into rowjson;entity:=i.id;
  elsif p_operation like '%_void' then
   before_data:=to_jsonb(e);entity:=e.id;
   if e.kind='allowance' then perform 1 from public.quotation_invoices where id=e.invoice_id for update;end if;
   update public.quotation_financial_events set voided_at=now(),voided_by=p_actor,void_reason=reference where id=e.id returning to_jsonb(quotation_financial_events.*) into rowjson;
  else
   kind:=split_part(p_operation,'_',1);
   if kind in ('allowance','receipt') then
    if i.tax_basis='unconfirmed' or i.canonical_invoice_id is not null then raise exception '請先確認原始發票稅額，重複關聯不能重複登帳。';end if;
    if dt<i.invoice_date then raise exception '收款／折讓日期不可早於發票；預收款須另外核對，不可假裝發票收款。';end if;
    if kind='allowance' then
     net:=(p_payload->>'net_amount')::numeric;vat:=(p_payload->>'vat_amount')::numeric;
     if net is null or vat is null or net<0 or vat<0 or net<>round(net,2) or vat<>round(vat,2) or net+vat<>amount then raise exception '折讓未稅及稅額合計須等於折讓金額。';end if;
     if net+coalesce((select sum(net_amount) from public.quotation_financial_events where invoice_id=i.id and kind='allowance' and voided_at is null),0)>i.net_amount
       or vat+coalesce((select sum(vat_amount) from public.quotation_financial_events where invoice_id=i.id and kind='allowance' and voided_at is null),0)>i.vat_amount then raise exception '折讓不可超過原發票未稅／稅額。';end if;
     select coalesce(sum(amount),0) into used from public.quotation_financial_events where invoice_id=i.id and kind in ('allowance','receipt') and voided_at is null;
     if used+amount>i.net_amount+i.vat_amount then raise exception '折讓後金額低於已收款，請先依實際退款更正收款紀錄。';end if;
    else
     select coalesce(sum(amount),0) into used from public.quotation_financial_events where invoice_id=i.id and kind in ('allowance','receipt') and voided_at is null;
     if used+amount>i.net_amount+i.vat_amount then raise exception '收款超過發票扣除折讓後的未收金額。';end if;
     if length(btrim(coalesce(p_payload->>'method',''))) not between 1 and 100 then raise exception '請填寫收款方式。';end if;
    end if;
   elsif kind='recognition' then
    if not exists(select 1 from public.quotation_work_links where quotation_id=q.id and project_id=(p_payload->>'project_id')::uuid) then raise exception '認列工作內容須為此報價已關聯的工作。';end if;
    perform public.erp_private_assert_v1(jsonb_build_array((p_payload->>'project_id')::uuid));
    if length(btrim(coalesce(p_payload->>'policy',''))) not between 2 and 2000 then raise exception '請填寫適用會計政策及履約認列依據。';end if;
   end if;
   insert into public.quotation_financial_events(quotation_id,invoice_id,project_id,kind,event_date,net_amount,vat_amount,amount,reference,method,policy,created_by)
    values(q.id,case when kind in ('allowance','receipt') then i.id else null end,case when kind='recognition' then (p_payload->>'project_id')::uuid else null end,kind,dt,net,vat,amount,reference,p_payload->>'method',p_payload->>'policy',p_actor)
    returning id,to_jsonb(quotation_financial_events.*) into entity,rowjson;
  end if;
 else
  if p_operation='supplier_payment_void' then
   select * into pay from public.supplier_payment_records where id=(p_payload->>'id')::uuid for update;
   if not found or pay.voided_at is not null then raise exception '找不到有效付款紀錄。';end if;document:=pay.document_id;
  else document:=(p_payload->>'document_id')::uuid;end if;
  perform pg_advisory_xact_lock(hashtextextended('supplier-invoice:'||document::text,0));
  select min(supplier_id::text)::uuid,public.receipt_money_totals_v2(jsonb_agg(jsonb_build_object('quantity',r.quantity,'unit_price',r.unit_price)),d.receipt_tax_mode,d.receipt_tax_rate_basis_points,coalesce(d.receipt_discount_amount,0))
   into supplier,fin from public.stock_receipts r join public.stock_transaction_documents d on d.kind='receipt' and d.id=r.receipt_document_id
   where r.receipt_document_id=document and r.quantity>0 and public.erp_private_json_visible_v1(to_jsonb(r)) and public.erp_private_json_visible_v1(to_jsonb(d))
   group by d.receipt_tax_mode,d.receipt_tax_rate_basis_points,d.receipt_discount_amount;
  if supplier is null then raise exception '找不到有權限的進貨單。';end if;
  select * into f from public.supplier_invoice_facts where document_id=document for update;
  if p_operation='supplier_invoice_save' then
   if f.document_id is not null and f.row_version is distinct from (p_payload->>'row_version')::integer then raise exception '供應商發票已變更，請重新讀取。';end if;
   net:=(p_payload->>'net_amount')::numeric;vat:=(p_payload->>'vat_amount')::numeric;dt:=(p_payload->>'date')::date;
   if net is null or vat is null or net<0 or vat<0 or net<>round(net,2) or vat<>round(vat,2) or dt is null or length(btrim(coalesce(p_payload->>'invoice_number',''))) not between 2 and 64 or p_payload->>'deduction_status' not in ('pending','deductible','nondeductible') then raise exception '請填寫完整的進項發票與扣抵狀態。';end if;
   if fin->>'total_amount' is null or net+vat<>(fin->>'total_amount')::numeric then raise exception '發票總額須與原進貨單含稅應付金額一致；請先核對進貨單。';end if;
   before_data:=to_jsonb(f);entity:=document;
   insert into public.supplier_invoice_facts(document_id,supplier_id,invoice_number,invoice_date,net_amount,vat_amount,deduction_status,evidence,updated_by,source_fingerprint)
   values(document,supplier,p_payload->>'invoice_number',dt,net,vat,p_payload->>'deduction_status',reference,p_actor,public.accounting_supplier_receipt_fingerprint_v1(document))
   on conflict(document_id) do update set supplier_id=excluded.supplier_id,source_fingerprint=excluded.source_fingerprint,invoice_number=excluded.invoice_number,invoice_date=excluded.invoice_date,net_amount=excluded.net_amount,vat_amount=excluded.vat_amount,deduction_status=excluded.deduction_status,evidence=excluded.evidence,updated_by=p_actor,updated_at=now(),row_version=supplier_invoice_facts.row_version+1 returning to_jsonb(supplier_invoice_facts.*) into rowjson;
  elsif p_operation='supplier_payment_create' then
   if f.document_id is null then raise exception '請先核對供應商發票資料。';end if;
   select coalesce(sum(amount),0) into used from public.supplier_payment_records where document_id=document and voided_at is null;
   if used+amount>f.net_amount+f.vat_amount then raise exception '付款金額超過此張發票未付餘額。';end if;
   if length(btrim(coalesce(p_payload->>'method',''))) not between 1 and 100 then raise exception '請填寫付款方式。';end if;
   insert into public.supplier_payment_records(document_id,payment_date,amount,method,reference,created_by) values(document,dt,amount,p_payload->>'method',reference,p_actor)
   returning id,to_jsonb(supplier_payment_records.*) into entity,rowjson;
  else
   before_data:=to_jsonb(pay);entity:=pay.id;
   update public.supplier_payment_records set voided_at=now(),voided_by=p_actor,void_reason=reference where id=pay.id returning to_jsonb(supplier_payment_records.*) into rowjson;
  end if;
 end if;
 result:=jsonb_build_object('record',rowjson);
 insert into public.accounting_finance_history(module,entity_id,action,before_data,after_data,actor_id) values('ledger_'||scope,entity,p_operation,before_data,rowjson,p_actor);
 insert into public.accounting_finance_requests(actor_id,request_id,operation,fingerprint,result) values(p_actor,req,'ledger.'||p_operation,fingerprint,result);
 return public.accounting_ledger_money_json_v1(result);
end $$;

-- A paid/allowanced original cannot silently be voided while leaving active children.
create function public.quotation_invoice_finance_guard_v1() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if old.status='active' and new.status='voided' and (exists(select 1 from public.quotation_financial_events where invoice_id=old.id and voided_at is null)
 or exists(select 1 from public.quotation_invoices where canonical_invoice_id=old.id and status='active')) then raise exception '發票仍有收款／折讓／重複關聯，請先核對並作廢相關紀錄。';end if;
 return new;end $$;
create trigger quotation_invoice_finance_guard before update of status on public.quotation_invoices for each row execute function public.quotation_invoice_finance_guard_v1();

create function public.accounting_ledger_read_v1(p_actor uuid,p_filters jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare scope text:=coalesce(p_filters->>'scope','sales'); yr integer:=(p_filters->>'year')::integer; data jsonb;begin
 perform public.accounting_ledger_assert_v1(p_actor,scope);
 if yr is null or yr not between 2000 and 2100 then raise exception '請選擇有效年度。';end if;
 if scope='sales' then
  with quotes as materialized (
   select q.*,c.name customer_name from public.quotations q join public.customers c on c.id=q.customer_id
   where public.erp_private_json_visible_v1(to_jsonb(q)) and public.erp_private_json_visible_v1(to_jsonb(c))
   and (nullif(p_filters->>'quotation_id','') is null or q.id=(p_filters->>'quotation_id')::uuid)
  ), invoices as materialized (
   select i.*,q.quotation_number,q.customer_name,public.quotation_linked_work_v1(q.id) projects,
    (select count(*) from public.quotation_invoices x where x.status='active' and x.canonical_invoice_id is null and public.accounting_invoice_identity_v1(x.invoice_number,x.invoice_date)=public.accounting_invoice_identity_v1(i.invoice_number,i.invoice_date)) identity_count,
    coalesce((select sum(amount) from public.quotation_financial_events where invoice_id=i.id and kind='allowance' and voided_at is null),0) allowance_amount,
    coalesce((select sum(amount) from public.quotation_financial_events where invoice_id=i.id and kind='receipt' and voided_at is null),0) received_amount
   from public.quotation_invoices i join quotes q on q.id=i.quotation_id where extract(year from i.invoice_date)=yr or i.invoice_date is null
  ), events as materialized (
   select e.*,q.quotation_number,q.customer_name from public.quotation_financial_events e join quotes q on q.id=e.quotation_id where extract(year from e.event_date)=yr
  ) select jsonb_build_object('scope',scope,'year',yr,
   'quotations',coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'quotation_number',q.quotation_number,'customer_name',q.customer_name,'billing_status',q.billing_status,'projects',public.quotation_linked_work_v1(q.id)) order by q.quotation_number) from quotes q where q.archived_at is null and q.quote_status<>'voided'),'[]'),
   'invoices',coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object('confirmed_gross',case when i.tax_basis<>'unconfirmed' then (i.net_amount+i.vat_amount)::text end,'unpaid_amount',case when i.tax_basis<>'unconfirmed' then (i.net_amount+i.vat_amount-i.allowance_amount-i.received_amount)::text end) order by invoice_date desc nulls first,id) from invoices i),'[]'),
   'events',coalesce((select jsonb_agg(to_jsonb(e) order by event_date desc,id) from events e),'[]')) into data;
 else
  with docs as materialized (
   select d.id,d.document_no,min(r.receipt_date) receipt_date,r.supplier_id,s.name supplier_name,
    public.receipt_money_totals_v2(jsonb_agg(jsonb_build_object('quantity',r.quantity,'unit_price',r.unit_price)),d.receipt_tax_mode,d.receipt_tax_rate_basis_points,coalesce(d.receipt_discount_amount,0)) financials
   from public.stock_transaction_documents d join public.stock_receipts r on r.receipt_document_id=d.id join public.suppliers s on s.id=r.supplier_id
   where d.kind='receipt' and r.quantity>0 and extract(year from r.receipt_date)=yr
   and (nullif(p_filters->>'supplier_id','') is null or r.supplier_id=(p_filters->>'supplier_id')::uuid)
   and public.erp_private_json_visible_v1(to_jsonb(d)) and public.erp_private_json_visible_v1(to_jsonb(r))
   group by d.id,d.document_no,r.supplier_id,s.name,d.receipt_tax_mode,d.receipt_tax_rate_basis_points,d.receipt_discount_amount
  ) select jsonb_build_object('scope',scope,'year',yr,'supplier_documents',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object('invoice',to_jsonb(f),'paid_amount',coalesce(pay.paid,0)::text,'unpaid_amount',case when f.document_id is not null then (f.net_amount+f.vat_amount-coalesce(pay.paid,0))::text end,'payments',coalesce(pay.records,'[]')) order by d.receipt_date desc,d.id) from docs d left join public.supplier_invoice_facts f on f.document_id=d.id left join lateral (select sum(amount) filter(where voided_at is null) paid,jsonb_agg(to_jsonb(p) order by payment_date desc,id) records from public.supplier_payment_records p where p.document_id=d.id) pay on true),'[]')) into data;
 end if;
 return data;
end $$;

-- Explicit invoice allocation: multi-work invoices remain unallocated until verified.
create function public.accounting_project_income_v1(p_actor uuid,p_project uuid) returns jsonb
language plpgsql security definer set search_path='' as $$ declare data jsonb;begin
 perform public.accounting_ledger_assert_v1(p_actor,'sales');perform public.erp_private_assert_v1(jsonb_build_array(p_project));
 with invoices as materialized (
 select distinct i.*,(select count(*) from public.quotation_work_links where quotation_id=i.quotation_id) work_count,
 (select count(*) from public.quotation_invoices x where x.status='active' and x.canonical_invoice_id is null and public.accounting_invoice_identity_v1(x.invoice_number,x.invoice_date)=public.accounting_invoice_identity_v1(i.invoice_number,i.invoice_date)) identity_count
 from public.quotation_invoices i join public.quotations q on q.id=i.quotation_id join public.quotation_work_links l on l.quotation_id=q.id
 where l.project_id=p_project and i.status='active' and i.canonical_invoice_id is null and public.erp_private_json_visible_v1(to_jsonb(q))
 ), amounts as (
 select i.*,coalesce(a.net,0) allowance_net,coalesce(a.vat,0) allowance_vat,coalesce(a.received,0) received
 from invoices i left join lateral (select sum(net_amount) filter(where kind='allowance') net,sum(vat_amount) filter(where kind='allowance') vat,sum(amount) filter(where kind='receipt') received from public.quotation_financial_events where invoice_id=i.id and voided_at is null) a on true
 ), recognition as (
 select e.* from public.quotation_financial_events e join public.quotations q on q.id=e.quotation_id where e.project_id=p_project and e.kind='recognition' and e.voided_at is null and public.erp_private_json_visible_v1(to_jsonb(q))
 ) select jsonb_build_object('project_id',p_project,
 'unconfirmed_invoice_count',(select count(*) from amounts where tax_basis='unconfirmed' or identity_count>1 or work_count<>1),
 'invoice_net',case when exists(select 1 from amounts where tax_basis='unconfirmed' or identity_count>1 or work_count<>1) then null else (select sum(net_amount-allowance_net)::text from amounts) end,
 'invoice_vat',case when exists(select 1 from amounts where tax_basis='unconfirmed' or identity_count>1 or work_count<>1) then null else (select sum(vat_amount-allowance_vat)::text from amounts) end,
 'invoice_gross',case when exists(select 1 from amounts where tax_basis='unconfirmed' or identity_count>1 or work_count<>1) then null else (select sum(net_amount+vat_amount-allowance_net-allowance_vat)::text from amounts) end,
 'received_amount',(select sum(received)::text from amounts where work_count=1 and identity_count=1),
 'billed_amount',(select sum(e.amount)::text from public.quotation_financial_events e join public.quotation_work_links l on l.quotation_id=e.quotation_id join public.quotations q on q.id=e.quotation_id where l.project_id=p_project and public.erp_private_json_visible_v1(to_jsonb(q)) and e.kind='billing' and e.voided_at is null and (select count(*) from public.quotation_work_links where quotation_id=e.quotation_id)=1),
 'allowance_amount',(select sum(allowance_net+allowance_vat)::text from amounts where work_count=1 and identity_count=1),
 'outstanding_amount',case when exists(select 1 from amounts where tax_basis='unconfirmed' or identity_count>1 or work_count<>1) then null else (select sum(net_amount+vat_amount-allowance_net-allowance_vat-received)::text from amounts) end,
 'recognized_net',(select sum(amount)::text from recognition),'recognition_count',(select count(*) from recognition),
 'invoices',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('confirmed_gross',case when a.tax_basis<>'unconfirmed' and a.identity_count=1 then (a.net_amount+a.vat_amount)::text end)) from amounts a),'[]'),'recognitions',coalesce((select jsonb_agg(to_jsonb(r)) from recognition r),'[]'),
 'missing',case when not exists(select 1 from recognition) then jsonb_build_array('尚未確認適用會計政策與履約收入認列') else '[]'::jsonb end) into data;
 return data;end $$;

do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in ('accounting_ledger_assert_v1','accounting_invoice_identity_v1','accounting_ledger_command_v1','accounting_ledger_read_v1','accounting_project_income_v1','quotation_invoice_finance_guard_v1') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);end loop;
end $$;
-- Invoice-date reporting remains compatible with existing routes/exports while
-- separating recognized revenue, actual receipts and unknown historical tax basis.
create or replace function public.quotation_revenue_report_v1(p_actor_user_id uuid,p_year integer,p_granularity text default 'month',p_customer_id uuid default null,p_period integer default null,p_page integer default 1,p_page_size integer default 50)
returns jsonb language plpgsql security definer set search_path='' as $$
declare slots integer;step_months integer;result jsonb;begin
 perform public.accounting_ledger_assert_v1(p_actor_user_id,'sales');
 if p_year is null or p_year not between 2000 and 2100 or p_granularity not in ('month','quarter') then raise exception '請選擇有效年度及報表類型。';end if;
 slots:=case p_granularity when 'month' then 12 else 4 end;step_months:=12/slots;
 if (p_period is not null and p_period not between 1 and slots) or p_page is null or p_page not between 1 and 100000 or p_page_size is null or p_page_size not between 1 and 200 then raise exception '報表期間或頁碼不正確。';end if;
 with quotes as materialized (
 select q.*,c.name customer_name from public.quotations q join public.customers c on c.id=q.customer_id
 where public.erp_private_json_visible_v1(to_jsonb(q)) and public.erp_private_json_visible_v1(to_jsonb(c))
 and (p_customer_id is null or q.customer_id=p_customer_id)
 ), visible as materialized (
 select i.*,q.quotation_number,q.archived_at is not null quotation_archived,q.customer_name,
 (select count(*) from public.quotation_invoices x where x.status='active' and x.canonical_invoice_id is null and public.accounting_invoice_identity_v1(x.invoice_number,x.invoice_date)=public.accounting_invoice_identity_v1(i.invoice_number,i.invoice_date)) identity_count
 from public.quotation_invoices i join quotes q on q.id=i.quotation_id
 ), active as materialized (select * from visible where status='active' and canonical_invoice_id is null),
 annual as materialized (
 select *,((extract(month from invoice_date)::integer-1)/step_months)+1 period,
 tax_basis<>'unconfirmed' and identity_count=1 confirmed
 from active where invoice_date>=make_date(p_year,1,1) and invoice_date<make_date(p_year+1,1,1)
 ), entries as materialized (
 select a.period,a.customer_id,'invoice' kind,a.net_amount net,a.vat_amount vat,a.net_amount+a.vat_amount amount from annual a where a.confirmed
 union all
 select ((extract(month from e.event_date)::integer-1)/step_months)+1,q.customer_id,e.kind,
 case when e.kind='allowance' then -e.net_amount when e.kind='recognition' then e.amount end,
 case when e.kind='allowance' then -e.vat_amount end,
 case when e.kind='allowance' then -e.amount else e.amount end
 from public.quotation_financial_events e join quotes q on q.id=e.quotation_id left join active i on i.id=e.invoice_id
 where e.voided_at is null and extract(year from e.event_date)=p_year
 and (e.kind in ('recognition','billing') or (i.tax_basis<>'unconfirmed' and i.identity_count=1))
 ), periods as (
 select n period,make_date(p_year,(n-1)*step_months+1,1) start_date,
 (make_date(p_year,(n-1)*step_months+1,1)+make_interval(months=>step_months)-interval '1 day')::date end_date,
 coalesce(sum(e.amount) filter(where kind in ('invoice','allowance')),0)::text amount_twd,
 coalesce(sum(e.net) filter(where kind in ('invoice','allowance')),0)::text net_amount,
 coalesce(sum(e.vat) filter(where kind in ('invoice','allowance')),0)::text vat_amount,
 coalesce(-sum(e.amount) filter(where kind='allowance'),0)::text allowance_amount,
 coalesce(sum(e.amount) filter(where kind='receipt'),0)::text received_amount,
 coalesce(sum(e.amount) filter(where kind='recognition'),0)::text recognized_amount,
 coalesce(sum(e.amount) filter(where kind='billing'),0)::text billed_amount,
 (select count(*) from annual where period=n) invoice_count,
 (select count(distinct customer_id) from annual where period=n) customer_count,
 (select count(*) from annual where period=n and not confirmed) unconfirmed_count
 from generate_series(1,slots) n left join entries e on e.period=n group by n
 ), selected as materialized (select * from annual where p_period is null or period=p_period), details as (
 select id,quotation_id,quotation_number,quotation_archived,customer_id,customer_name,invoice_number,invoice_date,
 case when confirmed then (net_amount+vat_amount)::text end amount_twd,
 amount_twd::text original_snapshot_amount,case when confirmed then net_amount::text end net_amount,
 case when confirmed then vat_amount::text end vat_amount,tax_basis,identity_count,confirmed,finance_row_version
 from selected order by invoice_date desc,id desc limit p_page_size offset (p_page-1)*p_page_size
 ) select jsonb_build_object('year',p_year,'granularity',p_granularity,'period',p_period,'page',p_page,'page_size',p_page_size,
 'basis','invoice_date','tax_basis','evidence_confirmed',
 'snapshot',md5(coalesce((select string_agg(to_jsonb(a)::text,',' order by id) from selected a),'')||coalesce((select string_agg(to_jsonb(e)::text,',' order by period,kind,customer_id,amount) from entries e),'')),
 'summary',(select jsonb_build_object('amount_twd',coalesce(sum(amount_twd::numeric),0)::text,'net_amount',coalesce(sum(net_amount::numeric),0)::text,'vat_amount',coalesce(sum(vat_amount::numeric),0)::text,
 'allowance_amount',coalesce(sum(allowance_amount::numeric),0)::text,'received_amount',coalesce(sum(received_amount::numeric),0)::text,'recognized_amount',coalesce(sum(recognized_amount::numeric),0)::text,'billed_amount',coalesce(sum(billed_amount::numeric),0)::text,
 'invoice_count',(select count(*) from selected),'customer_count',(select count(distinct customer_id) from selected),'unconfirmed_count',(select count(*) from selected where not confirmed),
 'voided_count',(select count(*) from visible where status='voided' and extract(year from invoice_date)=p_year),
 'duplicate_link_count',(select count(*) from visible where canonical_invoice_id is not null and extract(year from invoice_date)=p_year)) from periods where p_period is null or period=p_period),
 'periods',(select jsonb_agg(to_jsonb(p) order by period) from periods p),'invoices',coalesce((select jsonb_agg(to_jsonb(d) order by invoice_date desc,id desc) from details d),'[]'),
 'customers',coalesce((select jsonb_agg(to_jsonb(c) order by name,id) from (select distinct customer_id id,customer_name name from quotes) c),'[]'),
 'missing_date_count',(select count(*) from active where invoice_date is null)) into result;
 return public.accounting_ledger_money_json_v1(result);end $$;
revoke all on function public.quotation_revenue_report_v1(uuid,integer,text,uuid,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.quotation_revenue_report_v1(uuid,integer,text,uuid,integer,integer,integer) to service_role;
-- Supplier returns/allowances are credits, never disguised as supplier payments.
create table public.supplier_invoice_credits (
 id uuid primary key default gen_random_uuid(), document_id uuid not null references public.supplier_invoice_facts(document_id),
 source_return_id uuid references public.supplier_return_documents(id), credit_date date not null,
 net_amount numeric(20,2) not null check(net_amount>=0),vat_amount numeric(20,2) not null check(vat_amount>=0),
 reference text not null check(length(btrim(reference)) between 2 and 1000),
 created_by uuid not null references public.app_users(id),created_at timestamptz not null default now(),
 voided_at timestamptz,voided_by uuid references public.app_users(id),void_reason text,
 check(net_amount+vat_amount>0),
 check((voided_at is null and voided_by is null and void_reason is null) or (voided_at is not null and voided_by is not null and length(btrim(void_reason)) between 2 and 1000))
);
create unique index supplier_credit_return_idx on public.supplier_invoice_credits(source_return_id) where voided_at is null;
create unique index supplier_credit_reference_idx on public.supplier_invoice_credits(document_id,lower(btrim(reference))) where voided_at is null;
alter table public.supplier_invoice_credits enable row level security;
alter table public.supplier_invoice_credits force row level security;
revoke all on public.supplier_invoice_credits from public,anon,authenticated;
grant select,insert,update on public.supplier_invoice_credits to service_role;
alter function public.accounting_ledger_command_v1(uuid,text,jsonb) rename to accounting_ledger_before_credits_v1;
revoke all on function public.accounting_ledger_before_credits_v1(uuid,text,jsonb) from public,anon,authenticated,service_role;
create function public.accounting_ledger_command_v1(p_actor uuid,p_operation text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f public.supplier_invoice_facts;c public.supplier_invoice_credits;r public.supplier_return_documents;req uuid;prior public.accounting_finance_requests;
 fingerprint text;doc uuid;net numeric;vat numeric;dt date;ref text;paid numeric;used_net numeric;used_vat numeric;fin jsonb;result jsonb;before_data jsonb;rowjson jsonb;entity uuid;
begin
 if p_operation not in ('supplier_credit_create','supplier_credit_void','supplier_payment_create','supplier_invoice_save') then return public.accounting_ledger_money_json_v1(public.accounting_ledger_before_credits_v1(p_actor,p_operation,p_payload));end if;
 perform public.accounting_ledger_assert_v1(p_actor,'purchases',case when p_operation like '%_void' then 'DELETE' when p_operation='supplier_invoice_save' then 'UPDATE' else 'CREATE' end);
 req:=(p_payload->>'request_id')::uuid;if req is null then raise exception '缺少請求識別。';end if;
 fingerprint:=md5(p_operation||p_payload::text);
 perform pg_advisory_xact_lock(hashtextextended('finance-request:'||p_actor::text||':'||req::text,0));
 select * into prior from public.accounting_finance_requests where actor_id=p_actor and request_id=req;
 if found then if prior.fingerprint<>fingerprint then raise exception '相同請求識別不可用於不同內容。';end if;return public.accounting_ledger_money_json_v1(prior.result);end if;
 if p_operation='supplier_credit_void' then
 select * into c from public.supplier_invoice_credits where id=(p_payload->>'id')::uuid for update;
 if not found or c.voided_at is not null then raise exception '找不到有效退出／折讓紀錄。';end if;doc:=c.document_id;
 else doc:=(p_payload->>'document_id')::uuid;end if;
 if doc is null then raise exception '缺少原進貨單。';end if;
 perform pg_advisory_xact_lock(hashtextextended(doc::text,0));
 perform pg_advisory_xact_lock(hashtextextended('supplier-invoice:'||doc::text,0));
 perform 1 from public.stock_transaction_documents where kind='receipt' and id=doc for update;
 select * into f from public.supplier_invoice_facts where document_id=doc for update;
 if f.document_id is null and p_operation<>'supplier_invoice_save' then raise exception '請先核對原進項發票。';end if;
 if not exists(select 1 from public.stock_receipts sr join public.stock_transaction_documents d on d.kind='receipt' and d.id=sr.receipt_document_id where sr.receipt_document_id=doc and public.erp_private_json_visible_v1(to_jsonb(sr)) and public.erp_private_json_visible_v1(to_jsonb(d))) then raise exception '找不到有權限的原進貨單。';end if;
 select coalesce(sum(net_amount),0),coalesce(sum(vat_amount),0) into used_net,used_vat from public.supplier_invoice_credits where document_id=doc and voided_at is null;
 select coalesce(sum(amount),0) into paid from public.supplier_payment_records where document_id=doc and voided_at is null;
 if p_operation in ('supplier_payment_create','supplier_credit_create') and not public.accounting_supplier_invoice_current_v1(doc) then raise exception '原進貨單已更正，請重新核對供應商發票後再登錄付款或折讓。';end if;
 if p_operation='supplier_invoice_save' then
 if f.document_id is not null and (paid>0 or used_net+used_vat>0) and exists(select 1 from public.stock_receipts sr where sr.receipt_document_id=doc and sr.supplier_id<>f.supplier_id) then raise exception '供應商已變更；請先核對並作廢原付款／折讓紀錄，再重新核對發票。';end if;
 if used_net>(p_payload->>'net_amount')::numeric or used_vat>(p_payload->>'vat_amount')::numeric or paid+used_net+used_vat>(p_payload->>'net_amount')::numeric+(p_payload->>'vat_amount')::numeric then raise exception '更正進項發票不可低於已付與已折讓金額。';end if;
 return public.accounting_ledger_money_json_v1(public.accounting_ledger_before_credits_v1(p_actor,p_operation,p_payload));
 elsif p_operation='supplier_payment_create' then
 if paid+used_net+used_vat+(p_payload->>'amount')::numeric>f.net_amount+f.vat_amount then raise exception '付款超過扣除進貨退出／折讓後的未付餘額。';end if;
 return public.accounting_ledger_money_json_v1(public.accounting_ledger_before_credits_v1(p_actor,p_operation,p_payload));
 end if;
 ref:=btrim(coalesce(p_payload->>'reference',''));if length(ref) not between 2 and 1000 then raise exception '請填寫原始折讓憑證／作廢原因。';end if;
 if p_operation='supplier_credit_create' then
 net:=(p_payload->>'net_amount')::numeric;vat:=(p_payload->>'vat_amount')::numeric;dt:=(p_payload->>'date')::date;
 if net is null or vat is null or dt is null or net<0 or vat<0 or net+vat<=0 or net<>round(net,2) or vat<>round(vat,2) then raise exception '請填寫有效折讓日期、未稅與稅額。';end if;
 if net+used_net>f.net_amount or vat+used_vat>f.vat_amount or paid+net+vat+used_net+used_vat>f.net_amount+f.vat_amount then raise exception '退出／折讓超過原發票餘額；如已付款，請先核對實際退款與付款更正。';end if;
 if nullif(p_payload->>'source_return_id','') is not null then
 perform pg_advisory_xact_lock(hashtextextended('supplier-return-document:'||(p_payload->>'source_return_id'),0));
 select * into r from public.supplier_return_documents where id=(p_payload->>'source_return_id')::uuid and deleted_at is null for update;
 if r.id is null or r.supplier_id<>f.supplier_id or not public.erp_private_json_visible_v1(to_jsonb(r)) then raise exception '找不到同供應商且有權限的退貨單。';end if;
 select public.receipt_money_totals_v2(jsonb_agg(jsonb_build_object('quantity',l.quantity,'unit_price',l.unit_price)),r.tax_mode,r.tax_rate_basis_points,r.discount_amount) into fin from public.supplier_return_lines l where l.document_id=r.id;
 if fin->>'total_amount' is null or net+vat<>(fin->>'total_amount')::numeric then raise exception '折讓金額須與關聯退貨單一致。';end if;
 end if;
 insert into public.supplier_invoice_credits(document_id,source_return_id,credit_date,net_amount,vat_amount,reference,created_by)
 values(doc,nullif(p_payload->>'source_return_id','')::uuid,dt,net,vat,ref,p_actor) returning id,to_jsonb(supplier_invoice_credits.*) into entity,rowjson;
 else
 entity:=c.id;before_data:=to_jsonb(c);
 update public.supplier_invoice_credits set voided_at=now(),voided_by=p_actor,void_reason=ref where id=c.id returning to_jsonb(supplier_invoice_credits.*) into rowjson;
 end if;
 result:=jsonb_build_object('record',rowjson);
 insert into public.accounting_finance_history(module,entity_id,action,before_data,after_data,actor_id) values('ledger_purchases',entity,p_operation,before_data,rowjson,p_actor);
 insert into public.accounting_finance_requests(actor_id,request_id,operation,fingerprint,result) values(p_actor,req,'ledger.'||p_operation,fingerprint,result);
 return public.accounting_ledger_money_json_v1(result);end $$;
alter function public.accounting_ledger_read_v1(uuid,jsonb) rename to accounting_ledger_before_credits_read_v1;
revoke all on function public.accounting_ledger_before_credits_read_v1(uuid,jsonb) from public,anon,authenticated,service_role;
create function public.accounting_ledger_read_v1(p_actor uuid,p_filters jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$ declare data jsonb;begin
 data:=public.accounting_ledger_before_credits_read_v1(p_actor,p_filters);
 if data->>'scope'='purchases' then
 data:=jsonb_set(data,'{supplier_documents}',coalesce((select jsonb_agg(d||jsonb_build_object('credits',coalesce(a.records,'[]'),'credit_amount',coalesce(a.total,0)::text,'source_stale',d->'invoice'<>'null'::jsonb and not public.accounting_supplier_invoice_current_v1((d->>'id')::uuid),'unpaid_amount',case when public.accounting_supplier_invoice_current_v1((d->>'id')::uuid) and d->>'unpaid_amount' is not null then ((d->>'unpaid_amount')::numeric-coalesce(a.total,0))::text end))
 from jsonb_array_elements(data->'supplier_documents') d left join lateral (select sum(net_amount+vat_amount) filter(where voided_at is null) total,jsonb_agg(to_jsonb(c) order by credit_date desc,id) records from public.supplier_invoice_credits c where document_id=(d->>'id')::uuid) a on true),'[]'));
 data:=data||jsonb_build_object('supplier_returns',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'supplier_id',r.supplier_id,'supplier_name',s.name,'date',r.return_date,'document_no',d.document_no))
 from public.supplier_return_documents r join public.suppliers s on s.id=r.supplier_id join public.stock_transaction_documents d on d.kind='supplier_return' and d.id=r.id
 where r.deleted_at is null and extract(year from r.return_date)=(p_filters->>'year')::integer and public.erp_private_json_visible_v1(to_jsonb(r)) and public.erp_private_json_visible_v1(to_jsonb(d))),'[]'));
 end if;return public.accounting_ledger_money_json_v1(data);end $$;
revoke all on function public.accounting_ledger_command_v1(uuid,text,jsonb),public.accounting_ledger_read_v1(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.accounting_ledger_command_v1(uuid,text,jsonb),public.accounting_ledger_read_v1(uuid,jsonb) to service_role;

-- A linked return must be corrected through void-credit -> edit-return -> new-credit.
-- This preserves a usable correction path without silently changing a booked VAT credit.
create function public.accounting_guard_supplier_credit_source_v1() returns trigger
language plpgsql security definer set search_path='' as $$ declare doc uuid;docs uuid[];begin
 if tg_table_name='supplier_return_documents' then docs:=array[case when tg_op<>'INSERT' then old.id end,case when tg_op<>'DELETE' then new.id end];else docs:=array[case when tg_op<>'INSERT' then old.document_id end,case when tg_op<>'DELETE' then new.document_id end];end if;
 for doc in select distinct x from unnest(docs) x where x is not null loop
  perform 1 from public.supplier_return_documents where id=doc for update;
  if exists(select 1 from public.supplier_invoice_credits where source_return_id=doc and voided_at is null) then raise exception '退貨單已有進項退出／折讓憑證；請先作廢該折讓憑證，再更正退貨單並重新核對。';end if;
 end loop;
 if tg_op='DELETE' then return old;else return new;end if;
end $$;
create trigger accounting_supplier_credit_document_guard before update or delete on public.supplier_return_documents for each row execute function public.accounting_guard_supplier_credit_source_v1();
create trigger accounting_supplier_credit_line_guard before insert or update or delete on public.supplier_return_lines for each row execute function public.accounting_guard_supplier_credit_source_v1();
revoke all on function public.accounting_guard_supplier_credit_source_v1() from public,anon,authenticated;

-- NUMERIC values leave the API as decimal strings so JSON/JavaScript cannot lose cents.
create function public.accounting_ledger_money_json_v1(p_data jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$ declare data jsonb;begin
 if jsonb_typeof(p_data)='object' then
 select coalesce(jsonb_object_agg(key,case when jsonb_typeof(value)='number' and (key~'(^amount$|_amount$|^amount_twd$|^unit_price$|^confirmed_gross$)') then to_jsonb(value#>>'{}') else public.accounting_ledger_money_json_v1(value) end),'{}') into data from jsonb_each(p_data);
 elsif jsonb_typeof(p_data)='array' then
 select coalesce(jsonb_agg(public.accounting_ledger_money_json_v1(value) order by ordinality),'[]') into data from jsonb_array_elements(p_data) with ordinality;
 else return p_data;end if;return data;end $$;
revoke all on function public.accounting_ledger_money_json_v1(jsonb) from public,anon,authenticated;
grant execute on function public.accounting_ledger_money_json_v1(jsonb) to service_role;

notify pgrst,'reload schema';
commit;
