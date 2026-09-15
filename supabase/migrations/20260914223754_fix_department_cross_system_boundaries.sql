-- Correct cross-module boundaries without granting table access or changing Auth/RLS.
-- Existing function signatures, owners, security modes and ACLs stay unchanged.
-- Apply only after approval for production; safe to rerun. No business-data rewrite.
begin;
set local lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.audit_work_content_tracking_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_actor uuid; v_event text; v_quote public.quotations; v_before jsonb;
begin
  -- Reuse the existing project/quotation boundary. This trigger branch only validates;
  -- it never returns quotation data or duplicates the normal AFTER audit.
  if tg_when='BEFORE' and tg_op='UPDATE' and tg_name='quotation_project_department_guard' then
    if new.department_id is distinct from old.department_id
      and exists(select 1 from public.quotations where project_id=old.id) then
      raise exception '此工作內容已有報價，為保留正式科室關聯，請另建工作內容，不可直接更換科室。';
    end if;
    return new;
  end if;
  if tg_op='DELETE' then
    if exists(select 1 from public.quotations where project_id=old.id) then
      raise exception '此工作內容已有報價及稽核紀錄，不可刪除。';
    end if;
    return old;
  end if;
  select id into v_actor from public.app_users where username=coalesce(nullif(current_setting('app.actor',true),''),new.updated_by);
  if tg_op='INSERT' then v_event:='create_tracking';
  elsif not exists(select 1 from public.quotable_work_types_v1() where code=old.project_type) then v_event:='create_tracking';
  else v_event:='update_work_content'; end if;
  if tg_op='UPDATE' then
    v_before:=to_jsonb(old);
    if new.customer_id is distinct from old.customer_id then
      perform set_config('app.sync_origin',coalesce(nullif(current_setting('app.sync_origin',true),''),'ERP'),true);
      for v_quote in select * from public.quotations where project_id=new.id order by id for update loop
        if public.quotation_has_billing_v1(v_quote.id) then raise exception '此工作內容已有請款紀錄，不可更換客戶。'; end if;
        update public.quotations set customer_id=new.customer_id,updated_by_user_id=coalesce(v_actor,updated_by_user_id) where id=v_quote.id;
      end loop;
    end if;
  end if;
  if exists(select 1 from public.quotable_work_types_v1() where code=new.project_type) then
    insert into public.audit_logs(entity_type,entity_id,action,source,actor,actor_user_id,before_data,after_data,system_module)
    values('project',new.id,case when v_event='create_tracking' then 'insert' else 'update' end,
      coalesce(nullif(current_setting('app.sync_origin',true),''),'ERP'),new.updated_by,v_actor,
      v_before,jsonb_build_object('event',v_event,'work_content_id',new.id,'work_content_no',new.project_code,'customer_id',new.customer_id,'work_date',new.project_date,'work_content_name',new.name,'work_content_type',new.project_type,'tracking_status',case when exists(select 1 from public.quotations where project_id=new.id and archived_at is null and quote_status<>'voided') then 'linked' else 'unquoted' end),'projects');
  end if;
  return new;
end;
$function$
;
create or replace trigger quotation_project_department_guard
before update of department_id on public.projects for each row
execute function public.audit_work_content_tracking_v1();

CREATE OR REPLACE FUNCTION public.upsert_repair_item_v1(p_id uuid, p_row_version integer, p_received_on date, p_customer_id uuid, p_inventory_item_id uuid, p_quantity integer, p_serial_number text, p_issue_description text, p_supplier_id uuid, p_sent_to_supplier_on date, p_returned_from_supplier_on date, p_returned_to_customer_on date, p_status text, p_supplier_reference text, p_notes text, p_actor text)
 RETURNS repair_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_before public.repair_items;
  v_result public.repair_items;
  v_actor text := btrim(coalesce(p_actor, ''));
  -- Transaction-local input from the existing department wrapper. No new RPC/grant.
  v_selection jsonb := nullif(current_setting('app.repair_department_selection',true),'')::jsonb;
  v_department_id uuid;
