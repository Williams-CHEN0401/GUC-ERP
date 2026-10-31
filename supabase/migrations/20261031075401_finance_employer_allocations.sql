begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create or replace function public.accounting_payroll_calculate_v1(p_month date,p_input jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare k text; v numeric; wage numeric; hourly numeric; gross numeric; net numeric; ot numeric:=0; h numeric; units numeric; days integer;
 labor numeric:=0; employment numeric:=0; health numeric:=0; pension numeric:=0; employer_pension numeric:=0;
 labor_base numeric; health_base numeric; pension_base numeric; kind text; row jsonb; rows jsonb:='[]'; seen text[]:='{}';
 employer_labor numeric:=0; employer_employment numeric:=0; employer_health numeric:=0; occupational numeric; employer_total numeric; missing jsonb:='[]'; occupational_status text; pension_status text;
 ot_hours numeric:=0; warnings jsonb:='[]'; overrides jsonb; reason text;
begin
 if p_month is null or extract(day from p_month)<>1 or extract(year from p_month)<>2026 then raise exception '目前試算採 2026 年規則，請選擇 2026 年薪資月份。';end if;
 if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input) x where x not in
 ('base_salary','position_allowance','other_wage','bonus','tax_withheld','other_deductions','deduction_reason','labor_kind','labor_base','insurance_days','health_kind','health_base','dependents','pension_base','pension_percent','overtime','overrides','adjustment_reason','notes','occupational_status','occupational_base','occupational_rate_percent','pension_status')) then raise exception '薪資欄位不正確。';end if;
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
 if kind in ('both','labor_only') then labor:=round(labor_base*0.115*0.2*days/30);end if;
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
 -- Employer charges are distinct from deductions; company supplement is calculated once per company/month.
 if kind in ('both','labor_only') then employer_labor:=round(labor_base*0.115*0.7*days/30);end if;
 if kind in ('both','employment_only') then employer_employment:=round(labor_base*0.01*0.7*days/30);end if;
 if p_input->>'health_kind'='employee' then employer_health:=round(health_base*0.0517*0.6*1.56);end if;
 occupational_status:=coalesce(p_input->>'occupational_status','unknown');
 pension_status:=coalesce(p_input->>'pension_status','applicable');

 if occupational_status not in ('unknown','applicable','exempt') or pension_status not in ('unknown','applicable','exempt') then raise exception '雇主負擔適用身分不正確。';end if;
 if (occupational_status='exempt' or pension_status='exempt') and length(btrim(coalesce(p_input->>'notes','')))<2 then raise exception '選擇職災或新制勞退不適用時，請在備註記錄適用依據。';end if;
 if occupational_status='applicable' then
  if jsonb_typeof(p_input->'occupational_base') is distinct from 'number' or jsonb_typeof(p_input->'occupational_rate_percent') is distinct from 'number' then raise exception '請填核定職災投保金額及費率。';end if;
  if (p_input->>'occupational_base')::numeric not between 29500 and 72800 or (p_input->>'occupational_base')::numeric<>trunc((p_input->>'occupational_base')::numeric)
    or (p_input->>'occupational_rate_percent')::numeric not between 0.01 and 10 or (p_input->>'occupational_rate_percent')::numeric<>round((p_input->>'occupational_rate_percent')::numeric,4) then raise exception '請核對職災核定級距（29,500～72,800）及完整百分比費率。';end if;
  occupational:=round((p_input->>'occupational_base')::numeric*(p_input->>'occupational_rate_percent')::numeric/100*days/30);
 elsif occupational_status='exempt' then occupational:=0;
 else missing:=missing||'"職災保險適用身分及核定費率"'::jsonb;end if;
 if pension_status='exempt' then
  if (p_input->>'pension_percent')::numeric<>0 then raise exception '未適用新制勞退時不可計入員工自提。';end if;
  employer_pension:=0;
 elsif pension_status='unknown' then employer_pension:=null;missing:=missing||'"雇主勞退適用身分"'::jsonb;end if;
 employer_total:=employer_labor+employer_employment+employer_health+occupational+employer_pension;
 warnings:=warnings||'"雇主費用為 2026 年一般受僱試算，請依實際投保核定級距、職災費率及繳款單核對。公司補充保費與積欠工資墊償基金另按公司月總額計算，不逐人四捨五入相加。"'::jsonb;
 return jsonb_build_object('rules_version','TW-2026-v2','normal_wage',wage,'hourly_wage',round(hourly,6),'overtime',ot,'overtime_lines',rows,'overtime_hours',ot_hours,
 'insurance_estimate',jsonb_build_object('labor',labor,'employment',employment,'health',health),'labor',coalesce((overrides->>'labor')::numeric,labor),'employment',coalesce((overrides->>'employment')::numeric,employment),'health',coalesce((overrides->>'health')::numeric,health),
 'employee_pension',pension,'employer_pension',employer_pension,'employer_labor',employer_labor,'employer_employment',employer_employment,'employer_health',employer_health,'employer_occupational',occupational,'employer_burden',employer_total,'employer_cost',gross+employer_total,'missing_employer_fields',missing,'gross',gross,'deductions',gross-net,'net',net,'warnings',warnings);
