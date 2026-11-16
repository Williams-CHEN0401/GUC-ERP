begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Project-specific quantities reference the existing project and item masters.
-- NULL means no estimate; zero is an explicit zero. Units are snapshots and
-- never retroactively converted when a stock item's packaging changes.
create table public.project_material_estimates (
 id uuid primary key default gen_random_uuid(),
 project_id uuid not null references public.projects(id) on delete restrict,
 inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
 unit text not null check(length(btrim(unit)) between 1 and 30),
 planned_quantity numeric(18,2) check(planned_quantity>=0 and planned_quantity<1e12),
 row_version integer not null default 1,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 created_by_user_id uuid not null references public.app_users(id),
 updated_by_user_id uuid not null references public.app_users(id),
 unique(project_id,inventory_item_id,unit)
);
alter table public.project_material_estimates enable row level security;
revoke all on public.project_material_estimates from public,anon,authenticated;
grant select,insert,update on public.project_material_estimates to service_role;
create index project_material_estimates_item_idx on public.project_material_estimates(inventory_item_id);
create trigger project_material_estimates_form_audit after insert or update on public.project_material_estimates
 for each row execute function audit_internal.capture_form('id');

create function public.project_material_estimates_v1(p_actor_user_id uuid,p_project_id uuid,p_options boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare report jsonb; rows jsonb; options jsonb:='[]'; writable boolean;
begin
 if p_project_id is null then raise exception '請選擇工作內容。';end if;
 -- Reuse the complete installed report/private/project scope authorization.
 report:=public.work_content_report_v1(p_actor_user_id,p_project_id,null,null,null,false);
 writable:=public.has_app_permission_v1(p_actor_user_id,'projects','UPDATE')
   and public.has_app_permission_v1(p_actor_user_id,'inventory','VIEW');
 select coalesce(jsonb_agg(to_jsonb(e)||jsonb_build_object('name',i.item_name,'code',i.inventory_code,
  'brand',i.brand,'model',i.model,'categoryId',i.category_id,'categoryName',coalesce(c.name,'未分類')) order by i.inventory_code,e.unit),'[]') into rows
 from public.project_material_estimates e join public.inventory_items i on i.id=e.inventory_item_id
 left join public.product_categories c on c.id=i.category_id
 where e.project_id=p_project_id and public.erp_private_json_visible_v1(to_jsonb(i));
 if p_options and writable then
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'code',i.inventory_code,'name',i.item_name,
   'brand',i.brand,'model',i.model,'unit',i.unit,'allow_meters',public.inventory_loose_meter_allowed_v1(i.id)) order by i.inventory_code,i.id),'[]') into options
  from public.inventory_items i where public.erp_private_json_visible_v1(to_jsonb(i));
 end if;
 return jsonb_build_object('records',rows,'items',options,'can_write',writable);
end $$;

create function public.save_project_material_estimate_v1(p_actor_user_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare project uuid:=(p_payload->>'project_id')::uuid; item uuid:=(p_payload->>'inventory_item_id')::uuid;
 measure text:=btrim(p_payload->>'unit'); qty numeric; prior public.project_material_estimates;
 result public.project_material_estimates; stock public.inventory_items; expected integer:=(p_payload->>'row_version')::integer;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'projects','UPDATE')
  or not public.has_app_permission_v1(p_actor_user_id,'inventory','VIEW') then raise exception '沒有修改預計用料的權限。';end if;
 if project is null or item is null or measure is null or measure='' or expected is null then raise exception '請選擇工作內容、品項及單位。';end if;
 perform 1 from public.projects where id=project for no key update;
 perform public.work_content_report_v1(p_actor_user_id,project,null,null,null,false);
 select * into stock from public.inventory_items where id=item for share;
 if not found then raise exception '找不到貨品。';end if;
 perform public.erp_private_assert_v1(to_jsonb(stock));
 select * into prior from public.project_material_estimates where project_id=project and inventory_item_id=item and unit=measure for update;
 if coalesce(prior.row_version,0)<>expected then raise exception '預計用料已被其他人修改，請重新讀取。';end if;
 if prior.id is null and measure is distinct from stock.unit
  and not(measure='米' and public.inventory_loose_meter_allowed_v1(item)) then raise exception '請選擇此貨品可用的計量單位。';end if;
 if not(p_payload ? 'planned_quantity') then raise exception '請填寫預計用量，或明確清除。';end if;
 if p_payload->>'planned_quantity' is not null then
  if jsonb_typeof(p_payload->'planned_quantity')<>'number' then raise exception '預計用量須為數字。';end if;
  qty:=(p_payload->>'planned_quantity')::numeric;
  if qty<0 or qty>=1e12 or qty<>round(qty,2) then raise exception '預計用量須為非負數，最多兩位小數。';end if;
 end if;
 if prior.id is null and qty is null then raise exception '尚未設定預計用量。';end if;
 insert into public.project_material_estimates(project_id,inventory_item_id,unit,planned_quantity,created_by_user_id,updated_by_user_id)
 values(project,item,measure,qty,p_actor_user_id,p_actor_user_id)
 on conflict(project_id,inventory_item_id,unit) do update set planned_quantity=excluded.planned_quantity,
  row_version=project_material_estimates.row_version+1,updated_at=now(),updated_by_user_id=p_actor_user_id returning * into result;
 return to_jsonb(result);
end $$;
revoke all on function public.project_material_estimates_v1(uuid,uuid,boolean),public.save_project_material_estimate_v1(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.project_material_estimates_v1(uuid,uuid,boolean),public.save_project_material_estimate_v1(uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
