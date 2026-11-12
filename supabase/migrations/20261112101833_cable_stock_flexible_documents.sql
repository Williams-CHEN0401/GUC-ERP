begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $baseline$ begin
 if md5(replace(pg_get_functiondef('public.guard_cable_pickup_v1()'::regprocedure),chr(13),''))<>'5a207dbf854b464f9bdf95f10e9b479e' then raise exception 'Unexpected baseline: guard_cable_pickup_v1()';end if;
 if md5(replace(pg_get_functiondef('public.guard_meter_stock_balance_v1()'::regprocedure),chr(13),''))<>'3ece33e9df4b60e02d413422e99a2c58' then raise exception 'Unexpected baseline: guard_meter_stock_balance_v1()';end if;
 if md5(replace(pg_get_functiondef('public.guard_remnant_pickup_v1()'::regprocedure),chr(13),''))<>'b796201935c22455fd268e3b5ca320c9' then raise exception 'Unexpected baseline: guard_remnant_pickup_v1()';end if;
 if md5(replace(pg_get_functiondef('public.guard_remnant_pickup_balance_v1()'::regprocedure),chr(13),''))<>'b23b194db8b97d2e3026e4ac5f3b8a35' then raise exception 'Unexpected baseline: guard_remnant_pickup_balance_v1()';end if;
 if md5(replace(pg_get_functiondef('public.unpack_cable_for_pickup_v1()'::regprocedure),chr(13),''))<>'9644ca974ab3d87622b2a8b493a8d6c0' then raise exception 'Unexpected baseline: unpack_cable_for_pickup_v1()';end if;
end $baseline$;

-- Quantity availability is advisory for these two existing cable categories.
-- Keep identity, positive input, unit, RBAC, audit and document version checks.
create function public.inventory_cable_stock_flexible_v1(p_item uuid) returns boolean
language sql stable security invoker set search_path='' as $$
 select coalesce((select replace(btrim(c.name),'＆','&') in('弱電線材','電線&電纜類')
 from public.inventory_items i join public.product_categories c on c.id=i.category_id where i.id=p_item),false);
$$;
revoke all on function public.inventory_cable_stock_flexible_v1(uuid) from public,anon,authenticated;
grant execute on function public.inventory_cable_stock_flexible_v1(uuid) to service_role;

-- Keep previous free site-return reversals; allow cable balances below zero
-- so partial replenishment, real-package unpacking and counts can proceed.
alter table public.stock_adjustments drop constraint stock_adjustments_after_quantity_check;
alter table public.stock_adjustments add constraint stock_adjustments_after_quantity_check
 check(after_quantity>=0 or source='site_return' or remnant_count_scope is not null or public.inventory_cable_stock_flexible_v1(inventory_item_id));

create or replace function public.guard_cable_pickup_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare i uuid;q numeric;factor numeric;
begin
 for i in select old.inventory_item_id union select new.inventory_item_id loop
  if i is null then continue;end if;
  select meters_per_unit into factor from public.inventory_items where id=i for update;

  q:=public.current_inventory_meters_v1(i);
  if q<0 and not public.inventory_cable_stock_flexible_v1(i) then raise exception '散料米數不足，不能超領；整箱／整捲庫存不會自動拆用。';end if;
 end loop;
 return null;
end $function$;

create or replace function public.guard_meter_stock_balance_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare item_id uuid;items uuid[];
begin
 if tg_table_name='inventory_items' then
  if tg_op='UPDATE' and new.opening_meters is not distinct from old.opening_meters then return null;end if;
  items:=array[new.id];
 else
  if tg_op='INSERT' and new.quantity_unit<>'meter' or tg_op='DELETE' and old.quantity_unit<>'meter' or tg_op='UPDATE' and old.quantity_unit<>'meter' and new.quantity_unit<>'meter' then return null;end if;
  items:=array[old.inventory_item_id,new.inventory_item_id];
 end if;
 for item_id in select distinct x from unnest(items)x where x is not null order by x loop
  perform 1 from public.inventory_items where id=item_id for update;
  if public.current_inventory_meters_v1(item_id)<0 and not public.inventory_cable_stock_flexible_v1(item_id) then raise exception '散料米數不足，不能移除或減少已領用的入庫米數。';end if;
 end loop;
 return null;
end $$;

