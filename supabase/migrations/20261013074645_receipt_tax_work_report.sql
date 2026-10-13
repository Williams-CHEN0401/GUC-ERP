begin;
set local lock_timeout='5s';

-- One canonical source for the existing quotation money settings. No change to
-- quotation's default rate, TWD rounding or existing saved quotation versions.
create function public.erp_money_settings_v1() returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('currency','TWD','default_tax_rate_basis_points',500,
 'currency_scale',0,'quantity_scale',3,'rounding','round_half_away_from_zero');
$$;
do $$ declare s text; needle text; begin
 s:=pg_get_functiondef('public.private_base_quotation_options_v1(uuid)'::regprocedure);
 needle:=substring(s from 'jsonb_build_object\(\s*''currency'', ''TWD'',\s*''default_tax_rate_basis_points'', 500,\s*''quantity_scale'', 3,\s*''rounding'', ''round_half_away_from_zero''\s*\)');
 if needle is null then raise exception 'Quotation money settings source changed; review before migration'; end if;
 execute replace(s,needle,'public.erp_money_settings_v1()');
end $$;

-- Reuse the existing document registry and stock ledger. Unknown legacy tax
-- semantics and project associations remain NULL; never infer from a name.
alter table public.stock_transaction_documents
 add column receipt_tax_mode text,
 add column receipt_tax_rate_basis_points integer,
 add column receipt_project_id uuid references public.projects(id) on delete restrict,
 add constraint stock_receipt_tax_settings_check check (
   (receipt_tax_mode is null and receipt_tax_rate_basis_points is null)
   or (kind='receipt' and receipt_tax_mode is not null and receipt_tax_mode in ('exclusive','inclusive')
       and receipt_tax_rate_basis_points is not null and receipt_tax_rate_basis_points between 0 and 10000)),
 add constraint stock_receipt_project_kind_check check(receipt_project_id is null or kind='receipt');
create index stock_documents_receipt_project_idx on public.stock_transaction_documents(receipt_project_id) where receipt_project_id is not null;

create function public.receipt_money_totals_v1(p_lines jsonb,p_mode text,p_rate integer)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare input_amount numeric; net numeric; tax numeric; total numeric; missing integer;
begin
 if p_mode is not null and p_mode not in ('exclusive','inclusive') then raise exception '計價模式不正確。'; end if;
 if (p_mode is null)<>(p_rate is null) or p_rate<0 or p_rate>10000 then raise exception '稅率設定不正確。'; end if;
 if exists(select 1 from jsonb_array_elements(p_lines) r where
   jsonb_typeof(r->'quantity')<>'number' or (r->>'quantity')::numeric<=0
   or (r->>'quantity')::numeric<>trunc((r->>'quantity')::numeric)
   or (r->>'unit_price')::numeric<0 or (r->>'unit_price')::numeric>=1000000000000
   or (r->>'unit_price')::numeric<>round((r->>'unit_price')::numeric,2)) then raise exception '進貨數量或單價格式不正確。'; end if;
 select coalesce(sum(round((r->>'quantity')::numeric*(r->>'unit_price')::numeric,0)),0),
 count(*) filter(where r->>'unit_price' is null) into input_amount,missing from jsonb_array_elements(p_lines) r;
 if p_mode is not null and missing=0 then
  if p_mode='inclusive' then total:=input_amount;net:=round(total*10000/(10000+p_rate),0);tax:=total-net;
  else net:=input_amount;tax:=round(net*p_rate/10000,0);total:=net+tax;end if;
 end if;
 if input_amount>9007199254740991 or total>9007199254740991 then raise exception '單據金額超過可精確計算的上限。';end if;
 return jsonb_build_object('mode',p_mode,'tax_rate_basis_points',p_rate,'currency','TWD','currency_scale',0,
 'input_amount',input_amount,'net_amount',net,'tax_amount',tax,'total_amount',total,'missing_price_count',missing);
end $$;