begin
  if v_selection is not null then
    perform set_config('app.repair_department_selection','',true);
    if jsonb_typeof(v_selection)<>'object'
      or not(v_selection ? 'department_id')
      or (v_selection->>'customer_id')::uuid is distinct from p_customer_id
      or nullif(v_selection->>'id','')::uuid is distinct from p_id then
      raise exception '維修品科室選擇與儲存資料不一致。';
    end if;
    v_department_id:=nullif(v_selection->>'department_id','')::uuid;
    perform 1 from public.customers where id=p_customer_id for update;
  end if;
  if p_received_on is null or p_customer_id is null or p_inventory_item_id is null
     or p_quantity is null or p_quantity < 1
     or btrim(coalesce(p_issue_description, '')) = ''
     or char_length(btrim(p_issue_description)) > 2000
     or p_status is null
     or p_status not in ('received', 'sent_to_supplier', 'supplier_returned', 'returned_to_customer', 'cancelled')
     or char_length(coalesce(p_serial_number, '')) > 160
     or char_length(coalesce(p_supplier_reference, '')) > 160
     or char_length(coalesce(p_notes, '')) > 2000
     or char_length(v_actor) not between 1 and 100 then
    raise exception '請完整填寫有效的維修品資料。';
  end if;

  if p_status not in ('received', 'cancelled') and (p_supplier_id is null or p_sent_to_supplier_on is null) then
    raise exception '此維修狀態必須選擇供應商並填寫送修日期。';
  end if;
  if p_status in ('supplier_returned', 'returned_to_customer') and p_returned_from_supplier_on is null then
    raise exception '此維修狀態必須填寫供應商返件日期。';
  end if;
  if p_status = 'returned_to_customer' and p_returned_to_customer_on is null then
    raise exception '已返還客戶時必須填寫返還客戶日期。';
  end if;
  if (p_sent_to_supplier_on is not null and p_sent_to_supplier_on < p_received_on)
     or (p_returned_from_supplier_on is not null and (p_sent_to_supplier_on is null or p_returned_from_supplier_on < p_sent_to_supplier_on))
     or (p_returned_to_customer_on is not null and (p_returned_from_supplier_on is null or p_returned_to_customer_on < p_returned_from_supplier_on)) then
    raise exception '維修流程日期順序不正確。';
  end if;

  if p_id is null then
    if p_row_version is not null then
      raise exception '新增維修品不應包含資料版本。';
    end if;
    if v_selection is not null then
      perform public.assert_customer_department_v1(p_customer_id,v_department_id);
    end if;
    insert into public.repair_items (
      received_on, customer_id, department_id, inventory_item_id, quantity, serial_number,
      issue_description, supplier_id, sent_to_supplier_on, returned_from_supplier_on,
      returned_to_customer_on, status, supplier_reference, notes, source, updated_by
    ) values (
      p_received_on, p_customer_id, v_department_id, p_inventory_item_id, p_quantity, nullif(btrim(coalesce(p_serial_number, '')), ''),
      btrim(p_issue_description), p_supplier_id, p_sent_to_supplier_on, p_returned_from_supplier_on,
      p_returned_to_customer_on, p_status, nullif(btrim(coalesce(p_supplier_reference, '')), ''),
      nullif(btrim(coalesce(p_notes, '')), ''), 'web', v_actor
    ) returning * into v_result;

    insert into public.audit_logs(entity_type, entity_id, action, before_data, after_data, source, actor)
    values ('repair_items', v_result.id, 'CREATE_REPAIR_ITEM', null, to_jsonb(v_result), 'web', v_actor);
  else
    if p_row_version is null or p_row_version < 1 then
      raise exception '維修品資料版本不正確。';
    end if;
    select * into v_before from public.repair_items where id = p_id for update;
    if not found or v_before.row_version <> p_row_version then
      raise exception '維修品資料已被其他使用者更新，請重新載入後再修改。';
    end if;

    if v_selection is not null then
      perform public.assert_customer_department_v1(p_customer_id,v_department_id,v_before.department_id,
        v_before.customer_id=p_customer_id);
    else
      v_department_id:=v_before.department_id;
    end if;
    update public.repair_items
    set received_on = p_received_on,
        customer_id = p_customer_id,
        department_id = v_department_id,
        inventory_item_id = p_inventory_item_id,
        quantity = p_quantity,
        serial_number = nullif(btrim(coalesce(p_serial_number, '')), ''),
        issue_description = btrim(p_issue_description),
        supplier_id = p_supplier_id,
        sent_to_supplier_on = p_sent_to_supplier_on,
        returned_from_supplier_on = p_returned_from_supplier_on,
        returned_to_customer_on = p_returned_to_customer_on,
        status = p_status,
        supplier_reference = nullif(btrim(coalesce(p_supplier_reference, '')), ''),
        notes = nullif(btrim(coalesce(p_notes, '')), ''),
        source = 'web',
        updated_by = v_actor
    where id = p_id and row_version = p_row_version
    returning * into v_result;
    if not found then
      raise exception '維修品資料已被其他使用者更新，請重新載入後再修改。';
    end if;

    insert into public.audit_logs(entity_type, entity_id, action, before_data, after_data, source, actor)
    values ('repair_items', v_result.id, 'UPDATE_REPAIR_ITEM', to_jsonb(v_before), to_jsonb(v_result), 'web', v_actor);
  end if;

  return v_result;
exception
  when foreign_key_violation then
    raise exception '客戶、商品或供應商資料不存在，請重新載入後再試。';
  when check_violation then
    raise exception '維修品資料未符合流程或欄位限制。';
end;
$function$
;
create or replace function public.upsert_repair_item_department_v1(
  p_id uuid,p_row_version integer,p_received_on date,p_customer_id uuid,p_inventory_item_id uuid,p_quantity integer,
  p_serial_number text,p_issue_description text,p_supplier_id uuid,p_sent_to_supplier_on date,p_returned_from_supplier_on date,
  p_returned_to_customer_on date,p_status text,p_supplier_reference text,p_notes text,p_actor text,p_department_id uuid
) returns public.repair_items language plpgsql security invoker set search_path='' as $$
declare v_result public.repair_items;
  v_previous text:=coalesce(current_setting('app.repair_department_selection',true),'');
begin
  -- Carry validated business input within this transaction; never give the Gateway UPDATE.
  -- The existing writer locks the row, checks its version and validates ownership/active status.
  perform set_config('app.repair_department_selection',
    jsonb_build_object('id',p_id,'customer_id',p_customer_id,'department_id',p_department_id)::text,true);
  select * into v_result from public.upsert_repair_item_v1(p_id,p_row_version,p_received_on,p_customer_id,p_inventory_item_id,
    p_quantity,p_serial_number,p_issue_description,p_supplier_id,p_sent_to_supplier_on,p_returned_from_supplier_on,
    p_returned_to_customer_on,p_status,p_supplier_reference,p_notes,p_actor);
  perform set_config('app.repair_department_selection',v_previous,true);
  return v_result;
exception when others then
  perform set_config('app.repair_department_selection',v_previous,true);
  raise;
end $$;
commit;
