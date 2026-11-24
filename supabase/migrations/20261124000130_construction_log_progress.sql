begin;

-- Points belong to a drawing/plan, including planned equipment not yet in the asset registry.
-- Each log records its own observations. Current cell states are derived, so correcting
-- or archiving a log never leaves orphaned progress or double-counted attendance.
alter table public.construction_plans add column drawing_points jsonb not null default '[]';
alter table public.site_work_logs
  add column construction_item_ids uuid[],
  add column equipment_progress jsonb not null default '[]';

create function public.apply_plan_drawing_points_v1() returns trigger
language plpgsql set search_path='' as $$
declare context jsonb:=nullif(current_setting('app.plan_drawing_points',true),'')::jsonb;
  points jsonb:=context->'points';
begin
  if context->>'id' is distinct from new.id::text or points is null then return new; end if;
  if jsonb_typeof(points)<>'array' or jsonb_array_length(points)>1000 then raise exception '每筆施工規劃最多 1000 個設備編號。'; end if;
  if exists(select 1 from jsonb_array_elements(points) p where jsonb_typeof(p->'code') is distinct from 'string'
      or length(btrim(p->>'code')) not between 1 and 80 or p->>'code'<>btrim(p->>'code')
      or jsonb_typeof(p->'location') is distinct from 'string' or length(p->>'location')>160
      or (p->>'code') ~ '[[:cntrl:]]' or (p->>'location') ~ '[[:cntrl:]]'
      or (p-'code'-'location')<>'{}'::jsonb)
    or exists(select 1 from jsonb_array_elements(points) p group by lower(p->>'code') having count(*)>1)
    then raise exception '設備編號格式錯誤或重複。'; end if;
  if tg_op='UPDATE' and old.drawing_points is distinct from points and exists(
    select 1 from public.site_work_logs l cross join lateral jsonb_array_elements(l.equipment_progress) e
    where l.construction_plan_id=new.id and not exists(select from jsonb_array_elements(points) p where p->>'code'=e->>'code')
  ) then raise exception '已有施工紀錄的設備編號必須保留。'; end if;
  new.drawing_points:=points;
  return new;
end $$;
create trigger construction_plan_drawing_points before insert or update on public.construction_plans
for each row execute function public.apply_plan_drawing_points_v1();

alter function public.save_construction_plan_v1(uuid,jsonb,boolean) rename to save_construction_plan_before_points_v1;
create function public.save_construction_plan_v1(p_actor_user_id uuid,p_payload jsonb,p_delete boolean default false)
returns jsonb language plpgsql set search_path='' as $$
declare result jsonb;
begin
  if not p_delete and p_payload ? 'drawing_points' then
    perform set_config('app.plan_drawing_points',jsonb_build_object('id',p_payload->'id','points',p_payload->'drawing_points')::text,true);
  end if;
  result:=public.save_construction_plan_before_points_v1(p_actor_user_id,p_payload,p_delete);
  perform set_config('app.plan_drawing_points','',true);
  return result;
end $$;

-- The existing writer sets the authorized plan and primary item before this trigger.
-- Limit context to the target row: the workforce writer can also update earlier logs.
create function public.apply_log_progress_v1() returns trigger language plpgsql set search_path='' as $$
declare ctx jsonb:=nullif(current_setting('app.log_progress',true),'')::jsonb;
begin
  if ctx is null or new.construction_plan_id::text is distinct from ctx->>'plan'
    or not ((tg_op='INSERT' and ctx->>'id' is null) or new.id::text=ctx->>'id') then return new; end if;
  new.construction_item_ids:=array(select jsonb_array_elements_text(ctx->'items')::uuid);
  new.equipment_progress:=ctx->'progress';
  return new;
end $$;
create trigger zz_construction_log_progress before insert or update on public.site_work_logs
for each row execute function public.apply_log_progress_v1();

