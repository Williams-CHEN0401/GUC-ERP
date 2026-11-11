-- Preserve old quantities and unknown lengths; current item units are editable.
do $baseline$ begin
 if md5(replace(pg_get_functiondef('guard_cable_profile_v1()'::regprocedure),chr(13),''))<>'9c2731e081922fd3d62fecfaab0ac0e9' then raise exception 'Unexpected baseline: guard_cable_profile_v1';end if;
 if md5(replace(pg_get_functiondef('guard_inventory_opening_meters_v1()'::regprocedure),chr(13),''))<>'cc1f9e6e2b9a184ee73394a238a73cbc' then raise exception 'Unexpected baseline: guard_inventory_opening_meters_v1';end if;
 if md5(replace(pg_get_functiondef('save_site_return_v1(uuid,uuid,uuid,integer,text,date,uuid,uuid,jsonb,text)'::regprocedure),chr(13),''))<>'15fd8b6218a0280c7a48f9595691c990' then raise exception 'Unexpected baseline: save_site_return_v1';end if;
 if md5(replace(pg_get_functiondef('guard_site_return_pickups_v1()'::regprocedure),chr(13),''))<>'60fef85e39305d46659d8b1779364564' then raise exception 'Unexpected baseline: guard_site_return_pickups_v1';end if;
 if md5(replace(pg_get_functiondef('site_return_list_v1(uuid)'::regprocedure),chr(13),''))<>'850d218928e1049da147a003ad75bdf3' then raise exception 'Unexpected baseline: site_return_list_v1';end if;
 if md5(replace(pg_get_functiondef('erp_stock_totals_v1(uuid)'::regprocedure),chr(13),''))<>'b9a957ba9f415abb61a8e4f9012af54f' then raise exception 'Unexpected baseline: erp_stock_totals_v1';end if;
 if md5(replace(pg_get_functiondef('work_content_report_v1(uuid,uuid,date,date,text,boolean)'::regprocedure),chr(13),''))<>'9732cdb770416e3137b8ea758eb5e5ca' then raise exception 'Unexpected baseline: work_content_report_v1';end if;
end $baseline$;
alter table public.inventory_items add column legacy_unit text check(legacy_unit is null or length(btrim(legacy_unit)) between 1 and 30);
-- One immutable return adjustment per line/version/stock dimension.
drop index public.stock_adjustments_return_line_version_uidx;
create unique index stock_adjustments_return_line_version_uidx on public.stock_adjustments(site_return_line_id,site_return_version,quantity_unit) where site_return_line_id is not null;
-- Manual return corrections may reverse stock already used by later pickups.
-- Other adjustment sources retain their existing nonnegative invariant.
alter table public.stock_adjustments drop constraint stock_adjustments_after_quantity_check;
alter table public.stock_adjustments add constraint stock_adjustments_after_quantity_check check(after_quantity>=0 or source='site_return');
create function public.inventory_loose_meter_allowed_v1(p_item_id uuid) returns boolean language sql stable security invoker set search_path='' as $$
select coalesce((select replace(btrim(c.name),'＆','&') in('弱電線材','電線&電纜類') and (lower(btrim(i.unit)) not in('米','m','公尺') or i.opening_meters<>0 or exists(select 1 from public.pickup_records p where p.inventory_item_id=i.id and p.quantity_unit='meter') or exists(select 1 from public.stock_receipts r where r.inventory_item_id=i.id and r.quantity_unit='meter') or exists(select 1 from public.stock_adjustments a where a.inventory_item_id=i.id and a.quantity_unit='meter')) from public.inventory_items i join public.product_categories c on c.id=i.category_id where i.id=p_item_id),false)
$$;
revoke all on function public.inventory_loose_meter_allowed_v1(uuid) from public,anon,authenticated;
grant execute on function public.inventory_loose_meter_allowed_v1(uuid) to service_role;
create or replace function public.guard_cable_profile_v1() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.meters_per_unit is not null and lower(btrim(new.unit)) in('米','m','公尺') then raise exception '原單位已是米，不需要設定預設長度。';end if;
 if tg_op='UPDATE' then
  -- One original-unit fallback for pre-snapshot rows; quantities and unknown
  -- historical lengths are never rewritten when the current profile changes.
  new.legacy_unit:=case when new.unit is distinct from old.unit then coalesce(old.legacy_unit,old.unit) else old.legacy_unit end;
 else new.legacy_unit:=null;end if;
 return new;
end $$;
CREATE OR REPLACE FUNCTION public.guard_inventory_opening_meters_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare category_name text;
begin
 if new.opening_meters<>0 and (tg_op='INSERT' or new.opening_meters is distinct from old.opening_meters) then
  select name into category_name from public.product_categories where id=new.category_id;
  if replace(btrim(category_name),'＆','&') not in('弱電線材','電線&電纜類') or category_name is null or lower(btrim(new.unit)) in('米','m','公尺') then raise exception '只有以箱／捲等包裝計量的線材可另填期初散料；單位為米時請填期初米數。';end if;
 end if;
 return new;
