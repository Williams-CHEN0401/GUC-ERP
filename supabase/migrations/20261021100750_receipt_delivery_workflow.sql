-- Extend the existing document registry and stock ledgers. NULL is a legacy
-- company receipt; only new v5 receipts start pending. No historical backfill.
alter table public.stock_transaction_documents
 add column receipt_delivery_state text check(receipt_delivery_state in('pending','company','site')),
 add column receipt_delivery_date date,
 add column receipt_delivery_project_id uuid references public.projects(id),
 add column receipt_delivery_pickup_id uuid,
 add column receipt_delivery_confirmed_at timestamptz,
 add column receipt_delivery_actor_id uuid references public.app_users(id),
 add column receipt_created_by_user_id uuid references public.app_users(id),
 add column receipt_create_fingerprint text;
alter table public.stock_transaction_documents add constraint receipt_delivery_shape check(
 receipt_delivery_state is null or kind='receipt' and (
 (receipt_delivery_state='pending' and receipt_delivery_date is null and receipt_delivery_project_id is null and receipt_delivery_pickup_id is null and receipt_delivery_confirmed_at is null and receipt_delivery_actor_id is null) or
 (receipt_delivery_state='company' and receipt_delivery_date is not null and receipt_delivery_project_id is null and receipt_delivery_pickup_id is null and receipt_delivery_confirmed_at is not null and receipt_delivery_actor_id is not null) or
 (receipt_delivery_state='site' and receipt_delivery_date is not null and receipt_delivery_project_id is not null and receipt_delivery_pickup_id is not null and receipt_delivery_confirmed_at is not null and receipt_delivery_actor_id is not null)));
alter table public.pickup_records add column source_receipt_line_id uuid unique references public.stock_receipts(id);
create index stock_documents_delivery_project_idx on public.stock_transaction_documents(receipt_delivery_project_id) where receipt_delivery_project_id is not null;
create index stock_documents_delivery_actor_idx on public.stock_transaction_documents(receipt_delivery_actor_id) where receipt_delivery_actor_id is not null;
create index stock_documents_receipt_creator_idx on public.stock_transaction_documents(receipt_created_by_user_id) where receipt_created_by_user_id is not null;

-- Use the same immutable adjustment-difference ledger as ERP stock totals.
-- This also handles a pending receipt confirmed after a stock count/return.
create or replace function public.current_inventory_quantity(p_inventory_item_id uuid) returns numeric
language plpgsql security definer set search_path='' as $$
declare result numeric;
begin
 select coalesce(i.opening_quantity,0)
 +coalesce((select sum(s.quantity) from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id where s.inventory_item_id=i.id and d.receipt_delivery_state is distinct from 'pending'),0)
 -coalesce((select sum(p.quantity) from public.pickup_records p where p.inventory_item_id=i.id),0)
 +coalesce((select sum(a.difference_quantity) from public.stock_adjustments a where a.inventory_item_id=i.id),0)
 into result from public.inventory_items i where i.id=p_inventory_item_id;
 if not found then raise exception '找不到指定品項。';end if;
 return result;
end $$;
create or replace function public.erp_stock_totals_v1(p_actor_user_id uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
begin
 if not exists(select 1 from unnest(array['inventory','purchases','pickups','worklogs','repairs','reports']) m where public.has_app_permission_v1(p_actor_user_id,m,'VIEW')) then raise exception '沒有庫存查看權限。';end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'quantity',coalesce(i.opening_quantity,0)+coalesce(r.q,0)-coalesce(p.q,0)+coalesce(a.q,0))),'[]') from public.inventory_items i
 left join (select s.inventory_item_id,sum(s.quantity) q from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id where d.receipt_delivery_state is distinct from 'pending' group by s.inventory_item_id) r on r.inventory_item_id=i.id
 left join (select inventory_item_id,sum(quantity) q from public.pickup_records group by inventory_item_id) p on p.inventory_item_id=i.id
 left join (select inventory_item_id,sum(difference_quantity) q from public.stock_adjustments group by inventory_item_id) a on a.inventory_item_id=i.id);
