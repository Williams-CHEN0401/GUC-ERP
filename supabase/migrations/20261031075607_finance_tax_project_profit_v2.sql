begin;
set local lock_timeout='5s';
-- Company tax review and project allocations extend the existing finance model.
-- They are source schedules, not a parallel general ledger or identity system.
do $$ declare c text; begin
 select pg_get_constraintdef(oid) into c from pg_constraint where conrelid='public.role_permissions'::regclass and conname='role_permissions_module_check';
 if position('accounting_tax' in c)=0 then
 alter table public.role_permissions drop constraint role_permissions_module_check;
 execute 'alter table public.role_permissions add constraint role_permissions_module_check '||replace(c,'''accounting_payroll''::text','''accounting_payroll''::text, ''accounting_tax''::text');end if;
end $$;

create table public.accounting_tax_profiles(
 year integer primary key check(year between 2000 and 2100), organization text not null default 'unconfirmed' check(organization in ('unconfirmed','company','sole_proprietor','partnership')),
 vat_method text not null default 'unconfirmed' check(vat_method in ('unconfirmed','general_5','other')),
 accounting_standard text not null default '', income_tax_method text not null default 'unconfirmed' check(income_tax_method in ('unconfirmed','general','other')),
 conditions_confirmed boolean not null default false, evidence text not null default '', statement jsonb not null default '{}',
 row_version integer not null default 1, updated_by uuid not null references public.app_users(id), updated_at timestamptz not null default now()
);
create index accounting_tax_profiles_actor_idx on public.accounting_tax_profiles(updated_by);
create table public.accounting_tax_obligations(
 id uuid primary key default gen_random_uuid(), year integer not null references public.accounting_tax_profiles(year),
 kind text not null check(kind in ('vat','cit','undistributed','stamp','withholding','local_tax','employer','other')),
 period_start date not null, period_end date not null, due_date date, due_source text not null default '',
 applicability text not null check(applicability in ('unconfirmed','applicable','not_applicable')),
 status text not null check(status in ('pending','filed','paid','estimated','unconfirmed')), amount numeric(20,2), paid numeric(20,2) not null default 0,
 payment_date date, evidence text not null default '', adjustments jsonb not null default '{}',
 row_version integer not null default 1, updated_by uuid not null references public.app_users(id), updated_at timestamptz not null default now(),
 check(period_end>=period_start),check(amount>=0),check(paid>=0 and (amount is null and paid=0 or paid<=amount)),check(paid=0 or payment_date is not null)
);
create unique index accounting_tax_obligation_period_idx on public.accounting_tax_obligations(year,kind,period_start,period_end);
create index accounting_tax_obligation_actor_idx on public.accounting_tax_obligations(updated_by);
alter table public.project_costs add column finance_category text not null default 'unconfirmed'
 check(finance_category in ('unconfirmed','subcontract','rental','equipment','transport','other_direct','stamp','nondeductible_vat','other_tax')),
 add column finance_status text not null default 'unconfirmed' check(finance_status in ('unconfirmed','incurred','booked','estimated')),
 add column evidence_ref text not null default '', add column finance_voided_at timestamptz;
create unique index project_costs_evidence_once_idx on public.project_costs(evidence_ref) where evidence_ref<>'' and finance_voided_at is null;
create table public.accounting_overhead_pools(
 id uuid primary key default gen_random_uuid(), year integer not null references public.accounting_tax_profiles(year),
 category text not null check(category in ('administration','office','depreciation','other','cit')),
 label text not null, amount numeric(20,2) not null check(amount>=0), evidence text not null unique,
 status text not null check(status in ('incurred','booked','estimated')), method text not null check(method in ('actual','hours','revenue','duration','approved_other')),
 rationale text not null, denominator numeric not null check(denominator>0), tax_obligation_id uuid references public.accounting_tax_obligations(id), tax_source_version integer, tax_profile_version integer,
 row_version integer not null default 1, updated_by uuid not null references public.app_users(id), updated_at timestamptz not null default now(),
 check((category='cit')=(tax_obligation_id is not null))
);
create index accounting_overhead_tax_idx on public.accounting_overhead_pools(tax_obligation_id);
create unique index accounting_overhead_tax_once_idx on public.accounting_overhead_pools(tax_obligation_id) where tax_obligation_id is not null;
create index accounting_overhead_actor_idx on public.accounting_overhead_pools(updated_by);
create table public.accounting_overhead_allocations(
 pool_id uuid not null references public.accounting_overhead_pools(id), project_id uuid not null references public.projects(id),
 amount numeric(20,2) not null check(amount>=0), basis_quantity numeric not null check(basis_quantity>0), primary key(pool_id,project_id)
);
create index accounting_overhead_project_idx on public.accounting_overhead_allocations(project_id);
create table public.accounting_project_finance_policy(
 project_id uuid primary key references public.projects(id), materials_reviewed boolean not null default false,
 direct_costs_complete boolean not null default false, overhead_complete boolean not null default false, taxes_complete boolean not null default false,
 revenue_complete boolean not null default false, evidence text not null, row_version integer not null default 1,
 updated_by uuid not null references public.app_users(id), updated_at timestamptz not null default now()
);
create index accounting_project_finance_actor_idx on public.accounting_project_finance_policy(updated_by);
do $$ declare t text;begin
 foreach t in array array['accounting_tax_profiles','accounting_tax_obligations','accounting_overhead_pools','accounting_overhead_allocations','accounting_project_finance_policy'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $$;

create function public.accounting_analysis_assert_v1(p_actor uuid,p_tax boolean default false,p_action text default 'VIEW') returns void
language plpgsql security invoker set search_path='' as $$ begin
 if not public.has_app_permission_v1(p_actor,'accounting_prices','VIEW')
 or not public.has_app_permission_v1(p_actor,case when p_tax then 'accounting_tax' else 'accounting_reports' end,'VIEW')
 or not public.has_app_permission_v1(p_actor,case when p_tax then 'accounting_tax' else 'accounting_prices' end,p_action)
 then raise exception using errcode='42501',message='沒有此財務分析操作權限。';end if;
 perform public.erp_private_prepare_v1(p_actor);
end $$;
create function public.accounting_cit_estimate_v1(p_income numeric) returns numeric language sql immutable security invoker set search_path='' as $$
 select case when p_income is null then null when p_income<=120000 then 0 when p_income<=200000 then round((p_income-120000)/2,0) else round(p_income*0.2,0) end;
$$;
create function public.accounting_analysis_command_v1(p_actor uuid,p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
#variable_conflict use_variable
declare req uuid:=(p_payload->>'request_id')::uuid; fp text:=md5(p_payload::text); prior public.accounting_finance_requests;
 id uuid:=nullif(p_payload->>'id','')::uuid; yr integer:=(p_payload->>'year')::integer; ver integer:=(p_payload->>'row_version')::integer;
 old jsonb; fresh jsonb; result jsonb; entity text; action text; p uuid:=nullif(p_payload->>'project_id','')::uuid; k text; v numeric; row jsonb;
 pool public.accounting_overhead_pools; total numeric:=0; denominator numeric; raw_total numeric; assigned numeric:=0; n integer; idx integer:=0; amount numeric;
begin
 if req is null or jsonb_typeof(p_payload)<>'object' then raise exception '缺少送出識別碼。';end if;
 if p_operation not in ('tax_profile_save','tax_obligation_save','cost_save','cost_void','overhead_save','project_policy_save') then raise exception '不支援的財務分析操作。';end if;
 action:=case when p_operation='cost_void' then 'DELETE' when id is null and coalesce(ver,0)=0 then 'CREATE' else 'UPDATE' end;
 perform public.accounting_analysis_assert_v1(p_actor,p_operation in ('tax_profile_save','tax_obligation_save','overhead_save'),action);
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text||req::text,0));
 select * into prior from public.accounting_finance_requests where actor_id=p_actor and request_id=req;
 if found then if prior.operation<>p_operation or prior.fingerprint<>fp then raise exception '送出識別碼已使用。';end if;return prior.result;end if;
 if p is not null then perform public.work_content_report_v1(p_actor,p,null,null,null,true);end if;
 if length(btrim(coalesce(p_payload->>'evidence','')))<2 or length(coalesce(p_payload->>'evidence',''))>2000 then raise exception '請填寫原始憑證或核准依據（2～2000字）。';end if;
 if p_operation='tax_profile_save' then
  if yr is null or yr not between 2000 and 2100 then raise exception '年度不正確。';end if;
  perform pg_advisory_xact_lock(hashtextextended('tax-year-'||yr,0));
  select to_jsonb(t) into old from public.accounting_tax_profiles t where year=yr for update;
  if coalesce((old->>'row_version')::int,0)<>coalesce(ver,0) then raise exception '年度設定已更新，請重新讀取。';end if;
  if coalesce((p_payload->>'conditions_confirmed')::boolean,false) and
   (coalesce(p_payload->>'organization','unconfirmed')='unconfirmed' or coalesce(p_payload->>'vat_method','unconfirmed')='unconfirmed' or coalesce(p_payload->>'income_tax_method','unconfirmed')='unconfirmed' or length(btrim(coalesce(p_payload->>'accounting_standard','')))<2)
   then raise exception '確認公司條件前須填妥組織、會計準則及課稅身分。';end if;
  if jsonb_typeof(coalesce(p_payload->'statement','{}'))<>'object' then raise exception '年度損益格式不正確。';end if;
  for k in select jsonb_object_keys(coalesce(p_payload->'statement','{}')) loop
   if k not in ('revenue','cogs','personnel','administration','depreciation','other_expenses','nonoperating_income','nonoperating_loss','tax_additions','tax_deductions','prepayments','credits','undistributed_base','statement_confirmed','undistributed_base_confirmed','undistributed_income_year','undistributed_evidence') then raise exception '年度試算欄位不正確。';end if;
   if k in ('statement_confirmed','undistributed_base_confirmed') then if jsonb_typeof(p_payload->'statement'->k)<>'boolean' then raise exception '須明確確認年度決算。';end if;
   elsif k='undistributed_evidence' then if jsonb_typeof(p_payload->'statement'->k)<>'string' or length(p_payload->'statement'->>k)>2000 then raise exception '未分配盈餘憑證格式不正確。';end if;
   elsif k='undistributed_income_year' then if (p_payload->'statement'->>k)::integer not between 2000 and 2100 then raise exception '盈餘所屬年度不正確。';end if;
   else v:=(p_payload->'statement'->>k)::numeric;if v is null or v<0 or v>1e12 or v<>round(v,2) then raise exception '年度金額須為非負數且最多兩位小數。';end if;end if;
  end loop;
  insert into public.accounting_tax_profiles(year,organization,vat_method,accounting_standard,income_tax_method,conditions_confirmed,evidence,statement,updated_by)
  values(yr,p_payload->>'organization',p_payload->>'vat_method',p_payload->>'accounting_standard',p_payload->>'income_tax_method',coalesce((p_payload->>'conditions_confirmed')::boolean,false),p_payload->>'evidence',coalesce(p_payload->'statement','{}'),p_actor)
  on conflict(year) do update set organization=excluded.organization,vat_method=excluded.vat_method,accounting_standard=excluded.accounting_standard,income_tax_method=excluded.income_tax_method,conditions_confirmed=excluded.conditions_confirmed,evidence=excluded.evidence,statement=excluded.statement,row_version=accounting_tax_profiles.row_version+1,updated_by=p_actor,updated_at=now() returning to_jsonb(accounting_tax_profiles) into fresh;
  entity:='accounting_tax';id:=gen_random_uuid();
 elsif p_operation='tax_obligation_save' then
  select to_jsonb(t) into old from public.accounting_tax_obligations t where t.id=id for update;
  if id is not null and old is null or coalesce((old->>'row_version')::int,0)<>coalesce(ver,0) then raise exception '申報紀錄已更新。';end if;
  if nullif(p_payload->>'due_date','') is not null and coalesce(p_payload->>'due_source','') !~ '^https://[^/]+\.gov\.tw/' then raise exception '申報期限須附臺灣官方來源網址；尚未公告請留空。';end if;
  if p_payload->>'status' in ('filed','paid') and p_payload->>'applicability'<>'applicable' then raise exception '未確認適用條件不能標示已申報或已繳納。';end if;
  if jsonb_typeof(coalesce(p_payload->'adjustments','{}'))<>'object' then raise exception '申報核對格式不正確。';end if;
  if coalesce((p_payload->'adjustments'->>'reviewed')::boolean,false) then
   foreach k in array array['previous_credit','other_adjustments','additional_input_reversal'] loop
    v:=nullif(p_payload->'adjustments'->>k,'')::numeric;
    if v is null or v<0 or v>1e12 or v<>round(v,2) then raise exception '完成核對時須填妥前期留抵、依法減項與其他進項轉出金額；沒有時明確填0。';end if;
   end loop;
  end if;
  foreach k in array array['amount','paid'] loop
   v:=nullif(p_payload->>k,'')::numeric;if v is not null and (v<0 or v>1e12 or v<>round(v,2)) then raise exception '稅費金額須非負且最多兩位小數。';end if;
  end loop;
  if p_payload->>'status'='paid' and (nullif(p_payload->>'amount','') is null or (p_payload->>'amount')::numeric<>coalesce(nullif(p_payload->>'paid','')::numeric,0)) then raise exception '已繳納狀態須核對足額繳納金額。';end if;
  if id is not null and exists(select 1 from public.accounting_overhead_pools pool join public.accounting_overhead_allocations a on a.pool_id=pool.id where tax_obligation_id=id) then raise exception '此稅額已有專案分攤，請先解除分攤後更正。';end if;
  id:=coalesce(id,gen_random_uuid());
  insert into public.accounting_tax_obligations(id,year,kind,period_start,period_end,due_date,due_source,applicability,status,amount,paid,payment_date,evidence,adjustments,updated_by)
  values(id,yr,p_payload->>'kind',(p_payload->>'period_start')::date,(p_payload->>'period_end')::date,nullif(p_payload->>'due_date','')::date,coalesce(p_payload->>'due_source',''),p_payload->>'applicability',p_payload->>'status',nullif(p_payload->>'amount','')::numeric,coalesce(nullif(p_payload->>'paid','')::numeric,0),nullif(p_payload->>'payment_date','')::date,p_payload->>'evidence',coalesce(p_payload->'adjustments','{}'),p_actor)
  on conflict on constraint accounting_tax_obligations_pkey do update set year=excluded.year,kind=excluded.kind,period_start=excluded.period_start,period_end=excluded.period_end,due_date=excluded.due_date,due_source=excluded.due_source,applicability=excluded.applicability,status=excluded.status,amount=excluded.amount,paid=excluded.paid,payment_date=excluded.payment_date,evidence=excluded.evidence,adjustments=excluded.adjustments,row_version=accounting_tax_obligations.row_version+1,updated_by=p_actor,updated_at=now() returning to_jsonb(accounting_tax_obligations) into fresh;
  entity:='accounting_tax';
 elsif p_operation in ('cost_save','cost_void') then
  if p is null then raise exception '請選擇工作內容。';end if;
  select to_jsonb(t) into old from public.project_costs t where t.id=id and project_id=p for update;
  if id is not null and old is null or coalesce((old->>'row_version')::int,0)<>coalesce(ver,0) then raise exception '工程費用已更新。';end if;
  if old is not null and public.erp_private_json_visible_v1(old) is not true then raise exception using errcode='42501',message='沒有此費用憑證權限。';end if;
  if old->>'finance_voided_at' is not null then raise exception '已作廢費用請另建更正憑證。';end if;
  if p_operation='cost_void' then
   update public.project_costs set finance_voided_at=now(),row_version=row_version+1,updated_at=now(),updated_by=p_actor::text where project_costs.id=id returning to_jsonb(project_costs) into fresh;
  else
   if p_payload->>'category' not in ('subcontract','rental','equipment','transport','other_direct','stamp','nondeductible_vat','other_tax') then raise exception '材料與員工薪資由既有來源取得，不可重複新增。';end if;
   v:=(p_payload->>'amount')::numeric;if v is null or v<0 or v>1e12 or v<>round(v,2) then raise exception '費用金額不正確。';end if;
   if exists(select 1 from public.accounting_overhead_pools where evidence=p_payload->>'evidence') then raise exception '同一費用已有間接費用來源，不可重複列入。';end if;
   id:=coalesce(id,gen_random_uuid());
   insert into public.project_costs(id,project_id,cost_type,amount,occurred_on,note,source,updated_by,finance_category,finance_status,evidence_ref)
   values(id,p,'other',v,(p_payload->>'date')::date,coalesce(p_payload->>'note',''),'web',p_actor::text,p_payload->>'category',p_payload->>'status',p_payload->>'evidence')
   on conflict on constraint project_costs_pkey do update set amount=excluded.amount,occurred_on=excluded.occurred_on,note=excluded.note,finance_category=excluded.finance_category,finance_status=excluded.finance_status,evidence_ref=excluded.evidence_ref,row_version=project_costs.row_version+1,updated_at=now(),updated_by=p_actor::text returning to_jsonb(project_costs) into fresh;
  end if;entity:='accounting_project_cost';
 elsif p_operation='overhead_save' then
  select * into pool from public.accounting_overhead_pools t where t.id=id for update;old:=case when pool.id is not null then to_jsonb(pool) end;
  if id is not null and old is null or coalesce(pool.row_version,0)<>coalesce(ver,0) then raise exception '分攤來源已更新。';end if;
  if exists(select 1 from public.accounting_overhead_allocations a join public.projects w on w.id=a.project_id where a.pool_id=id and public.erp_private_json_visible_v1(to_jsonb(w)) is not true) then raise exception using errcode='42501',message='此來源包含未授權分攤，無法編輯。';end if;
  if exists(select 1 from public.project_costs where evidence_ref=p_payload->>'evidence' and finance_voided_at is null) then raise exception '同一憑證已列為直接成本。';end if;
  v:=(p_payload->>'amount')::numeric;if v is null or v<0 or v>1e12 or v<>round(v,2) then raise exception '費用金額不正確。';end if;
  if p_payload->>'category'='cit' then
   perform 1 from public.accounting_tax_obligations t join public.accounting_tax_profiles pr on pr.year=t.year where t.id=(p_payload->>'tax_obligation_id')::uuid and t.year=yr and t.kind='cit' and t.applicability='applicable' and t.amount=v and t.status in ('estimated','filed','paid') and (t.status<>'estimated' or pr.conditions_confirmed) for update of t;
   if not found then raise exception '所得稅分攤須連結同年度已確認的公司稅額來源，金額必須一致。';end if;
  end if;
  denominator:=(p_payload->>'denominator')::numeric;
  if denominator is null or denominator<=0 or denominator>1e15 or length(btrim(coalesce(p_payload->>'rationale','')))<2 or length(btrim(coalesce(p_payload->>'label','')))<1 then raise exception '請填寫分攤母數、項目與核准依據。';end if;
  if jsonb_typeof(p_payload->'allocations')<>'array' or jsonb_array_length(p_payload->'allocations')>300 then raise exception '分攤明細格式不正確。';end if;
  id:=coalesce(id,gen_random_uuid());
  insert into public.accounting_overhead_pools(id,year,category,label,amount,evidence,status,method,rationale,denominator,tax_obligation_id,updated_by)
  values(id,yr,p_payload->>'category',p_payload->>'label',v,p_payload->>'evidence',p_payload->>'status',p_payload->>'method',p_payload->>'rationale',denominator,nullif(p_payload->>'tax_obligation_id','')::uuid,p_actor)
  on conflict on constraint accounting_overhead_pools_pkey do update set year=excluded.year,category=excluded.category,label=excluded.label,amount=excluded.amount,evidence=excluded.evidence,status=excluded.status,method=excluded.method,rationale=excluded.rationale,denominator=excluded.denominator,tax_obligation_id=excluded.tax_obligation_id,row_version=accounting_overhead_pools.row_version+1,updated_by=p_actor,updated_at=now();
  update public.accounting_overhead_pools pp set tax_source_version=t.row_version,tax_profile_version=pr.row_version from public.accounting_tax_obligations t join public.accounting_tax_profiles pr on pr.year=t.year where pp.id=id and pp.tax_obligation_id=t.id;
  delete from public.accounting_overhead_allocations where pool_id=id;
  raw_total:=0;for row in select * from jsonb_array_elements(p_payload->'allocations') loop
   amount:=(row->>'basis_quantity')::numeric;if amount is null or amount<=0 then raise exception '分攤依據量須大於零。';end if;raw_total:=raw_total+amount;
  end loop;
  if raw_total>denominator then raise exception '分攤依據總量不可超過母數，不可重複分攤。';end if;
  -- Largest remainder rounding conserves the rounded allocated total, never exceeds the pool.
  for row in with rows as(select (x->>'project_id')::uuid project_id,(x->>'basis_quantity')::numeric weight from jsonb_array_elements(p_payload->'allocations') x),
   cents as(select *,v*100*weight/denominator raw from rows), ranked as(select *,row_number() over(order by raw-floor(raw) desc,project_id) rn from cents)
   select to_jsonb(t) from (select project_id,weight,(floor(raw)+case when rn<=round(v*100*raw_total/denominator)-sum(floor(raw)) over() then 1 else 0 end)/100 allocated from ranked)t loop
   perform public.work_content_report_v1(p_actor,(row->>'project_id')::uuid,null,null,null,true);
   insert into public.accounting_overhead_allocations values(id,(row->>'project_id')::uuid,(row->>'allocated')::numeric,(row->>'weight')::numeric);
  end loop;
  select to_jsonb(t)||jsonb_build_object('denominator',denominator,'allocations',coalesce((select jsonb_agg(to_jsonb(a)) from public.accounting_overhead_allocations a where pool_id=id),'[]')) into fresh from public.accounting_overhead_pools t where t.id=id;
  entity:='accounting_overhead';
 else
  if p is null then raise exception '請選擇工作內容。';end if;
  select to_jsonb(t) into old from public.accounting_project_finance_policy t where project_id=p for update;
  if coalesce((old->>'row_version')::int,0)<>coalesce(ver,0) then raise exception '工程核對狀態已更新。';end if;
  insert into public.accounting_project_finance_policy(project_id,materials_reviewed,direct_costs_complete,overhead_complete,taxes_complete,revenue_complete,evidence,updated_by)
  values(p,coalesce((p_payload->>'materials_reviewed')::boolean,false),coalesce((p_payload->>'direct_costs_complete')::boolean,false),coalesce((p_payload->>'overhead_complete')::boolean,false),coalesce((p_payload->>'taxes_complete')::boolean,false),coalesce((p_payload->>'revenue_complete')::boolean,false),p_payload->>'evidence',p_actor)
  on conflict(project_id) do update set materials_reviewed=excluded.materials_reviewed,direct_costs_complete=excluded.direct_costs_complete,overhead_complete=excluded.overhead_complete,taxes_complete=excluded.taxes_complete,revenue_complete=excluded.revenue_complete,evidence=excluded.evidence,row_version=accounting_project_finance_policy.row_version+1,updated_by=p_actor,updated_at=now() returning to_jsonb(accounting_project_finance_policy) into fresh;
  entity:='accounting_project_policy';id:=p;
 end if;
 insert into public.accounting_finance_history(module,entity_id,action,before_data,after_data,actor_id) values(entity,id,p_operation,old,fresh,p_actor);
 insert into public.audit_logs(entity_type,entity_id,action,source,actor) values('accounting',id,'update','web',(select username from public.app_users where app_users.id=p_actor));
 result:=jsonb_build_object('id',id,'row_version',fresh->'row_version');
 insert into public.accounting_finance_requests values(p_actor,req,p_operation,fp,result,now());return result;
end $$;

create function public.accounting_receipt_unit_net_v1(p_receipt uuid) returns numeric
language sql stable security invoker set search_path='' as $$
 with source as(select r.*,d.receipt_tax_mode,d.receipt_tax_rate_basis_points,d.receipt_discount_amount from public.stock_receipts r
 join public.stock_transaction_documents d on d.kind='receipt' and d.id=r.receipt_document_id where r.id=p_receipt),
 sums as(select s.id,s.unit_price,s.quantity,
 public.receipt_money_totals_v2(jsonb_agg(jsonb_build_object('quantity',r.quantity,'unit_price',r.unit_price)),s.receipt_tax_mode,s.receipt_tax_rate_basis_points,coalesce(s.receipt_discount_amount,0)) totals,
 sum(round(r.quantity*r.unit_price,0)) subtotal
 from source s join public.stock_receipts r on r.receipt_document_id=s.receipt_document_id
 group by s.id,s.unit_price,s.quantity,s.receipt_tax_mode,s.receipt_tax_rate_basis_points,s.receipt_discount_amount)
 select case when subtotal=0 and totals->>'net_amount' is not null then 0 when quantity>0 then (totals->>'net_amount')::numeric * round(quantity*unit_price,0) / nullif(subtotal,0) / quantity end from sums;
$$;
-- Preserve the current shared report; only replace its net unit valuation expression.
do $$ declare definition text; old_expression text:='case when d.receipt_tax_mode=''inclusive'' then round(s.unit_price*10000/(10000+d.receipt_tax_rate_basis_points),2) else s.unit_price end unit_price';begin
 select pg_get_functiondef('public.work_content_report_v1(uuid,uuid,date,date,text,boolean)'::regprocedure) into definition;
 if position(old_expression in definition)=0 then raise exception 'Shared report cost expression changed; review migration before applying';end if;
 execute replace(definition,old_expression,'public.accounting_receipt_unit_net_v1(s.id) unit_price');
end $$;

-- Workflow 20261031075010 freezes cable cost at issue time. Future snapshots
-- must use the same discounted net receipt valuation as the shared report.
-- Never rewrite existing snapshots: they retain their original source basis.
do $$ declare definition text; old_expression text:='(case when d.receipt_tax_mode=''inclusive'' then round(r.unit_price*10000/(10000+d.receipt_tax_rate_basis_points),2) else r.unit_price end)/coalesce(r.meters_per_unit_snapshot,1)';begin
 if to_regprocedure('public.cable_reference_cost_snapshot_v1(uuid,uuid,uuid)') is null then
  raise exception 'Cable snapshot prerequisite is missing; apply reviewed workflow release first';
 end if;
 select pg_get_functiondef('public.cable_reference_cost_snapshot_v1(uuid,uuid,uuid)'::regprocedure) into definition;
 if position(old_expression in definition)=0 then raise exception 'Cable snapshot cost expression changed; review migration before applying';end if;
 execute replace(definition,old_expression,'public.accounting_receipt_unit_net_v1(r.id)/coalesce(r.meters_per_unit_snapshot,1)');
end $$;

create function public.accounting_analysis_money_json_v1(p_data jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$ declare result jsonb;begin
 if jsonb_typeof(p_data)='object' then
 select coalesce(jsonb_object_agg(key,case when jsonb_typeof(value)='number' and key !~ '(count|Count|version|year|^period$|denominator|quantity|Quantity|days|Days|records|headcount|meters_per_unit|basis_points)' then to_jsonb(value#>>'{}') else public.accounting_analysis_money_json_v1(value) end),'{}') into result from jsonb_each(p_data);
 elsif jsonb_typeof(p_data)='array' then select coalesce(jsonb_agg(public.accounting_analysis_money_json_v1(value) order by ordinality),'[]') into result from jsonb_array_elements(p_data) with ordinality;
 else return p_data;end if;return result;end $$;

create function public.accounting_analysis_read_v1(p_actor uuid,p_mode text,p_year integer default 2026,p_project uuid default null) returns jsonb
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
 invoices as(select i.*,(select count(*) from public.quotation_invoices x where x.status='active' and x.canonical_invoice_id is null and public.accounting_invoice_identity_v1(x.invoice_number,x.invoice_date)=public.accounting_invoice_identity_v1(i.invoice_number,i.invoice_date)) identity_count from public.quotation_invoices i join public.quotations q on q.id=i.quotation_id where i.status='active' and i.canonical_invoice_id is null and public.erp_private_json_visible_v1(to_jsonb(q))),
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

do $$ declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where proname in ('accounting_analysis_assert_v1','accounting_analysis_command_v1','accounting_analysis_read_v1','accounting_cit_estimate_v1','accounting_receipt_unit_net_v1','accounting_analysis_money_json_v1') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);end loop;
end $$;
notify pgrst,'reload schema';
commit;
