begin;
set local lock_timeout='5s';

-- Contract dates belong to the existing project only. No backfill invents dates.
alter table public.projects add column contract_start_date date, add column contract_end_date date,
 add constraint projects_contract_dates_check check(contract_start_date is null or contract_end_date is null or contract_start_date<=contract_end_date);
alter table public.construction_plans add column warning_work_days integer,
 add column warning_min_progress numeric,
 add constraint construction_warning_days_check check(warning_work_days between 1 and 3650),
 add constraint construction_warning_progress_check check(warning_min_progress between 0 and 100),
 add constraint construction_warning_pair_check check((warning_work_days is null)=(warning_min_progress is null));
comment on column public.projects.contract_end_date is '契約履約截止日，獨立於施工日期與實際施工天數。';
comment on column public.construction_plans.warning_work_days is '累計有效實際施工日期達此天數時，檢查施工項目數完成度；NULL 不設進度告警。';

create function public.set_project_contract_dates_v1(p_actor_user_id uuid,p_project_id uuid,p_row_version integer,p_start date,p_end date)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare old_row public.projects; new_row public.projects; actor text;
begin
 select * into old_row from public.projects where id=p_project_id for update;
 if not found or old_row.deleted_at is not null then raise exception '找不到工作內容。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform public.erp_private_assert_v1(to_jsonb(old_row));
 if not public.construction_project_access_v1(p_actor_user_id,p_project_id,true) then raise exception '只有具有施工規劃管理權限的負責人或管理員可修改履約期限。'; end if;
 if old_row.row_version is distinct from p_row_version then raise exception '工作內容已更新，請重新讀取履約日期。'; end if;
 if p_start>p_end then raise exception '履約開始日期不可晚於履約截止日期。'; end if;
 if old_row.contract_start_date is not distinct from p_start and old_row.contract_end_date is not distinct from p_end then return to_jsonb(old_row); end if;
 select username into actor from public.app_users where id=p_actor_user_id and is_active;
 update public.projects set contract_start_date=p_start,contract_end_date=p_end,updated_at=now(),row_version=row_version+1,updated_by=actor where id=p_project_id returning * into new_row;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('project',p_project_id,'update',to_jsonb(old_row),to_jsonb(new_row),'web',actor);
 return to_jsonb(new_row);
end $$;