end $function$;
CREATE OR REPLACE FUNCTION public.save_site_return_v1(p_actor_user_id uuid, p_document_id uuid, p_request_id uuid, p_row_version integer, p_action text, p_return_date date, p_customer_id uuid, p_project_id uuid, p_rows jsonb, p_note text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare old_doc public.site_return_documents;new_doc public.site_return_documents;reg public.stock_transaction_documents;
 old_request public.site_return_requests;request_payload jsonb;v_result jsonb;v_actor text;row_data jsonb;line public.site_return_lines;
 v_item uuid;v_line uuid;v_before numeric;v_old numeric;v_new numeric;v_delta numeric;v_old_unit text;v_ledger_unit text;v_old_package_unit text;v_new_package_unit text;v_version integer;v_status text;v_unit text;v_lengths jsonb;
begin
 if p_action is null or p_action not in ('create','update','cancel','delete') or p_document_id is null or p_request_id is null then raise exception '入庫單操作資料不完整。';end if;
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'purchases',case p_action when 'create' then 'CREATE' when 'update' then 'UPDATE' else 'DELETE' end) then raise exception '沒有案場餘料入庫操作權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform pg_advisory_xact_lock(hashtextextended('site-return-request:'||p_request_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('site-return-document:'||p_document_id::text,0));
 select * into old_doc from public.site_return_documents where id=p_document_id for update;
 if old_doc.id is not null and not public.site_return_project_visible_v1(p_actor_user_id,old_doc.project_id) then raise exception '找不到入庫單或沒有存取權限。';end if;
 request_payload:=jsonb_build_object('action',p_action,'date',p_return_date,'customer',p_customer_id,'project',p_project_id,'rows',p_rows,'note',p_note,'version',p_row_version);
 select * into old_request from public.site_return_requests where request_id=p_request_id;
 if found then
  if old_request.actor_user_id<>p_actor_user_id or old_request.document_id<>p_document_id or old_request.payload is distinct from request_payload then raise exception '重試識別碼已用於不同內容，請重新讀取後儲存。';end if;
  return old_request.result;
 end if;
 if p_action='create' then
  if old_doc.id is not null or p_row_version is not null then raise exception '入庫單已建立，請重新讀取，不可重複新增。';end if;
 elsif old_doc.id is null or old_doc.row_version is distinct from p_row_version or old_doc.status<>'active' then
  raise exception '入庫單已變更、取消或刪除，請重新讀取後操作。';
 end if;
 if p_action in ('create','update') then
  if p_return_date is null or p_customer_id is null or p_project_id is null or not public.site_return_project_visible_v1(p_actor_user_id,p_project_id) then raise exception '請選擇可存取的客戶與工作案名。';end if;
  perform 1 from public.projects where id=p_project_id and customer_id=p_customer_id for key share;
  if not found then raise exception '工作案名與客戶不符。';end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 50 or length(coalesce(p_note,''))>500 then raise exception '請填寫 1 至 50 筆材料，備註最多 500 字。';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r)<>'object' or nullif(r->>'inventory_item_id','') is null or (r->>'quantity') is null or (r->>'quantity')::numeric<=0 or (r->>'quantity')::numeric>=1000000000000 or (r->>'quantity')::numeric<>round((r->>'quantity')::numeric,2)) then raise exception '入庫數量須為大於 0、最多兩位小數的有效數字。';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where coalesce(r->>'quantity_unit','package') not in('package','meter')) then raise exception '入庫計量單位不正確。';end if;
  for row_data in select value from jsonb_array_elements(p_rows) loop
   v_unit:=coalesce(row_data->>'quantity_unit','package');
   v_lengths:=coalesce(row_data->'lengths','[]');
   if jsonb_typeof(v_lengths)<>'array' or jsonb_array_length(v_lengths)>100 then raise exception '餘料長度最多 100 段。';end if;
   if exists(select 1 from jsonb_array_elements(v_lengths) n where jsonb_typeof(n)<>'number' or (n::text)::numeric<=0 or (n::text)::numeric<>round((n::text)::numeric,2)) then raise exception '每段米數須為正數，最多兩位小數。';end if;
   if jsonb_array_length(v_lengths)>0 and (v_unit<>'meter' or (select sum((n::text)::numeric) from jsonb_array_elements(v_lengths)n)<>(row_data->>'quantity')::numeric) then raise exception '各段米數合計與入庫米數不符。';end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_rows))<>(select count(distinct r->>'inventory_item_id') from jsonb_array_elements(p_rows) r) then raise exception '同一張入庫單的重複品項請合併數量。';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r left join public.inventory_items i on i.id=(r->>'inventory_item_id')::uuid where i.id is null or i.inventory_status<>'active') then raise exception '部分品項已不存在或停用，請重新選擇。';end if;
 end if;
 -- Same row locks as pickup/receipt/physical count writes; serialize all stock changes.
 perform 1 from public.inventory_items where id in(select inventory_item_id from public.site_return_lines where document_id=p_document_id
 union select (r->>'inventory_item_id')::uuid from jsonb_array_elements(case when p_action in ('create','update') then p_rows else '[]'::jsonb end) r) order by id for update;
 if p_action in ('create','update') then
  for row_data in select value from jsonb_array_elements(p_rows) loop
   v_item:=(row_data->>'inventory_item_id')::uuid;
   v_unit:=coalesce(row_data->>'quantity_unit','package');
   if v_unit='meter' and not public.inventory_loose_meter_allowed_v1(v_item) and not exists(select 1 from public.site_return_lines where document_id=p_document_id and inventory_item_id=v_item and quantity_unit='meter') then raise exception '此貨品種類不能使用散料(米)。';end if;
  end loop;
 end if;
 v_status:=case p_action when 'cancel' then 'cancelled' when 'delete' then 'deleted' else 'active' end;
 v_version:=coalesce(old_doc.row_version,0)+1;
 select username into v_actor from public.app_users where id=p_actor_user_id and is_active;
 if p_action='create' then
  -- Global namespace only for return numbering; not a customer or identity record.
  reg:=public.ensure_stock_document_v1('site_return',p_document_id,p_return_date,'00000000-0000-0000-0000-000000000001'::uuid);
  insert into public.site_return_documents(id,document_no,return_date,customer_id,project_id,note,created_by_user_id,updated_by_user_id)
  values(p_document_id,reg.document_no,p_return_date,p_customer_id,p_project_id,coalesce(p_note,''),p_actor_user_id,p_actor_user_id) returning * into new_doc;
 else
  update public.site_return_documents set return_date=case when p_action='update' then p_return_date else return_date end,
  customer_id=case when p_action='update' then p_customer_id else customer_id end,project_id=case when p_action='update' then p_project_id else project_id end,
  note=case when p_action='update' then coalesce(p_note,'') else note end,status=v_status,row_version=v_version,updated_at=now(),updated_by_user_id=p_actor_user_id where id=p_document_id returning * into new_doc;
 end if;
 for v_item in select inventory_item_id from public.site_return_lines where document_id=p_document_id
 union select (r->>'inventory_item_id')::uuid from jsonb_array_elements(case when p_action in ('create','update') then p_rows else '[]'::jsonb end) r loop
  select * into line from public.site_return_lines where document_id=p_document_id and inventory_item_id=v_item;
  v_old:=case when old_doc.status='active' then coalesce(line.quantity,0) else 0 end;
  v_old_unit:=coalesce(line.quantity_unit,'package');
  select coalesce(line.package_unit_snapshot,i.legacy_unit,i.unit) into v_old_package_unit from public.inventory_items i where i.id=v_item;
  select coalesce((select (r->>'quantity')::numeric from jsonb_array_elements(case when p_action in ('create','update') then p_rows else '[]'::jsonb end) r where (r->>'inventory_item_id')::uuid=v_item),0) into v_new;
  select coalesce((select coalesce(r->>'quantity_unit','package') from jsonb_array_elements(case when p_action in ('create','update') then p_rows else '[]'::jsonb end) r where (r->>'inventory_item_id')::uuid=v_item),v_old_unit) into v_unit;
  select coalesce((select r->'lengths' from jsonb_array_elements(case when p_action in ('create','update') then p_rows else '[]'::jsonb end) r where (r->>'inventory_item_id')::uuid=v_item),'[]') into v_lengths;
  if p_action in ('create','update') then
   if v_new>0 then
    insert into public.site_return_lines(document_id,inventory_item_id,quantity,quantity_unit,lengths) values(p_document_id,v_item,v_new,v_unit,v_lengths)
    on conflict(document_id,inventory_item_id) do update set quantity=excluded.quantity,quantity_unit=excluded.quantity_unit,lengths=excluded.lengths returning id,package_unit_snapshot into v_line,v_new_package_unit;
   else
    -- Keep the old length/unit snapshots on an omitted line for its reversal.
    update public.site_return_lines set quantity=0 where id=line.id returning id,package_unit_snapshot into v_line,v_new_package_unit;
   end if;
  else v_line:=line.id;v_new_package_unit:=line.package_unit_snapshot;end if;
  select coalesce(v_new_package_unit,i.unit) into v_new_package_unit from public.inventory_items i where i.id=v_item;
  -- A mode edit reverses the original stock dimension and applies the new one.
  -- Never convert unknown historic package lengths or mutate old ledger rows.
  for v_ledger_unit in select v_old_unit union select v_unit loop
   v_delta:=(case when v_unit=v_ledger_unit then v_new else 0 end)-(case when v_old_unit=v_ledger_unit then v_old else 0 end);
   if v_delta<>0 then
    v_before:=case when v_ledger_unit='meter' then public.current_inventory_meters_v1(v_item) else public.current_inventory_quantity(v_item) end;
    insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,site_return_line_id,site_return_version,quantity_unit,package_unit_snapshot)
    values(v_item,v_before,v_before+v_delta,'案場餘料入庫 '||new_doc.document_no,gen_random_uuid(),'site_return',v_actor,v_line,v_version,v_ledger_unit,case when v_ledger_unit=v_old_unit and v_old>0 then v_old_package_unit else v_new_package_unit end);
   end if;
  end loop;
 end loop;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('site_return_documents',p_document_id,case p_action when 'create' then 'insert' when 'cancel' then 'update' else p_action end,case when old_doc.id is not null then to_jsonb(old_doc) end,to_jsonb(new_doc),'web',v_actor);
 v_result:=jsonb_build_object('document_id',p_document_id,'document_no',new_doc.document_no,'row_version',v_version,'status',v_status);
 insert into public.site_return_requests(request_id,document_id,actor_user_id,payload,result) values(p_request_id,p_document_id,p_actor_user_id,request_payload,v_result);
 return v_result;
end $function$;
create or replace function public.guard_site_return_pickups_v1() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 -- Return quantities are entered independently; later pickup correction is legal.
 return null;