create or replace function public.guard_remnant_pickup_v1() returns trigger language plpgsql set search_path='' as $$
declare l public.site_return_lines;available numeric;
begin
 if new.remnant_line_id is null then return new;end if;
 if tg_op='UPDATE' and new.inventory_item_id<>old.inventory_item_id and new.remnant_line_id=old.remnant_line_id then
  new.remnant_line_id:=null;return new;
 end if;
 if new.quantity_unit<>'meter' then raise exception '餘料箱必須以米取貨。';end if;
 perform 1 from public.inventory_items where id=new.inventory_item_id for update;
 select * into l from public.site_return_lines where id=new.remnant_line_id;
 if l.id is null or not l.is_remnant_box or l.inventory_item_id<>new.inventory_item_id then raise exception '所選餘料箱不屬於此品項，請重新選擇。';end if;
 -- A correction can reduce an old withdrawal even after its source was reversed.
 if tg_op='UPDATE' and old.remnant_line_id=new.remnant_line_id and old.inventory_item_id=new.inventory_item_id
  and old.quantity_unit='meter' and new.quantity<=old.quantity then return new;end if;
 available:=public.inventory_remnant_balance_v1(new.remnant_line_id);
 if tg_op='UPDATE' and old.remnant_line_id=new.remnant_line_id and old.quantity_unit='meter' then available:=available+old.quantity;end if;
 if new.quantity>available and not public.inventory_cable_stock_flexible_v1(new.inventory_item_id) then raise exception '所選餘料箱剩餘 % 米，不能超過該箱米數。',available;end if;
 return new;
end $$;

create or replace function public.guard_remnant_pickup_balance_v1() returns trigger language plpgsql set search_path='' as $$
begin
 if new.remnant_line_id is null then return null;end if;
 if tg_op='UPDATE' and old.remnant_line_id=new.remnant_line_id and old.inventory_item_id=new.inventory_item_id
  and old.quantity_unit='meter' and new.quantity<=old.quantity then return null;end if;
 if public.inventory_remnant_balance_v1(new.remnant_line_id)<0 and not public.inventory_cable_stock_flexible_v1(new.inventory_item_id) then raise exception '所選餘料箱米數不足，請重新讀取庫存。';end if;
 return null;
end $$;

create or replace function public.unpack_cable_for_pickup_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare factor numeric;loose numeric;packages numeric;available numeric;actor text;
begin
 if new.quantity_unit<>'meter' or new.remnant_line_id is not null then return new;end if;
 if tg_op='INSERT' or old.inventory_item_id is distinct from new.inventory_item_id or old.quantity_unit<>'meter' then
  if not public.inventory_loose_meter_allowed_v1(new.inventory_item_id) and not(tg_op='UPDATE' and old.inventory_item_id=new.inventory_item_id and old.quantity_unit='meter') then raise exception '此貨品請使用原單位取貨。';end if;
 end if;
 select meters_per_unit into factor from public.inventory_items where id=new.inventory_item_id for update;

 loose:=public.inventory_unboxed_meters_v1(new.inventory_item_id);
 if tg_op='UPDATE' and old.inventory_item_id=new.inventory_item_id and old.quantity_unit='meter' and old.remnant_line_id is null then loose:=loose+old.quantity;end if;
 if new.quantity>loose then
  if factor is null then
   if public.inventory_cable_stock_flexible_v1(new.inventory_item_id) then return new;end if;
   raise exception '未分箱散料不足；請選擇餘料箱，或以散料(米)進貨後再取貨。';
  end if;
  packages:=ceil((new.quantity-loose)/factor);available:=public.current_inventory_quantity(new.inventory_item_id);
  -- The BEFORE trigger still sees the old package withdrawal. Those packages
  -- are released by this same UPDATE and may supply the corrected meter row.
  if tg_op='UPDATE' and old.inventory_item_id=new.inventory_item_id and old.quantity_unit='package' then
    available:=available+old.quantity;
  end if;
  if available<packages then
   if public.inventory_cable_stock_flexible_v1(new.inventory_item_id) then
    -- Unpack only actual whole packages; missing material remains a visible
    -- negative meter balance rather than an invented package or stock receipt.
    packages:=greatest(0,least(packages,floor(available)));
    if packages=0 then return new;end if;
   else raise exception '可用米數不足，散料及整包庫存不足以供應本次取貨。';end if;
  end if;
  actor:=coalesce(new.updated_by,new.created_by_username,'system');
  insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
   values(new.inventory_item_id,available,available-packages,'米數取貨拆包：'||new.id::text||'；每包 '||factor::text||' 米',gen_random_uuid(),'web',actor,'package');
  insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
   values(new.inventory_item_id,public.current_inventory_meters_v1(new.inventory_item_id),public.current_inventory_meters_v1(new.inventory_item_id)+packages*factor,'米數取貨拆包：'||new.id::text||'；'||packages::text||' 包',gen_random_uuid(),'web',actor,'meter');
 end if;
 return new;
end $function$;

commit;
