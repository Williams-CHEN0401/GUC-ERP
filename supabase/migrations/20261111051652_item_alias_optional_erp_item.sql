begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Keep existing item links, RBAC, audit, stock and historical transactions.
alter table public.supplier_item_aliases alter column inventory_item_id drop not null;
alter table public.supplier_item_aliases add constraint supplier_item_alias_confirmed_item_check
 check(status<>'confirmed' or inventory_item_id is not null);
create unique index supplier_item_alias_unassigned_exact_idx on public.supplier_item_aliases
 (supplier_id,lower(btrim(supplier_item_name)),lower(btrim(supplier_sku))) where inventory_item_id is null;

create or replace function public.item_aliases_read_v1(p_actor uuid,p_filters jsonb default '{}') returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare rows jsonb; term text=lower(btrim(coalesce(p_filters->>'q',''))); history_id uuid=nullif(p_filters->>'history_id','')::uuid;
begin
 if not public.item_alias_read_allowed_v1(p_actor) then raise exception '沒有品項對照查詢權限。';end if;
 if coalesce((p_filters->>'export')::boolean,false) and not public.has_app_permission_v1(p_actor,'data_export','VIEW') then raise exception '沒有 Excel 匯出權限。';end if;
 if history_id is not null then
  if not public.has_app_permission_v1(p_actor,'inventory','VIEW') then raise exception '沒有品項對照歷程權限。';end if;
  select coalesce(jsonb_agg(jsonb_build_object('action',a.action,'before_data',a.before_data,'after_data',a.after_data,
   'actor',coalesce(u.display_name,a.actor),'created_at',a.created_at) order by a.created_at desc,a.id desc),'[]') into rows
  from public.audit_logs a left join public.app_users u on u.id=a.actor_user_id
  where a.entity_type='supplier_item_aliases' and a.entity_id=history_id and a.event_kind='change';
  return jsonb_build_object('history',rows);
 end if;
 select coalesce(jsonb_agg(x order by (x->>'status'='inactive'),(x->>'updated_at')::timestamptz desc,x->>'id'),'[]') into rows
 from (
  select to_jsonb(a)||jsonb_build_object('supplier_name',s.name,'inventory_code',i.inventory_code,'item_name',i.item_name,
   'item_brand',i.brand,'item_model',i.model,'item_unit',i.unit,'meters_per_unit',i.meters_per_unit,
   'created_by_name',c.display_name,'updated_by_name',u.display_name) as x
  from public.supplier_item_aliases a join public.suppliers s on s.id=a.supplier_id
  left join public.inventory_items i on i.id=a.inventory_item_id
  join public.app_users c on c.id=a.created_by_user_id join public.app_users u on u.id=a.updated_by_user_id
  where (coalesce(p_filters->>'supplier_id','')='' or a.supplier_id::text=p_filters->>'supplier_id')
   and (coalesce(p_filters->>'status','')='' or a.status=p_filters->>'status')
   and (not coalesce((p_filters->>'integration')::boolean,false) or (a.status<>'inactive' and a.inventory_item_id is not null))
   and (term='' or strpos(lower(concat_ws(' ',s.name,a.supplier_item_name,a.supplier_sku,a.brand,a.model,a.specification,i.item_name,i.inventory_code,i.brand,i.model)),term)>0)
 ) entries;
 return jsonb_build_object('records',rows,'permissions',jsonb_build_object(
  'create',public.has_app_permission_v1(p_actor,'inventory','VIEW') and public.has_app_permission_v1(p_actor,'inventory','CREATE'),
  'update',public.has_app_permission_v1(p_actor,'inventory','VIEW') and public.has_app_permission_v1(p_actor,'inventory','UPDATE'),
  'delete',public.has_app_permission_v1(p_actor,'inventory','VIEW') and public.has_app_permission_v1(p_actor,'inventory','DELETE'),
  'export',public.has_app_permission_v1(p_actor,'data_export','VIEW')));
end $$;