create function public.stock_receipt_financials_v1(p_document_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select public.receipt_money_totals_v1(
 coalesce((select jsonb_agg(jsonb_build_object('quantity',s.quantity,'unit_price',s.unit_price))
 from public.stock_receipts s where s.receipt_document_id=d.id),'[]'),d.receipt_tax_mode,d.receipt_tax_rate_basis_points)
 from public.stock_transaction_documents d where d.kind='receipt' and d.id=p_document_id;
$$;

create function public.receipt_document_context_v1(p_actor_user_id uuid,p_document_ids uuid[])
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; can_price boolean;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') then raise exception '沒有進貨查看權限。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 can_price:=public.has_app_permission_v1(p_actor_user_id,'purchase_prices','VIEW');
 select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'receipt_project_id',d.receipt_project_id)||
 case when can_price then jsonb_build_object('receipt_financials',public.stock_receipt_financials_v1(d.id)) else '{}'::jsonb end),'[]') into result
 from public.stock_transaction_documents d where d.kind='receipt' and d.id=any(p_document_ids)
 and exists(select 1 from public.stock_receipts s where s.receipt_document_id=d.id)
 and not exists(select 1 from public.stock_receipts s where s.receipt_document_id=d.id and not public.erp_private_json_visible_v1(to_jsonb(s)))
 and (d.receipt_project_id is null or exists(select 1 from public.projects p where p.id=d.receipt_project_id and public.erp_private_json_visible_v1(to_jsonb(p))));
 return jsonb_build_object('documents',result,'money_settings',public.erp_money_settings_v1());
end $$;

create function public.save_stock_receipt_document_v4(p_document_id uuid,p_create boolean,p_existing jsonb,
 p_receipt_date date,p_supplier_id uuid,p_rows jsonb,p_customer_ids uuid[],p_customer_departments jsonb,
 p_actor_user_id uuid,p_document_no text default null,p_metadata jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.stock_transaction_documents; result jsonb; financials jsonb; mode text; rate integer; project uuid; needed text;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_document_id::text,0));
 select * into d from public.stock_transaction_documents where kind='receipt' and id=p_document_id for update;
 if jsonb_typeof(p_metadata)<>'object' or exists(select 1 from jsonb_object_keys(p_metadata) k where k not in ('tax_mode','tax_rate_basis_points','project_id')) then raise exception '進貨單設定不正確。';end if;
 mode:=d.receipt_tax_mode;rate:=d.receipt_tax_rate_basis_points;project:=d.receipt_project_id;
 if p_metadata ? 'tax_mode' or p_metadata ? 'tax_rate_basis_points' then
  if not (p_metadata ? 'tax_mode' and p_metadata ? 'tax_rate_basis_points') then raise exception '請完整填寫計價模式與稅率。';end if;
  if jsonb_typeof(p_metadata->'tax_rate_basis_points')<>'number' or (p_metadata->>'tax_rate_basis_points')::numeric<>trunc((p_metadata->>'tax_rate_basis_points')::numeric) then raise exception '稅率不正確。';end if;
  mode:=p_metadata->>'tax_mode';rate:=(p_metadata->>'tax_rate_basis_points')::integer;
  if mode not in ('exclusive','inclusive') or mode is null or rate is null or rate<0 or rate>10000 then raise exception '計價模式或稅率不正確。';end if;
  if mode is distinct from d.receipt_tax_mode or rate is distinct from d.receipt_tax_rate_basis_points then
   needed:=case when d.receipt_tax_mode is null then 'CREATE' else 'UPDATE' end;
   if not public.has_app_permission_v1(p_actor_user_id,'purchase_prices','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'purchase_prices',needed) then raise exception '沒有進貨價格操作權限。';end if;
  end if;
 end if;
 if p_metadata ? 'project_id' then project:=nullif(p_metadata->>'project_id','')::uuid; end if;
 if project is not null then
  perform public.erp_private_prepare_v1(p_actor_user_id);
  if not public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') or not exists(
   select 1 from public.projects p join public.app_users u on u.id=p_actor_user_id and u.is_active
   join public.app_roles r on r.code=u.role where p.id=project and p.deleted_at is null
   and p.customer_id=any(p_customer_ids) and public.erp_private_json_visible_v1(to_jsonb(p))
   and (not r.project_scoped or exists(select 1 from public.project_workers w where w.project_id=p.id and w.user_id=u.id and (w.can_view or w.is_assignee))))
   then raise exception '所選工作內容不屬於訂貨客戶，或沒有查看權限。';end if;
 end if;
 -- Existing v3 checks stock permissions, per-price CREATE/UPDATE/DELETE, private
 -- visibility, optimistic row versions, numbering and inventory in one transaction.
 result:=public.save_stock_receipt_document_v3(p_document_id,p_create,p_existing,p_receipt_date,p_supplier_id,p_rows,p_customer_ids,p_customer_departments,p_actor_user_id,p_document_no);
 update public.stock_transaction_documents set receipt_tax_mode=mode,receipt_tax_rate_basis_points=rate,receipt_project_id=project where kind='receipt' and id=p_document_id;
 if (mode,rate,project) is distinct from (d.receipt_tax_mode,d.receipt_tax_rate_basis_points,d.receipt_project_id) then
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
  values('stock_transaction_documents',p_document_id,'update',jsonb_build_object('receipt_tax_mode',d.receipt_tax_mode,'receipt_tax_rate_basis_points',d.receipt_tax_rate_basis_points,'receipt_project_id',d.receipt_project_id),
  jsonb_build_object('receipt_tax_mode',mode,'receipt_tax_rate_basis_points',rate,'receipt_project_id',project),'web',(select username from public.app_users where id=p_actor_user_id));
 end if;
 -- Compute from saved quantities/prices, never accept client totals.
 financials:=public.stock_receipt_financials_v1(p_document_id);
 if public.has_app_permission_v1(p_actor_user_id,'purchase_prices','VIEW') then result:=result||jsonb_build_object('receipt_financials',financials);end if;
 return result;