alter function public.save_construction_work_log_v1(uuid,uuid,jsonb) rename to save_construction_log_before_progress_v1;
create function public.save_construction_work_log_v1(p_actor_user_id uuid,p_plan_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare log_id uuid:=(p_payload->>'id')::uuid; prior public.site_work_logs; plan public.construction_plans;
  items uuid[]; primary_item uuid; progress jsonb; result jsonb;
begin
  perform public.assert_construction_log_access_v1(p_actor_user_id,p_plan_id,log_id,case when log_id is null then 'CREATE' else 'UPDATE' end);
  select * into plan from public.construction_plans where id=p_plan_id;
  select * into prior from public.site_work_logs where id=log_id;
  primary_item:=case when p_payload ? 'construction_item_id' then (p_payload->>'construction_item_id')::uuid else prior.construction_item_id end;
  if p_payload ? 'construction_item_ids' then
    items:=array(select jsonb_array_elements_text(p_payload->'construction_item_ids')::uuid);
  elsif prior.construction_plan_id=p_plan_id and primary_item is not distinct from prior.construction_item_id then
    items:=coalesce(prior.construction_item_ids,array_remove(array[primary_item],null));
  else items:=array_remove(array[primary_item],null);
  end if;
  if cardinality(items)>100 or (select count(distinct id) from unnest(items) id)<>cardinality(items)
    or exists(select 1 from unnest(items) selected(item_id) where not exists(select from public.construction_plan_items i where i.id=selected.item_id and i.construction_plan_id=p_plan_id and i.deleted_at is null))
    then raise exception '請選擇同一施工規劃內的有效子項目。'; end if;
  progress:=coalesce(p_payload->'equipment_progress',case when prior.construction_plan_id=p_plan_id then prior.equipment_progress end,'[]');
  if progress is distinct from coalesce(prior.equipment_progress,'[]') or
    (prior.construction_plan_id is distinct from p_plan_id and prior.equipment_progress<>'[]') then
    if not public.construction_item_access_v1(p_actor_user_id,p_plan_id)
       or (prior.construction_plan_id is distinct from p_plan_id and prior.equipment_progress<>'[]' and not public.construction_item_access_v1(p_actor_user_id,prior.construction_plan_id))
       then raise exception '沒有更新設備施工進度的權限。'; end if;
  end if;
  if jsonb_typeof(progress)<>'array' or jsonb_array_length(progress)>2000 or exists(
    select 1 from jsonb_array_elements(progress) e where
      not exists(select from jsonb_array_elements(plan.drawing_points) p where p->>'code'=e->>'code')
      or not exists(select from unnest(items) i where i::text=e->>'item')
      or coalesce(e->>'status','') not in ('pending','working','done','na')
      or (e-'code'-'item'-'status')<>'{}'::jsonb
  ) or exists(select from jsonb_array_elements(progress) e group by e->>'item',e->>'code' having count(*)>1)
    then raise exception '請確認設備編號、今日施作子項目與進度，每格只能填報一次。'; end if;
  p_payload:=p_payload||jsonb_build_object('construction_item_id',items[1]);
  perform set_config('app.log_progress',jsonb_build_object('id',log_id,'plan',p_plan_id,'items',items,'progress',progress)::text,true);
  result:=public.save_construction_log_before_progress_v1(p_actor_user_id,p_plan_id,p_payload);
  perform set_config('app.log_progress','',true);
  if coalesce(nullif(result#>'{work_log,construction_item_ids}','null'),to_jsonb(array_remove(array[(result#>>'{work_log,construction_item_id}')::uuid],null)))<>to_jsonb(items)
    or coalesce(result#>'{work_log,equipment_progress}','[]')<>progress then raise exception '日誌內容與先前送出的識別碼不符，請重新讀取。'; end if;
  return result;
end $$;

create function public.keep_used_construction_item_v1() returns trigger language plpgsql set search_path='' as $$
begin
  if exists(select from public.site_work_logs l where l.construction_plan_id=new.construction_plan_id and new.id=any(l.construction_item_ids))
    then raise exception '已有日誌的子項目須保留。'; end if;
  return new;
end $$;
create trigger keep_used_construction_item before update of deleted_at on public.construction_plan_items
for each row when (old.deleted_at is null and new.deleted_at is not null) execute function public.keep_used_construction_item_v1();

-- Retain all existing visibility and cost predicates in both released projections.
do $migration$
declare func regprocedure; original text; revised text;
begin
  foreach func in array array['public.construction_scope_v1(uuid,uuid)'::regprocedure,
     'public.work_content_report_v1(uuid,uuid,date,date,text,boolean)'::regprocedure] loop
    original:=pg_get_functiondef(func);
    revised:=replace(original,'l.construction_item_id=i.id','i.id=any(coalesce(l.construction_item_ids,array[l.construction_item_id]))');
    if revised=original then raise exception 'Unexpected construction projection: %',func; end if;
    if func='public.construction_scope_v1(uuid,uuid)'::regprocedure then
      if strpos(revised,'''items'',items,''worked_days'',days')=0 then raise exception 'Unexpected plan projection'; end if;
      revised:=replace(revised,'''items'',items,''worked_days'',days',$fragment$
        'equipment_state',coalesce((select jsonb_agg(cell) from (
          select distinct on (e->>'code',e->>'item') e || case when public.construction_log_visible_v1(p_actor_user_id,l)
            then jsonb_build_object('log_id',l.id,'log_date',l.log_date) else '{}'::jsonb end as cell
          from logs l cross join lateral jsonb_array_elements(l.equipment_progress) e
          where l.construction_plan_id=(p->>'id')::uuid
          order by e->>'code',e->>'item',l.log_date desc,l.created_at desc,l.id desc
        ) latest),'[]'::jsonb),'items',items,'worked_days',days$fragment$);
    end if;
    execute revised;
  end loop;
end $migration$;

revoke all on function public.apply_plan_drawing_points_v1(),public.apply_log_progress_v1(),public.keep_used_construction_item_v1(),
  public.save_construction_work_log_v1(uuid,uuid,jsonb),public.save_construction_plan_v1(uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.save_construction_work_log_v1(uuid,uuid,jsonb),public.save_construction_plan_v1(uuid,jsonb,boolean) to service_role;
notify pgrst,'reload schema';
commit;
