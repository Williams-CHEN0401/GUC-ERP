-- Correct an existing pickup unit atomically while keeping stable IDs and
-- historical length/cost snapshots. No business-row backfill or ACL changes.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create or replace function public.unpack_cable_for_pickup_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare factor numeric;loose numeric;packages numeric;available numeric;actor text;
begin
 if new.quantity_unit<>'meter' then return new;end if;
 select meters_per_unit into factor from public.inventory_items where id=new.inventory_item_id for update;
 if factor is null then raise exception '請先設定此品項的預設長度。';end if;
 loose:=public.current_inventory_meters_v1(new.inventory_item_id);
 if tg_op='UPDATE' and old.inventory_item_id=new.inventory_item_id and old.quantity_unit='meter' then loose:=loose+old.quantity;end if;
 if new.quantity>loose then
  packages:=ceil((new.quantity-loose)/factor);available:=public.current_inventory_quantity(new.inventory_item_id);
  -- The BEFORE trigger still sees the old package withdrawal. Those packages
  -- are released by this same UPDATE and may supply the corrected meter row.
  if tg_op='UPDATE' and old.inventory_item_id=new.inventory_item_id and old.quantity_unit='package' then
    available:=available+old.quantity;
  end if;
  if available<packages then raise exception '可用米數不足，散料及整包庫存不足以供應本次取貨。';end if;
  actor:=coalesce(new.updated_by,new.created_by_username,'system');
  insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
   values(new.inventory_item_id,available,available-packages,'米數取貨拆包：'||new.id::text||'；每包 '||factor::text||' 米',gen_random_uuid(),'web',actor,'package');
  insert into public.stock_adjustments(inventory_item_id,before_quantity,after_quantity,reason,idempotency_key,source,updated_by,quantity_unit)
   values(new.inventory_item_id,loose,loose+packages*factor,'米數取貨拆包：'||new.id::text||'；'||packages::text||' 包',gen_random_uuid(),'web',actor,'meter');
 end if;
 return new;
end $$;