create or replace function public.save_item_alias_v1(p_actor uuid,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a public.supplier_item_aliases; old_a public.supplier_item_aliases;
 did uuid=nullif(p_payload->>'id','')::uuid; sid uuid=nullif(p_payload->>'supplier_id','')::uuid;
 iid uuid=nullif(p_payload->>'inventory_item_id','')::uuid; act text=coalesce(p_payload->>'action','save');
 conflicts jsonb; duplicate_id uuid; needed text; actor_name text;
begin
 needed=case when act='deactivate' then 'DELETE' when did is null then 'CREATE' else 'UPDATE' end;
 if not public.website_access_v1(p_actor,'erp','LOGIN') or not public.has_app_permission_v1(p_actor,'inventory','VIEW')
  or not public.has_app_permission_v1(p_actor,'inventory',needed) then raise exception '沒有品項對照操作權限。';end if;
 if act not in ('save','deactivate') then raise exception '不支援的品項對照操作。';end if;
 if did is not null then
  select * into old_a from public.supplier_item_aliases where id=did for update;
  if old_a.id is null or old_a.row_version<>coalesce((p_payload->>'row_version')::integer,0) then raise exception '此對照已被其他人修改，請重新讀取。';end if;
 end if;
 select username into actor_name from public.app_users where id=p_actor and is_active;
 perform set_config('app.actor',actor_name,true);
 if act='deactivate' then
  if old_a.id is null then raise exception '請選擇既有對照。';end if;
  update public.supplier_item_aliases set status='inactive',row_version=row_version+1,updated_at=now(),updated_by_user_id=p_actor where id=did returning * into a;
  return to_jsonb(a);
 end if;
 a= jsonb_populate_record(null::public.supplier_item_aliases, jsonb_build_object(
  'supplier_id',sid,'inventory_item_id',iid,'supplier_item_name',btrim(coalesce(p_payload->>'supplier_item_name','')),
  'supplier_sku',btrim(coalesce(p_payload->>'supplier_sku','')),'brand',btrim(coalesce(p_payload->>'brand','')),
  'model',btrim(coalesce(p_payload->>'model','')),'specification',btrim(coalesce(p_payload->>'specification','')),
  'supplier_unit',btrim(coalesce(p_payload->>'supplier_unit','')),'conversion_factor',nullif(p_payload->>'conversion_factor','')::numeric,
  'notes',btrim(coalesce(p_payload->>'notes','')),'status',coalesce(p_payload->>'status','pending'),
  'conflict_note',btrim(coalesce(p_payload->>'conflict_note',''))));
 if sid is null or not exists(select 1 from public.suppliers where id=sid) then raise exception '請選擇既有供應商。';end if;
 if iid is not null and not exists(select 1 from public.inventory_items where id=iid) then raise exception '請選擇既有 ERP 品項，或先留白。';end if;
 if a.status='confirmed' and iid is null then raise exception '請先選擇 ERP 商品再確認對照，或使用待確認儲存。';end if;
 if a.supplier_item_name='' then raise exception '供應商專業品名為必填。';end if;
 if a.status='confirmed' and not public.has_app_permission_v1(p_actor,'inventory','UPDATE') then raise exception '沒有品項對照確認權限。';end if;
 if a.status='inactive' and old_a.status is distinct from 'inactive' and not public.has_app_permission_v1(p_actor,'inventory','DELETE') then raise exception '沒有品項對照停用權限。';end if;
 -- Serializes same supplier identities, including concurrent imports/reassignments.
 perform pg_advisory_xact_lock(hashtextextended('supplier-item-alias:'||sid::text,0));
 select id into duplicate_id from public.supplier_item_aliases b where b.supplier_id=sid and b.id is distinct from did
  and (b.inventory_item_id is not distinct from iid or b.inventory_item_id is null or iid is null) and (lower(btrim(b.supplier_item_name))=lower(a.supplier_item_name)
  or a.supplier_sku<>'' and lower(btrim(b.supplier_sku))=lower(a.supplier_sku)) limit 1;
 if duplicate_id is not null then raise exception '此供應商的品名或料號已有相同對照，請編輯既有資料（包含停用資料）。';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'row_version',b.row_version,'inventory_code',i.inventory_code,'item_name',i.item_name,'supplier_item_name',b.supplier_item_name)),'[]') into conflicts
 from public.supplier_item_aliases b join public.inventory_items i on i.id=b.inventory_item_id
 where b.supplier_id=sid and b.id is distinct from did and b.inventory_item_id<>iid and b.status<>'inactive'
  and (lower(btrim(b.supplier_item_name))=lower(a.supplier_item_name) or a.supplier_sku<>'' and lower(btrim(b.supplier_sku))=lower(a.supplier_sku));
 if jsonb_array_length(conflicts)>0 then
  if coalesce((p_payload->>'allow_conflict')::boolean,false) is not true or a.conflict_note=''
   or coalesce(p_payload->'conflict_versions','[]') is distinct from (select coalesce(jsonb_agg(jsonb_build_object('id',x->>'id','row_version',(x->>'row_version')::integer) order by x->>'id'),'[]') from jsonb_array_elements(conflicts) x)
   then return jsonb_build_object('needs_confirmation',true,'conflicts',conflicts);end if;
 end if;
 if did is null then
  insert into public.supplier_item_aliases(supplier_id,inventory_item_id,supplier_item_name,supplier_sku,brand,model,specification,supplier_unit,conversion_factor,notes,status,conflict_note,created_by_user_id,updated_by_user_id)
   values(sid,iid,a.supplier_item_name,a.supplier_sku,a.brand,a.model,a.specification,a.supplier_unit,a.conversion_factor,a.notes,a.status,a.conflict_note,p_actor,p_actor) returning * into a;
 else
  update public.supplier_item_aliases set supplier_id=sid,inventory_item_id=iid,supplier_item_name=a.supplier_item_name,supplier_sku=a.supplier_sku,
   brand=a.brand,model=a.model,specification=a.specification,supplier_unit=a.supplier_unit,conversion_factor=a.conversion_factor,notes=a.notes,
   status=a.status,conflict_note=a.conflict_note,updated_at=now(),updated_by_user_id=p_actor,row_version=row_version+1 where id=did returning * into a;
 end if;
 return to_jsonb(a);
end $$;

commit;
