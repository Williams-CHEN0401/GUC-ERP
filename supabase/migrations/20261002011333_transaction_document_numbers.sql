begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Never choose an arbitrary header for an inconsistent legacy document.
do $$ begin
  if exists(select 1 from public.stock_receipts where receipt_document_id is not null group by receipt_document_id
    having count(distinct (receipt_date,supplier_id))>1) then
    raise exception '既有進貨單的日期／廠商不一致，請先執行唯讀盤點並人工確認；本次移轉未套用。';
  end if;
end $$;

-- Document identity/number registry only: existing stock rows remain the inventory ledger.
-- Numbering scope/date are immutable snapshots; editing business dates never renumbers.
create table public.stock_transaction_documents (
  kind text not null check(kind in ('receipt','pickup')),
  id uuid not null,
  numbering_scope_id uuid,
  numbering_date date not null,
  sequence_no integer check(sequence_no>0),
  document_no text,
  source_request_id uuid,
  created_at timestamptz not null default now(),
  primary key(kind,id),
  unique(kind,numbering_scope_id,numbering_date,sequence_no),
  check((numbering_scope_id is null and sequence_no is null and document_no is null)
    or (numbering_scope_id is not null and sequence_no is not null and document_no is not null))
);
create unique index stock_documents_request_group_uidx on public.stock_transaction_documents
  (kind,source_request_id,numbering_scope_id,numbering_date) where source_request_id is not null;
alter table public.stock_transaction_documents enable row level security;
revoke all on public.stock_transaction_documents from public,anon,authenticated;
grant select,insert,update on public.stock_transaction_documents to service_role;

alter table public.stock_receipts add column receipt_document_no text;
alter table public.pickup_records add column pickup_document_id uuid,add column pickup_document_no text;
create index pickup_records_document_idx on public.pickup_records(pickup_document_id,id);

create function public.ensure_stock_document_v1(p_kind text,p_id uuid,p_date date,p_scope uuid,p_request uuid default null)
returns public.stock_transaction_documents language plpgsql security invoker set search_path='' as $$
declare v_doc public.stock_transaction_documents;v_id uuid:=p_id;v_sequence integer;
begin
  if p_kind not in ('receipt','pickup') or p_id is null or p_date is null then raise exception '單據識別資料不完整。';end if;
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
    perform pg_advisory_xact_lock(hashtextextended('stock-number:'||p_kind||':'||p_scope::text||':'||p_date::text,0));
    select coalesce(max(sequence_no),0)+1 into v_sequence from public.stock_transaction_documents
      where kind=p_kind and numbering_scope_id=p_scope and numbering_date=p_date;
  end if;
  insert into public.stock_transaction_documents(kind,id,numbering_scope_id,numbering_date,sequence_no,document_no,source_request_id)
  values(p_kind,v_id,p_scope,p_date,v_sequence,case when v_sequence is not null then to_char(p_date,'YYYYMMDD')||case when v_sequence>1 then '-'||v_sequence else '' end end,p_request)
  returning * into v_doc;
  return v_doc;
end $$;
revoke all on function public.ensure_stock_document_v1(text,uuid,date,uuid,uuid) from public,anon,authenticated;
grant execute on function public.ensure_stock_document_v1(text,uuid,date,uuid,uuid) to service_role;

-- Backfill only explicit identities. No date/vendor/name heuristic merges.
-- Legacy pickup request IDs are partitioned by exact project ID + actual date to
-- preserve historical single-line reassignments and old mixed-context requests.
do $$
declare r record;d public.stock_transaction_documents;
begin
  for r in select * from public.stock_receipts order by created_at nulls last,id loop
    d:=public.ensure_stock_document_v1('receipt',coalesce(r.receipt_document_id,r.id),r.receipt_date,r.supplier_id);
    update public.stock_receipts set receipt_document_id=d.id,receipt_document_no=d.document_no where id=r.id;
  end loop;
  for r in select * from public.pickup_records order by created_at nulls last,id loop
    d:=public.ensure_stock_document_v1('pickup',coalesce(r.request_id,r.id),r.pickup_date,r.project_id,r.request_id);
    update public.pickup_records set pickup_document_id=d.id,pickup_document_no=d.document_no where id=r.id;
  end loop;
end $$;

