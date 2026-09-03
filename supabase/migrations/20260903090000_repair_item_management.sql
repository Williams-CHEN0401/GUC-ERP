-- GUC ERP repair item management
-- Links existing customer, inventory and supplier master data without duplicating names.

begin;

do $$
declare
  v_missing text[] := array[]::text[];
begin
  if to_regclass('public.customers') is null then v_missing := array_append(v_missing, 'public.customers'); end if;
  if to_regclass('public.inventory_items') is null then v_missing := array_append(v_missing, 'public.inventory_items'); end if;
  if to_regclass('public.suppliers') is null then v_missing := array_append(v_missing, 'public.suppliers'); end if;
  if to_regclass('public.audit_logs') is null then v_missing := array_append(v_missing, 'public.audit_logs'); end if;

  if cardinality(v_missing) > 0 then
    raise exception 'Repair item migration prerequisites are missing: %', array_to_string(v_missing, ', ');
  end if;
end $$;

create sequence if not exists public.repair_item_no_seq;

create table if not exists public.repair_items (
  id uuid primary key default gen_random_uuid(),
  repair_no text not null unique default (
    'R' || to_char(current_date, 'YYMM') || lpad(nextval('public.repair_item_no_seq')::text, 5, '0')
  ),
  received_on date not null default current_date,
  customer_id uuid not null references public.customers(id) on delete restrict,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  quantity integer not null default 1,
  serial_number text,
  issue_description text not null,
  supplier_id uuid references public.suppliers(id) on delete restrict,
  sent_to_supplier_on date,
  returned_from_supplier_on date,
  returned_to_customer_on date,
  status text not null default 'received',
  supplier_reference text,
  notes text,
  source text not null default 'web',
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  constraint repair_items_repair_no_length check (char_length(repair_no) between 1 and 40),
  constraint repair_items_quantity_check check (quantity > 0),
  constraint repair_items_serial_number_length check (serial_number is null or char_length(serial_number) <= 160),
  constraint repair_items_issue_description_length check (char_length(issue_description) between 1 and 2000),
  constraint repair_items_status_check check (status in ('received', 'sent_to_supplier', 'supplier_returned', 'returned_to_customer', 'cancelled')),
  constraint repair_items_supplier_reference_length check (supplier_reference is null or char_length(supplier_reference) <= 160),
  constraint repair_items_notes_length check (notes is null or char_length(notes) <= 2000),
  constraint repair_items_updated_by_length check (char_length(updated_by) between 1 and 100),
  constraint repair_items_row_version_check check (row_version >= 1),
  constraint repair_items_supplier_status_check check (
    status in ('received', 'cancelled') or supplier_id is not null
  ),
  constraint repair_items_sent_date_check check (
    status in ('received', 'cancelled') or sent_to_supplier_on is not null
  ),
  constraint repair_items_supplier_return_date_check check (
    status not in ('supplier_returned', 'returned_to_customer') or returned_from_supplier_on is not null
  ),
  constraint repair_items_customer_return_date_check check (
    status <> 'returned_to_customer' or returned_to_customer_on is not null
  ),
  constraint repair_items_date_order_check check (
    (sent_to_supplier_on is null or sent_to_supplier_on >= received_on)
    and (returned_from_supplier_on is null or (sent_to_supplier_on is not null and returned_from_supplier_on >= sent_to_supplier_on))
    and (returned_to_customer_on is null or (returned_from_supplier_on is not null and returned_to_customer_on >= returned_from_supplier_on))
  )
);

create index if not exists repair_items_customer_received_idx
  on public.repair_items(customer_id, received_on desc, id desc);
create index if not exists repair_items_inventory_received_idx
  on public.repair_items(inventory_item_id, received_on desc, id desc);
create index if not exists repair_items_supplier_status_idx
  on public.repair_items(supplier_id, status, received_on desc)
  where supplier_id is not null;
create index if not exists repair_items_status_updated_idx
  on public.repair_items(status, updated_at desc, id desc);

create or replace function public.repair_items_set_update_fields_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.row_version := old.row_version + 1;
  return new;
end;
$$;

drop trigger if exists repair_items_set_update_fields on public.repair_items;
create trigger repair_items_set_update_fields
before update on public.repair_items
for each row execute function public.repair_items_set_update_fields_v1();

create or replace function public.upsert_repair_item_v1(
  p_id uuid,
  p_row_version integer,
  p_received_on date,
  p_customer_id uuid,
  p_inventory_item_id uuid,
  p_quantity integer,
  p_serial_number text,
  p_issue_description text,
  p_supplier_id uuid,
  p_sent_to_supplier_on date,
  p_returned_from_supplier_on date,
  p_returned_to_customer_on date,
  p_status text,
  p_supplier_reference text,
  p_notes text,
  p_actor text
)
returns public.repair_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.repair_items;
  v_result public.repair_items;
  v_actor text := btrim(coalesce(p_actor, ''));
begin
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
    insert into public.repair_items (
      received_on, customer_id, inventory_item_id, quantity, serial_number,
      issue_description, supplier_id, sent_to_supplier_on, returned_from_supplier_on,
      returned_to_customer_on, status, supplier_reference, notes, source, updated_by
    ) values (
      p_received_on, p_customer_id, p_inventory_item_id, p_quantity, nullif(btrim(coalesce(p_serial_number, '')), ''),
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

    update public.repair_items
    set received_on = p_received_on,
        customer_id = p_customer_id,
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
$$;

create or replace function public.delete_repair_item_v1(
  p_id uuid,
  p_row_version integer,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.repair_items;
  v_actor text := btrim(coalesce(p_actor, ''));
begin
  if p_id is null or p_row_version is null or p_row_version < 1 or char_length(v_actor) not between 1 and 100 then
    raise exception '維修品資料或版本不正確。';
  end if;
  select * into v_before from public.repair_items where id = p_id for update;
  if not found or v_before.row_version <> p_row_version then
    raise exception '維修品資料已被其他使用者更新，請重新載入後再刪除。';
  end if;

  delete from public.repair_items where id = p_id and row_version = p_row_version;
  insert into public.audit_logs(entity_type, entity_id, action, before_data, after_data, source, actor)
  values ('repair_items', p_id, 'DELETE_REPAIR_ITEM', to_jsonb(v_before), null, 'web', v_actor);
  return jsonb_build_object('id', p_id, 'deleted', true);
end;
$$;

alter table public.repair_items enable row level security;
alter table public.repair_items force row level security;

revoke all on public.repair_items from public, anon, authenticated, service_role;
revoke all on sequence public.repair_item_no_seq from public, anon, authenticated, service_role;
grant select on public.repair_items to service_role;

revoke all on function public.repair_items_set_update_fields_v1() from public, anon, authenticated, service_role;
revoke all on function public.upsert_repair_item_v1(uuid,integer,date,uuid,uuid,integer,text,text,uuid,date,date,date,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.delete_repair_item_v1(uuid,integer,text) from public, anon, authenticated, service_role;
grant execute on function public.upsert_repair_item_v1(uuid,integer,date,uuid,uuid,integer,text,text,uuid,date,date,date,text,text,text,text) to service_role;
grant execute on function public.delete_repair_item_v1(uuid,integer,text) to service_role;

comment on table public.repair_items is 'Customer repair intake and supplier repair workflow linked to ERP master data.';
comment on column public.repair_items.customer_id is 'Canonical customer relation; customer category is derived from customers.';
comment on column public.repair_items.inventory_item_id is 'Canonical inventory item relation; product category is derived from inventory_items.';

commit;
