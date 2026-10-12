begin;
set local lock_timeout='5s';
create or replace function public.work_content_report_v1(p_actor_user_id uuid,p_project_id uuid default null,
 p_from date default null,p_to date default null,p_work_type text default null,p_accounting boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $report$
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
 select r.*,i.item_name,i.brand,i.model,i.unit from public.pickup_records r join public.inventory_items i on i.id=r.inventory_item_id
 where r.project_id=p_project_id and (p_from is null or r.pickup_date>=p_from) and (p_to is null or r.pickup_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(r))),
 workers as materialized (
 select w.user_id,l.id,l.log_date,u.display_name,u.is_active from logs l
 join public.site_work_log_workers w on w.work_log_id=l.id join public.app_users u on u.id=w.user_id),
 mat as (
 select m.inventory_item_id id,max(m.item_name) name,max(m.brand) brand,max(m.model) model,max(coalesce(nullif(m.unit,''),'未標示單位')) unit,
 sum(m.quantity) quantity,count(*) "recordCount",min(m.pickup_date) "firstDate",max(m.pickup_date) "recentDate"
 from materials m group by m.inventory_item_id),
 material_stats as (
 select to_jsonb(m)||case when price_visible then jsonb_build_object('unit_price',coalesce(manual.unit_price,latest.unit_price),
 'amount',round(m.quantity*coalesce(manual.unit_price,latest.unit_price),2),
 'price_source',case when manual.unit_price is not null then 'manual' when latest.id is not null then 'receipt' else 'missing' end,
 'price_date',case when manual.unit_price is not null then (manual.updated_at at time zone 'Asia/Taipei')::date else latest.receipt_date end,
 'source_receipt_id',case when manual.unit_price is null then latest.id end,
 'price_row_version',manual.row_version) else '{}'::jsonb end data from mat m
 left join public.accounting_material_prices manual on manual.project_id=p_project_id and manual.inventory_item_id=m.id
 left join lateral(select s.id,s.unit_price,s.receipt_date from public.stock_receipts s
 where s.inventory_item_id=m.id and s.unit_price is not null and public.erp_private_json_visible_v1(to_jsonb(s))
 order by s.receipt_date desc,s.created_at desc,s.id desc limit 1) latest on true),
 worker_stats as (
 select user_id id,max(display_name) name,max(display_name)||'（'||left(user_id::text,8)||'）' label,
 bool_or(is_active) active,count(distinct log_date) "constructionDays",count(distinct id) "recordCount",
 min(log_date) "firstDate",max(log_date) "lastDate",max(log_date) "recentDate" from workers group by user_id)
 select result||jsonb_build_object('report',jsonb_build_object('error','',
 'materialStats',coalesce((select jsonb_agg(data order by (data->>'recordCount')::int desc,data->>'id') from material_stats),'[]'),
 'workerStats',coalesce((select jsonb_agg(to_jsonb(w) order by w."constructionDays" desc,w.id) from worker_stats w),'[]'),
 'materialRows',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'date',m.pickup_date,'itemId',m.inventory_item_id,
 'quantity',m.quantity,'account',m.created_by_username,'item',jsonb_build_object('name',m.item_name,'brand',m.brand,'model',m.model,'unit',m.unit)) order by m.pickup_date desc,m.id) from materials m),'[]'),
 'dailyRows',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'date',l.log_date,'timePeriod',l.time_period,'summary',l.summary,'status',l.status,
 'workerIds',coalesce((select jsonb_agg(w.user_id) from workers w where w.id=l.id),'[]'),
 'workerNames',coalesce((select jsonb_agg(w.display_name) from workers w where w.id=l.id),'[]'),
 'dailyHeadcount',(select count(distinct w.user_id) from workers w where w.log_date=l.log_date)) order by l.log_date desc,l.id) from logs l),'[]'),
 'totalsByUnit',coalesce((select jsonb_agg(to_jsonb(t)) from(select unit,sum(quantity) total from mat group by unit)t),'[]'),
 'kpis',jsonb_build_object('materialTypeCount',(select count(*) from mat),'materialRecordCount',(select count(*) from materials),
 'primaryMaterial',(select data from material_stats order by (data->>'recordCount')::int desc,data->>'id' limit 1),
 'constructionDays',(select count(distinct log_date) from logs),'workerCount',(select count(*) from worker_stats),
 'workerDays',(select count(distinct(user_id,log_date)) from workers),'recentConstructionDate',(select max(log_date) from logs)))) into result;
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
 ), completed as materialized (select * from logs where status='completed'),
 item_stats as (
  select i.*, (select count(distinct l.log_date)::int from completed l where l.construction_item_id=i.id) completed_days
  from public.construction_plan_items i join plans p on p.id=i.construction_plan_id where i.deleted_at is null
 ), plan_stats as (
  select c.*,(select count(distinct l.log_date)::int from completed l where l.construction_plan_id=c.id) completed_days,
  coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object(
   'remaining_days',case when i.planned_days>0 then greatest(i.planned_days-i.completed_days,0) end,
   'overrun_days',case when i.planned_days>0 then greatest(i.completed_days-i.planned_days,0) else 0 end,
   'progress_percent',case when i.planned_days>0 then round(100.0*i.completed_days/i.planned_days,1) end,
   'logs',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'date',l.log_date,'status',l.status,
    'summary',l.summary,'can_open',public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW')) order by l.log_date,l.id)
    from logs l where l.construction_item_id=i.id and public.construction_log_visible_v1(p_actor_user_id,l)),'[]')) order by i.sort_order,i.id)
   from item_stats i where i.construction_plan_id=c.id),'[]') items,
  coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'name',u.display_name) order by u.display_name,u.id)
   from public.construction_plan_assignees a join public.app_users u on u.id=a.user_id where a.construction_plan_id=c.id),'[]') assignees,
  coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'date',l.log_date,'status',l.status,'item_id',l.construction_item_id,
   'summary',l.summary,'can_open',public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW')) order by l.log_date,l.id)
   from logs l where l.construction_plan_id=c.id and public.construction_log_visible_v1(p_actor_user_id,l)),'[]') logs
  from plans c
 ), enriched as (
  select to_jsonb(p)||jsonb_build_object(
   'remaining_days',case when p.planned_days>0 then greatest(p.planned_days-p.completed_days,0) end,
   'overrun_days',case when p.planned_days>0 then greatest(p.completed_days-p.planned_days,0) else 0 end,
   'progress_percent',case when p.planned_days>0 then round(100.0*p.completed_days/p.planned_days,1) end,
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
   'projectDays',(select count(distinct l.log_date) from completed l join plans c on c.id=l.construction_plan_id where c.status<>'cancelled'),
   'overdueItemCount',(select count(*) from item_stats i join plans p on p.id=i.construction_plan_id where p.status<>'cancelled' and i.planned_days>0 and i.completed_days>i.planned_days)
    +(select count(*) from plan_stats p where p.status<>'cancelled' and jsonb_array_length(p.items)=0 and p.planned_days>0 and p.completed_days>p.planned_days)
  ))) into result;

 return result;
end $report$;
revoke all on function public.work_content_report_v1(uuid,uuid,date,date,text,boolean) from public,anon,authenticated;
grant execute on function public.work_content_report_v1(uuid,uuid,date,date,text,boolean) to service_role;
notify pgrst,'reload schema';
commit;