end $$;
create or replace function public.apply_stock_adjustment_verified_v1(p_inventory_item_id uuid,p_after_quantity integer,p_reason text,p_idempotency_key uuid,p_actor text)
returns table(inventory_item_id uuid,verified_quantity numeric) language plpgsql security invoker set search_path='' as $$
declare qty numeric;
begin
 if p_after_quantity is null or p_after_quantity<0 then raise exception '校正後庫存不可小於 0。';end if;
 perform 1 from public.inventory_items where id=p_inventory_item_id for update;
 if not found then raise exception '找不到要校正的庫存品項。';end if;
 perform public.apply_stock_adjustment(p_inventory_item_id,p_after_quantity,p_reason,p_idempotency_key,p_actor);
 qty:=public.current_inventory_quantity(p_inventory_item_id);
 if qty is distinct from p_after_quantity then raise exception '庫存校正驗證失敗。';end if;
 return query select p_inventory_item_id,qty;
end $$;

create function public.receipt_delivery_visible_v1(p_actor_user_id uuid,p_document_id uuid) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.stock_transaction_documents d join public.app_users u on u.id=p_actor_user_id and u.is_active join public.app_roles role on role.code=u.role
 where d.kind='receipt' and d.id=p_document_id and d.merged_into is null
 and exists(select 1 from public.stock_receipts s where s.receipt_document_id=d.id)
 and not exists(select 1 from public.stock_receipts s join public.suppliers supplier on supplier.id=s.supplier_id where s.receipt_document_id=d.id and (not public.erp_private_json_visible_v1(to_jsonb(s)) or not public.erp_private_json_visible_v1(to_jsonb(supplier))))
 and not exists(select 1 from public.stock_receipts s join public.stock_receipt_customers x on x.stock_receipt_id=s.id join public.customers c on c.id=x.customer_id where s.receipt_document_id=d.id and not public.erp_private_json_visible_v1(to_jsonb(c)))
 and (d.receipt_project_id is null or public.site_return_project_visible_v1(p_actor_user_id,d.receipt_project_id))
 and (d.receipt_delivery_project_id is null or public.site_return_project_visible_v1(p_actor_user_id,d.receipt_delivery_project_id))
 and (not role.project_scoped or public.site_return_project_visible_v1(p_actor_user_id,coalesce(d.receipt_delivery_project_id,d.receipt_project_id))));
$$;
create or replace function public.receipt_document_context_v1(p_actor_user_id uuid,p_document_ids uuid[]) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;prices boolean;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') then raise exception '沒有進貨查看權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 prices:=public.has_app_permission_v1(p_actor_user_id,'purchase_prices','VIEW');
 select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'receipt_project_id',d.receipt_project_id,
 'delivery_state',coalesce(d.receipt_delivery_state,'company'),'delivery_date',d.receipt_delivery_date,
 'delivery_project_id',d.receipt_delivery_project_id,'delivery_pickup_id',d.receipt_delivery_pickup_id,
 'delivery_pickup_no',(select document_no from public.stock_transaction_documents where kind='pickup' and id=d.receipt_delivery_pickup_id),
 'can_confirm_delivery',public.has_app_permission_v1(p_actor_user_id,'purchases','UPDATE') or (d.receipt_created_by_user_id=p_actor_user_id and public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE')))
 ||case when prices then jsonb_build_object('receipt_financials',public.stock_receipt_financials_v1(d.id)) else '{}'::jsonb end),'[]') into result
 from public.stock_transaction_documents d where d.kind='receipt' and d.id=any(p_document_ids) and public.receipt_delivery_visible_v1(p_actor_user_id,d.id);
 return jsonb_build_object('documents',result,'money_settings',public.erp_money_settings_v1());
end $$;