end $$;
CREATE OR REPLACE FUNCTION public.site_return_list_v1(p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare allowed uuid[];
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') then raise exception '沒有案場餘料入庫查看權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 select coalesce(array_agg(p.id),'{}') into allowed from public.projects p where public.site_return_project_visible_v1(p_actor_user_id,p.id);
 return jsonb_build_object(
 'documents',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object('account',u.display_name,'lines',
  coalesce((select jsonb_agg(to_jsonb(l)-'cable_unit_cost_snapshot'-'cable_cost_source_receipt_ids' order by l.id) from public.site_return_lines l where l.document_id=d.id and l.quantity>0),'[]')) order by d.return_date desc,d.created_at desc)
  from public.site_return_documents d join public.app_users u on u.id=d.created_by_user_id where d.status<>'deleted' and d.project_id=any(allowed)),'[]'),
 'projects',coalesce((select jsonb_agg(jsonb_build_object('id',id,'customer_id',customer_id,'name',name,'code',project_code,'department_id',department_id) order by project_code) from public.projects where id=any(allowed)),'[]'),
 'customers',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'code',c.customer_code,'category',c.customer_category) order by c.customer_code) from public.customers c where c.id in(select customer_id from public.projects where id=any(allowed))),'[]'),
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'code',i.inventory_code,'name',i.item_name,'brand',i.brand,'model',i.model,'unit',i.unit,'meters_per_unit',i.meters_per_unit,'can_use_meter',public.inventory_loose_meter_allowed_v1(i.id),'legacy_unit',i.legacy_unit,'category_id',i.category_id,'category',coalesce(c.name,'未分類'),'active',i.inventory_status='active') order by i.inventory_code) from public.inventory_items i left join public.product_categories c on c.id=i.category_id),'[]'),
 'permissions',jsonb_build_object('create',public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE'),'update',public.has_app_permission_v1(p_actor_user_id,'purchases','UPDATE'),'delete',public.has_app_permission_v1(p_actor_user_id,'purchases','DELETE')));
end $function$;
CREATE OR REPLACE FUNCTION public.erp_stock_totals_v1(p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
begin
 if not exists(select 1 from unnest(array['inventory','purchases','pickups','worklogs','repairs','reports']) m where public.has_app_permission_v1(p_actor_user_id,m,'VIEW')) then raise exception '沒有庫存查看權限。';end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'can_use_meter',public.inventory_loose_meter_allowed_v1(i.id),'loose_meters',public.current_inventory_meters_v1(i.id),'quantity',coalesce(i.opening_quantity,0)+coalesce(r.q,0)-coalesce(p.q,0)+coalesce(a.q,0))),'[]') from public.inventory_items i
 left join (select s.inventory_item_id,sum(s.quantity) q from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id where s.quantity_unit='package' and d.receipt_delivery_state is distinct from 'pending' group by s.inventory_item_id) r on r.inventory_item_id=i.id
 left join (select inventory_item_id,sum(quantity) q from public.pickup_records where quantity_unit='package' group by inventory_item_id) p on p.inventory_item_id=i.id
 left join (select inventory_item_id,sum(difference_quantity) q from public.stock_adjustments where quantity_unit='package' group by inventory_item_id) a on a.inventory_item_id=i.id);