-- Existing project creation/update, owners, department, numbering, visibility,
-- and optimistic concurrency remain authoritative and run in one transaction.
create function public.upsert_erp_project_contract_v1(p_actor_user_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_id uuid:=nullif(p_payload->>'id','')::uuid; old_row public.projects; result jsonb; project jsonb;
 actor text; workers uuid[]; start_date date; end_date date; department uuid;
begin
 select username into actor from public.app_users where id=p_actor_user_id and is_active;
 if actor is null or not public.has_app_permission_v1(p_actor_user_id,'projects',case when v_id is null then 'CREATE' else 'UPDATE' end) then raise exception '沒有工作內容修改權限。'; end if;
 -- Match the existing project writer's customer-before-project lock order.
 perform 1 from public.customers where id=(p_payload->>'customer_id')::uuid for update;
 if v_id is not null then
  select * into old_row from public.projects where projects.id=v_id for update;
  perform public.erp_private_prepare_v1(p_actor_user_id);
  perform public.erp_private_assert_v1(to_jsonb(old_row));
  if (p_payload ? 'contract_start_date' or p_payload ? 'contract_end_date') and not public.construction_project_access_v1(p_actor_user_id,v_id,true) then raise exception '沒有履約期限管理權限。'; end if;
 end if;
 start_date:=case when p_payload ? 'contract_start_date' then nullif(p_payload->>'contract_start_date','')::date else old_row.contract_start_date end;
 end_date:=case when p_payload ? 'contract_end_date' then nullif(p_payload->>'contract_end_date','')::date else old_row.contract_end_date end;
 if start_date>end_date then raise exception '履約開始日期不可晚於履約截止日期。'; end if;
 select array_agg(value::uuid) into workers from jsonb_array_elements_text(p_payload->'worker_user_ids');
 department:=case when p_payload ? 'department_id' then nullif(p_payload->>'department_id','')::uuid else old_row.department_id end;
 result:=public.upsert_erp_project_department_v1(v_id,(p_payload->>'row_version')::integer,p_payload->>'name',(p_payload->>'customer_id')::uuid,
  p_payload->>'project_type',p_payload->>'status',nullif(p_payload->>'description',''),nullif(p_payload->>'estimated_cost','')::numeric,
  nullif(p_payload->>'note',''),coalesce(workers,'{}'),actor,(p_payload->>'project_date')::date,nullif(p_payload->>'construction_category',''),department,p_payload ? 'construction_category');
 project:=result->'project';
 -- New dates on creation are subject to the same project owner/admin manager gate.
 if start_date is not null or end_date is not null or old_row.contract_start_date is not null or old_row.contract_end_date is not null then
  project:=public.set_project_contract_dates_v1(p_actor_user_id,(project->>'id')::uuid,(project->>'row_version')::integer,start_date,end_date);
 end if;
 return result||jsonb_build_object('project',project);
end $$;

alter function public.save_construction_plan_v1(uuid,jsonb,boolean) rename to save_construction_plan_without_monitoring_v1;
create function public.save_construction_plan_v1(p_actor_user_id uuid,p_payload jsonb,p_delete boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; old_plan public.construction_plans; project public.projects; days integer; goal numeric; actor text;
begin
 select * into old_plan from public.construction_plans where id=(p_payload->>'id')::uuid for update;
 if not p_delete then
  if p_payload ? 'warning_work_days' and nullif(p_payload->>'warning_work_days','') is not null and (p_payload->>'warning_work_days') !~ '^[0-9]+$' then raise exception '告警天數須為 1 至 3650 的正整數。'; end if;
  days:=case when p_payload ? 'warning_work_days' then nullif(p_payload->>'warning_work_days','')::integer else old_plan.warning_work_days end;
  goal:=case when p_payload ? 'warning_min_progress' then nullif(p_payload->>'warning_min_progress','')::numeric else old_plan.warning_min_progress end;
  if (days is null)<>(goal is null) or days not between 1 and 3650 or goal not between 0 and 100 or goal='NaN'::numeric then raise exception '告警天數與最低完成度須同時設定；天數 1–3650，完成度 0–100%%。'; end if;
 end if;
 result:=public.save_construction_plan_without_monitoring_v1(p_actor_user_id,p_payload,p_delete);
 if not p_delete then
  if p_payload ? 'contract_start_date' or p_payload ? 'contract_end_date' then
   select * into project from public.projects where id=(result->>'project_id')::uuid;
   perform public.set_project_contract_dates_v1(p_actor_user_id,project.id,(p_payload->>'project_row_version')::integer,
    case when p_payload ? 'contract_start_date' then nullif(p_payload->>'contract_start_date','')::date else project.contract_start_date end,
    case when p_payload ? 'contract_end_date' then nullif(p_payload->>'contract_end_date','')::date else project.contract_end_date end);
  end if;
  update public.construction_plans set warning_work_days=days,warning_min_progress=goal where id=(result->>'id')::uuid;
  result:=result||jsonb_build_object('warning_work_days',days,'warning_min_progress',goal);
  if old_plan.warning_work_days is distinct from days or old_plan.warning_min_progress is distinct from goal then
   select username into actor from public.app_users where id=p_actor_user_id;
   insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
   values('construction_plans',(result->>'id')::uuid,'update',jsonb_build_object('warning_work_days',old_plan.warning_work_days,'warning_min_progress',old_plan.warning_min_progress),
    jsonb_build_object('warning_work_days',days,'warning_min_progress',goal),'web',actor);
  end if;
 end if;
 return result;
end $$;

-- One pure calculation for the two reports and ERP operational projections.
create or replace function public.construction_completion_totals_v1(p_items jsonb,p_planned_days integer,p_status text)
returns jsonb language sql immutable security invoker set search_path='' as $$
 with counts as (
  select count(*) total,count(*) filter(where (item->>'is_completed')::boolean) done
  from jsonb_array_elements(coalesce(p_items,'[]')) item where item->>'deleted_at' is null
 ) select jsonb_build_object('item_count',total,'completed_item_count',done,
  'completion_percent',case when total>0 then round(100.0*done/total,1) end,
  -- Compatibility only: schedule-weighted days are separate from completion %.
  'completed_days',coalesce((select sum((i->>'planned_days')::numeric) from jsonb_array_elements(coalesce(p_items,'[]')) i where i->>'deleted_at' is null and (i->>'is_completed')::boolean),0),
  'remaining_days',case when p_planned_days>0 then greatest(p_planned_days-coalesce((select sum((i->>'planned_days')::numeric) from jsonb_array_elements(coalesce(p_items,'[]')) i where i->>'deleted_at' is null and (i->>'is_completed')::boolean),0),0) end) from counts;
$$;

create function public.construction_progress_alert_v1(p_worked_days integer,p_total integer,p_completed integer,p_warning_days integer,p_min_progress numeric,p_status text)
returns jsonb language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('progress_alert',coalesce(p_status<>'cancelled' and p_total>0 and p_warning_days is not null and p_min_progress is not null and p_worked_days>=p_warning_days and 100.0*p_completed/nullif(p_total,0)<p_min_progress,false),
 'progress_gap',case when p_total>0 and p_min_progress is not null then greatest(round(p_min_progress-100.0*p_completed/nullif(p_total,0),1),0) end);
$$;

-- Only planning managers may change completion. Ordinary assigned workers keep
-- their existing work-log permissions without gaining planning management.
do $$ declare definition text; before_text text:='if not (public.construction_project_access_v1(p_actor_user_id,project.id,true)
  or public.has_app_permission_v1(p_actor_user_id,''worklogs'',''UPDATE'') and exists(select 1 from public.construction_plan_assignees where construction_plan_id=plan.id and user_id=p_actor_user_id)) then raise exception ''只有專案負責人、管理員或被指派且具修改權限的施工人員可勾選完成。'';';
begin
 definition:=pg_get_functiondef('public.set_construction_item_completed_v1(uuid,uuid,integer,boolean)'::regprocedure);
 if position(before_text in definition)=0 then raise exception 'Unexpected completion permission baseline'; end if;
 definition:=replace(definition,before_text,'if not public.construction_project_access_v1(p_actor_user_id,project.id,true) then raise exception ''只有具有施工規劃管理權限的負責人或管理員可勾選完成。'';');
 execute definition;
end $$;

create or replace function public.construction_scope_v1(p_actor_user_id uuid,p_project_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare data jsonb; plans jsonb; today date:=(now() at time zone 'Asia/Taipei')::date;
begin
 data:=public.construction_scope_without_progress_v1(p_actor_user_id,p_project_id);
 -- Aggregate only already-authorized plans and non-private rows. Raw worker
 -- notes continue to use the original ownership filter in the base projection.
 with authorized as (select value p from jsonb_array_elements(data->'construction_plans')),
 logs as (
  select l.* from public.site_work_logs l join authorized a on l.construction_plan_id=(a.p->>'id')::uuid
  where l.deleted_at is null and l.work_type='工程施工' and l.status in ('in_progress','completed') and l.log_date<=today and public.erp_private_json_visible_v1(to_jsonb(l))
 ), enriched as (
 select p,coalesce((select jsonb_agg(log_day order by log_day) from (select distinct l.log_date as log_day from logs l where l.construction_plan_id=(p->>'id')::uuid) d),'[]') dates,
  coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object(
   'worked_days',(select count(distinct l.log_date) from logs l where l.construction_item_id=i.id),
   'log_dates',coalesce((select jsonb_agg(log_day order by log_day) from (select distinct l.log_date as log_day from logs l where l.construction_item_id=i.id) d),'[]')) order by i.sort_order,i.id)
   from public.construction_plan_items i where i.construction_plan_id=(p->>'id')::uuid and i.deleted_at is null),'[]') items
 from authorized
 ), measured as (
 select *,jsonb_array_length(dates) days,jsonb_array_length(items) total,
 (select count(*)::int from jsonb_array_elements(items) i where (i->>'is_completed')::boolean) done,
 (select coalesce(jsonb_agg(jsonb_build_object('id',i->>'id','title',i->>'title')),'[]') from jsonb_array_elements(items) i where not (i->>'is_completed')::boolean and (i->>'worked_days')::int=0) unstarted
 from enriched), calculated as (select *,public.construction_completion_totals_v1(items,(p->>'planned_days')::integer,p->>'status') completion from measured)
 select coalesce(jsonb_agg(p||jsonb_build_object(
 'items',items,'worked_days',days,'completed_days',completion->'completed_days','work_dates',dates,'item_count',total,'completed_item_count',done,
 'completion_percent',completion->'completion_percent',
 'progress_percent',completion->'completion_percent',
 'remaining_days',case when (p->>'planned_days')::integer>0 then greatest((p->>'planned_days')::integer-days,0) end,
 'contract_start_date',(select contract_start_date from public.projects where id=(p->>'project_id')::uuid),
 'contract_end_date',(select contract_end_date from public.projects where id=(p->>'project_id')::uuid),
 'contract_remaining_days',(select contract_end_date-today from public.projects where id=(p->>'project_id')::uuid),
 'contract_completed_on',(select completed_on from public.projects where id=(p->>'project_id')::uuid),
 'contract_overdue',(select coalesce(project.contract_end_date<today
   and ((project.status<>'completed' and not exists(select 1 from public.construction_plan_items i join public.construction_plans c on c.id=i.construction_plan_id where c.project_id=project.id and c.deleted_at is null and c.status<>'cancelled' and i.deleted_at is null and public.erp_private_json_visible_v1(to_jsonb(c))))
    or exists(select 1 from public.construction_plan_items i join public.construction_plans c on c.id=i.construction_plan_id where c.project_id=project.id and c.deleted_at is null and c.status<>'cancelled' and i.deleted_at is null and not i.is_completed and public.erp_private_json_visible_v1(to_jsonb(c)))),false) from public.projects project where project.id=(p->>'project_id')::uuid),
 'overrun_days',case when p->>'planned_days' is not null then greatest(days-(p->>'planned_days')::int,0) end,
 'warning_after_days',(p->>'warning_work_days')::integer,
 'progress_alert',alert->'progress_alert','progress_gap',alert->'progress_gap',
 'unstarted_items',unstarted,
 'needs_attention',alert->'progress_alert',
 'can_complete_items',p->>'status'<>'cancelled' and (p->>'can_manage')::boolean
 ) order by p->>'construction_date',p->>'created_at',p->>'id'),'[]') into plans from calculated cross join lateral(select public.construction_progress_alert_v1(days,total,done,(p->>'warning_work_days')::integer,(p->>'warning_min_progress')::numeric,p->>'status') alert) a;
 return jsonb_set(data,'{construction_plans}',plans);