-- Candidate identities only: historical price information is deliberately not
-- fetched or returned, so this endpoint cannot disclose a restricted price.
create function public.receipt_supplier_items_v1(p_actor_user_id uuid,p_supplier_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') then raise exception '沒有進貨查看權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 if not exists(select 1 from public.suppliers s where id=p_supplier_id and public.erp_private_json_visible_v1(to_jsonb(s))) then raise exception '找不到供應商或沒有存取權限。';end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.last_receipt_date desc,x.inventory_item_id),'[]') into result from(
 select s.inventory_item_id,max(s.receipt_date) last_receipt_date from public.stock_receipts s
 join public.inventory_items i on i.id=s.inventory_item_id join public.product_categories c on c.id=i.category_id
 where s.supplier_id=p_supplier_id and c.is_active and public.erp_private_json_visible_v1(to_jsonb(i)) and public.receipt_delivery_visible_v1(p_actor_user_id,s.receipt_document_id)
 group by s.inventory_item_id) x;
 return jsonb_build_object('items',result);
end $$;

create function public.receipt_delivery_options_v1(p_actor_user_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare projects jsonb;customers jsonb;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'pickups','CREATE') or not public.has_app_permission_v1(p_actor_user_id,'customers','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') then raise exception '沒有施工現場取貨或客戶工作內容查看權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'code',p.project_code,'customer_id',p.customer_id) order by p.name),'[]') into projects from public.projects p where public.site_return_project_visible_v1(p_actor_user_id,p.id);
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'category',c.customer_category) order by c.name),'[]') into customers from public.customers c where exists(select 1 from jsonb_array_elements(projects) p where p->>'customer_id'=c.id::text);
 return jsonb_build_object('customers',customers,'projects',projects);
end $$;

-- Linked pickup rows may only be changed together with their source receipt.
create function public.guard_receipt_delivery_lines_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare did uuid;source_id uuid;
begin
 if tg_table_name='pickup_records' then
  source_id:=case when tg_op='DELETE' then old.source_receipt_line_id else new.source_receipt_line_id end;
  if tg_op='UPDATE' and old.source_receipt_line_id is distinct from new.source_receipt_line_id then raise exception '不能移除或變更進貨來源關聯。';end if;
  select receipt_document_id into did from public.stock_receipts where id=source_id;
 else
  did:=old.receipt_document_id;
  if not exists(select 1 from public.stock_transaction_documents where kind='receipt' and id=did and receipt_delivery_state='site') then return coalesce(new,old);end if;
 end if;
 if did is not null and current_setting('app.receipt_delivery_sync',true) is distinct from did::text then raise exception '此單據由進貨直接送達案場，請從原進貨單同步修改或刪除。';end if;
 return coalesce(new,old);
end $$;
create trigger pickup_receipt_delivery_guard before insert or update or delete on public.pickup_records for each row execute function public.guard_receipt_delivery_lines_v1();
create trigger receipt_delivery_guard before update or delete on public.stock_receipts for each row execute function public.guard_receipt_delivery_lines_v1();