CREATE OR REPLACE FUNCTION public.save_pickup_document_v1(p_document_id uuid, p_existing jsonb, p_pickup_date date, p_project_id uuid, p_rows jsonb, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_current uuid[];v_expected uuid[];v_submitted uuid[];v_removed uuid[];v_row jsonb;v_id uuid;v_version integer;
  v_actor text;v_creator uuid;v_username text;v_log uuid;v_context text;v_request_row integer;v_ids uuid[]:='{}';
begin
  if p_document_id is null or p_pickup_date is null or p_project_id is null or not public.has_app_permission_v1(p_actor_user_id,'pickups','UPDATE') then raise exception '沒有有效的取貨單資料或操作權限。';end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 50
    or p_existing is null or jsonb_typeof(p_existing)<>'array' or jsonb_array_length(p_existing) not between 1 and 50 then raise exception '取貨明細資料不完整。';end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r)<>'object' or nullif(r->>'inventory_item_id','') is null
    or coalesce((r->>'quantity')::numeric,0)<=0 or (r->>'quantity')::numeric<>round((r->>'quantity')::numeric,2) or coalesce(r->>'quantity_unit','package') not in('package','meter') or (coalesce(r->>'quantity_unit','package')='package' and (r->>'quantity')::numeric<>trunc((r->>'quantity')::numeric)) or char_length(coalesce(r->>'note',''))>500)
    then raise exception '取貨明細品項、數量或備註不正確。';end if;
  if (select count(*) from jsonb_array_elements(p_rows))<>(select count(distinct r->>'inventory_item_id') from jsonb_array_elements(p_rows) r) then raise exception '同一張取貨單有重複品項，請合併數量。';end if;
  perform pg_advisory_xact_lock(hashtextextended(p_document_id::text,0));
  perform 1 from public.projects where id=p_project_id for key share;
  if not found then raise exception '找不到指定工作內容。';end if;
  perform 1 from public.site_work_logs where id in(select work_log_id from public.pickup_records where pickup_document_id=p_document_id) order by id for share;
  perform 1 from public.pickup_records where pickup_document_id=p_document_id order by id for update;
  select coalesce(array_agg(id order by id),'{}') into v_current from public.pickup_records where pickup_document_id=p_document_id;
  select coalesce(array_agg((r->>'id')::uuid order by (r->>'id')::uuid),'{}') into v_expected from jsonb_array_elements(p_existing) r;
  select coalesce(array_agg((r->>'id')::uuid order by (r->>'id')::uuid),'{}') into v_submitted from jsonb_array_elements(p_rows) r where nullif(r->>'id','') is not null;
  if cardinality(v_current)=0 or v_current is distinct from v_expected or not(v_submitted<@v_current)
    or cardinality(v_submitted)<>(select count(distinct id) from unnest(v_submitted) id)
    or exists(select 1 from jsonb_array_elements(p_existing) e join public.pickup_records s on s.id=(e->>'id')::uuid where (e->>'row_version')::integer is distinct from s.row_version)
    then raise exception '取貨單已被更新，請重新整理後再修改；原單據未變更。';end if;
  perform 1 from public.inventory_items where id in(select (r->>'inventory_item_id')::uuid from jsonb_array_elements(p_rows) r
    union select inventory_item_id from public.pickup_records where id=any(v_current)) order by id for update;
  select username into v_actor from public.app_users where id=p_actor_user_id and is_active;
  select created_by_user_id,created_by_username,work_log_id into v_creator,v_username,v_log from public.pickup_records where id=any(v_current) order by id limit 1;
  if exists(select 1 from public.pickup_records where id=any(v_current) and (work_log_id is distinct from v_log or project_id<>p_project_id)) then v_log:=null;end if;
  select coalesce(array_agg(id),'{}') into v_removed from unnest(v_current) id where not(id=any(v_submitted));
  if cardinality(v_removed)>0 then
    if not public.has_app_permission_v1(p_actor_user_id,'pickups','DELETE') then raise exception '沒有刪除取貨明細的權限。';end if;
    perform public.delete_pickup_records(v_removed,v_actor);
  end if;
  v_context:=current_setting('app.pickup_document_id',true);perform set_config('app.pickup_document_id',p_document_id::text,true);
  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_id:=nullif(v_row->>'id','')::uuid;
    if v_id is null then
      if not public.has_app_permission_v1(p_actor_user_id,'pickups','CREATE') then raise exception '沒有新增取貨明細的權限。';end if;
      -- New lines retain the original account/log context, not another assignment ID.
      insert into public.pickup_records(pickup_date,project_id,inventory_item_id,quantity,note,source,updated_by,created_by_user_id,created_by_username,work_log_id,quantity_unit)
      values(p_pickup_date,p_project_id,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,nullif(btrim(v_row->>'note'),''),'web',v_actor,v_creator,v_username,v_log,coalesce(v_row->>'quantity_unit','package')) returning id into v_id;
    else

      select row_version into v_version from public.pickup_records where id=v_id;
      if exists(select 1 from public.pickup_records where id=v_id and quantity_unit<>coalesce(v_row->>'quantity_unit','package')) then
        -- A correction keeps the original row, author, assignment, length and
        -- cost provenance. It is one UPDATE, so triggers see the final unit and
        -- quantity together; no delete/recreate or temporary quantity is used.
        if exists(select 1 from public.pickup_records p join public.inventory_items i on i.id=p.inventory_item_id
          where p.id=v_id and p.inventory_item_id=(v_row->>'inventory_item_id')::uuid
          and p.meters_per_unit_snapshot is distinct from i.meters_per_unit)
          then raise exception '此歷史單據的包裝長度與現行規格不同，不能直接切換計量單位。';end if;
        update public.pickup_records p set pickup_date=p_pickup_date,project_id=p_project_id,
          work_log_id=case when p.project_id=p_project_id or exists(select 1 from public.site_work_logs l join public.sites s on s.id=l.site_id
            where l.id=p.work_log_id and coalesce(l.project_id,s.project_id)=p_project_id) then p.work_log_id else null end,
          inventory_item_id=(v_row->>'inventory_item_id')::uuid,quantity=(v_row->>'quantity')::numeric,
          quantity_unit=coalesce(v_row->>'quantity_unit','package'),note=nullif(btrim(v_row->>'note'),''),source='web',updated_by=v_actor
          where p.id=v_id and p.row_version=v_version;
        if not found then raise exception '此取貨紀錄已被其他使用者更新，請重新載入。';end if;
      else
      perform public.update_pickup_record_v2(v_id,v_version,p_pickup_date,p_project_id,(v_row->>'inventory_item_id')::uuid,(v_row->>'quantity')::numeric,v_row->>'note',v_actor);
      end if;
    end if;
    v_ids:=array_append(v_ids,v_id);
  end loop;
  perform set_config('app.pickup_document_id',coalesce(v_context,''),true);
  return jsonb_build_object('document_id',p_document_id,'ids',v_ids,'saved',cardinality(v_ids));
end $function$;

-- CREATE OR REPLACE preserves existing service_role-only function grants.
notify pgrst,'reload schema';
commit;
