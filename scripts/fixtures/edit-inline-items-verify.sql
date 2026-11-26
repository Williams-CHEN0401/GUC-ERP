-- Assertions for update_transaction_inline_items_v1 on the synthetic baseline.
\set ON_ERROR_STOP on
insert into public.app_users(id,username,is_active) values
 ('10000000-0000-4000-8000-0000000000a1','editor',true),
 ('10000000-0000-4000-8000-0000000000a2','no-inventory',true),
 ('10000000-0000-4000-8000-0000000000a3','no-update',true),
 ('10000000-0000-4000-8000-0000000000a4','inactive',false);
insert into public.test_grants(user_id,module,action)
 select '10000000-0000-4000-8000-0000000000a1'::uuid,m,a from unnest(array['inventory','pickups','purchases']) m,unnest(array['VIEW','CREATE','UPDATE']) a
 union all select '10000000-0000-4000-8000-0000000000a2',m,a from unnest(array['pickups','purchases']) m,unnest(array['VIEW','UPDATE']) a
 union all select '10000000-0000-4000-8000-0000000000a2','inventory','VIEW'
 union all select '10000000-0000-4000-8000-0000000000a3',m,a from (values('inventory','VIEW'),('inventory','CREATE'),('pickups','VIEW'),('purchases','VIEW')) v(m,a)
 union all select '10000000-0000-4000-8000-0000000000a4',m,a from unnest(array['inventory','pickups','purchases']) m,unnest(array['VIEW','CREATE','UPDATE']) a;
insert into public.product_categories(id,name,code_prefix) values('20000000-0000-4000-8000-0000000000c1','監控設備','A');
insert into public.inventory_items(id,inventory_code,category_id,item_type,brand,item_name,unit)
 values('30000000-0000-4000-8000-0000000000e1','A001','20000000-0000-4000-8000-0000000000c1','監控設備','既有牌','既有品項','台');
insert into public.test_numbers(scope,value) values('inventory:A',1);

create function pg_temp.args(p_kind text,p_actor text,p_rows jsonb,p_version int default 1,p_create boolean default false) returns jsonb language sql as $$
 select case when p_kind='pickup' then jsonb_build_object('p_document_id','40000000-0000-4000-8000-0000000000d1','p_existing',jsonb_build_array(jsonb_build_object('id','50000000-0000-4000-8000-0000000000f1','row_version',p_version)),
  'p_pickup_date','2026-11-26','p_project_id','60000000-0000-4000-8000-000000000001','p_rows',p_rows,'p_actor_user_id',p_actor)
 else jsonb_build_object('p_document_id','40000000-0000-4000-8000-0000000000d2','p_create',p_create,'p_existing',jsonb_build_array(jsonb_build_object('id','50000000-0000-4000-8000-0000000000f2','row_version',p_version)),
  'p_receipt_date','2026-11-26','p_supplier_id','70000000-0000-4000-8000-000000000001','p_rows',p_rows,'p_customer_ids',jsonb_build_array('80000000-0000-4000-8000-000000000001'),
  'p_customer_departments','[]'::jsonb,'p_actor_user_id',p_actor,'p_document_no','R-1','p_metadata',jsonb_build_object('tax_mode','exclusive')) end $$;
create function pg_temp.expect_error(p_kind text,p_actor uuid,p_arguments jsonb,p_pattern text) returns void language plpgsql as $$
declare before_items int;before_calls int;message text;
begin
 select count(*) into before_items from public.inventory_items;select count(*) into before_calls from public.test_writer_calls;
 begin
  perform public.update_transaction_inline_items_v1(p_kind,p_actor,p_arguments);
  raise exception 'EXPECTED_FAILURE_NOT_RAISED';
 exception when others then message:=sqlerrm;end;
 if message='EXPECTED_FAILURE_NOT_RAISED' or message !~ p_pattern then raise exception 'expected % but got %',p_pattern,message;end if;
 if (select count(*) from public.inventory_items)<>before_items then raise exception 'item master changed after failure: %',message;end if;
 if (select count(*) from public.test_writer_calls)<>before_calls then raise exception 'writer recorded a failed call: %',message;end if;
 raise notice 'PASS rejected (%): %',p_pattern,message;
end $$;