create function public.sync_receipt_delivery_pickups_v1(p_document_id uuid,p_actor_user_id uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare d public.stock_transaction_documents;r public.stock_receipts;actor text;line_no integer:=0;
begin
 select * into strict d from public.stock_transaction_documents where kind='receipt' and id=p_document_id and receipt_delivery_state='site';
 if current_setting('app.receipt_delivery_sync',true) is distinct from d.id::text then raise exception '送達同步必須在進貨交易內執行。';end if;
 select username into strict actor from public.app_users where id=p_actor_user_id and is_active;
 perform public.ensure_stock_document_v1('pickup',d.receipt_delivery_pickup_id,d.receipt_delivery_date,d.receipt_delivery_project_id,d.id);
 select coalesce(max(request_row),0) into line_no from public.pickup_records where request_id=d.id;
 for r in select * from public.stock_receipts where receipt_document_id=d.id order by receipt_line_no,id loop
  line_no:=line_no+1;
  insert into public.pickup_records(pickup_document_id,pickup_date,project_id,inventory_item_id,quantity,note,source,updated_by,created_by_user_id,created_by_username,request_id,request_row,source_receipt_line_id)
  values(d.receipt_delivery_pickup_id,d.receipt_delivery_date,d.receipt_delivery_project_id,r.inventory_item_id,r.quantity,r.note,'web',actor,p_actor_user_id,actor,d.id,line_no,r.id)
  on conflict(source_receipt_line_id) do update set inventory_item_id=excluded.inventory_item_id,quantity=excluded.quantity,note=excluded.note,updated_by=excluded.updated_by
  where (pickup_records.inventory_item_id,pickup_records.quantity,pickup_records.note) is distinct from (excluded.inventory_item_id,excluded.quantity,excluded.note);
 end loop;
end $$;

create function public.save_stock_receipt_document_v5(p_document_id uuid,p_create boolean,p_existing jsonb,p_receipt_date date,p_supplier_id uuid,p_rows jsonb,p_customer_ids uuid[],p_customer_departments jsonb,p_actor_user_id uuid,p_document_no text default null,p_metadata jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d public.stock_transaction_documents;result jsonb;fingerprint text;sync_context text;removed uuid[];
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'purchases',case when p_create then 'CREATE' else 'UPDATE' end) then raise exception '沒有進貨操作權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform pg_advisory_xact_lock(hashtextextended(p_document_id::text,0));
 select * into d from public.stock_transaction_documents where kind='receipt' and id=p_document_id for update;
 fingerprint:=md5(jsonb_build_array(p_actor_user_id,p_existing,p_receipt_date,p_supplier_id,p_rows,p_customer_ids,p_customer_departments,p_document_no,p_metadata)::text);
 if d.id is not null then
  if not public.receipt_delivery_visible_v1(p_actor_user_id,d.id) then raise exception '找不到進貨單或沒有存取權限。';end if;
  if p_create then
   if d.receipt_create_fingerprint is distinct from fingerprint then raise exception '此進貨單已建立，重試內容不同，請重新開啟原單據。';end if;
   return jsonb_build_object('document_id',d.id,'ids',(select jsonb_agg(id order by receipt_line_no,id) from public.stock_receipts where receipt_document_id=d.id),'delivery_state',d.receipt_delivery_state);
  end if;
 end if;
 if exists(select 1 from public.app_users u join public.app_roles role on role.code=u.role where u.id=p_actor_user_id and role.project_scoped)
 and not public.site_return_project_visible_v1(p_actor_user_id,coalesce(nullif(p_metadata->>'project_id','')::uuid,d.receipt_project_id)) then raise exception '請選擇有存取權限的工作內容。';end if;
 sync_context:=current_setting('app.receipt_delivery_sync',true);
 if d.receipt_delivery_state='site' then
  if not public.has_app_permission_v1(p_actor_user_id,'pickups','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'pickups','UPDATE') then raise exception '修改案場直送進貨需要取貨修改權限。';end if;
  if p_metadata ? 'project_id' and p_metadata->>'project_id' is not null and (p_metadata->>'project_id')::uuid<>d.receipt_delivery_project_id then raise exception '送達工作內容已確認，不能變更為其他工作內容。';end if;
  perform 1 from public.inventory_items where id in(select inventory_item_id from public.stock_receipts where receipt_document_id=d.id union select (r->>'inventory_item_id')::uuid from jsonb_array_elements(p_rows) r) order by id for update;
  perform set_config('app.receipt_delivery_sync',d.id::text,true);
  select array_agg(s.id) into removed from public.stock_receipts s where s.receipt_document_id=d.id and not exists(select 1 from jsonb_array_elements(p_rows) r where nullif(r->>'id','')::uuid=s.id);
  if cardinality(removed)>0 then
   if not public.has_app_permission_v1(p_actor_user_id,'pickups','DELETE') then raise exception '刪除案場直送明細需要取貨刪除權限。';end if;
   delete from public.pickup_records where source_receipt_line_id=any(removed);
  end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where nullif(r->>'id','') is null) and not public.has_app_permission_v1(p_actor_user_id,'pickups','CREATE') then raise exception '新增案場直送明細需要取貨新增權限。';end if;
 end if;
 result:=public.save_stock_receipt_document_v4(p_document_id,p_create,p_existing,p_receipt_date,p_supplier_id,p_rows,p_customer_ids,p_customer_departments,p_actor_user_id,p_document_no,p_metadata);
 if p_create then
  update public.stock_transaction_documents set receipt_delivery_state='pending',receipt_created_by_user_id=p_actor_user_id,receipt_create_fingerprint=fingerprint where kind='receipt' and id=p_document_id;
 elsif d.receipt_delivery_state='site' then
  perform public.sync_receipt_delivery_pickups_v1(d.id,p_actor_user_id);
 end if;
 perform set_config('app.receipt_delivery_sync',coalesce(sync_context,''),true);
 return result||jsonb_build_object('delivery_state',case when p_create then 'pending' else coalesce(d.receipt_delivery_state,'company') end);
end $$;

create function public.confirm_receipt_delivery_v1(p_actor_user_id uuid,p_document_id uuid,p_destination text,p_delivery_date date,p_customer_id uuid default null,p_project_id uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d public.stock_transaction_documents;result jsonb;old_context text;pickup_id uuid;actor text;before_stock jsonb;item uuid;
begin
 if p_destination is null or p_destination not in('company','site') or p_delivery_date is null or p_document_id is null then raise exception '請選擇送達位置及實際送達日期。';end if;
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') then raise exception '沒有進貨查看權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform pg_advisory_xact_lock(hashtextextended(p_document_id::text,0));
 select * into d from public.stock_transaction_documents where kind='receipt' and id=p_document_id for update;
 if d.id is null or not public.receipt_delivery_visible_v1(p_actor_user_id,d.id) then raise exception '找不到進貨單或沒有存取權限。';end if;
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','UPDATE') and not(d.receipt_created_by_user_id=p_actor_user_id and public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE')) then raise exception '沒有進貨送達操作權限。';end if;
 if p_destination='site' then
  if not public.has_app_permission_v1(p_actor_user_id,'pickups','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'pickups','CREATE') or not public.has_app_permission_v1(p_actor_user_id,'customers','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') then raise exception '沒有施工現場取貨或客戶工作內容查看權限。';end if;
  if not public.site_return_project_visible_v1(p_actor_user_id,p_project_id) or not exists(select 1 from public.projects where id=p_project_id and customer_id=p_customer_id) then raise exception '工作內容不屬於所選客戶或沒有存取權限。';end if;
  if d.receipt_project_id is not null and d.receipt_project_id<>p_project_id then raise exception '送達工作內容與進貨單關聯的工作內容不一致。';end if;
 elsif p_project_id is not null or p_customer_id is not null then raise exception '公司入庫不能包含施工現場關聯。';end if;
 if d.receipt_delivery_state is distinct from 'pending' then
  if (d.receipt_delivery_state,d.receipt_delivery_date,d.receipt_delivery_project_id) is distinct from (p_destination,p_delivery_date,p_project_id) then raise exception '送達位置已確認，請重新讀取原單據。';end if;
  return jsonb_build_object('document_id',d.id,'delivery_state',d.receipt_delivery_state,'pickup_document_id',d.receipt_delivery_pickup_id,'pickup_document_no',(select document_no from public.stock_transaction_documents where kind='pickup' and id=d.receipt_delivery_pickup_id));
 end if;
 perform 1 from public.inventory_items where id in(select inventory_item_id from public.stock_receipts where receipt_document_id=d.id) order by id for update;
 select jsonb_object_agg(i.id::text,public.current_inventory_quantity(i.id)) into before_stock from public.inventory_items i where id in(select inventory_item_id from public.stock_receipts where receipt_document_id=d.id);
 pickup_id:=case when p_destination='site' then gen_random_uuid() end;
 select username into actor from public.app_users where id=p_actor_user_id and is_active;
 old_context:=current_setting('app.receipt_delivery_sync',true);perform set_config('app.receipt_delivery_sync',d.id::text,true);
 update public.stock_transaction_documents set receipt_delivery_state=p_destination,receipt_delivery_date=p_delivery_date,receipt_delivery_project_id=p_project_id,receipt_delivery_pickup_id=pickup_id,receipt_delivery_confirmed_at=clock_timestamp(),receipt_delivery_actor_id=p_actor_user_id where kind='receipt' and id=d.id;
 if p_destination='site' then
  perform public.sync_receipt_delivery_pickups_v1(d.id,p_actor_user_id);
  for item in select distinct inventory_item_id from public.stock_receipts where receipt_document_id=d.id loop
   if public.current_inventory_quantity(item) is distinct from (before_stock->>item::text)::numeric then raise exception '施工現場送達庫存核對失敗，整筆操作已取消，可安全重試。';end if;
  end loop;
 end if;
 perform set_config('app.receipt_delivery_sync',coalesce(old_context,''),true);
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor) values('stock_transaction_documents',d.id,'update',jsonb_build_object('delivery_state','pending'),jsonb_build_object('delivery_state',p_destination,'delivery_date',p_delivery_date,'project_id',p_project_id,'pickup_document_id',pickup_id),'web',actor);
 return jsonb_build_object('document_id',d.id,'delivery_state',p_destination,'pickup_document_id',pickup_id,'pickup_document_no',(select document_no from public.stock_transaction_documents where kind='pickup' and id=pickup_id));
