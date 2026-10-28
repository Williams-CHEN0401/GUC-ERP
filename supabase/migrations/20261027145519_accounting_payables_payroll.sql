begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Finance uses the existing app_users / role_permissions model and master suppliers.
do $$ declare c text; begin
 select pg_get_constraintdef(oid) into c from pg_constraint where conrelid='public.role_permissions'::regclass and conname='role_permissions_module_check';
 if c is null then raise exception 'Missing role permission constraint'; end if;
 alter table public.role_permissions drop constraint role_permissions_module_check;
 execute 'alter table public.role_permissions add constraint role_permissions_module_check '||replace(c,'''performance''::text','''performance''::text, ''accounting_payables''::text, ''accounting_payroll''::text');
end $$;
alter table public.app_users add column payroll_excluded boolean not null default false;
-- One-time identification of the two existing users; subsequent checks use the flag and stable FK.
update public.app_users set payroll_excluded=true where display_name in ('老闆','老闆娘');

create table public.supplier_payment_terms (
 supplier_id uuid not null references public.suppliers(id), effective_month date not null check(extract(day from effective_month)=1),
 closing_day integer not null check(closing_day between 1 and 31), payment_day integer not null check(payment_day between 1 and 31),
 payment_month_offset integer not null default 1 check(payment_month_offset between 0 and 3),
 row_version integer not null default 1, updated_by uuid not null references public.app_users(id), updated_at timestamptz not null default now(),
 primary key(supplier_id,effective_month)
);
create index supplier_payment_terms_actor_idx on public.supplier_payment_terms(updated_by);
create table public.accounting_payroll (
 id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.app_users(id),
 month date not null check(extract(day from month)=1), input jsonb not null, calculation jsonb not null,
 deleted_at timestamptz, row_version integer not null default 1, created_by uuid not null references public.app_users(id),
 updated_by uuid not null references public.app_users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index accounting_payroll_employee_month_idx on public.accounting_payroll(employee_id,month) where deleted_at is null;
create index accounting_payroll_month_idx on public.accounting_payroll(month) where deleted_at is null;
create index accounting_payroll_created_idx on public.accounting_payroll(created_by);
create index accounting_payroll_updated_idx on public.accounting_payroll(updated_by);
create table public.accounting_finance_history (
 id bigint generated always as identity primary key, module text not null, entity_id uuid not null,
 action text not null, before_data jsonb, after_data jsonb, actor_id uuid not null references public.app_users(id), created_at timestamptz not null default now()
);
create index accounting_finance_history_entity_idx on public.accounting_finance_history(module,entity_id,id);
create index accounting_finance_history_actor_idx on public.accounting_finance_history(actor_id);
create table public.accounting_finance_requests (
 actor_id uuid not null references public.app_users(id), request_id uuid not null, operation text not null,
 fingerprint text not null, result jsonb not null, created_at timestamptz not null default now(), primary key(actor_id,request_id)
);
do $$ declare t text; begin
 foreach t in array array['supplier_payment_terms','accounting_payroll','accounting_finance_history','accounting_finance_requests'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $$;
grant usage,select on sequence public.accounting_finance_history_id_seq to service_role;

create function public.accounting_finance_assert_v1(p_actor uuid,p_module text,p_action text default 'VIEW') returns void
language plpgsql security invoker set search_path='' as $$ begin
 if p_module not in ('accounting_payables','accounting_payroll') or not public.has_app_permission_v1(p_actor,p_module,'VIEW')
 or not public.has_app_permission_v1(p_actor,p_module,p_action) then raise exception using message='沒有此會計資料操作權限。',errcode='42501';end if;
end $$;

create function public.accounting_month_day_v1(p_month date,p_day integer) returns date
language sql immutable security invoker set search_path='' as $$
 select (date_trunc('month',p_month)::date + least(p_day,extract(day from date_trunc('month',p_month)+interval '1 month -1 day')::int)-1);
$$;

create function public.accounting_payables_v1(p_actor uuid,p_month date,p_supplier uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb; begin
 perform public.accounting_finance_assert_v1(p_actor,'accounting_payables');
 if p_month is null or extract(day from p_month)<>1 then raise exception '請選擇結帳月份。';end if;
 perform public.erp_private_prepare_v1(p_actor);
 with terms as (
 select s.id,s.name,t.effective_month,t.row_version,coalesce(t.closing_day,31) closing_day,coalesce(t.payment_day,31) payment_day,
 coalesce(t.payment_month_offset,1) payment_month_offset,
 public.accounting_month_day_v1((p_month-interval '1 month')::date,coalesce(prev.closing_day,t.closing_day,31))+1 date_from,
 public.accounting_month_day_v1(p_month,coalesce(t.closing_day,31)) date_to
 from public.suppliers s
 left join lateral (select * from public.supplier_payment_terms where supplier_id=s.id and effective_month<=p_month order by effective_month desc limit 1) t on true
 left join lateral (select closing_day from public.supplier_payment_terms where supplier_id=s.id and effective_month<p_month order by effective_month desc limit 1) prev on true
 where p_supplier is null or s.id=p_supplier
 ), documents as (
 select t.id supplier_id,coalesce(r.receipt_document_id,r.id) id,'receipt' kind,min(r.receipt_date) date,min(r.receipt_document_no) document_no,
 public.receipt_money_totals_v2(jsonb_agg(jsonb_build_object('quantity',r.quantity,'unit_price',r.unit_price)),d.receipt_tax_mode,d.receipt_tax_rate_basis_points,coalesce(d.receipt_discount_amount,0)) financials,
 jsonb_agg(jsonb_build_object('item_name',i.item_name,'quantity',r.quantity,'unit_price',r.unit_price) order by r.receipt_line_no,r.id) lines
 from terms t join public.stock_receipts r on r.supplier_id=t.id and r.receipt_date between t.date_from and t.date_to
 left join public.stock_transaction_documents d on d.kind='receipt' and d.id=r.receipt_document_id
 left join public.inventory_items i on i.id=r.inventory_item_id
 where r.quantity>0 and public.erp_private_json_visible_v1(to_jsonb(r)) and public.erp_private_json_visible_v1(to_jsonb(d))
 group by t.id,coalesce(r.receipt_document_id,r.id),d.receipt_tax_mode,d.receipt_tax_rate_basis_points,d.receipt_discount_amount
 union all
 select t.id,r.id,'return',r.return_date,d.document_no,
 public.receipt_money_totals_v2(jsonb_agg(jsonb_build_object('quantity',l.quantity,'unit_price',l.unit_price)),r.tax_mode,r.tax_rate_basis_points,r.discount_amount),
 jsonb_agg(jsonb_build_object('item_name',i.item_name,'quantity',l.quantity,'unit_price',l.unit_price) order by l.line_no)
 from terms t join public.supplier_return_documents r on r.supplier_id=t.id and r.return_date between t.date_from and t.date_to and r.deleted_at is null
 join public.supplier_return_lines l on l.document_id=r.id left join public.inventory_items i on i.id=l.inventory_item_id
 join public.stock_transaction_documents d on d.kind='supplier_return' and d.id=r.id
 where public.erp_private_json_visible_v1(to_jsonb(r)) and public.erp_private_json_visible_v1(to_jsonb(d))
 group by t.id,r.id,d.document_no
 ), rows as (
 select t.*,public.accounting_month_day_v1((p_month+make_interval(months=>t.payment_month_offset))::date,t.payment_day) payment_date,
 case when p_supplier is null then '[]'::jsonb else coalesce((select jsonb_agg(to_jsonb(d)-'supplier_id' order by d.date,d.id) from documents d where d.supplier_id=t.id),'[]') end documents,
 (select count(*) from documents d where d.supplier_id=t.id and d.financials->>'total_amount' is null) incomplete_count,
 coalesce((select sum((d.financials->>'total_amount')::numeric) from documents d where d.supplier_id=t.id and kind='receipt'),0) purchases,
 coalesce((select sum((d.financials->>'total_amount')::numeric) from documents d where d.supplier_id=t.id and kind='return'),0) returns,
 coalesce((select sum((case when kind='receipt' then 1 else -1 end)*(d.financials->>'net_amount')::numeric) from documents d where d.supplier_id=t.id),0) net_amount,
 coalesce((select sum((case when kind='receipt' then 1 else -1 end)*(d.financials->>'tax_amount')::numeric) from documents d where d.supplier_id=t.id),0) tax_amount
 from terms t
 ) select jsonb_build_object('month',p_month,'suppliers',coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('payable',case when incomplete_count=0 then purchases-returns else null end) order by r.name),'[]')) into result from rows r;
 return result;
end $$;

-- Exact NUMERIC arithmetic. Monthly normal wage includes regular allowances; overtime is daily, never monthly buckets.
create function public.accounting_payroll_calculate_v1(p_month date,p_input jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare k text; v numeric; wage numeric; hourly numeric; gross numeric; net numeric; ot numeric:=0; h numeric; units numeric; days integer;
 labor numeric:=0; employment numeric:=0; health numeric:=0; pension numeric:=0; employer_pension numeric:=0;
 labor_base numeric; health_base numeric; pension_base numeric; kind text; row jsonb; rows jsonb:='[]'; seen text[]:='{}';
 ot_hours numeric:=0; warnings jsonb:='[]'; overrides jsonb; reason text;
begin
 if p_month is null or extract(day from p_month)<>1 or extract(year from p_month)<>2026 then raise exception '目前試算採 2026 年規則，請選擇 2026 年薪資月份。';end if;
 if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input) x where x not in
 ('base_salary','position_allowance','other_wage','bonus','tax_withheld','other_deductions','deduction_reason','labor_kind','labor_base','insurance_days','health_kind','health_base','dependents','pension_base','pension_percent','overtime','overrides','adjustment_reason','notes')) then raise exception '薪資欄位不正確。';end if;
 foreach k in array array['base_salary','position_allowance','other_wage','bonus','tax_withheld','other_deductions','labor_base','health_base','pension_base','pension_percent','insurance_days','dependents'] loop
  if jsonb_typeof(p_input->k) is distinct from 'number' then raise exception '請填寫所有薪資及投保數字欄位：%',k;end if;
  v:=(p_input->>k)::numeric;
  if v<0 or v>10000000 or v<>round(v,2) then raise exception '薪資數字須為非負金額，最多小數二位。';end if;
 end loop;
 if length(coalesce(p_input->>'notes',''))>2000 or length(coalesce(p_input->>'adjustment_reason',''))>2000 then raise exception '備註過長。';end if;
 days:=(p_input->>'insurance_days')::integer;
 if days not between 0 and 30 or days::numeric<>(p_input->>'insurance_days')::numeric or (p_input->>'dependents')::numeric not between 0 and 20 or (p_input->>'dependents')::numeric<>trunc((p_input->>'dependents')::numeric)
 or (p_input->>'pension_percent')::numeric>6 then raise exception '投保日數須 0～30 整數、眷屬須 0～20 整數，自提率須 0～6%%。';end if;
 wage:=(p_input->>'base_salary')::numeric+(p_input->>'position_allowance')::numeric+(p_input->>'other_wage')::numeric;
 hourly:=wage/240;
 if wage<=0 then raise exception '正常工時月工資須大於零。';end if;
 if wage<29500 then warnings:=warnings||'"正常工時月工資低於 2026 年全時最低工資 29,500 元；請確認是否為部分月份或部分工時，特殊工時應人工核對。"'::jsonb;end if;
 if jsonb_typeof(p_input->'overtime') is distinct from 'array' or jsonb_array_length(p_input->'overtime')>31 then raise exception '請按日填寫加班，最多 31 筆。';end if;
 for row in select * from jsonb_array_elements(p_input->'overtime') loop
  if jsonb_typeof(row) is distinct from 'object' or coalesce(row->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception '加班日期須使用 YYYY-MM-DD 格式。';end if;
  if row->>'date' is null or (row->>'date')::date<p_month or (row->>'date')::date>=p_month+interval '1 month' or row->>'date'=any(seen) then raise exception '加班日期須在當月且不可重複，請合併同日工時。';end if;
  seen:=array_append(seen,row->>'date');kind:=row->>'kind';h:=(row->>'hours')::numeric;
  if jsonb_typeof(row->'hours') is distinct from 'number' or h<=0 or h<>round(h,2) or h>12 or kind is null or kind not in ('weekday','rest','holiday') or (kind='weekday' and h>4) then raise exception '加班類型或時數不正確；平日最多 4 小時，休息日／休假日最多 12 小時。';end if;
  if kind='weekday' then units:=least(h,2)*4+greatest(h-2,0)*5;
  elsif kind='rest' then units:=least(h,2)*4+greatest(least(h-2,6),0)*5+greatest(h-8,0)*8;
  else units:=24+greatest(least(h-8,2),0)*4+greatest(h-10,0)*5;end if;
  ot:=ot+wage*units;ot_hours:=ot_hours+case when kind='holiday' then greatest(h-8,0) else h end;
  rows:=rows||jsonb_build_array(row||jsonb_build_object('amount',round(wage*units/720,2)));
 end loop;
 -- Round the final overtime upward to a whole dollar so wage is never rounded below the minimum.
 ot:=ceil(ot/720);
 if ot_hours>46 then warnings:=warnings||'"本月延長工時超過一般 46 小時上限，請核對適用的法定程序及工時限制。"'::jsonb;end if;
 labor_base:=(p_input->>'labor_base')::numeric;health_base:=(p_input->>'health_base')::numeric;pension_base:=(p_input->>'pension_base')::numeric;
 kind:=p_input->>'labor_kind';
 if kind is null or kind not in ('both','labor_only','employment_only','none') then raise exception '請選擇勞就保身分。';end if;
 if kind<>'none' and (labor_base<=0 or labor_base>45800) then raise exception '勞就保月投保薪資須大於 0 且不超過 45,800 元，請依核定級距填寫。';end if;
 if kind in ('both','labor_only') then labor:=round(labor_base*(case when kind='both' then 0.115 else 0.125 end)*0.2*days/30);end if;
 if kind in ('both','employment_only') then employment:=round(labor_base*0.01*0.2*days/30);end if;
 if p_input->>'health_kind' is null or p_input->>'health_kind' not in ('employee','elsewhere') then raise exception '請選擇健保身分。';end if;
 if p_input->>'health_kind'='employee' then
  if health_base<29500 or health_base>313000 then raise exception '健保月投保金額須為 29,500～313,000 元，請依核定級距填寫。';end if;
  health:=round(health_base*0.0517*0.3)*(1+least((p_input->>'dependents')::int,3));
 end if;
 if pension_base<=0 or pension_base>150000 then raise exception '勞退月提繳工資須大於 0 且不超過 150,000 元。';end if;
 pension:=round(pension_base*(p_input->>'pension_percent')::numeric/100*days/30);employer_pension:=round(pension_base*0.06*days/30);
 overrides:=coalesce(p_input->'overrides','{}');reason:=btrim(coalesce(p_input->>'adjustment_reason',''));
 if jsonb_typeof(overrides)<>'object' or exists(select 1 from jsonb_object_keys(overrides) x where x not in ('labor','employment','health')) then raise exception '僅可調整勞保、就保、健保扣款。';end if;
 for k in select jsonb_object_keys(overrides) loop
  if jsonb_typeof(overrides->k) is distinct from 'number' or (overrides->>k)::numeric<0 or (overrides->>k)::numeric>1000000 or (overrides->>k)::numeric<>trunc((overrides->>k)::numeric) or length(reason)<2 then raise exception '人工調整扣款須為非負整數並填寫調整原因。';end if;
 end loop;
 if (p_input->>'other_deductions')::numeric>0 and length(btrim(coalesce(p_input->>'deduction_reason','')))<2 then raise exception '其他扣款須填寫項目及依據。';end if;
 gross:=round(wage+(p_input->>'bonus')::numeric+ot,2);
 net:=gross-coalesce((overrides->>'labor')::numeric,labor)-coalesce((overrides->>'employment')::numeric,employment)-coalesce((overrides->>'health')::numeric,health)-pension-(p_input->>'tax_withheld')::numeric-(p_input->>'other_deductions')::numeric;
 if net<0 then raise exception '扣款超過應發金額，請檢查。';end if;
 return jsonb_build_object('rules_version','TW-2026-v1','normal_wage',wage,'hourly_wage',round(hourly,6),'overtime',ot,'overtime_lines',rows,'overtime_hours',ot_hours,
 'insurance_estimate',jsonb_build_object('labor',labor,'employment',employment,'health',health),'labor',coalesce((overrides->>'labor')::numeric,labor),'employment',coalesce((overrides->>'employment')::numeric,employment),'health',coalesce((overrides->>'health')::numeric,health),
 'employee_pension',pension,'employer_pension',employer_pension,'gross',gross,'deductions',gross-net,'net',net,'warnings',warnings);
end $$;

create function public.accounting_finance_read_v1(p_actor uuid,p_module text,p_month date,p_id uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$ declare result jsonb; begin
 perform public.accounting_finance_assert_v1(p_actor,p_module);
 if p_module='accounting_payables' then return public.accounting_payables_v1(p_actor,p_month,p_id);end if;
 if p_month is null or extract(day from p_month)<>1 then raise exception '請選擇薪資月份。';end if;
 return jsonb_build_object('month',p_month,
 'employees',coalesce((select jsonb_agg(jsonb_build_object('id',id,'display_name',display_name) order by display_name) from public.app_users where is_active and not payroll_excluded),'[]'),
 'records',coalesce((select jsonb_agg(to_jsonb(p)||jsonb_build_object('employee_name',u.display_name) order by u.display_name) from public.accounting_payroll p join public.app_users u on u.id=p.employee_id where p.month=p_month and p.deleted_at is null and (p_id is null or p.id=p_id)),'[]'),
 'history',case when p_id is null then '[]'::jsonb else coalesce((select jsonb_agg(to_jsonb(h) order by id desc) from public.accounting_finance_history h where h.module='accounting_payroll' and h.entity_id=p_id),'[]') end);
end $$;

create function public.accounting_finance_command_v1(p_actor uuid,p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
#variable_conflict use_variable
declare module text; action text; request uuid; fingerprint text; prior public.accounting_finance_requests; old jsonb; result jsonb; newrow jsonb;
 id uuid; employee uuid; month date; version integer; calculation jsonb; payroll public.accounting_payroll; terms public.supplier_payment_terms;
begin
 module:=case when p_operation='terms_save' then 'accounting_payables' else 'accounting_payroll' end;
 action:=case p_operation when 'payroll_create' then 'CREATE' when 'payroll_delete' then 'DELETE' when 'payroll_calculate' then 'VIEW' else 'UPDATE' end;
 perform public.accounting_finance_assert_v1(p_actor,module,action);
 if p_operation='payroll_calculate' then return public.accounting_payroll_calculate_v1((p_payload->>'month')::date,p_payload->'input');end if;
 if p_operation not in ('terms_save','payroll_create','payroll_update','payroll_delete') then raise exception '不支援的會計操作。';end if;
 request:=(p_payload->>'request_id')::uuid;
 if request is null then raise exception '缺少操作識別。';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text||request::text,0));
 fingerprint:=md5(p_payload::text);
 select * into prior from public.accounting_finance_requests where actor_id=p_actor and request_id=request;
 if found then if prior.operation<>p_operation or prior.fingerprint<>fingerprint then raise exception '操作識別已使用，請重新讀取。';end if;return prior.result;end if;
 month:=(p_payload->>'month')::date;version:=(p_payload->>'row_version')::integer;
 if p_operation='terms_save' then
  id:=(p_payload->>'supplier_id')::uuid;
  if (p_payload->>'payment_month_offset')::int=0 and (p_payload->>'payment_day')::int<(p_payload->>'closing_day')::int then
   raise exception '當月付款日不可早於結帳日，請改選結帳後月份。';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('terms:'||id::text,0));
  select * into terms from public.supplier_payment_terms where supplier_id=id and effective_month=month for update;
  old:=case when found then to_jsonb(terms) else null end;
  if terms.row_version is distinct from version then raise exception '供應商設定已變更，請重新讀取。';end if;
  insert into public.supplier_payment_terms(supplier_id,effective_month,closing_day,payment_day,payment_month_offset,updated_by)
  values(id,month,(p_payload->>'closing_day')::int,(p_payload->>'payment_day')::int,(p_payload->>'payment_month_offset')::int,p_actor)
  on conflict(supplier_id,effective_month) do update set closing_day=excluded.closing_day,payment_day=excluded.payment_day,payment_month_offset=excluded.payment_month_offset,updated_by=p_actor,updated_at=now(),row_version=supplier_payment_terms.row_version+1 returning to_jsonb(supplier_payment_terms) into newrow;
 else
  if p_operation='payroll_create' then
   employee:=(p_payload->>'employee_id')::uuid;
   if not exists(select 1 from public.app_users where app_users.id=employee and is_active and not payroll_excluded) then raise exception '此使用者不在薪資適用名單。';end if;
   calculation:=public.accounting_payroll_calculate_v1(month,p_payload->'input');
   insert into public.accounting_payroll(employee_id,month,input,calculation,created_by,updated_by) values(employee,month,p_payload->'input',calculation,p_actor,p_actor) returning * into payroll;
   id:=payroll.id;newrow:=to_jsonb(payroll);
  else
   id:=(p_payload->>'id')::uuid;
   select * into payroll from public.accounting_payroll where accounting_payroll.id=id and deleted_at is null for update;
   if not found then raise exception '找不到薪資紀錄。';end if;
   if payroll.row_version is distinct from version then raise exception '薪資已被其他人修改，請重新讀取。';end if;
   old:=to_jsonb(payroll);
   if p_operation='payroll_delete' then
    if length(btrim(coalesce(p_payload->>'reason','')))<2 then raise exception '刪除薪資須填寫原因。';end if;
    update public.accounting_payroll set deleted_at=now(),row_version=row_version+1,updated_at=now(),updated_by=p_actor where accounting_payroll.id=id returning to_jsonb(accounting_payroll) into newrow;
    newrow:=newrow||jsonb_build_object('delete_reason',p_payload->>'reason');
   else
    if exists(select 1 from public.app_users where app_users.id=payroll.employee_id and payroll_excluded) then raise exception '此使用者不在薪資適用名單。';end if;
    calculation:=public.accounting_payroll_calculate_v1(payroll.month,p_payload->'input');
    update public.accounting_payroll set input=p_payload->'input',calculation=calculation,row_version=row_version+1,updated_at=now(),updated_by=p_actor where accounting_payroll.id=id returning to_jsonb(accounting_payroll) into newrow;
   end if;
  end if;
 end if;
 insert into public.accounting_finance_history(module,entity_id,action,before_data,after_data,actor_id) values(module,id,p_operation,old,newrow,p_actor);
 -- The general ERP audit contains no salary values; detailed history is finance-restricted.
 insert into public.audit_logs(entity_type,entity_id,action,source,actor) values(module,id,case when p_operation='payroll_create' then 'insert' when p_operation='payroll_delete' then 'delete' else 'update' end,'web',(select username from public.app_users where app_users.id=p_actor));
 result:=jsonb_build_object('id',id,'row_version',newrow->'row_version');
 insert into public.accounting_finance_requests(actor_id,request_id,operation,fingerprint,result) values(p_actor,request,p_operation,fingerprint,result);
 return result;
end $$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
 ('accounting_finance_assert_v1','accounting_month_day_v1','accounting_payables_v1','accounting_payroll_calculate_v1','accounting_finance_read_v1','accounting_finance_command_v1') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
