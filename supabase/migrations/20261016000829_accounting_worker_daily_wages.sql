-- Expand the unreleased project-wide rates onto recorded attendance dates.
-- Existing rates and audit history are preserved; future dates start unpriced.
lock table public.accounting_worker_wages in access exclusive mode;
create temporary table wage_attendance_dates on commit drop as
select distinct c.id,l.log_date
from public.accounting_worker_wages c join public.site_work_logs l on l.project_id=c.project_id
where l.deleted_at is null and l.status in ('in_progress','completed') and l.work_type not in ('文書作業','場勘')
and case when c.worker_user_id is null then l.subcontractor_count>0 else exists(
 select 1 from public.site_work_log_workers w where w.work_log_id=l.id and w.user_id=c.worker_user_id
 and (l.reporter_on_site or w.user_id is distinct from l.reporter_user_id)) end;
do $$ begin
 if exists(select 1 from public.accounting_worker_wages c where not exists(select 1 from wage_attendance_dates d where d.id=c.id)) then
  raise exception '既有工資有無施工日期的紀錄，請先核對；本次轉換未更動資料。';
 end if;
end $$;
alter table public.accounting_worker_wages add column work_date date;
update public.accounting_worker_wages c set work_date=(select min(log_date) from wage_attendance_dates d where d.id=c.id),row_version=row_version+1;
alter table public.accounting_worker_wages alter column work_date set not null;
alter table public.accounting_worker_wages drop constraint accounting_worker_wages_project_id_worker_user_id_key;
alter table public.accounting_worker_wages add constraint accounting_worker_wages_project_worker_date_key unique nulls not distinct(project_id,worker_user_id,work_date);
insert into public.accounting_worker_wages(project_id,worker_user_id,work_date,daily_wage,updated_by_user_id,updated_at)
select c.project_id,c.worker_user_id,d.log_date,c.daily_wage,c.updated_by_user_id,c.updated_at
from public.accounting_worker_wages c join wage_attendance_dates d on d.id=c.id where d.log_date<>c.work_date;
comment on column public.accounting_worker_wages.work_date is 'Actual attendance date; one rate per work content, worker and date. NULL worker means subcontractor group.';