end $$;

-- Allocation is an auditable extension of the authoritative payroll, never a second wage ledger.
create table public.accounting_labor_allocations (
 payroll_id uuid primary key references public.accounting_payroll(id),
 payroll_version integer not null, source_fingerprint text not null,
 method text not null check(method in ('actual_hours','log_day_split','approved_weights')),
 denominator numeric(12,4) not null check(denominator>0 and denominator<=744),
 reason text not null check(length(btrim(reason)) between 2 and 2000),
 row_version integer not null default 1, updated_by uuid not null references public.app_users(id),updated_at timestamptz not null default now()
);
create index accounting_labor_allocations_actor_idx on public.accounting_labor_allocations(updated_by);
create table public.accounting_labor_allocation_lines (
 payroll_id uuid not null references public.accounting_labor_allocations(payroll_id),
 project_id uuid not null references public.projects(id),work_date date not null,
 work_log_id uuid not null references public.site_work_logs(id),
 units numeric(12,4) not null check(units>0 and units<=24),
 wage_amount numeric(14,2) not null check(wage_amount>=0),employer_amount numeric(14,2) check(employer_amount>=0),
 primary key(payroll_id,project_id,work_date)
);
create index accounting_labor_lines_project_idx on public.accounting_labor_allocation_lines(project_id,work_date);
create index accounting_labor_lines_log_idx on public.accounting_labor_allocation_lines(work_log_id);
create table public.accounting_employer_months (
 month date primary key check(extract(day from month)=1),
 status text not null check(status in ('applicable','exempt')),
 paid_wages numeric(16,2) not null check(paid_wages>=0), insured_total numeric(16,2) not null check(insured_total>=0),
 supplement numeric(16,0) not null check(supplement>=0),
 fund_status text not null check(fund_status in ('applicable','exempt')), fund_base numeric(16,2) not null check(fund_base>=0), fund_amount numeric(16,0) not null check(fund_amount>=0),
 source_reference text not null check(length(btrim(source_reference)) between 2 and 2000),
 row_version integer not null default 1, updated_by uuid not null references public.app_users(id),updated_at timestamptz not null default now()
);
create index accounting_employer_months_actor_idx on public.accounting_employer_months(updated_by);
do $$ declare t text; begin
 foreach t in array array['accounting_labor_allocations','accounting_labor_allocation_lines','accounting_employer_months'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $$;

-- Only actual on-site employees; a reporter who did not attend cannot acquire allocated wages.
create function public.accounting_labor_sources_v1(p_actor uuid,p_payroll uuid) returns table(work_log_id uuid,project_id uuid,project_name text,work_date date,source_fingerprint text)
language plpgsql security invoker set search_path='' as $$
begin
 perform public.accounting_finance_assert_v1(p_actor,'accounting_payroll');
 perform public.erp_private_prepare_v1(p_actor);
 return query select l.id,l.project_id,p.name,l.log_date,md5(to_jsonb(l)::text||w.user_id::text)
 from public.accounting_payroll pay join public.site_work_log_workers w on w.user_id=pay.employee_id
 join public.site_work_logs l on l.id=w.work_log_id join public.projects p on p.id=l.project_id
 where pay.id=p_payroll and pay.deleted_at is null and l.deleted_at is null and l.status in ('in_progress','completed')
 and l.log_date>=pay.month and l.log_date<pay.month+interval '1 month'
 and l.log_date<=(now() at time zone 'Asia/Taipei')::date
 and (l.reporter_on_site or w.user_id is distinct from l.reporter_user_id)
 and public.erp_private_json_visible_v1(to_jsonb(l)) and public.site_return_project_visible_v1(p_actor,p.id);
end $$;

create function public.accounting_labor_source_digest_v1(p_actor uuid,p_payroll uuid) returns text
language sql security invoker set search_path='' as $$
 select md5(coalesce(string_agg(s.work_log_id::text||':'||s.project_id::text||':'||s.work_date::text,',' order by s.work_log_id),'')) from public.accounting_labor_sources_v1(p_actor,p_payroll) s;
$$;

create function public.accounting_labor_read_v1(p_actor uuid,p_month date,p_payroll uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$ declare result jsonb; begin
 perform public.accounting_finance_assert_v1(p_actor,'accounting_payroll');
 perform public.erp_private_prepare_v1(p_actor);
 if p_month is null or extract(day from p_month)<>1 then raise exception '請選擇薪資月份。';end if;
 select jsonb_build_object('month',p_month,
 'employer_month',(select to_jsonb(m) from public.accounting_employer_months m where month=p_month),
 'payrolls',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'employee_id',p.employee_id,'employee_name',u.display_name,'row_version',p.row_version,
 'calculation',p.calculation,'allocation',case when a.payroll_id is null then null else to_jsonb(a)||jsonb_build_object('stale',p.row_version<>a.payroll_version or (a.method='log_day_split' and a.source_fingerprint<>public.accounting_labor_source_digest_v1(p_actor,p.id))) end,
 'sources',case when p_payroll is distinct from p.id then '[]'::jsonb else coalesce((select jsonb_agg(to_jsonb(s) order by s.work_date,s.project_name,s.work_log_id) from public.accounting_labor_sources_v1(p_actor,p.id) s),'[]'::jsonb) end,
 'lines',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('project_name',q.name) order by l.work_date,q.name) from public.accounting_labor_allocation_lines l join public.projects q on q.id=l.project_id where l.payroll_id=p.id and public.site_return_project_visible_v1(p_actor,q.id) and exists(select 1 from public.site_work_logs log where log.id=l.work_log_id and public.erp_private_json_visible_v1(to_jsonb(log)))),'[]'::jsonb)
 ) order by u.display_name) from public.accounting_payroll p join public.app_users u on u.id=p.employee_id
 left join public.accounting_labor_allocations a on a.payroll_id=p.id where p.month=p_month and p.deleted_at is null),'[]'::jsonb)) into result;
 return result;
