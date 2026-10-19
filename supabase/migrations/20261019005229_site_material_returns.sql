-- Site returns reuse the existing stock document registry and immutable stock
-- adjustment ledger. They never create a supplier receipt, price or tax amount.
alter table public.stock_transaction_documents drop constraint stock_transaction_documents_kind_check;
alter table public.stock_transaction_documents add constraint stock_transaction_documents_kind_check check(kind in ('receipt','pickup','site_return'));

create table public.site_return_documents (
 id uuid primary key,
 kind text not null default 'site_return' check(kind='site_return'),
 document_no text not null unique,
 return_date date not null,
 customer_id uuid not null references public.customers(id),
 project_id uuid not null references public.projects(id),
 status text not null default 'active' check(status in ('active','cancelled','deleted')),
 note text not null default '' check(length(note)<=500),
 created_by_user_id uuid not null references public.app_users(id),
 updated_by_user_id uuid not null references public.app_users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),row_version integer not null default 1,
 foreign key(kind,id) references public.stock_transaction_documents(kind,id)
);
create index site_return_documents_project_date_idx on public.site_return_documents(project_id,return_date) where status='active';
create index site_return_documents_customer_idx on public.site_return_documents(customer_id,return_date);
create index site_return_documents_creator_idx on public.site_return_documents(created_by_user_id);
create index site_return_documents_updater_idx on public.site_return_documents(updated_by_user_id);
create table public.site_return_lines (
 id uuid primary key default gen_random_uuid(),document_id uuid not null references public.site_return_documents(id),
 inventory_item_id uuid not null references public.inventory_items(id),quantity numeric(14,2) not null check(quantity>=0),
 unique(document_id,inventory_item_id)
);
create index site_return_lines_item_idx on public.site_return_lines(inventory_item_id,document_id);
create table public.site_return_requests (
 request_id uuid primary key,document_id uuid not null references public.site_return_documents(id),
 actor_user_id uuid not null references public.app_users(id),payload jsonb not null,result jsonb not null,created_at timestamptz not null default now()
);
create index site_return_requests_doc_idx on public.site_return_requests(document_id);
create index site_return_requests_actor_idx on public.site_return_requests(actor_user_id);
alter table public.stock_adjustments add column site_return_line_id uuid references public.site_return_lines(id),
 add column site_return_version integer;
create unique index stock_adjustments_return_line_version_uidx on public.stock_adjustments(site_return_line_id,site_return_version) where site_return_line_id is not null;
alter table public.stock_adjustments add constraint site_return_adjustment_source_check check(
 (site_return_line_id is null and site_return_version is null and source<>'site_return') or
 (site_return_line_id is not null and site_return_version>0 and source='site_return'));
alter table public.site_return_documents enable row level security;
alter table public.site_return_lines enable row level security;
alter table public.site_return_requests enable row level security;
revoke all on public.site_return_documents,public.site_return_lines,public.site_return_requests from public,anon,authenticated;
grant select,insert,update on public.site_return_documents,public.site_return_lines to service_role;
grant select,insert on public.site_return_requests to service_role;

create function public.site_return_project_visible_v1(p_actor_user_id uuid,p_project_id uuid) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.projects p join public.customers c on c.id=p.customer_id
 join public.app_users u on u.id=p_actor_user_id and u.is_active join public.app_roles role on role.code=u.role
 where p.id=p_project_id and p.deleted_at is null and c.deleted_at is null
 and public.erp_private_json_visible_v1(to_jsonb(p)) and public.erp_private_json_visible_v1(to_jsonb(c))
 and (not role.project_scoped or exists(select 1 from public.project_workers w where w.project_id=p.id and w.user_id=u.id and (w.can_view or w.is_assignee))));
$$;

