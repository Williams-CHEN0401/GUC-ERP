begin;
set local lock_timeout='5s';

-- This is a read projection of existing invoice/billing records, not a new
-- ledger. Deletion/void history, original confirmations and receipt vouchers stay
-- intact. No fake payment or manual confirmation records are generated.
create or replace view public.accounting_invoice_source_v1 with (security_invoker=true) as
select i.id,i.quotation_id,i.billing_history_id,i.customer_id,i.invoice_number,i.invoice_date,
 i.amount_twd,i.status,i.replaces_invoice_id,i.created_at,i.created_by_user_id,
 i.voided_at,i.voided_by_user_id,i.void_reason,
 'inclusive'::text tax_basis,
 (i.amount_twd-round(i.amount_twd::numeric*5/105,0))::numeric(20,2) net_amount,
 round(i.amount_twd::numeric*5/105,0)::numeric(20,2) vat_amount,
 i.tax_evidence,i.tax_confirmed_at,i.tax_confirmed_by,i.finance_row_version,i.canonical_invoice_id
from public.quotation_invoices i join public.quotations q on q.id=i.quotation_id
where i.status='active' and i.canonical_invoice_id is null
 and q.archived_at is null and q.quote_status<>'voided'
 and nullif(btrim(q.invoice_number),'')=i.invoice_number
 and q.invoice_date is not distinct from i.invoice_date;
-- Accessible only through existing role-checked RPCs. Never expose the view via
-- PostgREST or use service-role grants to bypass the existing access predicates.
revoke all on public.accounting_invoice_source_v1 from public,anon,authenticated,service_role;
comment on view public.accounting_invoice_source_v1 is 'Current billing invoices, automatic inclusive 5% projection; no confirmation/payment history mutation.';

create or replace function public.accounting_ledger_before_credits_read_v1(p_actor uuid,p_filters jsonb default '{}') returns jsonb
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
    (select count(*) from public.accounting_invoice_source_v1 x where x.status='active' and x.canonical_invoice_id is null and public.accounting_invoice_identity_v1(x.invoice_number,x.invoice_date)=public.accounting_invoice_identity_v1(i.invoice_number,i.invoice_date)) identity_count,
    coalesce((select sum(amount) from public.quotation_financial_events where invoice_id=i.id and kind='allowance' and voided_at is null),0) allowance_amount,
    i.amount_twd received_amount
   from public.accounting_invoice_source_v1 i join quotes q on q.id=i.quotation_id where extract(year from i.invoice_date)=yr or i.invoice_date is null
  ), events as materialized (
   select e.*,q.quotation_number,q.customer_name from public.quotation_financial_events e join quotes q on q.id=e.quotation_id where extract(year from e.event_date)=yr
  ) select jsonb_build_object('scope',scope,'year',yr,
   'quotations',coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'quotation_number',q.quotation_number,'customer_name',q.customer_name,'billing_status',q.billing_status,'projects',public.quotation_linked_work_v1(q.id)) order by q.quotation_number) from quotes q where q.archived_at is null and q.quote_status<>'voided'),'[]'),
   'invoices',coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object('confirmed_gross',case when i.tax_basis<>'unconfirmed' then (i.net_amount+i.vat_amount)::text end,'unpaid_amount',case when i.tax_basis<>'unconfirmed' then (0)::text end) order by invoice_date desc nulls first,id) from invoices i),'[]'),
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
 (select count(*) from public.accounting_invoice_source_v1 x where x.status='active' and x.canonical_invoice_id is null and public.accounting_invoice_identity_v1(x.invoice_number,x.invoice_date)=public.accounting_invoice_identity_v1(i.invoice_number,i.invoice_date)) identity_count
 from public.accounting_invoice_source_v1 i join quotes q on q.id=i.quotation_id
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
 and (e.kind in ('recognition','billing') or (e.kind='allowance' and i.identity_count=1))
 ), periods as (
 select n period,make_date(p_year,(n-1)*step_months+1,1) start_date,
 (make_date(p_year,(n-1)*step_months+1,1)+make_interval(months=>step_months)-interval '1 day')::date end_date,
 coalesce(sum(e.amount) filter(where kind in ('invoice','allowance')),0)::text amount_twd,
 coalesce(sum(e.net) filter(where kind in ('invoice','allowance')),0)::text net_amount,
 coalesce(sum(e.vat) filter(where kind in ('invoice','allowance')),0)::text vat_amount,
 coalesce(-sum(e.amount) filter(where kind='allowance'),0)::text allowance_amount,
 coalesce(sum(e.amount) filter(where kind='invoice'),0)::text received_amount,
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
 'basis','invoice_date','tax_basis','automatic_inclusive_5','received_basis','invoice_gross',
 'snapshot',md5(coalesce((select string_agg(to_jsonb(a)::text,',' order by id) from selected a),'')||coalesce((select string_agg(to_jsonb(e)::text,',' order by period,kind,customer_id,amount) from entries e),'')),
 'summary',(select jsonb_build_object('amount_twd',coalesce(sum(amount_twd::numeric),0)::text,'net_amount',coalesce(sum(net_amount::numeric),0)::text,'vat_amount',coalesce(sum(vat_amount::numeric),0)::text,
 'allowance_amount',coalesce(sum(allowance_amount::numeric),0)::text,'received_amount',coalesce(sum(received_amount::numeric),0)::text,'recognized_amount',coalesce(sum(recognized_amount::numeric),0)::text,'billed_amount',coalesce(sum(billed_amount::numeric),0)::text,
 'invoice_count',(select count(*) from selected),'customer_count',(select count(distinct customer_id) from selected),'unconfirmed_count',(select count(*) from selected where not confirmed),
 'voided_count',(select count(*) from public.quotation_invoices i join quotes q on q.id=i.quotation_id where i.status='voided' and extract(year from i.invoice_date)=p_year),
 'duplicate_link_count',(select count(*) from public.quotation_invoices i join quotes q on q.id=i.quotation_id where i.canonical_invoice_id is not null and extract(year from i.invoice_date)=p_year)) from periods where p_period is null or period=p_period),
 'periods',(select jsonb_agg(to_jsonb(p) order by period) from periods p),'invoices',coalesce((select jsonb_agg(to_jsonb(d) order by invoice_date desc,id desc) from details d),'[]'),
 'customers',coalesce((select jsonb_agg(to_jsonb(c) order by name,id) from (select distinct customer_id id,customer_name name from quotes) c),'[]'),
 'missing_date_count',(select count(*) from active where invoice_date is null)) into result;
 return public.accounting_ledger_money_json_v1(result);end $$;