-- Old clients must refresh rather than accidentally change every date.
create or replace function public.save_accounting_worker_wage_v1(p_actor_user_id uuid,p_project_id uuid,p_worker_user_id uuid,p_daily_wage numeric,p_row_version integer default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin raise exception '工資已改為逐日設定，請重新整理頁面後操作。';end $$;

create function public.save_accounting_worker_wage_v2(p_actor_user_id uuid,p_project_id uuid,p_worker_user_id uuid,p_work_date date,p_daily_wage numeric,p_row_version integer default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare old public.accounting_worker_wages; after_row public.accounting_worker_wages; needed text; report jsonb;
begin
 if p_project_id is null or p_work_date is null or not isfinite(p_work_date) then raise exception '請指定工作內容及施工日期。';end if;
 report:=public.work_content_report_v1(p_actor_user_id,p_project_id,p_work_date,p_work_date,null,true);
 perform pg_advisory_xact_lock(hashtextextended(p_project_id::text||coalesce(p_worker_user_id::text,'subcontractor')||p_work_date::text,0));
 select * into old from public.accounting_worker_wages where project_id=p_project_id and worker_user_id is not distinct from p_worker_user_id and work_date=p_work_date for update;
 if old.row_version is distinct from p_row_version then raise exception '當日工資已被其他人修改，請重新讀取。';end if;
 needed:=case when p_daily_wage is null then 'DELETE' when old.id is null then 'CREATE' else 'UPDATE' end;
 if not public.has_app_permission_v1(p_actor_user_id,'accounting_prices','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'accounting_prices',needed) then raise exception '沒有工資操作權限。';end if;
 -- Use the same attendance, private-data and project-scope rules as the report.
 if not exists(select 1 from jsonb_array_elements(report#>'{report,laborDailyRows}') d
  where d->>'workerId'=coalesce(p_worker_user_id::text,'subcontractor') and d->>'date'=p_work_date::text) then
  raise exception '此工作內容在指定日期沒有該施工人員紀錄。';
 end if;
 if p_daily_wage is not null and (p_daily_wage<0 or p_daily_wage>=1000000000000 or p_daily_wage<>round(p_daily_wage,2)) then raise exception '每日工資須為非負金額，最多小數二位。';end if;
 if p_daily_wage is null then
  if old.id is null then return jsonb_build_object('saved',true,'row_version',null);end if;
  delete from public.accounting_worker_wages where id=old.id;
 else insert into public.accounting_worker_wages(project_id,worker_user_id,work_date,daily_wage,updated_by_user_id)
  values(p_project_id,p_worker_user_id,p_work_date,p_daily_wage,p_actor_user_id)
  on conflict(project_id,worker_user_id,work_date) do update
  set daily_wage=excluded.daily_wage,row_version=accounting_worker_wages.row_version+1,updated_at=now(),updated_by_user_id=p_actor_user_id returning * into after_row;
 end if;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
  values('accounting_worker_wages',coalesce(after_row.id,old.id),case when p_daily_wage is null then 'delete' when old.id is null then 'insert' else 'update' end,to_jsonb(old),to_jsonb(after_row),'web',(select username from public.app_users where id=p_actor_user_id));
 return jsonb_build_object('saved',true,'row_version',after_row.row_version);
end $$;
revoke all on function public.save_accounting_worker_wage_v2(uuid,uuid,uuid,date,numeric,integer) from public,anon,authenticated;
grant execute on function public.save_accounting_worker_wage_v2(uuid,uuid,uuid,date,numeric,integer) to service_role;

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
 if p_work_type in ('clerical','site_survey') then raise exception '此工作類型不列入統計報表。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 select coalesce(array_agg(p.id),'{}') into allowed from public.projects p
 join public.app_users u on u.id=p_actor_user_id and u.is_active
 join public.app_roles role on role.code=u.role
 where p.deleted_at is null and p.project_type not in ('clerical','site_survey')
 and (nullif(p_work_type,'') is null or p.project_type=p_work_type)
 and public.erp_private_json_visible_v1(to_jsonb(p))
 and (not role.project_scoped or exists(select 1 from public.project_workers w
 where w.project_id=p.id and w.user_id=u.id and (w.can_view or w.is_assignee)));
 if p_project_id is not null and not(p_project_id=any(allowed)) then raise exception '找不到工作內容或沒有統計查看權限。'; end if;
 price_visible:=p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','VIEW');
 select jsonb_build_object('work_types',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.erp_work_content_types_v1() t where t.code not in ('clerical','site_survey')),
 'projects',coalesce((select jsonb_agg(to_jsonb(p) order by p.project_code) from public.projects p where p.id=any(allowed)),'[]'),
 'customers',coalesce((select jsonb_agg(to_jsonb(c)) from public.customers c where c.id in(select customer_id from public.projects where id=any(allowed))),'[]'),
 'customer_departments',coalesce((select jsonb_agg(to_jsonb(d)) from public.customer_departments d where d.customer_id in(select customer_id from public.projects where id=any(allowed))),'[]'),
 'price_permissions',jsonb_build_object('view',price_visible,'create',p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','CREATE'),
 'update',p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','UPDATE'),'delete',p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','DELETE'))) into result;
 if p_project_id is null then return result; end if;
 with logs as materialized (
 select l.* from public.site_work_logs l where l.project_id=p_project_id and l.deleted_at is null
 and l.work_type not in ('文書作業','場勘') and l.status in ('in_progress','completed')
 and (p_from is null or l.log_date>=p_from) and (p_to is null or l.log_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(l))),
 materials as materialized (
 select r.*,i.item_name,i.brand,i.model,i.unit,i.category_id,
 coalesce(nullif(btrim(c.name),''),'未分類') category_name
 from public.pickup_records r join public.inventory_items i on i.id=r.inventory_item_id
 left join public.product_categories c on c.id=i.category_id
 where r.project_id=p_project_id and (p_from is null or r.pickup_date>=p_from) and (p_to is null or r.pickup_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(r))),
 workers as materialized (
 select w.user_id,l.id,l.log_date,u.display_name,u.is_active from logs l
 join public.site_work_log_workers w on w.work_log_id=l.id join public.app_users u on u.id=w.user_id where l.reporter_on_site or w.user_id is distinct from l.reporter_user_id),
 contractor_days as (select log_date,max(subcontractor_count) headcount,count(*) records from logs where subcontractor_count>0 group by log_date),
 mat as (
 select m.inventory_item_id id,max(m.item_name) name,max(m.brand) brand,max(m.model) model,max(coalesce(nullif(m.unit,''),'未標示單位')) unit,
 m.category_id "categoryId",m.category_name "categoryName",
 sum(m.quantity) quantity,count(*) "recordCount",min(m.pickup_date) "firstDate",max(m.pickup_date) "recentDate"
 from materials m group by m.inventory_item_id,m.category_id,m.category_name),
 material_stats as (
 select m."categoryId",m."categoryName",m.unit,m.quantity,m."recordCount",
 to_jsonb(m)||case when price_visible then jsonb_build_object('unit_price',coalesce(manual.unit_price,latest.unit_price),
 'amount',round(m.quantity*coalesce(manual.unit_price,latest.unit_price),2),
 'price_source',case when manual.unit_price is not null then 'manual' when latest.id is not null then 'receipt' else 'missing' end,
 'price_date',case when manual.unit_price is not null then (manual.updated_at at time zone 'Asia/Taipei')::date else latest.receipt_date end,
 'source_receipt_id',case when manual.unit_price is null then latest.id end,
 'source_document_id',case when manual.unit_price is null then latest.receipt_document_id end,
 'source_tax_mode',case when manual.unit_price is null then latest.receipt_tax_mode end,
 'source_tax_rate_basis_points',case when manual.unit_price is null then latest.receipt_tax_rate_basis_points end,
 'source_input_unit_price',case when manual.unit_price is null then latest.input_unit_price end,
 'price_row_version',manual.row_version) else '{}'::jsonb end data from mat m
 left join public.accounting_material_prices manual on manual.project_id=p_project_id and manual.inventory_item_id=m.id
 left join lateral(select s.id,s.receipt_date,s.receipt_document_id,s.unit_price input_unit_price,
 d.receipt_tax_mode,d.receipt_tax_rate_basis_points,
 case when d.receipt_tax_mode='inclusive' then round(s.unit_price*10000/(10000+d.receipt_tax_rate_basis_points),2) else s.unit_price end unit_price
 from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id
 where s.inventory_item_id=m.id and s.unit_price is not null and public.erp_private_json_visible_v1(to_jsonb(s))
 order by s.receipt_date desc,s.created_at desc,s.id desc limit 1) latest on true),
 category_stats as (
 select s."categoryId" id,max(s."categoryName") name,count(*) "itemCount",sum(s."recordCount") "recordCount",
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
 union all select 'subcontractor','代工','代工（人天）',true,sum(headcount),sum(records),min(log_date),max(log_date),max(log_date) from contractor_days having count(*)>0),
 labor_days as (
 select user_id::text worker_id,max(display_name) worker_name,log_date,1::bigint headcount from workers group by user_id,log_date
 union all select 'subcontractor','代工',log_date,headcount from contractor_days),
 labor_costs as (
 select d.*,c.daily_wage,round(d.headcount*c.daily_wage,2) labor_amount,c.row_version wage_row_version
 from labor_days d left join public.accounting_worker_wages c on price_visible and c.project_id=p_project_id
 and coalesce(c.worker_user_id::text,'subcontractor')=d.worker_id and c.work_date=d.log_date),
 worker_json as (select w.*,to_jsonb(w)||jsonb_build_object('unit',case when w.id='subcontractor' then '人天' else '天' end)
 ||case when price_visible then (select jsonb_build_object('labor_amount',sum(c.labor_amount),'unpricedDayCount',count(*) filter(where c.daily_wage is null)) from labor_costs c where c.worker_id=w.id) else '{}'::jsonb end data
 from worker_stats w)
 select result||jsonb_build_object('report',jsonb_build_object('error','',
 'materialStats',coalesce((select jsonb_agg(data order by (data->>'recordCount')::int desc,data->>'id') from material_stats),'[]'),
 'materialCategoryStats',coalesce((select jsonb_agg(data order by data->>'name',data->>'id') from category_json),'[]'),
 'workerStats',coalesce((select jsonb_agg(w.data order by w."constructionDays" desc,w.id) from worker_json w),'[]'),
 'materialRows',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'date',m.pickup_date,'itemId',m.inventory_item_id,
 'categoryId',m.category_id,'categoryName',m.category_name,'quantity',m.quantity,'account',m.created_by_username,'item',jsonb_build_object('name',m.item_name,'brand',m.brand,'model',m.model,'unit',m.unit)) order by m.pickup_date desc,m.id) from materials m),'[]'),
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
 'kpis',jsonb_build_object('materialTypeCount',(select count(*) from mat),'materialRecordCount',(select count(*) from materials),
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
  where l.deleted_at is null and l.work_type='工程施工' and l.log_date<=(now() at time zone 'Asia/Taipei')::date
  and (p_from is null or l.log_date>=p_from) and (p_to is null or l.log_date<=p_to)
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
   'remaining_days',case when p.planned_days>0 then greatest(p.planned_days-p.completed_days,0) end,
   'overrun_days',case when p.planned_days>0 then greatest(p.worked_days-p.planned_days,0) else 0 end,
   'progress_percent',p.completion_percent,
   'can_open',public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') and public.construction_project_access_v1(p_actor_user_id,p.project_id,false),
   'completed_item_count',(select count(*) from item_stats i where i.construction_plan_id=p.id and i.is_completed)) data from plan_stats p
 )
 select result||jsonb_build_object('report',(result->'report')||jsonb_build_object(
  'project', (select jsonb_build_object('id',p.id,'code',p.project_code,'name',p.name,'type',t.label,'status',p.status,
   'customer',c.name,'owner',coalesce(nullif(p.assigned_to,''),(select string_agg(u.display_name,'、' order by u.id) from public.project_workers w join public.app_users u on u.id=w.user_id where w.project_id=p.id and w.is_assignee)),
   'createdAt',p.created_at,'completedOn',p.completed_on,'date',p.project_date)
   from public.projects p join public.customers c on c.id=p.customer_id left join public.erp_work_content_types_v1() t on t.code=p.project_type where p.id=p_project_id),
  'constructionPlans',coalesce((select jsonb_agg(data order by data->>'construction_date',data->>'id') from enriched),'[]'),
  'constructionSummary',jsonb_build_object(
   'planCount',(select count(*) from plans),
   'plannedDays',(select coalesce(sum(planned_days),0) from plan_stats where status<>'cancelled'),
   'completedDays',(select coalesce(sum(completed_days),0) from plan_stats where status<>'cancelled'),
   'remainingDays',(select coalesce(sum(greatest(planned_days-completed_days,0)),0) from plan_stats where status<>'cancelled' and planned_days>0),
   'unsetPlanCount',(select count(*) from plans where status<>'cancelled' and coalesce(planned_days,0)=0),
   'workedDays',(select coalesce(sum(worked_days),0) from plan_stats where status<>'cancelled'),
   'progressPercent',(select case when sum(planned_days)>0 then round(100.0*sum(completed_days)/sum(planned_days),1) end from plan_stats where status<>'cancelled'),
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
      'id',s.id,'itemId',s.inventory_item_id,'name',i.item_name,'quantity',s.quantity,'unit',i.unit,
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