create function public.site_return_list_v1(p_actor_user_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare allowed uuid[];
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') then raise exception '沒有案場餘料入庫查看權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 select coalesce(array_agg(p.id),'{}') into allowed from public.projects p where public.site_return_project_visible_v1(p_actor_user_id,p.id);
 return jsonb_build_object(
 'documents',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object('account',u.display_name,'lines',
  coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from public.site_return_lines l where l.document_id=d.id and l.quantity>0),'[]')) order by d.return_date desc,d.created_at desc)
  from public.site_return_documents d join public.app_users u on u.id=d.created_by_user_id where d.status<>'deleted' and d.project_id=any(allowed)),'[]'),
 'projects',coalesce((select jsonb_agg(jsonb_build_object('id',id,'customer_id',customer_id,'name',name,'code',project_code,'department_id',department_id) order by project_code) from public.projects where id=any(allowed)),'[]'),
 'customers',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'code',c.customer_code,'category',c.customer_category) order by c.customer_code) from public.customers c where c.id in(select customer_id from public.projects where id=any(allowed))),'[]'),
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'code',i.inventory_code,'name',i.item_name,'brand',i.brand,'model',i.model,'unit',i.unit,'category_id',i.category_id,'category',coalesce(c.name,'未分類'),'active',i.inventory_status='active') order by i.inventory_code) from public.inventory_items i left join public.product_categories c on c.id=i.category_id),'[]'),
 'permissions',jsonb_build_object('create',public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE'),'update',public.has_app_permission_v1(p_actor_user_id,'purchases','UPDATE'),'delete',public.has_app_permission_v1(p_actor_user_id,'purchases','DELETE')));
end $$;

create function public.save_site_return_v1(p_actor_user_id uuid,p_document_id uuid,p_request_id uuid,p_row_version integer,
 p_action text,p_return_date date,p_customer_id uuid,p_project_id uuid,p_rows jsonb,p_note text default '') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare old_doc public.site_return_documents;new_doc public.site_return_documents;reg public.stock_transaction_documents;
 old_request public.site_return_requests;request_payload jsonb;v_result jsonb;v_actor text;row_data jsonb;line public.site_return_lines;
 v_item uuid;v_line uuid;v_before numeric;v_old numeric;v_new numeric;v_delta numeric;v_issued numeric;v_other numeric;v_version integer;v_status text;
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
  if (select count(*) from jsonb_array_elements(p_rows))<>(select count(distinct r->>'inventory_item_id') from jsonb_array_elements(p_rows) r) then raise exception '同一張入庫單的重複品項請合併數量。';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r left join public.inventory_items i on i.id=(r->>'inventory_item_id')::uuid where i.id is null or i.inventory_status<>'active') then raise exception '部分品項已不存在或停用，請重新選擇。';end if;
 end if;
 -- Same row locks as pickup/receipt/physical count writes; serialize all stock changes.
 perform 1 from public.inventory_items where id in(select inventory_item_id from public.site_return_lines where document_id=p_document_id
 union select (r->>'inventory_item_id')::uuid from jsonb_array_elements(case when p_action in ('create','update') then p_rows else '[]'::jsonb end) r) order by id for update;
 if p_action in ('create','update') then
  for row_data in select value from jsonb_array_elements(p_rows) loop
   v_item:=(row_data->>'inventory_item_id')::uuid;
   select coalesce(sum(quantity),0) into v_issued from public.pickup_records where project_id=p_project_id and inventory_item_id=v_item;
   select coalesce(sum(l.quantity),0) into v_other from public.site_return_lines l join public.site_return_documents d on d.id=l.document_id where d.project_id=p_project_id and d.status='active' and d.id<>p_document_id and l.inventory_item_id=v_item;
   if (row_data->>'quantity')::numeric+v_other>v_issued then raise exception '退回數量超過此工作內容可退的領用數量，請核對領料與其他退料單。';end if;
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
  select coalesce((select (r->>'quantity')::numeric from jsonb_array_elements(p_rows) r where (r->>'inventory_item_id')::uuid=v_item),0) into v_new;
  if p_action not in ('create','update') then v_new:=0;end if;
  v_delta:=v_new-v_old;
  if p_action in ('create','update') then
   insert into public.site_return_lines(document_id,inventory_item_id,quantity) values(p_document_id,v_item,v_new)
   on conflict(document_id,inventory_item_id) do update set quantity=excluded.quantity returning id into v_line;
  else v_line:=line.id;end if;
  if v_delta<>0 then
   v_before:=public.current_inventory_quantity(v_item);
   if v_before+v_delta<0 then raise exception '退料已被後續領用，回沖會造成負庫存；請先處理後續取貨。';end if;
   insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,site_return_line_id,site_return_version)
   values(v_item,v_before,v_before+v_delta,'案場餘料入庫 '||new_doc.document_no,gen_random_uuid(),'site_return',v_actor,v_line,v_version);
  end if;
 end loop;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('site_return_documents',p_document_id,case p_action when 'create' then 'insert' when 'cancel' then 'update' else p_action end,case when old_doc.id is not null then to_jsonb(old_doc) end,to_jsonb(new_doc),'web',v_actor);
 v_result:=jsonb_build_object('document_id',p_document_id,'document_no',new_doc.document_no,'row_version',v_version,'status',v_status);
 insert into public.site_return_requests(request_id,document_id,actor_user_id,payload,result) values(p_request_id,p_document_id,p_actor_user_id,request_payload,v_result);
 return v_result;
end $$;

-- Keep original pickup history; reject changes that would invalidate existing returns.
create function public.guard_site_return_pickups_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare p uuid;i uuid;issued numeric;returned numeric;
begin
 for p,i in select old.project_id,old.inventory_item_id union select new.project_id,new.inventory_item_id loop
  if p is null or i is null then continue;end if;
  perform 1 from public.inventory_items where id=i for update;
  select coalesce(sum(quantity),0) into issued from public.pickup_records where project_id=p and inventory_item_id=i;
  select coalesce(sum(l.quantity),0) into returned from public.site_return_lines l join public.site_return_documents d on d.id=l.document_id where d.project_id=p and d.status='active' and l.inventory_item_id=i;
  if returned>issued then raise exception '此工作內容已有餘料退回，請先調整退料單，不能使領用數量低於退料數量。';end if;
 end loop;
 return null;