create function public.stamp_stock_document_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare d public.stock_transaction_documents;v_context uuid;v_batch uuid;
begin
  if tg_table_name='stock_receipts' then
    if tg_op='UPDATE' then
      new.receipt_document_id:=old.receipt_document_id;new.receipt_document_no:=old.receipt_document_no;return new;
    end if;
    v_context:=nullif(current_setting('app.receipt_document_id',true),'')::uuid;
    v_batch:=nullif(current_setting('app.receipt_batch_id',true),'')::uuid;
    d:=public.ensure_stock_document_v1('receipt',coalesce(new.receipt_document_id,v_context,v_batch,new.id),new.receipt_date,new.supplier_id,
      case when new.receipt_document_id is null and v_context is null then v_batch end);
    new.receipt_document_id:=d.id;new.receipt_document_no:=d.document_no;
  else
    if tg_op='UPDATE' then
      new.pickup_document_id:=old.pickup_document_id;new.pickup_document_no:=old.pickup_document_no;return new;
    end if;
    v_context:=nullif(current_setting('app.pickup_document_id',true),'')::uuid;
    d:=public.ensure_stock_document_v1('pickup',coalesce(new.pickup_document_id,v_context,new.request_id,new.id),new.pickup_date,new.project_id,
      case when new.pickup_document_id is null and v_context is null then new.request_id end);
    new.pickup_document_id:=d.id;new.pickup_document_no:=d.document_no;
  end if;
  return new;
end $$;
revoke all on function public.stamp_stock_document_v1() from public,anon,authenticated;
grant execute on function public.stamp_stock_document_v1() to service_role;
create trigger receipt_document_stamp before insert or update on public.stock_receipts for each row execute function public.stamp_stock_document_v1();
create trigger pickup_document_stamp before insert or update on public.pickup_records for each row execute function public.stamp_stock_document_v1();

-- Keep old batch contracts; a missing client request ID gets one server batch ID.
do $$
declare s text;needle text:='for v_row in select value from jsonb_array_elements(p_rows)';guard text:='  select array_agg(distinct ids.value order by ids.value)';writer text:='for v_row in select value from jsonb_array_elements(v_normalized)';
begin
  select pg_get_functiondef('public.create_pickup_records_batch_v2(jsonb,uuid,text,uuid,uuid,text)'::regprocedure) into s;
  if position(needle in s)=0 then raise exception '取貨批次函式版本不符，停止移轉。';end if;
  s:=replace(s,needle,'p_request_id:=coalesce(p_request_id,gen_random_uuid());'||chr(10)||needle);
  if position(guard in s)=0 then raise exception '取貨批次防重複版本不符，停止移轉。';end if;
  -- A completed request whose rows were deleted cannot silently resurrect.
  s:=overlay(s placing '  if exists(select 1 from public.stock_transaction_documents where kind=''pickup'' and source_request_id=p_request_id) then raise exception ''此取貨請求已處理或刪除，請重新建立新單據。'';end if;'||chr(10) from position(guard in s) for 0);
  if position(writer in s)=0 or position('v_row jsonb;' in s)=0 then raise exception '取貨寫入函式版本不符，停止移轉。';end if;
  s:=replace(s,'v_row jsonb;','v_number_scope record;v_row jsonb;');
  -- Mixed-context old batches take numbering locks in the same order, without
  -- changing input row order, request_row, or the existing return contract.
  s:=replace(s,writer,'for v_number_scope in select distinct (value->>''project_id'')::uuid scope,(value->>''pickup_date'')::date actual_date from jsonb_array_elements(v_normalized) order by scope,actual_date loop perform public.ensure_stock_document_v1(''pickup'',p_request_id,v_number_scope.actual_date,v_number_scope.scope,p_request_id);end loop;'||chr(10)||writer);
  execute s;
end $$;

-- Older receipt callers still get their original return value/customer logic.
-- Group only rows submitted in THIS invocation, partitioned by exact scope/date.
do $$
declare s text;needle text:='for v_row in select value from jsonb_array_elements(p_rows) loop';
begin
  select pg_get_functiondef('public.create_stock_receipts_with_customers_v1(jsonb,uuid[],uuid)'::regprocedure) into s;
  if position(needle in s)=0 or position('return jsonb_build_object(' in s)=0 or position('declare v_row jsonb;' in s)=0 then raise exception '進貨批次函式版本不符，停止移轉。';end if;
  s:=replace(s,'declare v_row jsonb;','declare v_previous_batch text;v_number_scope record;v_row jsonb;');
  s:=replace(s,needle,'v_previous_batch:=current_setting(''app.receipt_batch_id'',true);perform set_config(''app.receipt_batch_id'',gen_random_uuid()::text,true);'||chr(10)||'if nullif(current_setting(''app.receipt_document_id'',true),'''') is null then for v_number_scope in select distinct (value->>''supplier_id'')::uuid scope,(value->>''receipt_date'')::date actual_date from jsonb_array_elements(p_rows) order by scope,actual_date loop perform public.ensure_stock_document_v1(''receipt'',current_setting(''app.receipt_batch_id'')::uuid,v_number_scope.actual_date,v_number_scope.scope,current_setting(''app.receipt_batch_id'')::uuid);end loop;end if;'||chr(10)||needle);
  s:=replace(s,'return jsonb_build_object(','perform set_config(''app.receipt_batch_id'',coalesce(v_previous_batch,''''),true);return jsonb_build_object(');
  execute s;
