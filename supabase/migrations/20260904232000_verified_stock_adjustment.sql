-- Keep a stock correction and its verification in one short database transaction.
-- The inventory item row is always the first and only explicit row lock.
create or replace function public.apply_stock_adjustment_verified_v1(
  p_inventory_item_id uuid,
  p_after_quantity integer,
  p_reason text,
  p_idempotency_key uuid,
  p_actor text
)
returns table (
  inventory_item_id uuid,
  verified_quantity numeric
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current_quantity numeric;
begin
  if p_after_quantity is null or p_after_quantity < 0 then
    raise exception using errcode = 'P0001', message = '校正後庫存不可小於 0。';
  end if;

  perform 1
  from public.inventory_items
  where id = p_inventory_item_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = '找不到要校正的庫存品項。';
  end if;

  perform public.apply_stock_adjustment(
    p_inventory_item_id,
    p_after_quantity,
    p_reason,
    p_idempotency_key,
    p_actor
  );

  select
    item.opening_quantity
      + coalesce((select sum(receipt.quantity) from public.stock_receipts receipt where receipt.inventory_item_id = item.id), 0)
      - coalesce((select sum(pickup.quantity) from public.pickup_records pickup where pickup.inventory_item_id = item.id), 0)
      + coalesce((select sum(adjustment.difference_quantity) from public.stock_adjustments adjustment where adjustment.inventory_item_id = item.id), 0)
  into v_current_quantity
  from public.inventory_items item
  where item.id = p_inventory_item_id;

  if v_current_quantity is distinct from p_after_quantity then
    raise exception using
      errcode = 'P0001',
      message = format('庫存校正驗證失敗：預期 %s，資料庫計算為 %s。', p_after_quantity, v_current_quantity);
  end if;

  return query select p_inventory_item_id, v_current_quantity;
end;
$$;

revoke all on function public.apply_stock_adjustment_verified_v1(uuid, integer, text, uuid, text) from public, anon, authenticated;
grant execute on function public.apply_stock_adjustment_verified_v1(uuid, integer, text, uuid, text) to service_role;

comment on function public.apply_stock_adjustment_verified_v1(uuid, integer, text, uuid, text) is
  'Atomically applies a stock correction and rejects the transaction unless the ledger recomputes to the requested integer quantity.';