-- 1. Edited pickup: an existing line stays, the added line gets a new zero-stock master item.
do $$
declare actor uuid:='10000000-0000-4000-8000-0000000000a1';result jsonb;created public.inventory_items;call public.test_writer_calls;
begin
 result:=public.update_transaction_inline_items_v1('pickup',actor,pg_temp.args('pickup',actor::text,jsonb_build_array(
  jsonb_build_object('id','50000000-0000-4000-8000-0000000000f1','inventory_item_id','30000000-0000-4000-8000-0000000000e1','quantity',2,'quantity_unit','package','note','原列'),
  jsonb_build_object('id',null,'inventory_item_id',null,'quantity',3,'quantity_unit','package','note','新列',
   'new_item',jsonb_build_object('category_id','20000000-0000-4000-8000-0000000000c1','item_name','新攝影機','brand','新牌','model',null,'unit','台')))));
 select * into strict created from public.inventory_items where item_name='新攝影機';
 if created.inventory_code<>'A002' or created.opening_quantity<>0 or created.opening_meters<>0 or created.meters_per_unit is not null or created.updated_by<>'editor' then raise exception 'unexpected new item %',to_jsonb(created);end if;
 select * into strict call from public.test_writer_calls where kind='pickup';
 if call.document_id<>'40000000-0000-4000-8000-0000000000d1' or jsonb_array_length(call.rows)<>2 then raise exception 'unexpected writer call %',to_jsonb(call);end if;
 if call.rows->0->>'inventory_item_id'<>'30000000-0000-4000-8000-0000000000e1' or call.rows->0->>'id'<>'50000000-0000-4000-8000-0000000000f1' or call.rows->0->>'note'<>'原列' then raise exception 'existing line changed %',call.rows->0;end if;
 if call.rows->1->>'inventory_item_id'<>created.id::text or call.rows->1 ? 'new_item' or (call.rows->1->>'quantity')::numeric<>3 then raise exception 'new line not resolved %',call.rows->1;end if;
 if call.args->>'actor'<>actor::text or call.args->>'date'<>'2026-11-26' or call.args->'existing'->0->>'row_version'<>'1' then raise exception 'writer args changed %',call.args;end if;
 if result->>'document_id'<>'40000000-0000-4000-8000-0000000000d1' then raise exception 'writer result not returned %',result;end if;
 raise notice 'PASS edited pickup creates one zero-stock item, keeps the existing line and calls save_pickup_document_v1';
end $$;

-- 2. Edited receipt: existing line can switch to a new item; header arguments pass through unchanged.
do $$
declare actor uuid:='10000000-0000-4000-8000-0000000000a1';created public.inventory_items;call public.test_writer_calls;
begin
 perform public.update_transaction_inline_items_v1('receipt',actor,pg_temp.args('receipt',actor::text,jsonb_build_array(
  jsonb_build_object('id','50000000-0000-4000-8000-0000000000f2','inventory_item_id',null,'quantity',5,'quantity_unit','package','note','改為新品項','unit_price',120,
   'new_item',jsonb_build_object('category_id','20000000-0000-4000-8000-0000000000c1','item_name','新硬碟','brand','新牌','model','4TB','unit','顆')))));
 select * into strict created from public.inventory_items where item_name='新硬碟';
 select * into strict call from public.test_writer_calls where kind='receipt';
 if (call.args->>'create')::boolean or call.args->>'document_no'<>'R-1' or call.args->'metadata'->>'tax_mode'<>'exclusive' or call.args->'customers'->>0<>'80000000-0000-4000-8000-000000000001'
  or call.args->>'supplier'<>'70000000-0000-4000-8000-000000000001' then raise exception 'receipt header changed %',call.args;end if;
 if call.rows->0->>'id'<>'50000000-0000-4000-8000-0000000000f2' or call.rows->0->>'inventory_item_id'<>created.id::text or (call.rows->0->>'unit_price')::numeric<>120 or call.rows->0 ? 'new_item' then raise exception 'receipt line not resolved %',call.rows->0;end if;
 if created.model<>'4TB' or created.inventory_code<>'A003' then raise exception 'unexpected receipt item %',to_jsonb(created);end if;
 raise notice 'PASS edited receipt resolves the new item and passes header, price and line ID to save_stock_receipt_document_v5';
end $$;

-- 3. Rejections leave no item and no writer call.
select pg_temp.expect_error('pickup','10000000-0000-4000-8000-0000000000a1',pg_temp.args('pickup','10000000-0000-4000-8000-0000000000a1',jsonb_build_array(
 jsonb_build_object('quantity',1,'quantity_unit','package','new_item',jsonb_build_object('category_id','20000000-0000-4000-8000-0000000000c1','item_name','過期版本品項','brand','牌','unit','台'))),2),'已被更新');
