begin;
set local lock_timeout='5s';
-- Keep existing stock rows, balances, audit triggers and customer links as the source of truth.
-- Null document IDs remain individual legacy documents; never infer groups from dates/names.
alter table public.stock_receipts add column receipt_document_id uuid,
  add column receipt_line_no integer check(receipt_line_no>0);
create index stock_receipts_document_idx on public.stock_receipts(receipt_document_id,id)
  where receipt_document_id is not null;

create function public.save_stock_receipt_document_v1(p_document_id uuid,p_create boolean,p_existing jsonb,
  p_receipt_date date,p_supplier_id uuid,p_rows jsonb,p_customer_ids uuid[],p_customer_departments jsonb,p_actor_user_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_current uuid[]; v_expected uuid[]; v_submitted uuid[]; v_row jsonb; v_id uuid;
  v_created jsonb; v_line integer:=0; v_ids uuid[]:='{}'; v_version integer;
begin
  if p_create is null or p_document_id is null or p_receipt_date is null or p_supplier_id is null
    or not public.has_app_permission_v1(p_actor_user_id,'purchases',case when p_create then 'CREATE' else 'UPDATE' end) then
    raise exception '沒有有效的進貨單資料或操作權限。';
  end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 20
    or p_existing is null or jsonb_typeof(p_existing)<>'array' or jsonb_array_length(p_existing)>20 then
    raise exception '每張進貨單必須有 1 至 20 筆明細。';
  end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r)<>'object'
    or nullif(r->>'inventory_item_id','') is null or coalesce((r->>'quantity')::numeric,0)<=0
    or (r->>'quantity')::numeric<>trunc((r->>'quantity')::numeric) or char_length(coalesce(r->>'note',''))>500) then
    raise exception '進貨明細品項、數量或備註不正確。';
  end if;
  if (select count(*) from jsonb_array_elements(p_rows))<>(select count(distinct (r->>'inventory_item_id',lower(btrim(coalesce(r->>'note',''))))) from jsonb_array_elements(p_rows) r) then
    raise exception '同一張進貨單有重複明細，請合併數量。';
  end if;
  -- Serialize requests for one document, including duplicate create submissions.
  perform pg_advisory_xact_lock(hashtextextended(p_document_id::text,0));
  perform 1 from public.inventory_items where id in(
    select (r->>'inventory_item_id')::uuid from jsonb_array_elements(p_rows) r
    union select inventory_item_id from public.stock_receipts where receipt_document_id=p_document_id or (receipt_document_id is null and id=p_document_id)
  ) order by id for update;
  perform 1 from public.stock_receipts where receipt_document_id=p_document_id or (receipt_document_id is null and id=p_document_id) order by id for update;
  select coalesce(array_agg(id order by id),'{}') into v_current from public.stock_receipts
    where receipt_document_id=p_document_id or (receipt_document_id is null and id=p_document_id);
  select coalesce(array_agg((r->>'id')::uuid order by (r->>'id')::uuid),'{}') into v_expected from jsonb_array_elements(p_existing) r;
  select coalesce(array_agg((r->>'id')::uuid order by (r->>'id')::uuid),'{}') into v_submitted from jsonb_array_elements(p_rows) r where nullif(r->>'id','') is not null;
  if (p_create and cardinality(v_current)>0) or (not p_create and cardinality(v_current)=0)
    or v_current is distinct from v_expected or v_current is distinct from v_submitted
    or exists(select 1 from jsonb_array_elements(p_existing) e join public.stock_receipts s on s.id=(e->>'id')::uuid
      where (e->>'row_version')::integer is distinct from s.row_version) then
    raise exception '進貨單已被更新，請重新整理後再修改；原單據未變更。';
  end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_line:=v_line+1; v_id:=nullif(v_row->>'id','')::uuid;
    if v_id is null then
      if not public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE') then raise exception '沒有新增進貨明細的權限。'; end if;
      v_created:=public.create_stock_receipts_department_v1(jsonb_build_array(jsonb_build_object(
        'receipt_date',p_receipt_date,'supplier_id',p_supplier_id,'inventory_item_id',v_row->>'inventory_item_id',
        'quantity',v_row->'quantity','note',v_row->>'note')),p_customer_ids,p_customer_departments,p_actor_user_id);
      v_id:=(v_created->'ids'->>0)::uuid;
    else
      select row_version into v_version from public.stock_receipts where id=v_id;
      perform public.update_stock_receipt_department_v1(v_id,v_version,p_receipt_date,(v_row->>'inventory_item_id')::uuid,
        (v_row->>'quantity')::numeric,p_supplier_id,v_row->>'note',p_customer_ids,p_customer_departments,p_actor_user_id);
    end if;
    update public.stock_receipts set receipt_document_id=p_document_id,receipt_line_no=v_line
      where id=v_id and (receipt_document_id is distinct from p_document_id or receipt_line_no is distinct from v_line);
    v_ids:=array_append(v_ids,v_id);
  end loop;
  return jsonb_build_object('document_id',p_document_id,'ids',v_ids,'saved',cardinality(v_ids));
end $$;
revoke all on function public.save_stock_receipt_document_v1(uuid,boolean,jsonb,date,uuid,jsonb,uuid[],jsonb,uuid) from public,anon,authenticated;
grant execute on function public.save_stock_receipt_document_v1(uuid,boolean,jsonb,date,uuid,jsonb,uuid[],jsonb,uuid) to service_role;
commit;
