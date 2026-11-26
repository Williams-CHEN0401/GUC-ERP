begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Editing an existing receipt or pickup document may add an item that is not in
-- the inventory master yet. Reuse the existing master creator and the existing
-- document writers inside one transaction; no parallel item table or document
-- path. The pinned row versions of the document keep retries from creating a
-- second item: a stale retry fails in the writer and rolls the new item back.
create function public.update_transaction_inline_items_v1(p_kind text,p_actor uuid,p_arguments jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actor public.app_users;doc_id uuid;module text;max_rows integer;line jsonb;spec jsonb;created jsonb;resolved jsonb:='[]';rows jsonb;
begin
 if p_kind is null or p_kind not in('pickup','receipt') then raise exception '不支援的單據類型。';end if;
 module:=case when p_kind='receipt' then 'purchases' else 'pickups' end;
 max_rows:=case when p_kind='receipt' then 20 else 50 end;
 select * into actor from public.app_users where id=p_actor and is_active;
 if actor.id is null or not public.has_app_permission_v1(p_actor,'inventory','VIEW') or not public.has_app_permission_v1(p_actor,'inventory','CREATE')
 or not public.has_app_permission_v1(p_actor,module,'VIEW') or not public.has_app_permission_v1(p_actor,module,'UPDATE') then raise exception '沒有修改單據及新增品項權限。';end if;
 perform public.erp_private_prepare_v1(p_actor);
 if p_arguments->>'p_actor_user_id' is distinct from p_actor::text then raise exception '單據帳號不相符。';end if;
 if p_kind='receipt' and (p_arguments->>'p_create')::boolean is distinct from false then raise exception '新增進貨單請使用建立單據流程。';end if;
 doc_id:=(p_arguments->>'p_document_id')::uuid;
 if doc_id is null then raise exception '缺少單據識別碼。';end if;
 rows:=p_arguments->'p_rows';
 if jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows) not between 1 and max_rows then raise exception '單據明細筆數不正確。';end if;
 -- Same document key as the writers, taken before any item master is created.
 perform pg_advisory_xact_lock(hashtextextended(doc_id::text,0));
 for line in select value from jsonb_array_elements(rows) loop
  if line ? 'new_item' then
   spec:=line->'new_item';
   if jsonb_typeof(spec) is distinct from 'object' or nullif(line->>'inventory_item_id','') is not null or coalesce(line->>'quantity_unit','package')<>'package' then raise exception '新貨品明細不正確。';end if;
   -- Serialize the existing category's master creation and duplicate check.
   perform 1 from public.product_categories where id=(spec->>'category_id')::uuid for update;
   created:=public.create_inventory_items_batch_v1(jsonb_build_array(spec||jsonb_build_object('opening_quantity',0,'opening_meters',0,'meters_per_unit',null)),actor.username);
   line:=(line-'new_item')||jsonb_build_object('inventory_item_id',created->0->>'id');
  end if;
  resolved:=resolved||jsonb_build_array(line);
 end loop;
 if p_kind='pickup' then
  return public.save_pickup_document_v1(doc_id,p_arguments->'p_existing',(p_arguments->>'p_pickup_date')::date,(p_arguments->>'p_project_id')::uuid,resolved,p_actor);
 end if;
 return public.save_stock_receipt_document_v5(doc_id,false,p_arguments->'p_existing',(p_arguments->>'p_receipt_date')::date,(p_arguments->>'p_supplier_id')::uuid,resolved,
  array(select value::uuid from jsonb_array_elements_text(p_arguments->'p_customer_ids')),
  p_arguments->'p_customer_departments',p_actor,p_arguments->>'p_document_no',coalesce(p_arguments->'p_metadata','{}'));
end $$;
revoke all on function public.update_transaction_inline_items_v1(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.update_transaction_inline_items_v1(text,uuid,jsonb) to service_role;

notify pgrst,'reload schema';
commit;