create or replace function public.accounting_project_income_v1(p_actor uuid,p_project uuid) returns jsonb
language plpgsql security definer set search_path='' as $$ declare data jsonb;begin
 perform public.accounting_ledger_assert_v1(p_actor,'sales');perform public.erp_private_assert_v1(jsonb_build_array(p_project));
 with invoices as materialized (
 select distinct i.*,(select count(*) from public.quotation_work_links where quotation_id=i.quotation_id) work_count,
 (select count(*) from public.accounting_invoice_source_v1 x where x.status='active' and x.canonical_invoice_id is null and public.accounting_invoice_identity_v1(x.invoice_number,x.invoice_date)=public.accounting_invoice_identity_v1(i.invoice_number,i.invoice_date)) identity_count
 from public.accounting_invoice_source_v1 i join public.quotations q on q.id=i.quotation_id join public.quotation_work_links l on l.quotation_id=q.id
 where l.project_id=p_project and i.status='active' and i.canonical_invoice_id is null and public.erp_private_json_visible_v1(to_jsonb(q))
 ), amounts as (
 select i.*,coalesce(a.net,0) allowance_net,coalesce(a.vat,0) allowance_vat,i.amount_twd received
 from invoices i left join lateral (select sum(net_amount) filter(where kind='allowance') net,sum(vat_amount) filter(where kind='allowance') vat,0 received from public.quotation_financial_events where invoice_id=i.id and voided_at is null) a on true
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
 'outstanding_amount',case when exists(select 1 from amounts where tax_basis='unconfirmed' or identity_count>1 or work_count<>1) then null else (select sum(0)::text from amounts) end,
 'recognized_net',(select sum(amount)::text from recognition),'recognition_count',(select count(*) from recognition),
 'invoices',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('confirmed_gross',case when a.tax_basis<>'unconfirmed' and a.identity_count=1 then (a.net_amount+a.vat_amount)::text end)) from amounts a),'[]'),'recognitions',coalesce((select jsonb_agg(to_jsonb(r)) from recognition r),'[]'),
 'missing',case when not exists(select 1 from recognition) then jsonb_build_array('尚未確認適用會計政策與履約收入認列') else '[]'::jsonb end) into data;
 return data;end $$;

