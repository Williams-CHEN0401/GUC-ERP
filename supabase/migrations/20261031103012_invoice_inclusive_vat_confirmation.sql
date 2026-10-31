begin;
set local lock_timeout='5s';

-- Keep the authenticated command, privacy scope, original request fingerprint,
-- optimistic lock, duplicate check, receipt/allowance guards, and audit history.
-- Replace only the internal implementation already used by the credits wrapper.
-- No historical invoice, financial event, or supplier invoice is rewritten.
-- Sources: VAT Act Art. 14; MOF electronic VAT filing directions, 20.(15).
-- https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=g0340080
-- https://law-out.mof.gov.tw/LawContent.aspx?id=GL009478

create or replace function public.accounting_ledger_before_credits_v1(p_actor uuid,p_operation text,p_payload jsonb) returns jsonb
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
   -- This company's invoice snapshot is the VAT-inclusive amount (general VAT 5%).
   -- Calculate from the locked immutable invoice, never from client-supplied amounts.
   -- Round VAT to the nearest TWD, then retain the exact gross = net + VAT identity.
   vat:=round(i.amount_twd::numeric*5/105,0);net:=i.amount_twd::numeric-vat;
   -- Qualify kind: #variable_conflict use_variable would otherwise read the local
   -- (still NULL) operation-kind variable and skip both historical-money guards.
   select coalesce(sum(fe.amount),0) into used from public.quotation_financial_events fe where fe.invoice_id=i.id and fe.kind='receipt' and fe.voided_at is null;
   if used>net+vat then raise exception '確認金額不可低於已登錄收款。';end if;
   if exists(select 1 from public.quotation_financial_events fe where fe.invoice_id=i.id and fe.kind='allowance' and fe.voided_at is null) and (i.net_amount is distinct from net or i.vat_amount is distinct from vat) then raise exception '已有折讓，請先作廢折讓再更正發票財務資料。';end if;
   before_data:=to_jsonb(i);
   update public.quotation_invoices set tax_basis='inclusive',net_amount=net,vat_amount=vat,tax_evidence=reference,tax_confirmed_by=p_actor,tax_confirmed_at=now(),finance_row_version=finance_row_version+1 where id=i.id returning to_jsonb(quotation_invoices.*) into rowjson;
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
     if net+coalesce((select sum(fe.net_amount) from public.quotation_financial_events fe where fe.invoice_id=i.id and fe.kind='allowance' and fe.voided_at is null),0)>i.net_amount
       or vat+coalesce((select sum(fe.vat_amount) from public.quotation_financial_events fe where fe.invoice_id=i.id and fe.kind='allowance' and fe.voided_at is null),0)>i.vat_amount then raise exception '折讓不可超過原發票未稅／稅額。';end if;
     select coalesce(sum(fe.amount),0) into used from public.quotation_financial_events fe where fe.invoice_id=i.id and fe.kind in ('allowance','receipt') and fe.voided_at is null;
     if used+amount>i.net_amount+i.vat_amount then raise exception '折讓後金額低於已收款，請先依實際退款更正收款紀錄。';end if;
    else
     select coalesce(sum(fe.amount),0) into used from public.quotation_financial_events fe where fe.invoice_id=i.id and fe.kind in ('allowance','receipt') and fe.voided_at is null;
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

-- The implementation stays internal; gateways call accounting_ledger_command_v1.
revoke all on function public.accounting_ledger_before_credits_v1(uuid,text,jsonb) from public,anon,authenticated,service_role;
commit;