end $function$;
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
 select r.*,case when public.cable_cost_sources_visible_v1(r.cable_cost_source_receipt_ids) then r.cable_unit_cost_snapshot end visible_cable_cost,case when r.quantity_unit='meter' then r.quantity else r.quantity*coalesce(r.meters_per_unit_snapshot,1) end report_quantity,i.item_name,i.brand,i.model,case when r.quantity_unit='meter' or r.meters_per_unit_snapshot is not null then '米' else coalesce(r.package_unit_snapshot,i.legacy_unit,i.unit) end unit,i.category_id,
 coalesce(nullif(btrim(c.name),''),'未分類') category_name
 from public.pickup_records r join public.inventory_items i on i.id=r.inventory_item_id
 left join public.product_categories c on c.id=i.category_id
 where r.project_id=p_project_id and (p_from is null or r.pickup_date>=p_from) and (p_to is null or r.pickup_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(r)-'cable_cost_source_receipt_ids')),
 workers as materialized (
 select w.user_id,l.id,l.log_date,u.display_name,u.is_active from logs l
 join public.site_work_log_workers w on w.work_log_id=l.id join public.app_users u on u.id=w.user_id where l.reporter_on_site or w.user_id is distinct from l.reporter_user_id),
 contractor_days as (select log_date,max(subcontractor_count) headcount,count(*) records from logs where subcontractor_count>0 group by log_date),
 returned as materialized (
 select l.id,l.inventory_item_id,case when l.quantity_unit='meter' or l.meters_per_unit_snapshot is not null then '米' else coalesce(l.package_unit_snapshot,i.legacy_unit,i.unit) end unit,case when public.cable_cost_sources_visible_v1(l.cable_cost_source_receipt_ids) then l.cable_unit_cost_snapshot end visible_cable_cost,case when l.quantity_unit='meter' then l.quantity else l.quantity*coalesce(l.meters_per_unit_snapshot,1) end quantity,d.return_date,d.document_no,d.id document_id,u.display_name account
 from public.site_return_lines l join public.inventory_items i on i.id=l.inventory_item_id join public.site_return_documents d on d.id=l.document_id
 join public.app_users u on u.id=d.created_by_user_id
 where d.project_id=p_project_id and d.status='active' and l.quantity>0
 and (p_from is null or d.return_date>=p_from) and (p_to is null or d.return_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(d))),
 issued_totals as (select inventory_item_id,unit,sum(report_quantity) quantity,sum(report_quantity*visible_cable_cost) cable_amount,count(*) filter(where visible_cable_cost is null) unpriced,count(*) records,min(pickup_date) first_date,max(pickup_date) recent_date from materials group by inventory_item_id,unit),
 returned_totals as (select inventory_item_id,unit,sum(quantity) quantity,sum(quantity*visible_cable_cost) cable_amount,count(*) filter(where visible_cable_cost is null) unpriced,count(*) records,min(return_date) first_date,max(return_date) recent_date from returned group by inventory_item_id,unit),
 mat as (
 select i.id,i.item_name name,i.brand,i.model,coalesce(issued.unit,ret.unit,nullif(i.unit,''),'未標示單位') unit,
 i.unit package_unit,coalesce(i.meters_per_unit,1) meters_per_unit,
 i.category_id "categoryId",coalesce(nullif(btrim(c.name),''),'未分類') "categoryName",
 coalesce(issued.quantity,0) "issuedQuantity",coalesce(ret.quantity,0) "returnedQuantity",
 coalesce(issued.quantity,0)-coalesce(ret.quantity,0) quantity,
 coalesce(issued.cable_amount,0)-coalesce(ret.cable_amount,0) cable_amount,coalesce(issued.unpriced,0)+coalesce(ret.unpriced,0) cable_unpriced,
 coalesce(issued.records,0) "recordCount",coalesce(ret.records,0) "returnRecordCount",
 least(issued.first_date,ret.first_date) "firstDate",greatest(issued.recent_date,ret.recent_date) "recentDate"
 from issued_totals issued full join returned_totals ret using(inventory_item_id,unit)
 join public.inventory_items i on i.id=coalesce(issued.inventory_item_id,ret.inventory_item_id)
 left join public.product_categories c on c.id=i.category_id),
 material_stats as (
 select m."categoryId",m."categoryName",m.unit,m.quantity,m."recordCount",
 (to_jsonb(m)-'cable_amount'-'cable_unpriced')||case when price_visible then jsonb_build_object('unit_price',pricing.unit_price,'package_unit_price',case when m.unit='米' and m.package_unit not in('米','m','公尺') and (select meters_per_unit from public.inventory_items where id=m.id) is null then null else pricing.unit_price*m.meters_per_unit end,
 'amount',round(case when manual.unit_price is null and m.unit='米' and m.cable_unpriced=0 then m.cable_amount else m.quantity*pricing.unit_price end,2),
 'price_source',case when manual.unit_price is not null then 'manual' when m.unit='米' and m.cable_unpriced=0 then 'snapshot' when latest.id is not null then 'receipt' else 'missing' end,
 'price_date',case when manual.unit_price is not null then (manual.updated_at at time zone 'Asia/Taipei')::date when m.unit='米' and m.cable_unpriced=0 then m."recentDate" else latest.receipt_date end,
 'source_receipt_id',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.id end,
 'source_document_id',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.receipt_document_id end,
 'source_tax_mode',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.receipt_tax_mode end,
 'source_tax_rate_basis_points',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.receipt_tax_rate_basis_points end,
 'source_input_unit_price',case when manual.unit_price is null and not(m.unit='米' and m.cable_unpriced=0) then latest.input_unit_price end,
 'price_row_version',manual.row_version) else '{}'::jsonb end data from mat m
 left join public.accounting_material_prices manual on manual.project_id=p_project_id and manual.inventory_item_id=m.id and (m.unit<>'米' or manual.meters_per_unit_snapshot is not null or lower(btrim(coalesce(manual.package_unit_snapshot,(select coalesce(i.legacy_unit,i.unit) from public.inventory_items i where i.id=m.id)))) in('米','m','公尺'))
 left join lateral(select s.id,s.receipt_date,s.receipt_document_id,s.unit_price input_unit_price,s.meters_per_unit_snapshot,
 d.receipt_tax_mode,d.receipt_tax_rate_basis_points,
 public.accounting_receipt_unit_net_v1(s.id) unit_price
 from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id
 where s.inventory_item_id=m.id and d.receipt_delivery_state is distinct from 'pending' and s.unit_price is not null and ((m.unit='米' and (s.meters_per_unit_snapshot is not null or lower(btrim(coalesce(s.package_unit_snapshot,(select coalesce(i.legacy_unit,i.unit) from public.inventory_items i where i.id=m.id)))) in('米','m','公尺'))) or (m.unit<>'米' and s.quantity_unit='package' and s.meters_per_unit_snapshot is null)) and public.erp_private_json_visible_v1(to_jsonb(s))
 order by s.receipt_date desc,s.created_at desc,s.id desc limit 1) latest on true
 cross join lateral(select case when manual.unit_price is not null then manual.unit_price/coalesce(manual.meters_per_unit_snapshot,1)
 when m.unit='米' and m.cable_unpriced=0 then case when m.quantity<>0 then m.cable_amount/m.quantity else 0 end
 else latest.unit_price/coalesce(latest.meters_per_unit_snapshot,1) end unit_price) pricing),
 category_stats as (
 select s."categoryId" id,max(s."categoryName") name,count(distinct (s.data->>'id')) "itemCount",sum(s."recordCount") "recordCount",
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
 'returnRows',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'date',r.return_date,'documentId',r.document_id,'documentNo',r.document_no,'itemId',r.inventory_item_id,'categoryId',i.category_id,'quantity',r.quantity,'account',r.account,'item',jsonb_build_object('name',i.item_name,'brand',i.brand,'model',i.model,'unit',r.unit)) order by r.return_date desc,r.id) from returned r join public.inventory_items i on i.id=r.inventory_item_id),'[]'),
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
 'kpis',jsonb_build_object('materialTypeCount',(select count(distinct id) from mat),'materialRecordCount',(select count(*) from materials),
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
      'id',s.id,'itemId',s.inventory_item_id,'name',i.item_name,'quantity',s.quantity,'unit',case when s.quantity_unit='meter' then '米' else coalesce(s.package_unit_snapshot,i.legacy_unit,i.unit) end,
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

do $extra_baseline$ begin
if md5(replace(pg_get_functiondef('save_supplier_return_v1(uuid,text,jsonb)'::regprocedure),chr(13),''))<>'f14c75379b6242ed1fe66dcf2257c811' then raise exception 'Unexpected baseline: save_supplier_return_v1';end if;
if md5(replace(pg_get_functiondef('supplier_return_list_v1(uuid)'::regprocedure),chr(13),''))<>'acb7d56d79e1c21ffef781b9b9727785' then raise exception 'Unexpected baseline: supplier_return_list_v1';end if;
if md5(replace(pg_get_functiondef('stamp_cable_transaction_v1()'::regprocedure),chr(13),''))<>'5433240c0046783bb16954e81406bfc8' then raise exception 'Unexpected baseline: stamp_cable_transaction_v1';end if;
if md5(replace(pg_get_functiondef('stamp_receipt_quantity_unit_v1()'::regprocedure),chr(13),''))<>'43ae14059c091eebaa44fc9d9d9350af' then raise exception 'Unexpected baseline: stamp_receipt_quantity_unit_v1';end if;
if md5(replace(pg_get_functiondef('cable_reference_cost_snapshot_v1(uuid,uuid,uuid)'::regprocedure),chr(13),''))<>'af584e421eb945d195afef152c764a68' then raise exception 'Unexpected baseline: cable_reference_cost_snapshot_v1';end if;
if md5(replace(pg_get_functiondef('unpack_cable_for_pickup_v1()'::regprocedure),chr(13),''))<>'d5753a03be61fd84de266a089bbc5ae3' then raise exception 'Unexpected baseline: unpack_cable_for_pickup_v1';end if;
end $extra_baseline$;

alter table public.stock_adjustments add column package_unit_snapshot text;
alter table public.supplier_return_lines add column quantity_unit text not null default 'package' check(quantity_unit in('package','meter')),add column package_unit_snapshot text,add column meters_per_unit_snapshot numeric check(meters_per_unit_snapshot>0);
alter table public.supplier_return_lines drop constraint supplier_return_lines_quantity_check;
alter table public.supplier_return_lines add constraint supplier_return_lines_quantity_check check(quantity>0 and quantity=round(quantity,2) and(quantity_unit='meter' or quantity=trunc(quantity)));
drop index public.stock_adjustments_supplier_return_version_uidx;
create unique index stock_adjustments_supplier_return_version_uidx on public.stock_adjustments(supplier_return_document_id,supplier_return_version,inventory_item_id,quantity_unit) where supplier_return_document_id is not null;
create function public.stamp_inventory_unit_snapshot_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare profile public.inventory_items;
begin
 select * into profile from public.inventory_items where id=new.inventory_item_id for update;
 if tg_table_name='supplier_return_lines' then
  if new.quantity_unit='meter' and not public.inventory_loose_meter_allowed_v1(new.inventory_item_id) and not(tg_op='UPDATE' and old.quantity_unit='meter') then raise exception '此貨品種類不能使用散料(米)。';end if;
  if tg_op='UPDATE' and new.inventory_item_id=old.inventory_item_id and new.quantity_unit=old.quantity_unit then new.package_unit_snapshot:=old.package_unit_snapshot;new.meters_per_unit_snapshot:=old.meters_per_unit_snapshot;
  else new.package_unit_snapshot:=profile.unit;new.meters_per_unit_snapshot:=profile.meters_per_unit;end if;
 elsif new.source='site_return' then
  new.package_unit_snapshot:=coalesce(new.package_unit_snapshot,(select l.package_unit_snapshot from public.site_return_lines l where l.id=new.site_return_line_id),profile.legacy_unit,profile.unit);
 else new.package_unit_snapshot:=profile.unit;end if;
 return new;
end $$;
create trigger a_inventory_unit_snapshot before insert on public.stock_adjustments for each row execute function public.stamp_inventory_unit_snapshot_v1();
create trigger a_inventory_unit_snapshot before insert or update on public.supplier_return_lines for each row execute function public.stamp_inventory_unit_snapshot_v1();
create function public.reserve_inventory_meters_v1(p_item uuid,p_needed numeric,p_actor text,p_reference text) returns void language plpgsql security invoker set search_path='' as $$
declare loose numeric;factor numeric;packages numeric;available numeric;
begin
 select meters_per_unit into factor from public.inventory_items where id=p_item for update;
 loose:=public.current_inventory_meters_v1(p_item);
 if p_needed<=loose then return;end if;
 if factor is null then raise exception '散料米數不足；尚未設定包裝長度，無法自動拆包。';end if;
 packages:=ceil((p_needed-loose)/factor);available:=public.current_inventory_quantity(p_item);
 if packages>available then raise exception '可用米數不足，散料及整包庫存不足以供應本次領用。';end if;
 insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
 values(p_item,available,available-packages,p_reference||'；每包 '||factor::text||' 米',gen_random_uuid(),'web',p_actor,'package');
 insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
 values(p_item,loose,loose+packages*factor,p_reference||'；'||packages::text||' 包',gen_random_uuid(),'web',p_actor,'meter');
end $$;
create function public.apply_stock_adjustment_meter_v1(p_inventory_item_id uuid,p_after_quantity numeric,p_reason text,p_idempotency_key uuid,p_actor_user_id uuid) returns table(inventory_item_id uuid,verified_quantity numeric) language plpgsql security invoker set search_path='' as $$
declare actor text;before_qty numeric;entry public.stock_adjustments;qty numeric;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'inventory','UPDATE') then raise exception '沒有庫存校正權限。';end if;
 if p_after_quantity is null or p_after_quantity<0 or p_after_quantity>=1e12 or p_after_quantity<>round(p_after_quantity,2) or length(coalesce(p_reason,''))>500 or p_idempotency_key is null then raise exception '請填寫有效的校正米數與原因。';end if;
 select username into actor from public.app_users where id=p_actor_user_id and is_active;if actor is null then raise exception '無法確認操作帳號。';end if;
 perform 1 from public.inventory_items where id=p_inventory_item_id for update;if not found then raise exception '找不到指定品項。';end if;
 if not public.inventory_loose_meter_allowed_v1(p_inventory_item_id) then raise exception '此貨品種類不能使用散料(米)。';end if;
 select * into entry from public.stock_adjustments where idempotency_key=p_idempotency_key;
 if found then
  if entry.inventory_item_id<>p_inventory_item_id or entry.quantity_unit<>'meter' or entry.after_quantity<>p_after_quantity or coalesce(entry.reason,'')<>coalesce(p_reason,'') or entry.updated_by is distinct from actor then raise exception '重試識別碼已用於不同內容。';end if;
 else
  before_qty:=public.current_inventory_meters_v1(p_inventory_item_id);
  insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit) values(p_inventory_item_id,before_qty,p_after_quantity,nullif(p_reason,''),p_idempotency_key,'web',actor,'meter');
 end if;
 qty:=public.current_inventory_meters_v1(p_inventory_item_id);if qty is distinct from p_after_quantity then raise exception '庫存米數校正驗證失敗。';end if;
 return query select p_inventory_item_id,qty;