select pg_temp.expect_error('pickup','10000000-0000-4000-8000-0000000000a1',pg_temp.args('pickup','10000000-0000-4000-8000-0000000000a1',jsonb_build_array(
 jsonb_build_object('quantity',1,'quantity_unit','package','new_item',jsonb_build_object('category_id','20000000-0000-4000-8000-0000000000c1','item_name','既有品項','brand','既有牌','unit','台')))),'重複');
select pg_temp.expect_error('pickup','10000000-0000-4000-8000-0000000000a1',pg_temp.args('pickup','10000000-0000-4000-8000-0000000000a1',jsonb_build_array(
 jsonb_build_object('quantity',1.5,'quantity_unit','meter','new_item',jsonb_build_object('category_id','20000000-0000-4000-8000-0000000000c1','item_name','米數品項','brand','牌','unit','捲')))),'新貨品明細不正確');
select pg_temp.expect_error('pickup','10000000-0000-4000-8000-0000000000a1',pg_temp.args('pickup','10000000-0000-4000-8000-0000000000a1',jsonb_build_array(
 jsonb_build_object('inventory_item_id','30000000-0000-4000-8000-0000000000e1','quantity',1,'new_item',jsonb_build_object('category_id','20000000-0000-4000-8000-0000000000c1','item_name','雙重品項','brand','牌','unit','台')))),'新貨品明細不正確');
select pg_temp.expect_error('receipt','10000000-0000-4000-8000-0000000000a1',pg_temp.args('receipt','10000000-0000-4000-8000-0000000000a1',jsonb_build_array(
 jsonb_build_object('quantity',1,'new_item',jsonb_build_object('category_id','20000000-0000-4000-8000-0000000000c1','item_name','建立單據品項','brand','牌','unit','台'))),1,true),'建立單據流程');
select pg_temp.expect_error('pickup','10000000-0000-4000-8000-0000000000a2',pg_temp.args('pickup','10000000-0000-4000-8000-0000000000a2',jsonb_build_array(
 jsonb_build_object('quantity',1,'new_item',jsonb_build_object('category_id','20000000-0000-4000-8000-0000000000c1','item_name','無庫存權限','brand','牌','unit','台')))),'權限');
select pg_temp.expect_error('pickup','10000000-0000-4000-8000-0000000000a3',pg_temp.args('pickup','10000000-0000-4000-8000-0000000000a3',jsonb_build_array(
 jsonb_build_object('quantity',1,'new_item',jsonb_build_object('category_id','20000000-0000-4000-8000-0000000000c1','item_name','無修改權限','brand','牌','unit','台')))),'權限');
select pg_temp.expect_error('receipt','10000000-0000-4000-8000-0000000000a4',pg_temp.args('receipt','10000000-0000-4000-8000-0000000000a4',jsonb_build_array(
 jsonb_build_object('quantity',1,'new_item',jsonb_build_object('category_id','20000000-0000-4000-8000-0000000000c1','item_name','停用帳號','brand','牌','unit','台')))),'權限');
select pg_temp.expect_error('pickup','10000000-0000-4000-8000-0000000000a1',pg_temp.args('pickup','10000000-0000-4000-8000-0000000000a3',jsonb_build_array(
 jsonb_build_object('quantity',1,'new_item',jsonb_build_object('category_id','20000000-0000-4000-8000-0000000000c1','item_name','帳號不符','brand','牌','unit','台')))),'帳號不相符');
select pg_temp.expect_error('supplier_return','10000000-0000-4000-8000-0000000000a1','{}'::jsonb,'不支援');

-- 4. Only the Gateway's service role may call it.
do $$begin
 if has_function_privilege('anon','public.update_transaction_inline_items_v1(text,uuid,jsonb)','execute')
 or has_function_privilege('authenticated','public.update_transaction_inline_items_v1(text,uuid,jsonb)','execute')
 or not has_function_privilege('service_role','public.update_transaction_inline_items_v1(text,uuid,jsonb)','execute') then raise exception 'unexpected function grants';end if;
 if (select count(*) from public.inventory_items)<>3 or (select count(*) from public.test_writer_calls)<>2 then raise exception 'unexpected final counts';end if;
 raise notice 'PASS only service_role can execute; 2 items created, failures left no trace';
end $$;
