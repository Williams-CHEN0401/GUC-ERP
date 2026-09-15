CREATE OR REPLACE FUNCTION public.update_stock_receipt_record_v2(p_id uuid, p_row_version integer, p_receipt_date date, p_inventory_item_id uuid, p_quantity numeric, p_supplier_id uuid, p_note text, p_actor text)
 RETURNS stock_receipts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_result public.stock_receipts; v_supplier public.suppliers;
begin
  if p_quantity is null or p_quantity<=0 then raise exception '入庫數量必須大於 0。'; end if;
  select * into v_supplier from public.suppliers where id=p_supplier_id;
  if not found then raise exception '找不到指定供應商。'; end if;
  perform 1 from public.inventory_items where id=p_inventory_item_id for update;
  if not found then raise exception '找不到指定品項。'; end if;
  update public.stock_receipts set receipt_date=p_receipt_date,inventory_item_id=p_inventory_item_id,
    quantity=round(p_quantity,2),supplier_id=v_supplier.id,supplier=v_supplier.name,note=nullif(btrim(p_note),''),source='web',updated_by=p_actor
  where id=p_id and row_version=p_row_version returning * into v_result;
  if not found then raise exception '此進貨紀錄已被其他使用者更新，請重新載入。'; end if;
  return v_result;
end; $function$
;