end $$;

revoke all on function public.erp_money_settings_v1(),public.receipt_money_totals_v1(jsonb,text,integer),public.stock_receipt_financials_v1(uuid),public.receipt_document_context_v1(uuid,uuid[]),public.save_stock_receipt_document_v4(uuid,boolean,jsonb,date,uuid,jsonb,uuid[],jsonb,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.erp_money_settings_v1(),public.receipt_money_totals_v1(jsonb,text,integer),public.stock_receipt_financials_v1(uuid),public.receipt_document_context_v1(uuid,uuid[]),public.save_stock_receipt_document_v4(uuid,boolean,jsonb,date,uuid,jsonb,uuid[],jsonb,uuid,text,jsonb) to service_role;

-- The existing authorized report below is extended in place; no duplicate report.

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
 join public.site_work_log_workers w on w.work_log_id=l.id join public.app_users u on u.id=w.user_id),
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
 select user_id id,max(display_name) name,max(display_name)||'（'||left(user_id::text,8)||'）' label,
 bool_or(is_active) active,count(distinct log_date) "constructionDays",count(distinct id) "recordCount",
 min(log_date) "firstDate",max(log_date) "lastDate",max(log_date) "recentDate" from workers group by user_id)
 select result||jsonb_build_object('report',jsonb_build_object('error','',
 'materialStats',coalesce((select jsonb_agg(data order by (data->>'recordCount')::int desc,data->>'id') from material_stats),'[]'),
 'materialCategoryStats',coalesce((select jsonb_agg(data order by data->>'name',data->>'id') from category_json),'[]'),
 'workerStats',coalesce((select jsonb_agg(to_jsonb(w) order by w."constructionDays" desc,w.id) from worker_stats w),'[]'),
 'materialRows',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'date',m.pickup_date,'itemId',m.inventory_item_id,
 'categoryId',m.category_id,'categoryName',m.category_name,'quantity',m.quantity,'account',m.created_by_username,'item',jsonb_build_object('name',m.item_name,'brand',m.brand,'model',m.model,'unit',m.unit)) order by m.pickup_date desc,m.id) from materials m),'[]'),
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
    'taxAmount',(select sum((financials->>'tax_amount')::numeric) from documents),
    'totalAmount',(select sum((financials->>'total_amount')::numeric) from documents)),
   'receiptAssociationNote','僅列出以工作內容 ID 明確關聯的進貨單；未分配單據請至進貨管理補選工作內容。進貨歷史總額與領用量乘參考單價分開呈現，不合併加總。')) into result;
 end if;
 return result;
end $function$;
notify pgrst,'reload schema';
commit;