end $$;

create function public.accounting_labor_command_v1(p_actor uuid,p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
#variable_conflict use_variable
declare request uuid; prior public.accounting_finance_requests; fingerprint text; payroll public.accounting_payroll;
 allocation public.accounting_labor_allocations; empmonth public.accounting_employer_months; old jsonb; result jsonb; after_data jsonb;
 id uuid; month date; method text; denominator numeric; reason text; lines jsonb; row jsonb; units numeric; total_units numeric; perday_limit numeric;
 wages numeric; employer numeric; paid numeric; insured numeric; supplement numeric; fund numeric; fund_base numeric; fund_status text; status text; ref text;
begin
 perform public.accounting_finance_assert_v1(p_actor,'accounting_payroll','UPDATE');
 perform public.erp_private_prepare_v1(p_actor);
 if p_operation not in ('labor_allocate','employer_month_save') then raise exception '不支援的人事成本操作。';end if;
 request:=(p_payload->>'request_id')::uuid;
 if request is null then raise exception '缺少操作識別。';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text||request::text,0));
 fingerprint:=md5(p_payload::text);
 select * into prior from public.accounting_finance_requests where actor_id=p_actor and request_id=request;
 if found then if prior.operation<>p_operation or prior.fingerprint<>fingerprint then raise exception '操作識別已使用，請重新讀取。';end if;return prior.result;end if;
 if p_operation='employer_month_save' then
  month:=(p_payload->>'month')::date;status:=p_payload->>'status';paid:=(p_payload->>'paid_wages')::numeric;insured:=(p_payload->>'insured_total')::numeric;ref:=btrim(p_payload->>'source_reference');
  if month is null or extract(day from month)<>1 or extract(year from month)<>2026 or status is null or status not in ('applicable','exempt')
   or paid is null or insured is null or least(paid,insured)<0 or greatest(paid,insured)>10000000000 or paid<>round(paid,2) or insured<>round(insured,2)
   or ref is null or length(ref) not between 2 and 2000 then raise exception '請核對 2026 年月份、薪資總額、投保總額與申報憑據。';end if;
  perform pg_advisory_xact_lock(hashtextextended('employer-month:'||month::text,0));
  select * into empmonth from public.accounting_employer_months m where m.month=month for update;
  if empmonth.row_version is distinct from (p_payload->>'row_version')::integer then raise exception '公司月資料已修改，請重新讀取。';end if;
  old:=case when empmonth.month is not null then to_jsonb(empmonth) end;
  fund_status:=p_payload->>'fund_status';fund_base:=(p_payload->>'fund_base')::numeric;
  if fund_status is null or fund_status not in ('applicable','exempt') or fund_base is null or fund_base<0 or fund_base>10000000000 or fund_base<>round(fund_base,2) then raise exception '請核對墊償基金適用性及全單位當月核定投保薪資合計。';end if;
  fund:=case when fund_status='applicable' then round(fund_base*0.00025) else 0 end;
  supplement:=case when status='applicable' then round(greatest(paid-insured,0)*0.0211) else 0 end;
  insert into public.accounting_employer_months(month,status,paid_wages,insured_total,supplement,fund_status,fund_base,fund_amount,source_reference,updated_by)
  values(month,status,paid,insured,supplement,fund_status,fund_base,fund,ref,p_actor)
  on conflict on constraint accounting_employer_months_pkey do update set status=excluded.status,paid_wages=excluded.paid_wages,insured_total=excluded.insured_total,supplement=excluded.supplement,fund_status=excluded.fund_status,fund_base=excluded.fund_base,fund_amount=excluded.fund_amount,source_reference=excluded.source_reference,row_version=accounting_employer_months.row_version+1,updated_by=p_actor,updated_at=now()
  returning to_jsonb(accounting_employer_months) into after_data;
  id:=('00000000-0000-0000-0000-'||to_char(month,'YYYYMM')||'000000')::uuid;
 else
  id:=(p_payload->>'payroll_id')::uuid;
  select * into payroll from public.accounting_payroll p where p.id=id and p.deleted_at is null for update;
  if not found or payroll.row_version is distinct from (p_payload->>'payroll_version')::integer then raise exception '薪資版本已變更，請重新讀取。';end if;
  if payroll.calculation->>'rules_version' is distinct from 'TW-2026-v2' then raise exception '此薪資仍為舊規則，請先修改並核對雇主負擔後重新保存薪資。';end if;
  select * into allocation from public.accounting_labor_allocations a where a.payroll_id=id for update;
  if allocation.row_version is distinct from (p_payload->>'row_version')::integer then raise exception '人事分攤已修改，請重新讀取。';end if;
  if exists(select 1 from public.accounting_labor_allocation_lines l where l.payroll_id=id and not public.site_return_project_visible_v1(p_actor,l.project_id)) then raise exception using message='本薪資包含無權限工作內容，無法整筆重新分攤。',errcode='42501';end if;
  method:=p_payload->>'method';denominator:=(p_payload->>'denominator')::numeric;reason:=btrim(p_payload->>'reason');
  if method is null or method not in ('actual_hours','log_day_split','approved_weights') or denominator is null or denominator<=0 or denominator>744 or denominator<>round(denominator,4)
   or reason is null or length(reason) not between 2 and 2000 then raise exception '請選擇分攤方式、完整月份工時／權重分母及核准依據。';end if;
  perday_limit:=case when method='actual_hours' then 24 else 1 end;
  if method='log_day_split' then
   -- Missing/hidden work must not silently increase the visible work's fraction.
   if exists(select 1 from public.site_work_logs l join public.site_work_log_workers w on w.work_log_id=l.id
    where w.user_id=payroll.employee_id and l.deleted_at is null and l.status in ('in_progress','completed') and l.log_date>=payroll.month and l.log_date<payroll.month+interval '1 month'
    and (l.reporter_on_site or w.user_id is distinct from l.reporter_user_id)
    and (not public.erp_private_json_visible_v1(to_jsonb(l)) or not public.site_return_project_visible_v1(p_actor,l.project_id))) then raise exception using message='日誌含不可見工作內容，無法安全自動均分。',errcode='42501';end if;
   with distinct_days as(select distinct on(s.project_id,s.work_date) s.* from public.accounting_labor_sources_v1(p_actor,id) s order by s.project_id,s.work_date,s.work_log_id), numbered as(
    select d.*,count(*) over(partition by work_date) n,row_number() over(partition by work_date order by project_id) rn from distinct_days d)
   select coalesce(jsonb_agg(jsonb_build_object('work_log_id',work_log_id,'units',case when rn=n then 1-floor(10000.0/n)/10000*(n-1) else floor(10000.0/n)/10000 end) order by work_date,project_id),'[]') into lines from numbered;
  else lines:=p_payload->'lines';end if;
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines)>1500 then raise exception '分攤列格式不正確。';end if;
  total_units:=0;
  for row in select * from jsonb_array_elements(lines) loop
   if jsonb_typeof(row->'units') is distinct from 'number' then raise exception '工時／權重須為數字。';end if;
   units:=(row->>'units')::numeric;
   if units<=0 or units>perday_limit or units<>round(units,4) then raise exception '每日工時／權重超出範圍。';end if;
   if not exists(select 1 from public.accounting_labor_sources_v1(p_actor,id) s where s.work_log_id=(row->>'work_log_id')::uuid) then raise exception using message='分攤必須關聯本人當月到場且可查看的有效日誌。',errcode='42501';end if;
   total_units:=total_units+units;
  end loop;
  if total_units>denominator then raise exception '分攤總工時／權重不可超過完整月份分母，避免超額計入薪資。';end if;
  if exists(select 1 from jsonb_array_elements(lines) j join public.site_work_logs l on l.id=(j->>'work_log_id')::uuid group by l.project_id,l.log_date having count(*)>1)
   or exists(select 1 from jsonb_array_elements(lines) j join public.site_work_logs l on l.id=(j->>'work_log_id')::uuid group by l.log_date having sum((j->>'units')::numeric)>perday_limit) then raise exception '同工程同日不可重複；同人同日不可超過 24 小時或一日權重。';end if;
  old:=case when allocation.payroll_id is not null then to_jsonb(allocation)||jsonb_build_object('lines',(select coalesce(jsonb_agg(to_jsonb(l)),'[]') from public.accounting_labor_allocation_lines l where l.payroll_id=id)) end;
  insert into public.accounting_labor_allocations(payroll_id,payroll_version,source_fingerprint,method,denominator,reason,updated_by) values(id,payroll.row_version,public.accounting_labor_source_digest_v1(p_actor,id),method,denominator,reason,p_actor)
  on conflict on constraint accounting_labor_allocations_pkey do update set payroll_version=excluded.payroll_version,source_fingerprint=excluded.source_fingerprint,method=excluded.method,denominator=excluded.denominator,reason=excluded.reason,row_version=accounting_labor_allocations.row_version+1,updated_by=p_actor,updated_at=now();
  delete from public.accounting_labor_allocation_lines l where l.payroll_id=id;
  -- Floor cents for nonfinal lines; leftover remains unallocated, so rounding can never overallocate.
  for row in select j from jsonb_array_elements(lines) j order by j->>'work_log_id' loop
   units:=(row->>'units')::numeric;
   wages:=floor((payroll.calculation->>'gross')::numeric*units/denominator*100)/100;
   employer:=floor((payroll.calculation->>'employer_burden')::numeric*units/denominator*100)/100;
   insert into public.accounting_labor_allocation_lines(payroll_id,project_id,work_date,work_log_id,units,wage_amount,employer_amount)
   select id,l.project_id,l.log_date,l.id,units,wages,employer from public.site_work_logs l where l.id=(row->>'work_log_id')::uuid;
  end loop;
  select to_jsonb(a)||jsonb_build_object('lines',(select coalesce(jsonb_agg(to_jsonb(l)),'[]') from public.accounting_labor_allocation_lines l where l.payroll_id=id)) into after_data from public.accounting_labor_allocations a where a.payroll_id=id;
 end if;
 insert into public.accounting_finance_history(module,entity_id,action,before_data,after_data,actor_id) values('accounting_payroll',id,p_operation,old,after_data,p_actor);
 insert into public.audit_logs(entity_type,entity_id,action,source,actor) values('accounting_payroll',id,'update','web',(select username from public.app_users where app_users.id=p_actor));
 result:=jsonb_build_object('id',id,'row_version',after_data->'row_version');
 insert into public.accounting_finance_requests(actor_id,request_id,operation,fingerprint,result) values(p_actor,request,p_operation,fingerprint,result);
 return result;