end $$;

-- Preserve the existing signature, customer links, stock writers and audit path.
create or replace function public.save_stock_receipt_document_v1(p_document_id uuid,p_create boolean,p_existing jsonb,
  p_receipt_date date,p_supplier_id uuid,p_rows jsonb,p_customer_ids uuid[],p_customer_departments jsonb,p_actor_user_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_current uuid[];v_expected uuid[];v_submitted uuid[];v_removed uuid[];v_row jsonb;v_id uuid;
  v_created jsonb;v_line integer:=0;v_ids uuid[]:='{}';v_version integer;v_context text;v_actor text;
begin
  if p_create is null or p_document_id is null or p_receipt_date is null or p_supplier_id is null
    or not public.has_app_permission_v1(p_actor_user_id,'purchases',case when p_create then 'CREATE' else 'UPDATE' end) then
    raise exception '沒有有效的進貨單資料或操作權限。';end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 20
    or p_existing is null or jsonb_typeof(p_existing)<>'array' or jsonb_array_length(p_existing)>50 then raise exception '每張進貨單必須有 1 至 20 筆明細。';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r)<>'object' or nullif(r->>'inventory_item_id','') is null
    or coalesce((r->>'quantity')::numeric,0)<=0 or (r->>'quantity')::numeric<>trunc((r->>'quantity')::numeric)
    or char_length(coalesce(r->>'note',''))>500) then raise exception '進貨明細品項、數量或備註不正確。';end if;
  if (select count(*) from jsonb_array_elements(p_rows))<>(select count(distinct (r->>'inventory_item_id',lower(btrim(coalesce(r->>'note',''))))) from jsonb_array_elements(p_rows) r) then
    raise exception '同一張進貨單有重複明細，請合併數量。';end if;
  perform pg_advisory_xact_lock(hashtextextended(p_document_id::text,0));
  perform 1 from public.stock_receipts where receipt_document_id=p_document_id order by id for update;
  select coalesce(array_agg(id order by id),'{}') into v_current from public.stock_receipts where receipt_document_id=p_document_id;
  select coalesce(array_agg((r->>'id')::uuid order by (r->>'id')::uuid),'{}') into v_expected from jsonb_array_elements(p_existing) r;
  select coalesce(array_agg((r->>'id')::uuid order by (r->>'id')::uuid),'{}') into v_submitted from jsonb_array_elements(p_rows) r where nullif(r->>'id','') is not null;
  if (p_create and (cardinality(v_current)>0 or exists(select 1 from public.stock_transaction_documents where kind='receipt' and id=p_document_id)))
    or (not p_create and cardinality(v_current)=0) or v_current is distinct from v_expected or not(v_submitted<@v_current)
    or cardinality(v_submitted)<>(select count(distinct id) from unnest(v_submitted) id)
    or exists(select 1 from jsonb_array_elements(p_existing) e join public.stock_receipts s on s.id=(e->>'id')::uuid where (e->>'row_version')::integer is distinct from s.row_version)
    then raise exception '進貨單已被更新，請重新整理後再修改；原單據未變更。';end if;
  perform 1 from public.inventory_items where id in(select (r->>'inventory_item_id')::uuid from jsonb_array_elements(p_rows) r
    union select inventory_item_id from public.stock_receipts where id=any(v_current)) order by id for update;
  select coalesce(array_agg(id),'{}') into v_removed from unnest(v_current) id where not(id=any(v_submitted));
  select username into v_actor from public.app_users where id=p_actor_user_id and is_active;
  if cardinality(v_removed)>0 then
    if not public.has_app_permission_v1(p_actor_user_id,'purchases','DELETE') then raise exception '沒有刪除進貨明細的權限。';end if;
    perform public.delete_stock_receipt_records(v_removed,v_actor);
  end if;
  v_context:=current_setting('app.receipt_document_id',true);perform set_config('app.receipt_document_id',p_document_id::text,true);
  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_line:=v_line+1;v_id:=nullif(v_row->>'id','')::uuid;
    if v_id is null then
      if not public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE') then raise exception '沒有新增進貨明細的權限。';end if;
      v_created:=public.create_stock_receipts_department_v1(jsonb_build_array(jsonb_build_object('receipt_date',p_receipt_date,'supplier_id',p_supplier_id,
        'inventory_item_id',v_row->>'inventory_item_id','quantity',v_row->'quantity','note',v_row->>'note')),p_customer_ids,p_customer_departments,p_actor_user_id);
      v_id:=(v_created->'ids'->>0)::uuid;
    else
      select row_version into v_version from public.stock_receipts where id=v_id;
      perform public.update_stock_receipt_department_v1(v_id,v_version,p_receipt_date,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,
        p_supplier_id,v_row->>'note',p_customer_ids,p_customer_departments,p_actor_user_id);
    end if;
    update public.stock_receipts set receipt_line_no=v_line where id=v_id and receipt_line_no is distinct from v_line;
    v_ids:=array_append(v_ids,v_id);
  end loop;
  perform set_config('app.receipt_document_id',coalesce(v_context,''),true);
  return jsonb_build_object('document_id',p_document_id,'ids',v_ids,'saved',cardinality(v_ids));
