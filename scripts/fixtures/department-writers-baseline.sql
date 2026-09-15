CREATE OR REPLACE FUNCTION public.create_stock_receipts_with_customers_v1(p_rows jsonb, p_customer_ids uuid[], p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_row jsonb; v_receipt uuid;v_ids uuid[]:='{}';v_actor text;v_supplier public.suppliers;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE') then raise exception '您的帳號沒有執行此操作的權限。';end if;
 if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 20 then raise exception '每次必須登錄 1 至 20 筆進貨資料。';end if;
 select username into v_actor from public.app_users where id=p_actor_user_id;
 perform 1 from public.inventory_items where id in(select (value->>'inventory_item_id')::uuid from jsonb_array_elements(p_rows)) order by id for update;
 for v_row in select value from jsonb_array_elements(p_rows) loop
  select * into v_supplier from public.suppliers where id=(v_row->>'supplier_id')::uuid;
  if not found or coalesce((v_row->>'quantity')::numeric,0)<=0 or (v_row->>'quantity')::numeric<>trunc((v_row->>'quantity')::numeric) then raise exception '進貨供應商或數量不正確。';end if;
  insert into public.stock_receipts(receipt_date,inventory_item_id,quantity,supplier_id,supplier,note,source,updated_by) values((v_row->>'receipt_date')::date,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,v_supplier.id,v_supplier.name,nullif(btrim(v_row->>'note'),''),'web',v_actor) returning id into v_receipt;
  perform public.set_receipt_customers_v1(v_receipt,p_customer_ids,p_actor_user_id);
  v_ids:=array_append(v_ids,v_receipt);
 end loop;
 return jsonb_build_object('ids',v_ids,'created',cardinality(v_ids));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_receipt_customers_v1(p_receipt_id uuid, p_customer_ids uuid[], p_actor_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_before jsonb;v_after jsonb;
begin
 if not (public.has_app_permission_v1(p_actor_user_id,'purchases','CREATE') or public.has_app_permission_v1(p_actor_user_id,'purchases','UPDATE')) then raise exception '您的帳號沒有執行此操作的權限。';end if;
 if p_customer_ids is null or cardinality(p_customer_ids)>2000 or array_position(p_customer_ids,null) is not null then raise exception '訂貨客戶格式不正確。';end if;
 if cardinality(p_customer_ids)<>(select count(distinct id) from unnest(p_customer_ids) id) then raise exception '訂貨客戶不可重複。';end if;
 if cardinality(p_customer_ids)<>(select count(*) from public.customers where id=any(p_customer_ids)) then raise exception '部分訂貨客戶不存在。';end if;
 select coalesce(jsonb_agg(customer_id order by customer_id),'[]') into v_before from public.stock_receipt_customers where stock_receipt_id=p_receipt_id;
 delete from public.stock_receipt_customers where stock_receipt_id=p_receipt_id and not(customer_id=any(p_customer_ids));
 insert into public.stock_receipt_customers(stock_receipt_id,customer_id,created_by) select p_receipt_id,id,p_actor_user_id from unnest(p_customer_ids) id on conflict do nothing;
 select coalesce(jsonb_agg(customer_id order by customer_id),'[]') into v_after from public.stock_receipt_customers where stock_receipt_id=p_receipt_id;
 if v_before is distinct from v_after then insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor) values('stock_receipt_customers',p_receipt_id,'update',jsonb_build_object('customer_ids',v_before),jsonb_build_object('customer_ids',v_after),'web',(select username from public.app_users where id=p_actor_user_id));end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.update_stock_receipt_with_customers_v1(p_id uuid, p_row_version integer, p_receipt_date date, p_inventory_item_id uuid, p_quantity numeric, p_supplier_id uuid, p_note text, p_customer_ids uuid[], p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_receipt public.stock_receipts;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'purchases','UPDATE') then raise exception '您的帳號沒有執行此操作的權限。';end if;
 select * into v_receipt from public.update_stock_receipt_record_v2(p_id,p_row_version,p_receipt_date,p_inventory_item_id,p_quantity,p_supplier_id,p_note,(select username from public.app_users where id=p_actor_user_id));
 if p_customer_ids is not null then perform public.set_receipt_customers_v1(p_id,p_customer_ids,p_actor_user_id);end if;
 return to_jsonb(v_receipt);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_erp_project_with_workers_v2(p_id uuid, p_row_version integer, p_name text, p_customer_id uuid, p_project_type text, p_status text, p_description text, p_estimated_cost numeric, p_note text, p_worker_user_ids uuid[], p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_existing public.projects;
  v_project public.projects;
  v_worker_ids uuid[];
  v_worker_count integer;
  v_assigned_to text;
  v_work_type text;
begin
  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 120 then
    raise exception '專案名稱必須為 1 至 120 個字。';
  end if;
  if p_customer_id is null or not exists(select 1 from public.customers where id = p_customer_id) then
    raise exception '找不到指定客戶。';
  end if;
  if p_project_type not in ('construction', 'repair', 'maintenance', 'delivery', 'clerical', 'site_survey') then
    raise exception '專案類型不正確。';
  end if;
  if p_status not in ('in_progress', 'completed') then
    raise exception '專案狀態不正確。';
  end if;
  if char_length(coalesce(p_description, '')) > 2000 or char_length(coalesce(p_note, '')) > 1000 then
    raise exception '專案說明或備註超過長度限制。';
  end if;
  if p_estimated_cost is not null and p_estimated_cost < 0 then
    raise exception '預估成本不可小於 0。';
  end if;

  select coalesce(array_agg(distinct worker_id order by worker_id), '{}'::uuid[])
  into v_worker_ids
  from unnest(coalesce(p_worker_user_ids, '{}'::uuid[])) as workers(worker_id)
  where worker_id is not null;

  if cardinality(v_worker_ids) > 30 then
    raise exception '每個專案最多可選擇 30 位負責人。';
  end if;

  if cardinality(v_worker_ids) > 0 then
    select count(*)
    into v_worker_count
    from public.app_users users
    where users.id = any(v_worker_ids)
      and (
        users.is_active = true
        or (
          p_id is not null
          and exists (
            select 1
            from public.project_workers existing_workers
            where existing_workers.project_id = p_id
              and existing_workers.user_id = users.id
          )
        )
      );
    if v_worker_count <> cardinality(v_worker_ids) then
      raise exception '部分專案負責人不存在或已停用，請重新選擇。';
    end if;
  end if;

  select string_agg(users.display_name, '、' order by users.display_name)
  into v_assigned_to
  from public.app_users users
  where users.id = any(v_worker_ids);

  if p_id is null then
    select * into v_project
    from public.create_project_auto_number_v1(
      btrim(p_name), p_customer_id, p_project_type, p_status,
      v_assigned_to, nullif(btrim(coalesce(p_description, '')), ''),
      p_estimated_cost, nullif(btrim(coalesce(p_note, '')), ''), p_actor
    );
  else
    if p_row_version is null or p_row_version < 1 then
      raise exception '專案版本不正確，請重新整理後再修改。';
    end if;
    select * into v_existing from public.projects where id = p_id for update;
    if not found then raise exception '找不到專案。'; end if;
    if v_existing.row_version <> p_row_version then
      raise exception '專案資料已被其他使用者更新，請重新載入後再修改。';
    end if;
    update public.projects
    set name = btrim(p_name),
        customer_id = p_customer_id,
        project_type = p_project_type,
        status = p_status,
        assigned_to = nullif(v_assigned_to, ''),
        description = nullif(btrim(coalesce(p_description, '')), ''),
        estimated_cost = p_estimated_cost,
        note = nullif(btrim(coalesce(p_note, '')), ''),
        source = 'web',
        updated_by = nullif(btrim(coalesce(p_actor, '')), '')
    where id = p_id and row_version = p_row_version
    returning * into v_project;
    if not found then
      raise exception '專案資料已被其他使用者更新，請重新載入後再修改。';
    end if;
  end if;

  update public.project_workers set is_assignee=false where project_id=v_project.id;
  insert into public.project_workers(project_id, user_id)
  select v_project.id, worker_id from unnest(v_worker_ids) as workers(worker_id) on conflict(project_id,user_id) do update set is_assignee=true;
  delete from public.project_workers where project_id=v_project.id and not is_assignee and not can_view;

  v_work_type := case p_project_type
    when 'construction' then '工程施工'
    when 'delivery' then '送貨'
    when 'clerical' then '文書作業'
    when 'site_survey' then '場勘'
    when 'repair' then '維修紀錄'
    else '維護保養'
  end;

  update public.site_work_logs
  set work_type = v_work_type,
      status = p_status,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where project_id = v_project.id
    and (
      work_type is distinct from v_work_type
      or status is distinct from p_status
    );

  return jsonb_build_object(
    'project', to_jsonb(v_project),
    'worker_user_ids', to_jsonb(v_worker_ids),
    'work_log_type', v_work_type,
    'work_log_status', p_status
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_erp_project_with_workers_v3(p_id uuid, p_row_version integer, p_name text, p_customer_id uuid, p_project_type text, p_status text, p_description text, p_estimated_cost numeric, p_note text, p_worker_user_ids uuid[], p_actor text, p_project_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_result jsonb; v_project public.projects; v_actor uuid;
begin
  select id into v_actor from public.app_users where username = p_actor and is_active;
  if not coalesce(public.has_app_permission_v1(v_actor,'projects',case when p_id is null then 'CREATE' else 'UPDATE' end),false)
    or exists(select 1 from public.app_users u join public.app_roles r on r.code=u.role where u.id=v_actor and r.project_scoped) then
    raise exception '您的帳號沒有建立或修改工作內容的權限。';
  end if;
  if p_project_date is null then raise exception '請填寫工作日期。'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_customer_id::text||':'||public.normalize_work_content_name_v1(p_name),0));
  perform set_config('app.actor',p_actor,true);
  v_result := public.upsert_erp_project_with_workers_v2(p_id,p_row_version,p_name,p_customer_id,p_project_type,p_status,p_description,p_estimated_cost,p_note,p_worker_user_ids,p_actor);
  update public.projects set project_date=p_project_date, updated_by=p_actor
    where id=(v_result#>>'{project,id}')::uuid and project_date is distinct from p_project_date;
  select * into v_project from public.projects where id=(v_result#>>'{project,id}')::uuid;
  return v_result || jsonb_build_object('project',to_jsonb(v_project));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_erp_project_with_workers_v4(p_id uuid, p_row_version integer, p_name text, p_customer_id uuid, p_project_type text, p_status text, p_description text, p_estimated_cost numeric, p_note text, p_worker_user_ids uuid[], p_actor text, p_project_date date, p_construction_category text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_result jsonb; v_project public.projects;
begin
  if p_construction_category is not null and
    (p_construction_category not in ('small_purchase','tender') or p_project_type <> 'construction') then
    raise exception '工程施工分類不正確。';
  end if;
  v_result := public.upsert_erp_project_with_workers_v3(p_id,p_row_version,p_name,p_customer_id,p_project_type,p_status,p_description,p_estimated_cost,p_note,p_worker_user_ids,p_actor,p_project_date);
  update public.projects set construction_category=p_construction_category,updated_by=p_actor
    where id=(v_result#>>'{project,id}')::uuid and construction_category is distinct from p_construction_category;
  select * into v_project from public.projects where id=(v_result#>>'{project,id}')::uuid;
  return v_result || jsonb_build_object('project',to_jsonb(v_project));
end;
$function$
;