end $$;
create constraint trigger pickup_site_return_guard after update or delete on public.pickup_records deferrable initially deferred for each row execute function public.guard_site_return_pickups_v1();

revoke all on function public.site_return_project_visible_v1(uuid,uuid),public.site_return_list_v1(uuid),public.save_site_return_v1(uuid,uuid,uuid,integer,text,date,uuid,uuid,jsonb,text),public.guard_site_return_pickups_v1() from public,anon,authenticated;
grant execute on function public.site_return_project_visible_v1(uuid,uuid),public.site_return_list_v1(uuid),public.save_site_return_v1(uuid,uuid,uuid,integer,text,date,uuid,uuid,jsonb,text),public.guard_site_return_pickups_v1() to service_role;

CREATE OR REPLACE FUNCTION public.ensure_stock_document_v1(p_kind text, p_id uuid, p_date date, p_scope uuid, p_request uuid DEFAULT NULL::uuid)
 RETURNS stock_transaction_documents
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_doc public.stock_transaction_documents;v_id uuid:=p_id;v_sequence integer;
begin
  if p_kind not in ('receipt','pickup','site_return') or p_id is null or p_date is null then raise exception '單據識別資料不完整。';end if;
  -- The request lock also protects mixed-project/date batches from older clients.
  perform pg_advisory_xact_lock(hashtextextended('stock-document:'||p_kind||':'||coalesce(p_request,p_id)::text,0));
  if p_request is not null then
    select * into v_doc from public.stock_transaction_documents where kind=p_kind and source_request_id=p_request
      and numbering_scope_id is not distinct from p_scope and numbering_date=p_date;
    if found then return v_doc;end if;
    if exists(select 1 from public.stock_transaction_documents where kind=p_kind and id=v_id) then v_id:=gen_random_uuid();end if;
  else
    select * into v_doc from public.stock_transaction_documents where kind=p_kind and id=v_id;
    if found then return v_doc;end if;
  end if;
  if p_scope is not null then
    -- Allocation is inside the caller's transaction, serialized per ID + actual date.
    -- Registry rows are retained after deletion, so issued numbers are never recycled.
    if p_kind='receipt' then perform pg_advisory_xact_lock(hashtextextended('receipt-number-scope:'||p_scope::text,0));end if;
perform pg_advisory_xact_lock(hashtextextended('stock-number:'||p_kind||':'||p_scope::text||':'||p_date::text,0));
    select coalesce(max(sequence_no),0)+1 into v_sequence from public.stock_transaction_documents
      where kind=p_kind and numbering_scope_id=p_scope and numbering_date=p_date;

    if p_kind='receipt' then
      while exists(select 1 from public.stock_transaction_documents where kind='receipt' and numbering_scope_id=p_scope
        and lower(document_no)=lower(to_char(p_date,'YYYYMMDD')||case when v_sequence>1 then '-'||v_sequence else '' end)) loop
        v_sequence:=v_sequence+1;
      end loop;
    end if;
  end if;
  insert into public.stock_transaction_documents(kind,id,numbering_scope_id,numbering_date,sequence_no,document_no,source_request_id)
  values(p_kind,v_id,p_scope,p_date,v_sequence,case when v_sequence is not null then case when p_kind='site_return' then 'RET-' else '' end||to_char(p_date,'YYYYMMDD')||case when v_sequence>1 then '-'||v_sequence else '' end end,p_request)
  returning * into v_doc;
  return v_doc;
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
 returned as materialized (
 select l.id,l.inventory_item_id,l.quantity,d.return_date,d.document_no,d.id document_id,u.display_name account
 from public.site_return_lines l join public.site_return_documents d on d.id=l.document_id
 join public.app_users u on u.id=d.created_by_user_id
 where d.project_id=p_project_id and d.status='active' and l.quantity>0
 and (p_from is null or d.return_date>=p_from) and (p_to is null or d.return_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(d))),
 issued_totals as (select inventory_item_id,sum(quantity) quantity,count(*) records,min(pickup_date) first_date,max(pickup_date) recent_date from materials group by inventory_item_id),
 returned_totals as (select inventory_item_id,sum(quantity) quantity,count(*) records,min(return_date) first_date,max(return_date) recent_date from returned group by inventory_item_id),
 mat as (
 select i.id,i.item_name name,i.brand,i.model,coalesce(nullif(i.unit,''),'未標示單位') unit,
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
 'returnRows',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'date',r.return_date,'documentId',r.document_id,'documentNo',r.document_no,'itemId',r.inventory_item_id,'categoryId',i.category_id,'quantity',r.quantity,'account',r.account,'item',jsonb_build_object('name',i.item_name,'brand',i.brand,'model',i.model,'unit',i.unit)) order by r.return_date desc,r.id) from returned r join public.inventory_items i on i.id=r.inventory_item_id),'[]'),
 'quantityBasis','issued_minus_returns',
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
