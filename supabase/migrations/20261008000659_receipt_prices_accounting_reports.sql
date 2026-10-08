begin;
set local lock_timeout='5s';

-- Nullable per-receipt-line price; never backfill historical cost or stock values.
alter table public.stock_receipts add column unit_price numeric(14,2)
  check(unit_price>=0 and unit_price<1000000000000);
create index stock_receipts_latest_price_idx on public.stock_receipts(inventory_item_id,receipt_date desc,created_at desc,id desc) where unit_price is not null;
do $$ declare definition text; begin
 select pg_get_constraintdef(oid) into definition from pg_constraint
 where conrelid='public.role_permissions'::regclass and conname='role_permissions_module_check';
 if definition is null then raise exception 'Missing RBAC module constraint'; end if;
 alter table public.role_permissions drop constraint role_permissions_module_check;
 execute 'alter table public.role_permissions add constraint role_permissions_module_check check (('
 ||substring(definition from 8 for length(definition)-8)||') or module in (''purchase_prices'',''accounting_reports'',''accounting_prices''))';
end $$;
insert into public.role_permissions(role_code,module,can_view,can_create,can_update,can_delete)
select r.code,m.module,r.code='admin',r.code='admin',r.code='admin',r.code='admin'
from public.app_roles r cross join (values('purchase_prices'),('accounting_reports'),('accounting_prices')) m(module);

create table public.accounting_material_prices(
 project_id uuid not null references public.projects(id) on delete restrict,
 inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
 unit_price numeric(14,2) not null check(unit_price>=0 and unit_price<1000000000000),
 row_version integer not null default 1,
 updated_by_user_id uuid not null references public.app_users(id),
 updated_at timestamptz not null default now(),
 primary key(project_id,inventory_item_id)
);
create index accounting_material_prices_item_idx on public.accounting_material_prices(inventory_item_id);
create index accounting_material_prices_actor_idx on public.accounting_material_prices(updated_by_user_id);
alter table public.accounting_material_prices enable row level security;
revoke all on public.accounting_material_prices from public,anon,authenticated;
grant select,insert,update,delete on public.accounting_material_prices to service_role;

-- Both websites use this one backend aggregation; no client-side re-summing.
create function public.work_content_report_v1(p_actor_user_id uuid,p_project_id uuid default null,
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
 return result;
end $report$;

create function public.save_accounting_material_price_v1(p_actor_user_id uuid,p_project_id uuid,p_item_id uuid,
 p_unit_price numeric,p_row_version integer default null)
returns jsonb language plpgsql security invoker set search_path='' as $price$
declare old public.accounting_material_prices; after_row public.accounting_material_prices; needed text;
begin
 perform public.work_content_report_v1(p_actor_user_id,p_project_id,null,null,null,true);
 perform pg_advisory_xact_lock(hashtextextended(p_project_id::text||p_item_id::text,0));
 select * into old from public.accounting_material_prices where project_id=p_project_id and inventory_item_id=p_item_id for update;
 if old.row_version is distinct from p_row_version then raise exception '價格已被其他人修改，請重新讀取。'; end if;
 needed:=case when p_unit_price is null then 'DELETE' when old.project_id is null then 'CREATE' else 'UPDATE' end;
 if not public.has_app_permission_v1(p_actor_user_id,'accounting_prices','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'accounting_prices',needed) then raise exception '沒有此用料價格操作權限。'; end if;
 if not exists(select 1 from public.pickup_records where project_id=p_project_id and inventory_item_id=p_item_id) then raise exception '此工作內容沒有該用料品項。'; end if;
 if p_unit_price is not null and (p_unit_price<0 or p_unit_price>=1000000000000 or p_unit_price<>round(p_unit_price,2)) then raise exception '單價需為非負金額，最多小數二位。'; end if;
 if p_unit_price is null then
  delete from public.accounting_material_prices where project_id=p_project_id and inventory_item_id=p_item_id;
 else
  insert into public.accounting_material_prices(project_id,inventory_item_id,unit_price,updated_by_user_id)
  values(p_project_id,p_item_id,p_unit_price,p_actor_user_id) on conflict(project_id,inventory_item_id) do update
  set unit_price=excluded.unit_price,updated_by_user_id=excluded.updated_by_user_id,updated_at=now(),row_version=accounting_material_prices.row_version+1 returning * into after_row;
 end if;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('accounting_material_prices',p_project_id,case when p_unit_price is null then 'delete' when old.project_id is null then 'insert' else 'update' end,to_jsonb(old),to_jsonb(after_row),'web',(select username from public.app_users where id=p_actor_user_id));
 return jsonb_build_object('saved',true,'row_version',after_row.row_version);
end $price$;
revoke all on function public.work_content_report_v1(uuid,uuid,date,date,text,boolean),public.save_accounting_material_price_v1(uuid,uuid,uuid,numeric,integer) from public,anon,authenticated;
grant execute on function public.work_content_report_v1(uuid,uuid,date,date,text,boolean),public.save_accounting_material_price_v1(uuid,uuid,uuid,numeric,integer) to service_role;

create function public.save_stock_receipt_document_v3(p_document_id uuid,p_create boolean,p_existing jsonb,
 p_receipt_date date,p_supplier_id uuid,p_rows jsonb,p_customer_ids uuid[],p_customer_departments jsonb,
 p_actor_user_id uuid,p_document_no text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; line jsonb; old_price numeric; price numeric; row_id uuid; row_index integer:=0; needed text;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_document_id::text,0));
 for line in select value from jsonb_array_elements(p_rows) loop
  if line ? 'unit_price' then
   if jsonb_typeof(line->'unit_price') not in ('number','null') then raise exception '單價須為數字或空白。'; end if;
   price:=(line->>'unit_price')::numeric;
   if price<0 or price>=1000000000000 or price<>round(price,2) then raise exception '單價須為非負數，最多兩位小數。'; end if;
   old_price:=null;
   select unit_price into old_price from public.stock_receipts where id=nullif(line->>'id','')::uuid for update;
   if price is distinct from old_price then
    needed:=case when price is null then 'DELETE' when old_price is null then 'CREATE' else 'UPDATE' end;
    if not public.has_app_permission_v1(p_actor_user_id,'purchase_prices',needed) then raise exception '沒有進貨價格操作權限。'; end if;
   end if;
  end if;
 end loop;
 result:=public.save_stock_receipt_document_v2(p_document_id,p_create,p_existing,p_receipt_date,p_supplier_id,p_rows,p_customer_ids,p_customer_departments,p_actor_user_id,p_document_no);
 for line in select value from jsonb_array_elements(p_rows) loop
  row_id:=(result->'ids'->>row_index)::uuid; row_index:=row_index+1;
  if line ? 'unit_price' then
   update public.stock_receipts set unit_price=(line->>'unit_price')::numeric
    where id=row_id and unit_price is distinct from (line->>'unit_price')::numeric;
  end if;
 end loop;
 return result;
end $$;
revoke all on function public.save_stock_receipt_document_v3(uuid,boolean,jsonb,date,uuid,jsonb,uuid[],jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.save_stock_receipt_document_v3(uuid,boolean,jsonb,date,uuid,jsonb,uuid[],jsonb,uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
