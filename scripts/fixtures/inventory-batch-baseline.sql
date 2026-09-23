-- Read-only production function definition checked 2026-09-23; test fixture only.
CREATE OR REPLACE FUNCTION public.create_inventory_items_batch_v1(p_rows jsonb, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_row jsonb;
  v_row_number integer := 0;
  v_category_id uuid;
  v_category public.product_categories;
  v_item_name text;
  v_brand text;
  v_model text;
  v_unit text;
  v_opening_quantity numeric;
  v_number bigint;
  v_inventory_code text;
  v_inserted public.inventory_items;
  v_result jsonb := '[]'::jsonb;
  v_key text;
  v_keys text[] := '{}'::text[];
  v_existing_code text;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '品項批次資料格式不正確。';
  end if;
  if jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 20 then
    raise exception '每次必須建立 1 至 20 筆品項。';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_row_number := v_row_number + 1;
    if jsonb_typeof(v_row) <> 'object' then
      raise exception '第 % 筆品項格式不正確。', v_row_number;
    end if;

    begin
      v_category_id := nullif(btrim(v_row ->> 'category_id'),'')::uuid;
      v_opening_quantity := nullif(btrim(v_row ->> 'opening_quantity'),'')::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception '第 % 筆品項種類或期初庫存格式不正確。', v_row_number;
    end;

    v_item_name := btrim(coalesce(v_row ->> 'item_name',''));
    v_brand := btrim(coalesce(v_row ->> 'brand',''));
    v_model := nullif(btrim(coalesce(v_row ->> 'model','')),'');
    v_unit := btrim(coalesce(v_row ->> 'unit',''));

    if v_category_id is null
       or v_item_name = '' or char_length(v_item_name) > 200
       or v_brand = '' or char_length(v_brand) > 120
       or char_length(coalesce(v_model,'')) > 120
       or v_unit = '' or char_length(v_unit) > 30
       or v_opening_quantity is null
       or v_opening_quantity < 0
       or v_opening_quantity <> trunc(v_opening_quantity)
    then
      raise exception '第 % 筆品項資料不完整，期初庫存須為 0 以上整數。', v_row_number;
    end if;

    select * into v_category
    from public.product_categories
    where id = v_category_id and is_active = true;
    if not found then
      raise exception '第 % 筆請選擇有效的貨品種類。', v_row_number;
    end if;

    v_key := v_category_id::text || '|' || lower(v_item_name) || '|' || lower(v_brand) || '|' || lower(coalesce(v_model,''));
    if v_key = any(v_keys) then
      raise exception '第 % 筆與同批其他品項重複。', v_row_number;
    end if;
    v_keys := array_append(v_keys, v_key);

    select inventory_code into v_existing_code
    from public.inventory_items
    where category_id = v_category_id
      and lower(btrim(item_name)) = lower(v_item_name)
      and lower(btrim(brand)) = lower(v_brand)
      and lower(btrim(coalesce(model,''))) = lower(coalesce(v_model,''))
    limit 1;
    if found then
      raise exception '第 % 筆與既有品項 % 重複。', v_row_number, v_existing_code;
    end if;

    v_number := public.next_business_number_value_v1('inventory:'||v_category.code_prefix);
    if v_number > 999 then
      raise exception '第 % 筆所屬貨品種類的三位數編號已用完。', v_row_number;
    end if;
    v_inventory_code := v_category.code_prefix||lpad(v_number::text,3,'0');

    insert into public.inventory_items(
      inventory_code, category_id, item_type, model, brand, item_name, unit,
      opening_quantity, source, updated_by
    )
    values (
      v_inventory_code, v_category.id, v_category.name, v_model, v_brand,
      v_item_name, v_unit, v_opening_quantity, 'web', nullif(p_actor,'')
    )
    returning * into v_inserted;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'id', v_inserted.id,
      'inventory_code', v_inserted.inventory_code
    ));
  end loop;

  return v_result;
exception
  when unique_violation then
    raise exception '品項已存在，請重新載入後檢查種類、名稱、品牌與型號。';
end;
$function$