end $$;

create function public.delete_receipt_delivery_document_v1(p_document_id uuid,p_existing jsonb,p_actor_user_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d public.stock_transaction_documents;result jsonb;old_context text;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'purchases','DELETE') then raise exception '沒有進貨刪除權限。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);perform pg_advisory_xact_lock(hashtextextended(p_document_id::text,0));
 select * into d from public.stock_transaction_documents where kind='receipt' and id=p_document_id for update;
 if not public.receipt_delivery_visible_v1(p_actor_user_id,p_document_id) then raise exception '找不到進貨單或沒有存取權限。';end if;
 old_context:=current_setting('app.receipt_delivery_sync',true);
 if d.receipt_delivery_state='site' then
  if not public.has_app_permission_v1(p_actor_user_id,'pickups','DELETE') then raise exception '刪除案場直送進貨需要取貨刪除權限。';end if;
  perform 1 from public.inventory_items where id in(select inventory_item_id from public.stock_receipts where receipt_document_id=d.id) order by id for update;
  perform set_config('app.receipt_delivery_sync',d.id::text,true);
  delete from public.pickup_records where source_receipt_line_id in(select id from public.stock_receipts where receipt_document_id=d.id);
 end if;
 result:=to_jsonb(public.delete_stock_document_v1('receipt',p_document_id,p_existing,p_actor_user_id));
 perform set_config('app.receipt_delivery_sync',coalesce(old_context,''),true);
 return result;