create or replace function public.accounting_analysis_read_v1(p_actor uuid,p_mode text,p_year integer default 2026,p_project uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; profile public.accounting_tax_profiles; policy public.accounting_project_finance_policy; statement jsonb;
 missing jsonb:='[]'; source_report jsonb; income jsonb; labor jsonb; materials jsonb; costs jsonb; allocations jsonb; totals jsonb;
 material numeric; wages numeric; employer numeric; direct numeric; subcontract numeric; other_direct numeric; gp numeric; pretax numeric; cit numeric; aftertax numeric;
 admin numeric; office numeric; depreciation numeric; other_overhead numeric; overhead numeric; stamp numeric; nondeductible numeric; other_tax numeric; taxes numeric;
 taxable numeric; undistributed numeric; payroll_sources jsonb; ready boolean; periods jsonb; annual_sources jsonb; private_missing integer; period_row jsonb; obligation public.accounting_tax_obligations; reconciled jsonb:='[]'; balance numeric;
begin
 if p_mode not in ('annual','project') or p_year is null or p_year not between 2000 and 2100 then raise exception '財務分析查詢不正確。';end if;
 perform public.accounting_analysis_assert_v1(p_actor,p_mode='annual');
 if p_mode='project' then
  if p_project is null then raise exception '請選擇工作內容。';end if;
  source_report:=public.work_content_report_v1(p_actor,p_project,null,null,null,true);
  if source_report->'report' is null then raise exception '工作內容不存在或無查看權限。';end if;
  select * into policy from public.accounting_project_finance_policy where project_id=p_project;
  if public.has_app_permission_v1(p_actor,'quotation_invoices','VIEW') then income:=public.accounting_project_income_v1(p_actor,p_project);
  else income:=jsonb_build_object('missing',jsonb_build_array('未具發票及收入查看權限'));end if;
  missing:=missing||coalesce(income->'missing','[]');
  income:=income||jsonb_build_object('gross',income->'invoice_gross','output_tax',income->'invoice_vat','net',income->'recognized_net','received',income->'received_amount','billed',income->'billed_amount','outstanding',income->'outstanding_amount','adjustments',income->'allowance_amount');
  if not coalesce(policy.revenue_complete,false) then missing:=missing||jsonb_build_array('收入認列範圍尚未完成核對（報價／發票不等於認列收入）');end if;
  if public.has_app_permission_v1(p_actor,'accounting_payroll','VIEW') then labor:=public.accounting_project_labor_v1(p_actor,p_project);
  else labor:=jsonb_build_object('wage_amount',null,'employer_amount',null,'note','未具薪資查看權限');end if;
  wages:=(labor->>'wage_amount')::numeric;employer:=(labor->>'employer_amount')::numeric;
  if wages is null or employer is null then missing:=missing||jsonb_build_array('薪資或雇主負擔分攤缺漏／來源已變更／無查看權限');end if;
  labor:=labor||jsonb_build_object('wages',wages,'employer_burden',employer,'total',wages+employer);
  select coalesce(sum((x->>'amount')::numeric),0) into material from jsonb_array_elements(source_report->'report'->'materialStats')x;
  if exists(select 1 from jsonb_array_elements(source_report->'report'->'materialStats') x where (x->>'quantity')::numeric<>0 and x->>'amount' is null) then material:=null;missing:=missing||jsonb_build_array('用料有缺少單價的品項');end if;
  if exists(select 1 from public.pickup_records r where r.project_id=p_project and r.quantity>0 and public.erp_private_json_visible_v1(to_jsonb(r)) is not true)
   or exists(select 1 from public.site_return_documents d where d.project_id=p_project and d.status='active' and public.erp_private_json_visible_v1(to_jsonb(d)) is not true and exists(select 1 from public.site_return_lines l where l.document_id=d.id and l.quantity>0)) then
   material:=null;missing:=missing||jsonb_build_array('尚有未授權用料來源，不能以部分資料計算完整材料成本');end if;
  if not coalesce(policy.materials_reviewed,false) then missing:=missing||jsonb_build_array('材料估值尚未核對：線材保留領退料成本快照，其餘採最新進貨／人工參考單價，非實際庫存批次成本');end if;
  materials:=jsonb_build_object('net_cost',material,'status','估算','basis','工程領用減案場餘料；線材保留歷史成本快照，新增快照與進貨參考單價採折扣後未稅價，人工設定價格優先；不再加進貨總額','rows',source_report->'report'->'materialStats','returns',source_report->'report'->'returnRows','creditable_input_vat',null,'input_vat_note','既有領用未綁定實際進貨批次與可扣抵憑證；可歸屬進項稅待核對，不按材料估值反推');
  select coalesce(jsonb_agg(to_jsonb(c) order by occurred_on,id),'[]'),
   coalesce(sum(amount) filter(where finance_category='subcontract'),0),coalesce(sum(amount) filter(where finance_category in ('rental','equipment','transport','other_direct')),0),
   coalesce(sum(amount) filter(where finance_category='stamp'),0),coalesce(sum(amount) filter(where finance_category='nondeductible_vat'),0),coalesce(sum(amount) filter(where finance_category='other_tax'),0)
   into costs,subcontract,other_direct,stamp,nondeductible,other_tax from public.project_costs c where project_id=p_project and finance_voided_at is null and public.erp_private_json_visible_v1(to_jsonb(c));
  if exists(select 1 from jsonb_array_elements(costs) x where x->>'finance_category'='unconfirmed' or x->>'finance_status'='unconfirmed') then missing:=missing||jsonb_build_array('既有工程成本尚未分類或確認，未自動疊加避免與材料／薪資重複');end if;
  if exists(select 1 from public.project_costs c where project_id=p_project and finance_voided_at is null and public.erp_private_json_visible_v1(to_jsonb(c)) is not true) then missing:=missing||jsonb_build_array('尚有未授權工程成本，不能以部分資料計算完整損益');end if;
  if not coalesce(policy.direct_costs_complete,false) then missing:=missing||jsonb_build_array('外包、租賃、運輸及其他直接成本尚未核對完整（沒有資料不等於零）');end if;
  select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('source',jsonb_build_object('id',pool.id,'year',pool.year,'category',pool.category,'label',pool.label,'status',pool.status,'method',pool.method,'rationale',pool.rationale,'evidence',pool.evidence))),'[]'),
   coalesce(sum(a.amount) filter(where pool.category='administration'),0),coalesce(sum(a.amount) filter(where pool.category='office'),0),
   coalesce(sum(a.amount) filter(where pool.category='depreciation'),0),coalesce(sum(a.amount) filter(where pool.category='other'),0),sum(a.amount) filter(where pool.category='cit')
   into allocations,admin,office,depreciation,other_overhead,cit from public.accounting_overhead_allocations a join public.accounting_overhead_pools pool on pool.id=a.pool_id where project_id=p_project;
  if not public.has_app_permission_v1(p_actor,'accounting_tax','VIEW') then
   allocations:='[]';admin:=null;office:=null;depreciation:=null;other_overhead:=null;cit:=null;missing:=missing||jsonb_build_array('未具公司費用與所得稅查看權限');end if;
  if exists(select 1 from public.accounting_overhead_allocations a join public.accounting_overhead_pools pool on pool.id=a.pool_id join public.accounting_tax_obligations t on t.id=pool.tax_obligation_id join public.accounting_tax_profiles pr on pr.year=pool.year where a.project_id=p_project and (pool.tax_source_version is distinct from t.row_version or t.amount is distinct from pool.amount or t.status not in ('estimated','filed','paid') or t.status='estimated' and (not pr.conditions_confirmed or pool.tax_profile_version is distinct from pr.row_version))) then cit:=null;missing:=missing||jsonb_build_array('公司所得稅來源或年度條件已更正，須重新核准分攤');end if;
  if not coalesce(policy.overhead_complete,false) then missing:=missing||jsonb_build_array('公司費用、補充保費／墊償基金分攤政策尚未確認');end if;
  if not coalesce(policy.taxes_complete,false) then missing:=missing||jsonb_build_array('契約印花稅、不可扣抵稅額及其他專案稅費尚未確認');end if;
  if (income->>'recognized_net') is null then missing:=missing||jsonb_build_array('尚未登錄依會計政策認列的未稅收入');end if;
  direct:=material+wages+employer+subcontract+other_direct;overhead:=admin+office+depreciation+other_overhead;taxes:=stamp+nondeductible+other_tax;
  if jsonb_array_length(missing)=0 then gp:=(income->>'recognized_net')::numeric-direct;pretax:=gp-overhead-taxes;end if;
  if cit is null then missing:=missing||jsonb_build_array('所得稅尚無法可靠估算：需連結公司年度稅額與核准分攤');else aftertax:=pretax-cit;end if;
  totals:=jsonb_build_object('material_cost',material,'wages',wages,'employer_burden',employer,'subcontract',subcontract,'other_direct',other_direct,'direct_cost',direct,'gross_profit',gp,
  'administration',admin,'office',office,'depreciation',depreciation,'other_overhead',other_overhead,'overhead',overhead,'stamp',stamp,'nondeductible_vat',nondeductible,'other_tax',other_tax,'taxes',taxes,
  'pretax',pretax,'income_tax',cit,'aftertax',aftertax,'margin',case when (income->>'recognized_net')::numeric>0 then round(aftertax/(income->>'recognized_net')::numeric*100,4) end);
  result:=jsonb_build_object('project',(select jsonb_build_object('id',id,'name',name,'code',project_code,'status',status) from public.projects where id=p_project),'policy',case when policy.project_id is not null then to_jsonb(policy) end,
   'income',income,'labor',labor,'materials',materials,'costs',costs,'allocations',allocations,'totals',totals,'missing',missing,'status',case when jsonb_array_length(missing)>0 then '未確認' else '估算' end,
   'note','全工程累計；不受材料頁日期篩選影響。材料參考估值與核准分攤仍為管理會計估算，不代表法定決算或個別工程應納稅額。');
  return public.accounting_analysis_money_json_v1(result);
 end if;
 if exists(select 1 from public.projects p where public.erp_private_json_visible_v1(to_jsonb(p)) is not true) or exists(select 1 from public.quotations q where public.erp_private_json_visible_v1(to_jsonb(q)) is not true) or exists(select 1 from public.stock_transaction_documents d where public.erp_private_json_visible_v1(to_jsonb(d)) is not true) then raise exception using errcode='42501',message='年度稅費需完整財務來源權限，目前仍有未授權私有資料，不能以部分資料產生公司稅額。';end if;
 select * into profile from public.accounting_tax_profiles where year=p_year;
 statement:=coalesce(profile.statement,'{}');
 ready:=p_year=2026 and profile.conditions_confirmed and profile.organization='company' and profile.income_tax_method='general'
 and coalesce((statement->>'statement_confirmed')::boolean,false)
 and statement ?& array['revenue','cogs','personnel','administration','depreciation','other_expenses','nonoperating_income','nonoperating_loss','tax_additions','tax_deductions','prepayments','credits'];
 if coalesce(ready,false) then
  taxable:=(statement->>'revenue')::numeric-(statement->>'cogs')::numeric-(statement->>'personnel')::numeric-(statement->>'administration')::numeric-(statement->>'depreciation')::numeric-(statement->>'other_expenses')::numeric+(statement->>'nonoperating_income')::numeric-(statement->>'nonoperating_loss')::numeric+(statement->>'tax_additions')::numeric-(statement->>'tax_deductions')::numeric;
  cit:=public.accounting_cit_estimate_v1(taxable);
 else missing:=missing||jsonb_build_array('公司適用條件／2026年度完整決算與財稅差異尚未確認；不能以單案利潤乘20%代替');end if;
 if p_year=2026 and profile.organization='company' and profile.conditions_confirmed
 and coalesce((statement->>'undistributed_base_confirmed')::boolean,false) and (statement->>'undistributed_income_year')::integer=p_year
 and statement->>'undistributed_base' is not null and length(btrim(coalesce(statement->>'undistributed_evidence','')))>=2 then
 undistributed:=round(greatest((statement->>'undistributed_base')::numeric,0)*0.05,0);end if;
 -- Period sources are informational until all vouchers and tax carry-forward are reconciled.
 with slots as(select n,make_date(p_year,n*2-1,1) start_date,(make_date(p_year,n*2-1,1)+interval '2 months -1 day')::date end_date from generate_series(1,6)n),
 invoices as(select i.*,(select count(*) from public.accounting_invoice_source_v1 x where x.status='active' and x.canonical_invoice_id is null and public.accounting_invoice_identity_v1(x.invoice_number,x.invoice_date)=public.accounting_invoice_identity_v1(i.invoice_number,i.invoice_date)) identity_count from public.accounting_invoice_source_v1 i join public.quotations q on q.id=i.quotation_id where i.status='active' and i.canonical_invoice_id is null and public.erp_private_json_visible_v1(to_jsonb(q))),
 ev as(select e.* from public.quotation_financial_events e join public.quotations q on q.id=e.quotation_id where e.voided_at is null and public.erp_private_json_visible_v1(to_jsonb(q))),
 purchases as(select f.*,public.accounting_supplier_invoice_current_v1(f.document_id) source_current from public.supplier_invoice_facts f join public.stock_transaction_documents d on d.kind='receipt' and d.id=f.document_id where public.erp_private_json_visible_v1(to_jsonb(d)))
 select jsonb_agg(jsonb_build_object('period',n,'start',start_date,'end',end_date,
  'output_tax',coalesce((select sum(vat_amount) from invoices where invoice_date between start_date and end_date and identity_count=1),0)-coalesce((select sum(e.vat_amount) from ev e join invoices i on i.id=e.invoice_id where e.kind='allowance' and e.event_date between start_date and end_date and i.identity_count=1),0),
  'creditable_input_tax',coalesce((select sum(vat_amount) from purchases where invoice_date between start_date and end_date and source_current is true and deduction_status='deductible'),0)-coalesce((select sum(c.vat_amount) from public.supplier_invoice_credits c join purchases f on f.document_id=c.document_id where c.voided_at is null and c.credit_date between start_date and end_date and f.source_current is true and f.deduction_status='deductible'),0),
  'nondeductible_input_tax',coalesce((select sum(vat_amount) from purchases where invoice_date between start_date and end_date and source_current is true and deduction_status='nondeductible'),0)-coalesce((select sum(c.vat_amount) from public.supplier_invoice_credits c join purchases f on f.document_id=c.document_id where c.voided_at is null and c.credit_date between start_date and end_date and f.source_current is true and f.deduction_status='nondeductible'),0),
  'unconfirmed_invoices',(select count(*) from invoices where invoice_date is null or invoice_date between start_date and end_date and (tax_basis='unconfirmed' or identity_count<>1)),
  'pending_input',(select count(*) from purchases where invoice_date between start_date and end_date and (deduction_status='pending' or source_current is not true)),
  'payable',null,'carry_forward',null,'status','未確認') order by n) into periods from slots;
 for period_row in select * from jsonb_array_elements(periods) loop
  select * into obligation from public.accounting_tax_obligations where year=p_year and kind='vat' and period_start=(period_row->>'start')::date and period_end=(period_row->>'end')::date;
  if profile.conditions_confirmed and profile.vat_method='general_5' and obligation.applicability='applicable'
   and coalesce((obligation.adjustments->>'reviewed')::boolean,false) and (period_row->>'unconfirmed_invoices')::int=0 and (period_row->>'pending_input')::int=0 then
   balance:=(period_row->>'output_tax')::numeric-(period_row->>'creditable_input_tax')::numeric+(obligation.adjustments->>'additional_input_reversal')::numeric-(obligation.adjustments->>'previous_credit')::numeric-(obligation.adjustments->>'other_adjustments')::numeric;
   period_row:=period_row||jsonb_build_object('payable',greatest(balance,0),'carry_forward',greatest(-balance,0),'status','估算','reconciliation',obligation.adjustments,'source_id',obligation.id);
  end if;
  reconciled:=reconciled||jsonb_build_array(period_row);
 end loop;periods:=reconciled;
 select jsonb_build_object('recognized_net',coalesce(sum(amount) filter(where kind='recognition'),0),'actual_receipts',coalesce(sum(amount) filter(where kind='receipt'),0),'billing_events',coalesce(sum(amount) filter(where kind='billing'),0)) into annual_sources
 from public.quotation_financial_events e join public.quotations q on q.id=e.quotation_id where e.voided_at is null and extract(year from e.event_date)=p_year and public.erp_private_json_visible_v1(to_jsonb(q));
 if public.has_app_permission_v1(p_actor,'accounting_payroll','VIEW') then
  with pay as(select p.*,(p.calculation->>'rules_version'='TW-2026-v2' and p.calculation->>'employer_burden' is not null) valid
   from public.accounting_payroll p where p.deleted_at is null and p.month>=make_date(p_year,1,1) and p.month<make_date(p_year+1,1,1))
  select jsonb_build_object('records',count(*),'payroll_month_count',count(distinct month),'missing_count',count(*) filter(where valid is not true),
   'gross',case when count(*)>0 and bool_and(valid is true) then sum((calculation->>'gross')::numeric) end,
   'net',case when count(*)>0 and bool_and(valid is true) then sum((calculation->>'net')::numeric) end,
   'employee_deductions',case when count(*)>0 and bool_and(valid is true) then sum((calculation->>'deductions')::numeric) end,
   'withholding',case when count(*)>0 and bool_and(valid is true) then sum((input->>'tax_withheld')::numeric) end,
   'employer_burden',case when count(*)>0 and bool_and(valid is true) then sum((calculation->>'employer_burden')::numeric) end,
   'employer_cost',case when count(*)>0 and bool_and(valid is true) then sum((calculation->>'employer_cost')::numeric) end) into payroll_sources from pay;
  payroll_sources:=payroll_sources||(select jsonb_build_object('company_month_count',count(*),'company_supplement',sum(supplement),'company_fund',sum(fund_amount),
   'company_months',coalesce(jsonb_agg(jsonb_build_object('month',month,'status',status,'supplement',supplement,'fund_status',fund_status,'fund_amount',fund_amount,'source_reference',source_reference,'row_version',row_version) order by month),'[]'))
   from public.accounting_employer_months where month>=make_date(p_year,1,1) and month<make_date(p_year+1,1,1));
  payroll_sources:=payroll_sources||jsonb_build_object('note','僅彙總已登錄且採2026新規則的來源，非完整年度決算。應發薪資與雇主負擔相加；實發及代扣不再加計。公司補充保費與墊償基金每月只計一次；已含於年度決算人事費用時不可再次加總。');
 else payroll_sources:=jsonb_build_object('note','未具薪資查看權限','gross',null,'net',null,'employee_deductions',null,'withholding',null,'employer_burden',null,'employer_cost',null,'company_supplement',null,'company_fund',null);end if;
 missing:=missing||jsonb_build_array('營業稅來源金額須與完整憑證、進貨退出折讓、前期留抵及申報調整核對；下列不是正式應納稅額','次年度申報期限須待官方公告或附官方來源確認');
 result:=jsonb_build_object('year',p_year,'profile',case when profile.year is not null then to_jsonb(profile) end,
  'estimate',jsonb_build_object('status','估算','taxable_income',taxable,'corporate_income_tax',cit,'prepayments',statement->'prepayments','credits',statement->'credits',
   'payable',case when cit is not null then greatest(0,cit-(statement->>'prepayments')::numeric-(statement->>'credits')::numeric) end,'undistributed_tax',undistributed,'undistributed_filing_year',case when undistributed is not null then p_year+2 end,'note','年度公司一般稅制條件試算；未分配盈餘另需確認適用所得年度、法定減項及申報年度'),
  'vat',jsonb_build_object('periods',periods,'output_tax',(select sum((x->>'output_tax')::numeric) from jsonb_array_elements(periods)x),'creditable_input_tax',(select sum((x->>'creditable_input_tax')::numeric) from jsonb_array_elements(periods)x),'nondeductible_input_tax',(select sum((x->>'nondeductible_input_tax')::numeric) from jsonb_array_elements(periods)x),'payable',null,'carry_forward',null),
  'sources',annual_sources,'payroll',payroll_sources,'missing',missing,
  'obligations',coalesce((select jsonb_agg(to_jsonb(t) order by period_start,kind) from public.accounting_tax_obligations t where year=p_year),'[]'),
  'pools',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('allocations',coalesce((select jsonb_agg(to_jsonb(a)) from public.accounting_overhead_allocations a where pool_id=t.id),'[]'))) from public.accounting_overhead_pools t where year=p_year),'[]'),
  'projects',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'code',p.project_code,'customer_name',c.name)) from public.projects p join public.customers c on c.id=p.customer_id where p.deleted_at is null and p.project_type in ('construction','repair') and public.erp_private_json_visible_v1(to_jsonb(p)) and public.erp_private_json_visible_v1(to_jsonb(c))),'[]'));
 return public.accounting_analysis_money_json_v1(result);
end $$;

-- CREATE OR REPLACE retains existing ACLs, including the private read helper.
notify pgrst,'reload schema';
commit;
