begin;
do $$
declare category public.product_categories; item public.inventory_items; client public.customers; result jsonb; log_id uuid; v_project_id uuid; v integer; username text; user_id uuid; code text;
begin
 select id,app_users.username into user_id,username from public.app_users where is_active order by id limit 1;
 select * into category from public.create_product_category_v1('Regression category','ZZ',username);
 if not exists(select 1 from public.audit_logs where entity_id=category.id and action='insert') then raise exception 'Missing create audit'; end if;
 begin
  perform public.create_product_category_v1(' regression CATEGORY ','ZZ',username);
  raise exception 'Duplicate accepted';
 exception when raise_exception then if sqlerrm<>'此貨品種類名稱已存在。' then raise; end if; end;
 select * into item from public.create_inventory_item_auto_number_v1(category.id,'M','Brand','Regression item','台',0,username);
 code:=item.inventory_code;
 select * into category from public.update_product_category_v1(category.id,category.row_version,'Renamed category','ZY',true,username);
 if not exists(select 1 from inventory_items where id=item.id and item_type='Renamed category' and inventory_code=code and opening_quantity=0) then raise exception 'Rename changed item identity or failed to sync'; end if;
 begin
  perform public.update_product_category_v1(category.id,1,'Stale','ZY',true,username);
  raise exception 'Stale version accepted';
 exception when raise_exception then if sqlerrm<>'此貨品種類已被更新或刪除，請重新載入後再編輯。' then raise; end if; end;
 begin
  perform public.delete_product_category_v1(category.id,category.row_version,username);
  raise exception 'In-use category deleted';
 exception when raise_exception then if sqlerrm<>'此貨品種類已有品項或維修紀錄使用，請改為停用。' then raise; end if; end;
 select * into category from public.update_product_category_v1(category.id,category.row_version,category.name,category.code_prefix,false,username);
 begin
  perform public.create_inventory_item_auto_number_v1(category.id,'M2','Brand','Another item','台',0,username);
  raise exception 'Inactive category accepted';
 exception when raise_exception then if sqlerrm<>'請選擇有效的貨品種類。' then raise; end if; end;
 select * into category from public.create_product_category_v1('Delete regression','ZA',username);
 perform public.delete_product_category_v1(category.id,category.row_version,username);
 if exists(select 1 from product_categories where id=category.id) or not exists(select 1 from audit_logs where entity_id=category.id and action='delete' and actor=username) then raise exception 'Delete persistence or audit failed'; end if;

 select * into client from public.create_customer_with_contracts_v1('government','Delivery test',null,null,null,null,array['maintenance'],username);
 if not exists(select 1 from customer_contract_services c join contract_service_types s on s.id=c.service_type_id where c.customer_id=client.id and s.code='maintenance' and s.name='維護保養') then raise exception 'Maintenance contract relation missing'; end if;
 result:=public.upsert_customer_project_work_log_with_maintenance_v2(null,null,null,client.id,'Delivery project',current_date,'送貨','Delivery test',null,'in_progress',array[user_id],user_id,'[]'::jsonb,username,gen_random_uuid());
 log_id:=(result->'work_log'->>'id')::uuid;
 select logs.project_id into v_project_id from site_work_logs logs where id=log_id and work_type='送貨';
 if v_project_id is null or not exists(select 1 from projects where id=v_project_id and project_type='delivery') then raise exception 'Delivery log did not create delivery project'; end if;
 result:=public.upsert_customer_project_work_log_v3(null,null,v_project_id,client.id,'Delivery project',current_date,'送貨','Second log',null,'in_progress',array[user_id],user_id,username);
 select row_version into v from projects where id=v_project_id;
 perform public.upsert_erp_project_with_workers_v2(v_project_id,v,'Delivery project',client.id,'repair','completed',null,null,null,'{}',username);
 if (select count(*) from site_work_logs l where l.project_id=v_project_id and work_type='維修紀錄' and status='completed')<>2 then raise exception 'Project-to-log synchronization failed'; end if;
 select row_version into v from site_work_logs where id=log_id;
 perform public.upsert_customer_project_work_log_v3(log_id,v,v_project_id,client.id,'Delivery project',current_date,'送貨','Return to delivery',null,'in_progress',array[user_id],user_id,username);
 if not exists(select 1 from projects where id=v_project_id and project_type='delivery' and status='in_progress') or (select count(*) from site_work_logs l where l.project_id=v_project_id and work_type='送貨')<>2 then raise exception 'Log-to-project/sibling synchronization failed'; end if;
 if has_function_privilege('anon','public.update_product_category_v1(uuid,integer,text,text,boolean,text)','execute') or has_function_privilege('authenticated','public.delete_product_category_v1(uuid,integer,text)','execute') then raise exception 'Category RPC exposed outside gateway'; end if;
end; $$;
rollback;