end $$;

revoke all on function public.receipt_delivery_visible_v1(uuid,uuid),public.receipt_supplier_items_v1(uuid,uuid),public.guard_receipt_delivery_lines_v1(),public.sync_receipt_delivery_pickups_v1(uuid,uuid),public.save_stock_receipt_document_v5(uuid,boolean,jsonb,date,uuid,jsonb,uuid[],jsonb,uuid,text,jsonb),public.confirm_receipt_delivery_v1(uuid,uuid,text,date,uuid,uuid),public.delete_receipt_delivery_document_v1(uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.receipt_delivery_visible_v1(uuid,uuid),public.receipt_supplier_items_v1(uuid,uuid),public.guard_receipt_delivery_lines_v1(),public.sync_receipt_delivery_pickups_v1(uuid,uuid),public.save_stock_receipt_document_v5(uuid,boolean,jsonb,date,uuid,jsonb,uuid[],jsonb,uuid,text,jsonb),public.confirm_receipt_delivery_v1(uuid,uuid,text,date,uuid,uuid),public.delete_receipt_delivery_document_v1(uuid,jsonb,uuid) to service_role;
revoke all on function public.receipt_delivery_options_v1(uuid) from public,anon,authenticated;
grant execute on function public.receipt_delivery_options_v1(uuid) to service_role;