end $$;

create function public.save_pickup_document_v1(p_document_id uuid,p_existing jsonb,p_pickup_date date,p_project_id uuid,p_rows jsonb,p_actor_user_id uuid)
-- Match existing pickup writers: service-only RPC, trusted actor + RBAC checked
-- inside; do not grant new direct table-write privileges to any application role.
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_current uuid[];v_expected uuid[];v_submitted uuid[];v_removed uuid[];v_row jsonb;v_id uuid;v_version integer;
  v_actor text;v_creator uuid;v_username text;v_log uuid;v_context text;v_request_row integer;v_ids uuid[]:='{}';
begin
  if p_document_id is null or p_pickup_date is null or p_project_id is null or not public.has_app_permission_v1(p_actor_user_id,'pickups','UPDATE') then raise exception '沒有有效的取貨單資料或操作權限。';end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 50
    or p_existing is null or jsonb_typeof(p_existing)<>'array' or jsonb_array_length(p_existing) not between 1 and 50 then raise exception '取貨明細資料不完整。';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r)<>'object' or nullif(r->>'inventory_item_id','') is null
    or coalesce((r->>'quantity')::numeric,0)<=0 or (r->>'quantity')::numeric<>trunc((r->>'quantity')::numeric) or char_length(coalesce(r->>'note',''))>500)
    then raise exception '取貨明細品項、數量或備註不正確。';end if;
  if (select count(*) from jsonb_array_elements(p_rows))<>(select count(distinct r->>'inventory_item_id') from jsonb_array_elements(p_rows) r) then raise exception '同一張取貨單有重複品項，請合併數量。';end if;
  perform pg_advisory_xact_lock(hashtextextended(p_document_id::text,0));
  perform 1 from public.projects where id=p_project_id for key share;
  if not found then raise exception '找不到指定工作內容。';end if;
  perform 1 from public.site_work_logs where id in(select work_log_id from public.pickup_records where pickup_document_id=p_document_id) order by id for share;
  perform 1 from public.pickup_records where pickup_document_id=p_document_id order by id for update;
  select coalesce(array_agg(id order by id),'{}') into v_current from public.pickup_records where pickup_document_id=p_document_id;
  select coalesce(array_agg((r->>'id')::uuid order by (r->>'id')::uuid),'{}') into v_expected from jsonb_array_elements(p_existing) r;
  select coalesce(array_agg((r->>'id')::uuid order by (r->>'id')::uuid),'{}') into v_submitted from jsonb_array_elements(p_rows) r where nullif(r->>'id','') is not null;
  if cardinality(v_current)=0 or v_current is distinct from v_expected or not(v_submitted<@v_current)
    or cardinality(v_submitted)<>(select count(distinct id) from unnest(v_submitted) id)
    or exists(select 1 from jsonb_array_elements(p_existing) e join public.pickup_records s on s.id=(e->>'id')::uuid where (e->>'row_version')::integer is distinct from s.row_version)
    then raise exception '取貨單已被更新，請重新整理後再修改；原單據未變更。';end if;
  perform 1 from public.inventory_items where id in(select (r->>'inventory_item_id')::uuid from jsonb_array_elements(p_rows) r
    union select inventory_item_id from public.pickup_records where id=any(v_current)) order by id for update;
  select username into v_actor from public.app_users where id=p_actor_user_id and is_active;
  select created_by_user_id,created_by_username,work_log_id into v_creator,v_username,v_log from public.pickup_records where id=any(v_current) order by id limit 1;
  if exists(select 1 from public.pickup_records where id=any(v_current) and (work_log_id is distinct from v_log or project_id<>p_project_id)) then v_log:=null;end if;
  select coalesce(array_agg(id),'{}') into v_removed from unnest(v_current) id where not(id=any(v_submitted));
  if cardinality(v_removed)>0 then
    if not public.has_app_permission_v1(p_actor_user_id,'pickups','DELETE') then raise exception '沒有刪除取貨明細的權限。';end if;
    perform public.delete_pickup_records(v_removed,v_actor);
  end if;
  v_context:=current_setting('app.pickup_document_id',true);perform set_config('app.pickup_document_id',p_document_id::text,true);
  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_id:=nullif(v_row->>'id','')::uuid;
    if v_id is null then
      if not public.has_app_permission_v1(p_actor_user_id,'pickups','CREATE') then raise exception '沒有新增取貨明細的權限。';end if;
      -- New lines retain the original account/log context, not another assignment ID.
      insert into public.pickup_records(pickup_date,project_id,inventory_item_id,quantity,note,source,updated_by,created_by_user_id,created_by_username,work_log_id)
      values(p_pickup_date,p_project_id,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,nullif(btrim(v_row->>'note'),''),'web',v_actor,v_creator,v_username,v_log) returning id into v_id;
    else
      select row_version into v_version from public.pickup_records where id=v_id;
      perform public.update_pickup_record_v2(v_id,v_version,p_pickup_date,p_project_id,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,v_row->>'note',v_actor);
    end if;
    v_ids:=array_append(v_ids,v_id);
  end loop;
  perform set_config('app.pickup_document_id',coalesce(v_context,''),true);
  return jsonb_build_object('document_id',p_document_id,'ids',v_ids,'saved',cardinality(v_ids));