end $$;

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
 if nullif(p_work_type,'') is not null and p_work_type not in ('construction','repair') then raise exception '統計報表僅納入工程施工與維修/查修工作內容。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 select coalesce(array_agg(p.id),'{}') into allowed from public.projects p
 join public.app_users u on u.id=p_actor_user_id and u.is_active
 join public.app_roles role on role.code=u.role
 where p.deleted_at is null and p.project_type in ('construction','repair')
 and (nullif(p_work_type,'') is null or p.project_type=p_work_type)
 and public.erp_private_json_visible_v1(to_jsonb(p))
 and (not role.project_scoped or exists(select 1 from public.project_workers w
 where w.project_id=p.id and w.user_id=u.id and (w.can_view or w.is_assignee)));
 if p_project_id is not null and not(p_project_id=any(allowed)) then raise exception '找不到工作內容或沒有統計查看權限。'; end if;
 price_visible:=p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','VIEW');
 select jsonb_build_object('work_types',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.erp_work_content_types_v1() t where t.code in ('construction','repair')),
 'projects',coalesce((select jsonb_agg(to_jsonb(p) order by p.project_code) from public.projects p where p.id=any(allowed)),'[]'),
 'customers',coalesce((select jsonb_agg(to_jsonb(c)) from public.customers c where c.id in(select customer_id from public.projects where id=any(allowed))),'[]'),
 'customer_departments',coalesce((select jsonb_agg(to_jsonb(d)) from public.customer_departments d where d.customer_id in(select customer_id from public.projects where id=any(allowed))),'[]'),
 'price_permissions',jsonb_build_object('view',price_visible,'create',p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','CREATE'),
 'update',p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','UPDATE'),'delete',p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','DELETE'))) into result;
 result:=result||jsonb_build_object('managerPerformanceVisible',public.has_app_permission_v1(p_actor_user_id,'projects','UPDATE'),
 'managerPerformance',public.construction_manager_performance_v1(p_actor_user_id,allowed));
 if p_project_id is null then return result; end if;
 with logs as materialized (
 select l.* from public.site_work_logs l where l.project_id=p_project_id and l.deleted_at is null
 and l.work_type not in ('文書作業','場勘') and l.status in ('in_progress','completed') and l.log_date<=(now() at time zone 'Asia/Taipei')::date
 and (p_from is null or l.log_date>=p_from) and (p_to is null or l.log_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(l))),
 materials as materialized (
 select r.*,case when r.quantity_unit='meter' then r.quantity else r.quantity*coalesce(i.meters_per_unit,1) end report_quantity,i.item_name,i.brand,i.model,case when i.meters_per_unit is not null then '米' else i.unit end unit,i.category_id,
 coalesce(nullif(btrim(c.name),''),'未分類') category_name
 from public.pickup_records r join public.inventory_items i on i.id=r.inventory_item_id
 left join public.product_categories c on c.id=i.category_id
 where r.project_id=p_project_id and (p_from is null or r.pickup_date>=p_from) and (p_to is null or r.pickup_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(r))),
 workers as materialized (
 select w.user_id,l.id,l.log_date,u.display_name,u.is_active from logs l
 join public.site_work_log_workers w on w.work_log_id=l.id join public.app_users u on u.id=w.user_id where l.reporter_on_site or w.user_id is distinct from l.reporter_user_id),
 contractor_days as (select log_date,max(subcontractor_count) headcount,count(*) records from logs where subcontractor_count>0 group by log_date),
 returned as materialized (
 select l.id,l.inventory_item_id,case when l.quantity_unit='meter' then l.quantity else l.quantity*coalesce(i.meters_per_unit,1) end quantity,d.return_date,d.document_no,d.id document_id,u.display_name account
 from public.site_return_lines l join public.inventory_items i on i.id=l.inventory_item_id join public.site_return_documents d on d.id=l.document_id
 join public.app_users u on u.id=d.created_by_user_id
 where d.project_id=p_project_id and d.status='active' and l.quantity>0
 and (p_from is null or d.return_date>=p_from) and (p_to is null or d.return_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(d))),
 issued_totals as (select inventory_item_id,sum(report_quantity) quantity,count(*) records,min(pickup_date) first_date,max(pickup_date) recent_date from materials group by inventory_item_id),
 returned_totals as (select inventory_item_id,sum(quantity) quantity,count(*) records,min(return_date) first_date,max(return_date) recent_date from returned group by inventory_item_id),
 mat as (
 select i.id,i.item_name name,i.brand,i.model,case when i.meters_per_unit is not null then '米' else coalesce(nullif(i.unit,''),'未標示單位') end unit,
 i.unit package_unit,coalesce(i.meters_per_unit,1) meters_per_unit,
 i.category_id "categoryId",coalesce(nullif(btrim(c.name),''),'未分類') "categoryName",
 coalesce(issued.quantity,0) "issuedQuantity",coalesce(ret.quantity,0) "returnedQuantity",
 coalesce(issued.quantity,0)-coalesce(ret.quantity,0) quantity,
 coalesce(issued.records,0) "recordCount",coalesce(ret.records,0) "returnRecordCount",
 least(issued.first_date,ret.first_date) "firstDate",greatest(issued.recent_date,ret.recent_date) "recentDate"
 from issued_totals issued full join returned_totals ret using(inventory_item_id)
 join public.inventory_items i on i.id=coalesce(issued.inventory_item_id,ret.inventory_item_id)
 left join public.product_categories c on c.id=i.category_id),
 material_stats as (
 select m."categoryId",m."categoryName",m.unit,m.quantity,m."recordCount",
 to_jsonb(m)||case when price_visible then jsonb_build_object('unit_price',coalesce(manual.unit_price,latest.unit_price)/m.meters_per_unit,'package_unit_price',coalesce(manual.unit_price,latest.unit_price),
 'amount',round(m.quantity*coalesce(manual.unit_price,latest.unit_price)/m.meters_per_unit,2),
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
 where s.inventory_item_id=m.id and d.receipt_delivery_state is distinct from 'pending' and s.unit_price is not null and public.erp_private_json_visible_v1(to_jsonb(s))
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
 union all select 'subcontractor','代工','代工（天）',true,sum(headcount),sum(records),min(log_date),max(log_date),max(log_date) from contractor_days having count(*)>0),
 labor_days as (
 select user_id::text worker_id,max(display_name) worker_name,log_date,1::bigint headcount from workers group by user_id,log_date
 union all select 'subcontractor','代工',log_date,headcount from contractor_days),
 labor_costs as (
 select d.*,c.daily_wage,round(d.headcount*c.daily_wage,2) labor_amount,c.row_version wage_row_version
 from labor_days d left join public.accounting_worker_wages c on price_visible and c.project_id=p_project_id
 and coalesce(c.worker_user_id::text,'subcontractor')=d.worker_id and c.work_date=d.log_date),
 worker_json as (select w.*,to_jsonb(w)||jsonb_build_object('unit','天')
 ||case when price_visible then (select jsonb_build_object('labor_amount',sum(c.labor_amount),'unpricedDayCount',count(*) filter(where c.daily_wage is null)) from labor_costs c where c.worker_id=w.id) else '{}'::jsonb end data
 from worker_stats w)
 select result||jsonb_build_object('report',jsonb_build_object('error','',
 'materialStats',coalesce((select jsonb_agg(data order by (data->>'recordCount')::int desc,data->>'id') from material_stats),'[]'),
 'materialCategoryStats',coalesce((select jsonb_agg(data order by data->>'name',data->>'id') from category_json),'[]'),
 'workerStats',coalesce((select jsonb_agg(w.data order by w."constructionDays" desc,w.id) from worker_json w),'[]'),
 'returnRows',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'date',r.return_date,'documentId',r.document_id,'documentNo',r.document_no,'itemId',r.inventory_item_id,'categoryId',i.category_id,'quantity',r.quantity,'account',r.account,'item',jsonb_build_object('name',i.item_name,'brand',i.brand,'model',i.model,'unit',case when i.meters_per_unit is not null then '米' else i.unit end)) order by r.return_date desc,r.id) from returned r join public.inventory_items i on i.id=r.inventory_item_id),'[]'),
 'quantityBasis','issued_minus_returns',
 'materialRows',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'date',m.pickup_date,'itemId',m.inventory_item_id,
 'categoryId',m.category_id,'categoryName',m.category_name,'quantity',m.report_quantity,'account',m.created_by_username,'item',jsonb_build_object('name',m.item_name,'brand',m.brand,'model',m.model,'unit',m.unit)) order by m.pickup_date desc,m.id) from materials m),'[]'),
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
  where l.deleted_at is null and l.work_type='工程施工' and l.status in ('in_progress','completed') and l.log_date<=(now() at time zone 'Asia/Taipei')::date
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
   'remaining_days',case when p.planned_days>0 then greatest(p.planned_days-p.worked_days,0) end,
   'item_count',jsonb_array_length(p.items),
   'warning_after_days',p.warning_work_days,'needs_attention',alert->'progress_alert','progress_alert',alert->'progress_alert','progress_gap',alert->'progress_gap',
   'contract_start_date',(select contract_start_date from public.projects where id=p.project_id),
   'contract_end_date',(select contract_end_date from public.projects where id=p.project_id),
   'overrun_days',case when p.planned_days>0 then greatest(p.worked_days-p.planned_days,0) else 0 end,
   'progress_percent',p.completion_percent,
   'can_open',public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') and public.construction_project_access_v1(p_actor_user_id,p.project_id,false),
   'completed_item_count',(select count(*) from item_stats i where i.construction_plan_id=p.id and i.is_completed)) data from plan_stats p cross join lateral(select public.construction_progress_alert_v1(p.worked_days,jsonb_array_length(p.items),
   (select count(*)::integer from item_stats i where i.construction_plan_id=p.id and i.is_completed),p.warning_work_days,p.warning_min_progress,p.status) alert) a
 )
 select result||jsonb_build_object('report',(result->'report')||jsonb_build_object(
  'managerPerformanceVisible',result->'managerPerformanceVisible','managerPerformance',result->'managerPerformance',
  'project', (select jsonb_build_object('id',p.id,'code',p.project_code,'name',p.name,'type',t.label,'status',p.status,
   'customer',c.name,'owner',coalesce(nullif(p.assigned_to,''),(select string_agg(u.display_name,'、' order by u.id) from public.project_workers w join public.app_users u on u.id=w.user_id where w.project_id=p.id and w.is_assignee)),
   'createdAt',p.created_at,'completedOn',p.completed_on,'date',p.project_date,
   'contractStartDate',p.contract_start_date,'contractEndDate',p.contract_end_date,
   'remainingContractDays',p.contract_end_date-(now() at time zone 'Asia/Taipei')::date,
   'contractOverdue',coalesce(p.contract_end_date<(now() at time zone 'Asia/Taipei')::date
    and ((p.status<>'completed' and not exists(select 1 from item_stats i join plans c on c.id=i.construction_plan_id where c.status<>'cancelled'))
     or exists(select 1 from item_stats i join plans c on c.id=i.construction_plan_id where c.status<>'cancelled' and not i.is_completed)),false))
   from public.projects p join public.customers c on c.id=p.customer_id left join public.erp_work_content_types_v1() t on t.code=p.project_type where p.id=p_project_id),
  'constructionPlans',coalesce((select jsonb_agg(data order by data->>'construction_date',data->>'id') from enriched),'[]'),
  'constructionSummary',jsonb_build_object(
   'planCount',(select count(*) from plans),
   'plannedDays',(select coalesce(sum(planned_days),0) from plan_stats where status<>'cancelled'),
   'completedDays',(select coalesce(sum(completed_days),0) from plan_stats where status<>'cancelled'),
   'remainingDays',(select coalesce(sum(greatest(planned_days-worked_days,0)),0) from plan_stats where status<>'cancelled' and planned_days>0),
   'unsetPlanCount',(select count(*) from plans where status<>'cancelled' and coalesce(planned_days,0)=0),
   'workedDays',(select coalesce(sum(worked_days),0) from plan_stats where status<>'cancelled'),
   'progressPercent',(select case when count(*)>0 then round(100.0*count(*) filter(where i.is_completed)/count(*),1) end from item_stats i join plans c on c.id=i.construction_plan_id where c.status<>'cancelled'),
   'totalItemCount',(select count(*) from item_stats i join plans c on c.id=i.construction_plan_id where c.status<>'cancelled'),
   'completedItemCount',(select count(*) from item_stats i join plans c on c.id=i.construction_plan_id where c.status<>'cancelled' and i.is_completed),
   'delayedPlanCount',(select count(*) from enriched where (data->>'progress_alert')::boolean),
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
-- Manager statistics aggregate only report-authorized projects. Membership is
-- the existing project_workers/is_assignee relation, never a parallel roster.
create function public.construction_manager_performance_v1(p_actor_user_id uuid,p_allowed_projects uuid[])
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'projects','UPDATE') then return '[]'; end if;
 if not (public.has_app_permission_v1(p_actor_user_id,'reports','VIEW') or public.has_app_permission_v1(p_actor_user_id,'accounting_reports','VIEW')) then raise exception '沒有工作內容統計報表查看權限。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 with permitted as materialized (
  select p.* from public.projects p join public.app_users u on u.id=p_actor_user_id and u.is_active join public.app_roles role on role.code=u.role
  where p.id=any(p_allowed_projects) and p.deleted_at is null and p.project_type='construction' and public.erp_private_json_visible_v1(to_jsonb(p))
   and (not role.project_scoped or exists(select 1 from public.project_workers w where w.project_id=p.id and w.user_id=u.id and (w.can_view or w.is_assignee)))
 ), plans as materialized (
  select c.* from public.construction_plans c join permitted p on p.id=c.project_id where c.deleted_at is null and c.status<>'cancelled' and public.erp_private_json_visible_v1(to_jsonb(c))
 ), plan_counts as (
  select p.*,i.total,i.done,l.days,
   (public.construction_progress_alert_v1(l.days,i.total,i.done,p.warning_work_days,p.warning_min_progress,p.status)->>'progress_alert')::boolean delayed
  from plans p cross join lateral (select count(*)::integer total,count(*) filter(where i.is_completed)::integer done from public.construction_plan_items i where i.construction_plan_id=p.id and i.deleted_at is null) i
  cross join lateral(select count(distinct l.log_date)::integer days from public.site_work_logs l where l.construction_plan_id=p.id and l.deleted_at is null and l.work_type='工程施工'
   and l.status in ('in_progress','completed') and l.log_date<=(now() at time zone 'Asia/Taipei')::date and public.erp_private_json_visible_v1(to_jsonb(l))) l
 ), projects as (
  select p.*,c.name customer,t.total,t.done,t.delayed,
   case when t.total>0 then t.done=t.total else p.status='completed' end monitor_completed,
   coalesce(p.contract_end_date<(now() at time zone 'Asia/Taipei')::date and (case when t.total>0 then t.done<t.total else p.status<>'completed' end),false) overdue
  from permitted p join public.customers c on c.id=p.customer_id
  cross join lateral(select coalesce(sum(total),0) total,coalesce(sum(done),0) done,count(*) filter(where delayed) delayed from plan_counts where project_id=p.id)t
 ), owners as (
  select p.id project_id,u.id::text manager_id,u.display_name name from projects p join public.project_workers w on w.project_id=p.id and w.is_assignee join public.app_users u on u.id=w.user_id
  union all select p.id,case when nullif(btrim(p.assigned_to),'') is not null then 'legacy:'||btrim(p.assigned_to) end,coalesce(nullif(btrim(p.assigned_to),''),'未指定負責人') from projects p
   where not exists(select 1 from public.project_workers w where w.project_id=p.id and w.is_assignee)
 ), rows as (
  select o.manager_id "managerId",o.name,count(*) "projectCount",count(*) filter(where p.monitor_completed) "completedProjectCount",
   count(*) filter(where not p.monitor_completed) "inProgressProjectCount",count(*) filter(where p.overdue) "overdueProjectCount",sum(p.delayed) "delayedPlanCount",
   count(*) filter(where p.monitor_completed and p.status='completed' and p.completed_on is not null and p.contract_end_date is not null) "onTimeEligibleCount",
   count(*) filter(where p.monitor_completed and p.status='completed' and p.completed_on is not null and p.contract_end_date is not null and p.completed_on<=p.contract_end_date) "onTimeCompletedCount",
   round(100.0*count(*) filter(where p.monitor_completed and p.status='completed' and p.completed_on is not null and p.contract_end_date is not null and p.completed_on<=p.contract_end_date)
    /nullif(count(*) filter(where p.monitor_completed and p.status='completed' and p.completed_on is not null and p.contract_end_date is not null),0),1) "onTimeCompletionRate",
   jsonb_agg(p.id order by p.project_code,p.id) "projectIds",
   jsonb_agg(jsonb_build_object('id',p.id,'code',p.project_code,'name',p.name,'customer',p.customer,'status',p.status,
    'progressPercent',case when p.total>0 then round(100.0*p.done/p.total,1) end,'contractEndDate',p.contract_end_date,'contractOverdue',p.overdue,'delayedPlanCount',p.delayed,'completedOn',p.completed_on) order by p.project_code,p.id) projects
   from owners o join projects p on p.id=o.project_id group by o.manager_id,o.name
 ) select coalesce(jsonb_agg(to_jsonb(rows) order by name,"managerId"),'[]') into result from rows;
 return result;
end $$;

revoke all on function public.set_project_contract_dates_v1(uuid,uuid,integer,date,date),
 public.upsert_erp_project_contract_v1(uuid,jsonb),public.save_construction_plan_v1(uuid,jsonb,boolean),
 public.save_construction_plan_without_monitoring_v1(uuid,jsonb,boolean),
 public.construction_completion_totals_v1(jsonb,integer,text),public.construction_progress_alert_v1(integer,integer,integer,integer,numeric,text),
 public.construction_scope_v1(uuid,uuid),public.work_content_report_v1(uuid,uuid,date,date,text,boolean),
 public.construction_manager_performance_v1(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.set_project_contract_dates_v1(uuid,uuid,integer,date,date),
 public.upsert_erp_project_contract_v1(uuid,jsonb),public.save_construction_plan_v1(uuid,jsonb,boolean),
 public.save_construction_plan_without_monitoring_v1(uuid,jsonb,boolean),
 public.construction_completion_totals_v1(jsonb,integer,text),public.construction_progress_alert_v1(integer,integer,integer,integer,numeric,text),
 public.construction_scope_v1(uuid,uuid),public.work_content_report_v1(uuid,uuid,date,date,text,boolean),
 public.construction_manager_performance_v1(uuid,uuid[]) to service_role;
notify pgrst,'reload schema';
commit;