end $$;

-- A financial report must not turn an incomplete old wage estimate into a precise total.
create function public.accounting_project_labor_v1(p_actor uuid,p_work uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare wage numeric; employer numeric; invalid integer; missing integer; rows jsonb; begin
 perform public.accounting_finance_assert_v1(p_actor,'accounting_payroll');
 perform public.erp_private_prepare_v1(p_actor);
 if not public.site_return_project_visible_v1(p_actor,p_work) then raise exception using message='沒有工作內容財務查看權限。',errcode='42501';end if;
 -- A permitted project can contain private labor sources. Never calculate a complete
 -- project total from only its visible subset, even when that subset has no costs.
 -- Return no hidden counts, source identifiers or monetary subtotals.
 if exists(select 1 from public.site_work_logs log where log.project_id=p_work
   and log.deleted_at is null and log.status in ('in_progress','completed')
   and log.log_date<=(now() at time zone 'Asia/Taipei')::date
   and public.erp_private_json_visible_v1(to_jsonb(log)) is not true)
 or exists(select 1 from public.accounting_labor_allocation_lines line
   left join public.site_work_logs log on log.id=line.work_log_id
   where line.project_id=p_work and (log.id is null or public.erp_private_json_visible_v1(to_jsonb(log)) is not true)) then
  return jsonb_build_object('basis','payroll_allocation','status','未確認',
   'wage_amount',null,'employer_amount',null,'known_wage_amount',null,'known_employer_amount',null,
   'missing_person_days',null,'invalid_lines',null,'sources','[]'::jsonb,
   'missing',jsonb_build_array('工程人事來源查看權限不足，無法確認完整成本'),
   'note','工程人事來源查看權限不足，無法確認完整成本。請由具備完整來源權限的人員核對；不以部分資料代替工程總額。');
 end if;
 with costs as (
 select l.*,p.month,p.calculation,a.method,a.reason,a.payroll_version,p.row_version,
 p.deleted_at is not null or p.row_version<>a.payroll_version or (a.method='log_day_split' and a.source_fingerprint<>public.accounting_labor_source_digest_v1(p_actor,p.id)) or not exists(select 1 from public.site_work_logs s join public.site_work_log_workers w on w.work_log_id=s.id
 where s.id=l.work_log_id and s.project_id=l.project_id and s.log_date=l.work_date and s.deleted_at is null and s.status in ('in_progress','completed') and w.user_id=p.employee_id and (s.reporter_on_site or w.user_id is distinct from s.reporter_user_id)) invalid
 from public.accounting_labor_allocation_lines l join public.accounting_labor_allocations a on a.payroll_id=l.payroll_id
 join public.accounting_payroll p on p.id=l.payroll_id where l.project_id=p_work and exists(select 1 from public.site_work_logs log where log.id=l.work_log_id and public.erp_private_json_visible_v1(to_jsonb(log)))
 ) select sum(wage_amount) filter(where not c.invalid),sum(employer_amount) filter(where not c.invalid),count(*) filter(where c.invalid or employer_amount is null),
 coalesce(jsonb_agg(jsonb_build_object('payroll_id',payroll_id,'payroll_version',payroll_version,'month',month,'work_log_id',work_log_id,'work_date',work_date,'method',method,'reason',reason,'wage_amount',wage_amount,'employer_amount',employer_amount,'invalid',c.invalid)),'[]')
 into wage,employer,invalid,rows from costs c;
 select count(*) into missing from (
 select distinct w.user_id,l.log_date from public.site_work_logs l join public.site_work_log_workers w on w.work_log_id=l.id
 where l.project_id=p_work and public.erp_private_json_visible_v1(to_jsonb(l)) and l.deleted_at is null and l.status in ('in_progress','completed') and l.log_date<=(now() at time zone 'Asia/Taipei')::date
 and (l.reporter_on_site or w.user_id is distinct from l.reporter_user_id)
 and not exists(select 1 from public.accounting_labor_allocation_lines a join public.accounting_payroll p on p.id=a.payroll_id where a.project_id=p_work and a.work_date=l.log_date and p.employee_id=w.user_id and p.deleted_at is null)
 ) unallocated;
 return jsonb_build_object('basis','payroll_allocation','status',case when missing+invalid>0 then '未確認' else '分攤' end,
 'wage_amount',case when missing+invalid=0 then coalesce(wage,0) end,'employer_amount',case when missing+invalid=0 then coalesce(employer,0) end,
 'known_wage_amount',coalesce(wage,0),'known_employer_amount',coalesce(employer,0),'missing_person_days',missing,'invalid_lines',invalid,'sources',rows,
 'note','依應發薪資及雇主負擔分攤；不加計實發、扣繳或原逐日工資。公司補充保費與墊償基金另列公司費用，核准後才另行分攤。');
end $$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('accounting_labor_sources_v1','accounting_labor_source_digest_v1','accounting_labor_read_v1','accounting_labor_command_v1','accounting_project_labor_v1') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;