end $$;
revoke all on function public.stamp_inventory_unit_snapshot_v1(),public.reserve_inventory_meters_v1(uuid,numeric,text,text),public.apply_stock_adjustment_meter_v1(uuid,numeric,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.stamp_inventory_unit_snapshot_v1(),public.reserve_inventory_meters_v1(uuid,numeric,text,text),public.apply_stock_adjustment_meter_v1(uuid,numeric,text,uuid,uuid) to service_role;
CREATE OR REPLACE FUNCTION public.save_supplier_return_v1(p_actor_user_id uuid, p_action text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare did uuid:=(p_payload->>'document_id')::uuid;req uuid:=(p_payload->>'request_id')::uuid;
 old_doc public.supplier_return_documents;doc public.supplier_return_documents;reg public.stock_transaction_documents;old_req public.supplier_return_requests;
 old_customers jsonb;rows jsonb:=p_payload->'rows';meta jsonb:=coalesce(p_payload->'receipt_metadata','{}');old_lines jsonb;customers jsonb:=p_payload->'customer_departments';
 customer_ids uuid[];old_ids uuid[];submitted_ids uuid[];v_row jsonb;line public.supplier_return_lines;cid uuid;dep uuid;legacy_dep uuid;
 v_supplier uuid;project uuid;day date;mode text;rate integer;discount numeric;price numeric;needed text;num text;actor text;
 item uuid;unit_mode text;unit_factor numeric;unknown_count numeric;before_qty numeric;old_qty numeric;new_qty numeric;issued numeric;returned numeric;version integer;v_line_number integer:=0;result jsonb;financials jsonb;
begin
 if p_action is null or p_action not in('create','update','delete') or did is null or req is null then raise exception '退貨單操作資料不完整。';end if;
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'purchases',upper(p_action)) then raise exception '沒有退貨操作權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform pg_advisory_xact_lock(hashtextextended('supplier-return-request:'||req::text,0));
 perform pg_advisory_xact_lock(hashtextextended('supplier-return-document:'||did::text,0));
 select * into old_doc from public.supplier_return_documents where id=did for update;
 if old_doc.id is not null and not public.supplier_return_visible_v1(p_actor_user_id,did) then raise exception '找不到退貨單或沒有存取權限。';end if;
 select * into old_req from public.supplier_return_requests where request_id=req;
 if found then
  if old_req.actor_user_id<>p_actor_user_id or old_req.document_id<>did or old_req.payload is distinct from jsonb_build_object('action',p_action,'payload',p_payload) then raise exception '重試識別碼已用於不同內容，請重新讀取後儲存。';end if;
  return old_req.result;
 end if;
 if p_action='create' then
  if old_doc.id is not null or p_payload->>'row_version' is not null then raise exception '退貨單已建立，請重新讀取。';end if;
 elsif old_doc.id is null or old_doc.deleted_at is not null or old_doc.row_version is distinct from (p_payload->>'row_version')::integer then raise exception '退貨單已被更新或刪除，請重新讀取後操作。';end if;
 select coalesce(jsonb_agg(to_jsonb(l)),'[]'),coalesce(array_agg(id),'{}') into old_lines,old_ids from public.supplier_return_lines l where document_id=did;
 select coalesce(jsonb_agg(to_jsonb(c)),'[]') into old_customers from public.supplier_return_customers c where document_id=did;
 v_supplier:=old_doc.supplier_id;project:=old_doc.project_id;day:=old_doc.return_date;mode:=old_doc.tax_mode;rate:=old_doc.tax_rate_basis_points;discount:=coalesce(old_doc.discount_amount,0);
 if p_action<>'delete' then
  v_supplier:=(p_payload->>'supplier_id')::uuid;day:=(p_payload->>'return_date')::date;
  if day is null or v_supplier is null or not exists(select 1 from public.suppliers s where id=v_supplier and public.erp_private_json_visible_v1(to_jsonb(s))) then raise exception '請選擇有效的退貨日期及供應商。';end if;
  if rows is null or jsonb_typeof(rows)<>'array' or jsonb_array_length(rows) not between 1 and 20 then raise exception '每張退貨單必須有 1 至 20 筆明細。';end if;
  if exists(select 1 from jsonb_array_elements(rows) r where jsonb_typeof(r)<>'object' or nullif(r->>'inventory_item_id','') is null or jsonb_typeof(r->'quantity') is distinct from 'number' or (r->>'quantity')::numeric<=0 or (r->>'quantity')::numeric>=1000000000000 or ((coalesce(r->>'quantity_unit','package')='package' and (r->>'quantity')::numeric<>trunc((r->>'quantity')::numeric)) or (r->>'quantity')::numeric<>round((r->>'quantity')::numeric,2) or coalesce(r->>'quantity_unit','package') not in('package','meter')) or length(coalesce(r->>'note',''))>500) then raise exception '退貨數量須為正數；散料最多兩位小數，備註最多500字。';end if;
  if (select count(*) from jsonb_array_elements(rows))<>(select count(distinct(r->>'inventory_item_id',lower(btrim(coalesce(r->>'note',''))))) from jsonb_array_elements(rows) r) then raise exception '同一張退貨單有重複明細，請合併數量。';end if;
  select coalesce(array_agg((r->>'id')::uuid),'{}') into submitted_ids from jsonb_array_elements(rows) r where nullif(r->>'id','') is not null;
  if not(submitted_ids<@old_ids) or cardinality(submitted_ids)<>(select count(distinct x) from unnest(submitted_ids) x) then raise exception '退貨明細不屬於這張單據。';end if;
  if exists(select 1 from unnest(old_ids) x where not(x=any(submitted_ids))) and not public.has_app_permission_v1(p_actor_user_id,'purchases','DELETE') then raise exception '沒有刪除退貨明細的權限。';end if;
  if exists(select 1 from jsonb_array_elements(rows) r where nullif(r->>'id','') is null) and not public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE') then raise exception '沒有新增退貨明細的權限。';end if;
  if jsonb_typeof(meta) is distinct from 'object' or exists(select 1 from jsonb_object_keys(meta) k where k not in('project_id','tax_mode','tax_rate_basis_points','discount_amount')) then raise exception '退貨單設定不正確。';end if;
  if meta ? 'tax_mode' or meta ? 'tax_rate_basis_points' then
   if meta->>'tax_mode' is null or meta->>'tax_mode' not in('exclusive','inclusive') or jsonb_typeof(meta->'tax_rate_basis_points') is distinct from 'number' or (meta->>'tax_rate_basis_points')::numeric<>trunc((meta->>'tax_rate_basis_points')::numeric) or (meta->>'tax_rate_basis_points')::numeric not between 0 and 10000 then raise exception '計價模式或稅率不正確。';end if;
   mode:=meta->>'tax_mode';rate:=(meta->>'tax_rate_basis_points')::integer;
  end if;
  if meta ? 'discount_amount' then
   if jsonb_typeof(meta->'discount_amount') is distinct from 'number' then raise exception '折扣須為非負整數金額。';end if;
   discount:=(meta->>'discount_amount')::numeric;
   if discount<0 or discount>=100000000000000 or discount<>trunc(discount) then raise exception '折扣須為非負整數金額。';end if;
  end if;
  if (mode,rate,discount) is distinct from (old_doc.tax_mode,old_doc.tax_rate_basis_points,coalesce(old_doc.discount_amount,0)) then
   needed:=case when old_doc.tax_mode is null then 'CREATE' else 'UPDATE' end;
   if not public.has_app_permission_v1(p_actor_user_id,'purchase_prices','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'purchase_prices',needed) then raise exception '沒有退貨價格操作權限。';end if;
  end if;
  if meta ? 'project_id' then project:=nullif(meta->>'project_id','')::uuid;end if;
  if jsonb_typeof(p_payload->'customer_ids') is distinct from 'array' or jsonb_typeof(customers) is distinct from 'array' then raise exception '客戶與科室資料不完整。';end if;
  select coalesce(array_agg(value::uuid),'{}') into customer_ids from jsonb_array_elements_text(p_payload->'customer_ids');
  if cardinality(customer_ids)>2000 or cardinality(customer_ids)<>(select count(distinct x) from unnest(customer_ids) x) or cardinality(customer_ids)<>jsonb_array_length(customers)
   or (select count(distinct(r->>'customer_id')::uuid) from jsonb_array_elements(customers) r)<>cardinality(customer_ids) then raise exception '客戶不可重複或遺漏科室對應。';end if;
  for v_row in select value from jsonb_array_elements(customers) loop
   cid:=(v_row->>'customer_id')::uuid;dep:=nullif(v_row->>'department_id','')::uuid;
   if cid is null or not(cid=any(customer_ids)) or not exists(select 1 from public.customers c where c.id=cid and public.erp_private_json_visible_v1(to_jsonb(c)) and (c.deleted_at is null or exists(select 1 from public.supplier_return_customers x where x.document_id=did and x.customer_id=cid))) then raise exception '客戶已停用或沒有存取權限。';end if;
   select department_id into legacy_dep from public.supplier_return_customers where document_id=did and customer_id=cid;
   if dep is not null and not exists(select 1 from public.customer_departments where id=dep and customer_id=cid and (is_active or dep=legacy_dep)) then raise exception '科室不屬於此客戶或已停用。';end if;
   if dep is null and not exists(select 1 from public.supplier_return_customers where document_id=did and customer_id=cid and department_id is null) and exists(select 1 from public.customer_departments where customer_id=cid and is_active) then raise exception '請選擇客戶科室。';end if;
  end loop;
  if project is not null and (not public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') or not public.site_return_project_visible_v1(p_actor_user_id,project) or not exists(select 1 from public.projects where id=project and customer_id=any(customer_ids))) then raise exception '工作內容不屬於所選客戶或沒有查看權限。';end if;
  if exists(select 1 from public.app_users u join public.app_roles role on role.code=u.role where u.id=p_actor_user_id and role.project_scoped) and project is null then raise exception '請關聯有權限的工作內容。';end if;
 end if;
 -- Use the same inventory row locks as receipts, pickups and physical counts.
 perform 1 from public.inventory_items where id in(select (r->>'inventory_item_id')::uuid from jsonb_array_elements(old_lines) r union select (r->>'inventory_item_id')::uuid from jsonb_array_elements(case when p_action='delete' then '[]'::jsonb else rows end) r) order by id for update;
 if p_action<>'delete' and exists(select 1 from jsonb_array_elements(rows) r left join public.inventory_items i on i.id=(r->>'inventory_item_id')::uuid where i.id is null or i.inventory_status<>'active') then raise exception '部分品項已不存在或停用。';end if;
 version:=coalesce(old_doc.row_version,0)+1;
 select username into actor from public.app_users where id=p_actor_user_id and is_active;
 if p_action='create' then
  reg:=public.ensure_stock_document_v1('supplier_return',did,day,v_supplier);
  insert into public.supplier_return_documents(id,return_date,supplier_id,created_by_user_id,updated_by_user_id) values(did,day,v_supplier,p_actor_user_id,p_actor_user_id);
 else select * into reg from public.stock_transaction_documents where kind='supplier_return' and id=did;end if;
 if p_action<>'delete' then
  num:=nullif(btrim(p_payload->>'document_no'),'');
  if num is not null and (length(num)>64 or num~'[[:cntrl:]]') then raise exception '退貨單號最多 64 字，不能包含控制字元。';end if;
  perform pg_advisory_xact_lock(hashtextextended('supplier-return-number-scope:'||reg.numbering_scope_id::text,0));
  if num is not null and num is distinct from reg.document_no then
   if exists(select 1 from public.stock_transaction_documents where kind='supplier_return' and numbering_scope_id=reg.numbering_scope_id and id<>did and lower(document_no)=lower(num)) then raise exception '退貨單號已使用，請輸入同一編號廠商下不重複的單號。';end if;
   update public.stock_transaction_documents set document_no=num where kind='supplier_return' and id=did;reg.document_no:=num;
  end if;
  delete from public.supplier_return_lines where document_id=did and not(id=any(submitted_ids));
  for v_row in select value from jsonb_array_elements(rows) loop
   v_line_number:=v_line_number+1;select * into line from public.supplier_return_lines where document_id=did and id=nullif(v_row->>'id','')::uuid;
   price:=line.unit_price;
   if v_row ? 'unit_price' then
    if jsonb_typeof(v_row->'unit_price') not in('number','null') then raise exception '單價須為數字或空白。';end if;
    price:=(v_row->>'unit_price')::numeric;
    if price<0 or price>=1000000000000 or price<>round(price,2) then raise exception '單價須為非負數，最多兩位小數。';end if;
    if price is distinct from line.unit_price then
     needed:=case when price is null then 'DELETE' when line.unit_price is null then 'CREATE' else 'UPDATE' end;
     if not public.has_app_permission_v1(p_actor_user_id,'purchase_prices','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'purchase_prices',needed) then raise exception '沒有退貨價格操作權限。';end if;
    end if;
   end if;
   insert into public.supplier_return_lines(id,document_id,line_no,inventory_item_id,quantity,unit_price,note,quantity_unit)
   values(coalesce(line.id,gen_random_uuid()),did,v_line_number,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,price,coalesce(v_row->>'note',''),coalesce(v_row->>'quantity_unit','package'))
   on conflict(id) do update set line_no=excluded.line_no,inventory_item_id=excluded.inventory_item_id,quantity=excluded.quantity,unit_price=excluded.unit_price,note=excluded.note,quantity_unit=excluded.quantity_unit;
  end loop;
  delete from public.supplier_return_customers where document_id=did;
  insert into public.supplier_return_customers(document_id,customer_id,department_id) select did,(r->>'customer_id')::uuid,nullif(r->>'department_id','')::uuid from jsonb_array_elements(customers) r;
 end if;
 update public.supplier_return_documents set return_date=day,supplier_id=v_supplier,project_id=project,tax_mode=mode,tax_rate_basis_points=rate,discount_amount=discount,
 row_version=version,deleted_at=case when p_action='delete' then now() end,updated_at=now(),updated_by_user_id=p_actor_user_id where id=did returning * into doc;
 for item,unit_mode in select (r->>'inventory_item_id')::uuid,coalesce(r->>'quantity_unit','package') from jsonb_array_elements(old_lines) r union select inventory_item_id,quantity_unit from public.supplier_return_lines where document_id=did order by 1,2 desc loop
  select coalesce(sum((r->>'quantity')::numeric),0) into old_qty from jsonb_array_elements(old_lines) r where (r->>'inventory_item_id')::uuid=item and coalesce(r->>'quantity_unit','package')=unit_mode;
  select coalesce(sum(quantity),0) into new_qty from public.supplier_return_lines where document_id=did and inventory_item_id=item and quantity_unit=unit_mode and p_action<>'delete';
  if p_action<>'delete' then
   if unit_mode='meter' then
    select coalesce(sum(case when r.quantity_unit='meter' then r.quantity else r.quantity*r.meters_per_unit_snapshot end),0) into issued from public.stock_receipts r left join public.stock_transaction_documents d on d.id=r.receipt_document_id and d.kind='receipt' where r.supplier_id=v_supplier and r.inventory_item_id=item and d.receipt_delivery_state is distinct from 'pending';
    select coalesce(sum(case when l.quantity_unit='meter' then l.quantity else l.quantity*l.meters_per_unit_snapshot end),0) into returned from public.supplier_return_lines l join public.supplier_return_documents d on d.id=l.document_id where d.supplier_id=v_supplier and d.deleted_at is null and l.inventory_item_id=item;
    select coalesce((select sum(r.quantity) from public.stock_receipts r left join public.stock_transaction_documents d on d.id=r.receipt_document_id and d.kind='receipt' where r.supplier_id=v_supplier and r.inventory_item_id=item and r.quantity_unit='package' and r.meters_per_unit_snapshot is null and d.receipt_delivery_state is distinct from 'pending'),0)-coalesce((select sum(l.quantity) from public.supplier_return_lines l join public.supplier_return_documents d on d.id=l.document_id where d.supplier_id=v_supplier and d.deleted_at is null and l.inventory_item_id=item and l.quantity_unit='package' and l.meters_per_unit_snapshot is null),0) into unknown_count;
    if returned>issued and unknown_count<=0 then raise exception '退貨米數超過此供應商的可退進貨米數。';end if;
   else
    select coalesce(sum(quantity),0) into issued from public.stock_receipts where supplier_id=v_supplier and inventory_item_id=item and quantity_unit='package';
    select coalesce(sum(l.quantity),0) into returned from public.supplier_return_lines l join public.supplier_return_documents d on d.id=l.document_id where d.supplier_id=v_supplier and d.deleted_at is null and l.inventory_item_id=item and l.quantity_unit='package';
    if returned>issued then raise exception '退貨數量超過此供應商的可退進貨量，請核對進貨紀錄及其他退貨單。';end if;
   end if;
  end if;
  if old_qty<>new_qty then
   if unit_mode='meter' and new_qty>old_qty then perform public.reserve_inventory_meters_v1(item,new_qty-old_qty,actor,'供應商退貨拆包 '||reg.document_no);end if;
   before_qty:=case when unit_mode='meter' then public.current_inventory_meters_v1(item) else public.current_inventory_quantity(item) end;
   if before_qty+old_qty-new_qty<0 then raise exception '庫存不足，無法退貨；請減少數量或先處理取貨紀錄。';end if;
   insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,supplier_return_document_id,supplier_return_version,quantity_unit)
   values(item,before_qty,before_qty+old_qty-new_qty,'供應商退貨 '||reg.document_no,gen_random_uuid(),'supplier_return',actor,did,version,unit_mode);
  end if;
 end loop;
 financials:=public.receipt_money_totals_v2((select jsonb_agg(jsonb_build_object('quantity',quantity,'unit_price',unit_price,'quantity_unit',quantity_unit)) from public.supplier_return_lines where document_id=did),mode,rate,discount);
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('supplier_return_documents',did,case p_action when 'create' then 'insert' else p_action end,case when old_doc.id is not null then to_jsonb(old_doc)||jsonb_build_object('lines',old_lines,'customer_departments',old_customers) end,to_jsonb(doc)||jsonb_build_object('lines',(select jsonb_agg(to_jsonb(l)) from public.supplier_return_lines l where document_id=did),'customer_departments',(select jsonb_agg(to_jsonb(c)) from public.supplier_return_customers c where document_id=did)),'web',actor);
 result:=jsonb_build_object('document_id',did,'document_no',reg.document_no,'row_version',version);
 insert into public.supplier_return_requests(request_id,document_id,actor_user_id,payload,result) values(req,did,p_actor_user_id,jsonb_build_object('action',p_action,'payload',p_payload),result);
 return result;
end $function$;
CREATE OR REPLACE FUNCTION public.supplier_return_list_v1(p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare prices boolean;result jsonb;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') then raise exception '沒有退貨查看權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 prices:=public.has_app_permission_v1(p_actor_user_id,'purchase_prices','VIEW');
 select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'document_no',r.document_no,'return_date',d.return_date,'supplier_id',d.supplier_id,'project_id',d.project_id,'row_version',d.row_version,
 'customer_departments',coalesce((select jsonb_agg(jsonb_build_object('customer_id',c.customer_id,'department_id',c.department_id) order by c.customer_id) from public.supplier_return_customers c where c.document_id=d.id),'[]'),
 'lines',coalesce((select jsonb_agg((to_jsonb(l)-'unit_price')||case when prices then jsonb_build_object('unit_price',l.unit_price) else '{}'::jsonb end order by l.line_no) from public.supplier_return_lines l where l.document_id=d.id),'[]'))
 ||case when prices then jsonb_build_object('financials',public.receipt_money_totals_v2((select jsonb_agg(jsonb_build_object('quantity',l.quantity,'unit_price',l.unit_price,'quantity_unit',l.quantity_unit)) from public.supplier_return_lines l where l.document_id=d.id),d.tax_mode,d.tax_rate_basis_points,d.discount_amount)) else '{}'::jsonb end
 order by d.return_date desc,d.created_at desc),'[]') into result
 from public.supplier_return_documents d join public.stock_transaction_documents r on r.kind=d.kind and r.id=d.id
 where d.deleted_at is null and public.supplier_return_visible_v1(p_actor_user_id,d.id);
 return jsonb_build_object('supplier_return_documents',result);
end $function$;
CREATE OR REPLACE FUNCTION public.stamp_cable_transaction_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare profile public.inventory_items;project uuid;cost numeric;reference jsonb;actor uuid;
begin
 select * into profile from public.inventory_items where id=new.inventory_item_id for update;
 if tg_table_name='stock_receipts' then
  if new.quantity_unit='meter' then
   new.meters_per_unit_snapshot:=1;new.package_unit_snapshot:='米';new.cable_snapshot_source:='recorded';return new;
  elsif tg_op='UPDATE' and old.quantity_unit is distinct from new.quantity_unit then
   new.meters_per_unit_snapshot:=profile.meters_per_unit;new.package_unit_snapshot:=profile.unit;new.cable_snapshot_source:='recorded';return new;
  end if;
 end if;
 if tg_op='UPDATE' and new.inventory_item_id=old.inventory_item_id and (tg_table_name<>'site_return_lines' or to_jsonb(new)->>'quantity_unit'=to_jsonb(old)->>'quantity_unit') then
  -- Editing date/quantity/notes does not revalue the historical conversion.
  new.meters_per_unit_snapshot:=old.meters_per_unit_snapshot;
  new.package_unit_snapshot:=old.package_unit_snapshot;
  new.cable_snapshot_source:=old.cable_snapshot_source;
  if tg_table_name in('pickup_records','site_return_lines') then new.cable_unit_cost_snapshot:=old.cable_unit_cost_snapshot;new.cable_cost_source_receipt_ids:=old.cable_cost_source_receipt_ids;end if;
 else
  new.meters_per_unit_snapshot:=profile.meters_per_unit;
  new.package_unit_snapshot:=profile.unit;
  new.cable_snapshot_source:='recorded';
  if tg_table_name='pickup_records' then
   if new.source_receipt_line_id is not null then select r.meters_per_unit_snapshot,r.package_unit_snapshot into new.meters_per_unit_snapshot,new.package_unit_snapshot from public.stock_receipts r where r.id=new.source_receipt_line_id;end if;
   if profile.meters_per_unit is not null or new.quantity_unit='meter' then
    select id into actor from public.app_users where username=new.updated_by and is_active;
    actor:=coalesce(actor,new.created_by_user_id);
    if actor is null then raise exception '無法確認領料者，不能建立成本快照。';end if;
    reference:=public.cable_reference_cost_snapshot_v1(new.inventory_item_id,new.project_id,actor);
    new.cable_unit_cost_snapshot:=(reference->>'unit_cost')::numeric;
    new.cable_cost_source_receipt_ids:=array(select jsonb_array_elements_text(reference->'source_receipt_ids')::uuid);
   end if;
  end if;
 end if;
 if tg_table_name='site_return_lines' then
   if tg_op='UPDATE' and new.quantity_unit is distinct from old.quantity_unit then new.meters_per_unit_snapshot:=profile.meters_per_unit;new.package_unit_snapshot:=profile.unit;end if;
   select project_id into project from public.site_return_documents where id=new.document_id;
   if tg_op='UPDATE' and new.inventory_item_id=old.inventory_item_id and new.quantity=old.quantity and project=old.cable_cost_project_id_snapshot then
    new.cable_cost_project_id_snapshot:=old.cable_cost_project_id_snapshot;
   else
    new.cable_cost_project_id_snapshot:=project;
   if profile.meters_per_unit is not null then
    with movements as (
     select (case when p.quantity_unit='meter' then p.quantity else p.quantity*coalesce(p.meters_per_unit_snapshot,1) end) qty,p.cable_unit_cost_snapshot price
     from public.pickup_records p where p.project_id=project and p.inventory_item_id=new.inventory_item_id
     union all
     select -(case when l.quantity_unit='meter' then l.quantity else l.quantity*coalesce(l.meters_per_unit_snapshot,1) end),l.cable_unit_cost_snapshot
     from public.site_return_lines l join public.site_return_documents d on d.id=l.document_id
     where d.project_id=project and d.status='active' and l.inventory_item_id=new.inventory_item_id and l.document_id<>new.document_id and l.quantity>0)
    select case when count(*) filter(where price is null)>0 then null else sum(qty*price)/nullif(sum(qty),0) end into cost from movements;
    new.cable_unit_cost_snapshot:=cost;
    new.cable_cost_source_receipt_ids:=array(select distinct unnest(p.cable_cost_source_receipt_ids) from public.pickup_records p where p.project_id=project and p.inventory_item_id=new.inventory_item_id);
   end if;
   end if;
 end if;
 -- Explicit accounting price edits intentionally establish a new package quote
 -- at the current specification; unrelated item profile edits do not.
 if tg_table_name='accounting_material_prices' then
  if tg_op='INSERT' or new.unit_price is distinct from old.unit_price then
   new.meters_per_unit_snapshot:=profile.meters_per_unit;new.package_unit_snapshot:=profile.unit;new.cable_snapshot_source:='recorded';
  end if;
 end if;
 return new;
end $function$;
CREATE OR REPLACE FUNCTION public.stamp_receipt_quantity_unit_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare mode text;category_name text;
begin
 mode:=current_setting('app.receipt_quantity_unit',true);
 if mode in('package','meter') then new.quantity_unit:=mode;end if;
 if new.quantity_unit='meter' then
  select c.name into category_name from public.inventory_items i join public.product_categories c on c.id=i.category_id where i.id=new.inventory_item_id;
  if replace(btrim(category_name),'＆','&') not in('弱電線材','電線&電纜類') or category_name is null then raise exception '此貨品種類不能使用散料(米)。';end if;
  if exists(select 1 from public.inventory_items where id=new.inventory_item_id and lower(btrim(unit)) in('米','m','公尺')) and not public.inventory_loose_meter_allowed_v1(new.inventory_item_id) then raise exception '原單位已是米，請使用原單位進貨。';end if;
  if new.quantity<>round(new.quantity,2) then raise exception '米數最多兩位小數。';end if;
 end if;
 return new;
end $function$;
CREATE OR REPLACE FUNCTION public.cable_reference_cost_snapshot_v1(p_item_id uuid, p_project_id uuid, p_actor_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare result jsonb;
begin
 if p_actor_user_id is not null then perform public.erp_private_prepare_v1(p_actor_user_id);end if;
 select jsonb_build_object('unit_cost',p.unit_price/coalesce(p.meters_per_unit_snapshot,1),'source_receipt_ids','[]'::jsonb) into result
 from public.accounting_material_prices p where p.project_id=p_project_id and p.inventory_item_id=p_item_id and (p.meters_per_unit_snapshot is not null or lower(btrim(coalesce(p.package_unit_snapshot,(select coalesce(i.legacy_unit,i.unit)from public.inventory_items i where i.id=p_item_id)))) in('米','m','公尺'));
 if result is not null then return result;end if;
 select jsonb_build_object('unit_cost',public.accounting_receipt_unit_net_v1(r.id)/coalesce(r.meters_per_unit_snapshot,1),'source_receipt_ids',jsonb_build_array(r.id)) into result
   from public.stock_receipts r left join public.stock_transaction_documents d on d.kind='receipt' and d.id=r.receipt_document_id
   where r.inventory_item_id=p_item_id and r.unit_price is not null and d.receipt_delivery_state is distinct from 'pending' and (r.meters_per_unit_snapshot is not null or lower(btrim(coalesce(r.package_unit_snapshot,(select coalesce(i.legacy_unit,i.unit)from public.inventory_items i where i.id=p_item_id)))) in('米','m','公尺'))
   and (p_actor_user_id is null or public.erp_private_json_visible_v1(to_jsonb(r)))
   order by r.receipt_date desc,r.created_at desc,r.id desc limit 1;
 return coalesce(result,jsonb_build_object('unit_cost',null,'source_receipt_ids','[]'::jsonb));
end $function$;
CREATE OR REPLACE FUNCTION public.unpack_cable_for_pickup_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare factor numeric;loose numeric;packages numeric;available numeric;actor text;
begin
 if new.quantity_unit<>'meter' then return new;end if;
 if tg_op='INSERT' or old.inventory_item_id is distinct from new.inventory_item_id or old.quantity_unit<>'meter' then
  if not public.inventory_loose_meter_allowed_v1(new.inventory_item_id) and not(tg_op='UPDATE' and old.inventory_item_id=new.inventory_item_id and old.quantity_unit='meter') then raise exception '此貨品請使用原單位取貨。';end if;
 end if;
 select meters_per_unit into factor from public.inventory_items where id=new.inventory_item_id for update;

 loose:=public.current_inventory_meters_v1(new.inventory_item_id);
 if tg_op='UPDATE' and old.inventory_item_id=new.inventory_item_id and old.quantity_unit='meter' then loose:=loose+old.quantity;end if;
 if new.quantity>loose then
  if factor is null then raise exception '可用米數不足；請先以散料(米)進貨，或設定實際每箱／捲米數後再取貨。';end if;
  packages:=ceil((new.quantity-loose)/factor);available:=public.current_inventory_quantity(new.inventory_item_id);
  -- The BEFORE trigger still sees the old package withdrawal. Those packages
  -- are released by this same UPDATE and may supply the corrected meter row.
  if tg_op='UPDATE' and old.inventory_item_id=new.inventory_item_id and old.quantity_unit='package' then
    available:=available+old.quantity;
  end if;
  if available<packages then raise exception '可用米數不足，散料及整包庫存不足以供應本次取貨。';end if;
  actor:=coalesce(new.updated_by,new.created_by_username,'system');
  insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
   values(new.inventory_item_id,available,available-packages,'米數取貨拆包：'||new.id::text||'；每包 '||factor::text||' 米',gen_random_uuid(),'web',actor,'package');
  insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
   values(new.inventory_item_id,loose,loose+packages*factor,'米數取貨拆包：'||new.id::text||'；'||packages::text||' 包',gen_random_uuid(),'web',actor,'meter');
 end if;
 return new;
end $function$;
notify pgrst,'reload schema';