end $$;
revoke all on function public.save_pickup_document_v1(uuid,jsonb,date,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.save_pickup_document_v1(uuid,jsonb,date,uuid,jsonb,uuid) to service_role;

create function public.delete_stock_document_v1(p_kind text,p_document_id uuid,p_existing jsonb,p_actor_user_id uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare v_ids uuid[];v_expected uuid[];v_actor text;v_stale boolean;
begin
  if p_kind is null or p_kind not in ('receipt','pickup') or p_document_id is null
    or not public.has_app_permission_v1(p_actor_user_id,case p_kind when 'receipt' then 'purchases' else 'pickups' end,'DELETE') then raise exception '沒有刪除整單的權限。';end if;
  if p_existing is null or jsonb_typeof(p_existing)<>'array' or jsonb_array_length(p_existing) not between 1 and 50 then raise exception '單據版本不正確。';end if;
  perform pg_advisory_xact_lock(hashtextextended(p_document_id::text,0));
  select coalesce(array_agg((r->>'id')::uuid order by (r->>'id')::uuid),'{}') into v_expected from jsonb_array_elements(p_existing) r;
  if p_kind='receipt' then
    perform 1 from public.stock_receipts where receipt_document_id=p_document_id order by id for update;
    select coalesce(array_agg(id order by id),'{}') into v_ids from public.stock_receipts where receipt_document_id=p_document_id;
    select exists(select 1 from jsonb_array_elements(p_existing) e join public.stock_receipts s on s.id=(e->>'id')::uuid where (e->>'row_version')::integer is distinct from s.row_version) into v_stale;
  else
    perform 1 from public.pickup_records where pickup_document_id=p_document_id order by id for update;
    select coalesce(array_agg(id order by id),'{}') into v_ids from public.pickup_records where pickup_document_id=p_document_id;
    select exists(select 1 from jsonb_array_elements(p_existing) e join public.pickup_records s on s.id=(e->>'id')::uuid where (e->>'row_version')::integer is distinct from s.row_version) into v_stale;
  end if;
  if cardinality(v_ids)=0 or v_ids is distinct from v_expected or v_stale then raise exception '單據已被更新，請重新整理後再刪除。';end if;
  select username into v_actor from public.app_users where id=p_actor_user_id and is_active;
  if p_kind='receipt' then return public.delete_stock_receipt_records(v_ids,v_actor);end if;
  return public.delete_pickup_records(v_ids,v_actor);
end $$;
revoke all on function public.delete_stock_document_v1(text,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.delete_stock_document_v1(text,uuid,jsonb,uuid) to service_role;
notify pgrst,'reload schema';
commit;
