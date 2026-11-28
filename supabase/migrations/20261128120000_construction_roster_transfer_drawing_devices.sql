begin;
-- 工作管理第三版：設備轉移（主項目／子項目）與工程圖指定顯示設備。
-- 沿用既有清冊（construction_plans.drawing_points）、子項目指派與工程圖（site_assets），只新增一個欄位與兩個函式。

-- 1. 工程圖指定顯示的設備。null 代表沿用舊行為：顯示工程圖所屬規劃的全部設備。
alter table public.site_assets add column drawing_codes text[]
  check (drawing_codes is null or cardinality(drawing_codes)<=1000);

-- 2. 清冊移除設備時，同步移除工程圖的指定（圖上已有定位的設備本來就不能從清冊移除）。
create function public.prune_drawing_equipment_codes_v1() returns trigger
language plpgsql set search_path='' as $$
declare prior text:=current_setting('app.construction_drawing_plan_id',true);
begin
  if not exists(select from public.site_assets a where a.construction_plan_id=new.id and a.drawing_codes is not null
    and exists(select from unnest(a.drawing_codes) c where not exists(select from jsonb_array_elements(new.drawing_points) p where p->>'code'=c)))
    then return null; end if;
  perform set_config('app.construction_drawing_plan_id',new.id::text,true);
  update public.site_assets a
    set drawing_codes=array(select c from unnest(a.drawing_codes) with ordinality u(c,o)
        where exists(select from jsonb_array_elements(new.drawing_points) p where p->>'code'=u.c) order by u.o)
  where a.construction_plan_id=new.id and a.drawing_codes is not null
    and exists(select from unnest(a.drawing_codes) c where not exists(select from jsonb_array_elements(new.drawing_points) p where p->>'code'=c));
  perform set_config('app.construction_drawing_plan_id',coalesce(prior,''),true);
  return null;
end $$;
create trigger prune_drawing_equipment_codes after update of drawing_points on public.construction_plans
for each row when (old.drawing_points is distinct from new.drawing_points) execute function public.prune_drawing_equipment_codes_v1();

-- 3. 指定工程圖顯示的設備（例如 1F 平面圖只顯示 CAM10～CAM50）。codes=null 恢復顯示所屬規劃全部設備。
-- 權限與設定點位相同（工程圖上傳權限）；圖上已有定位的設備自動保留。
create function public.assign_construction_drawing_equipment_v1(p_actor_user_id uuid,p_asset_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare asset public.site_assets; owner_id uuid; plan public.construction_plans; codes text[]; blocked text; actor text; prior text;
begin
  select construction_plan_id into owner_id from public.site_assets where id=p_asset_id;
  if owner_id is null then raise exception '找不到工程圖。'; end if;
  select * into plan from public.construction_plans where id=owner_id and deleted_at is null for update;
  if not found then raise exception '找不到工程圖所屬的施工規劃。'; end if;
  perform public.construction_drawings_v1(p_actor_user_id,owner_id,true);
  select * into asset from public.site_assets where id=p_asset_id and construction_plan_id=owner_id and upload_status='uploaded' for update;
  if not found then raise exception '找不到工程圖。'; end if;
  if asset.row_version is distinct from (p_payload->>'row_version')::integer then raise exception '工程圖已變更，請重新讀取。'; end if;
  if p_payload->'codes' is null or p_payload->'codes'='null'::jsonb then codes:=null;
  else
    if jsonb_typeof(p_payload->'codes')<>'array' or jsonb_array_length(p_payload->'codes')>1000
      or exists(select from jsonb_array_elements(p_payload->'codes') c where jsonb_typeof(c)<>'string')
      or exists(select from jsonb_array_elements_text(p_payload->'codes') c group by lower(c) having count(*)>1)
      then raise exception '指定的設備編號格式錯誤或重複。'; end if;
    select string_agg(c,'、') into blocked from jsonb_array_elements_text(p_payload->'codes') c
      where not exists(select from jsonb_array_elements(plan.drawing_points) p where p->>'code'=c);
    if blocked is not null then raise exception '設備不在工程圖所屬規劃「%」的清冊內：%',plan.content,left(blocked,300); end if;
    codes:=array(select jsonb_array_elements_text(p_payload->'codes'));
    -- 圖上已有定位的設備一定顯示在這張圖。
    codes:=codes||array(select k from jsonb_object_keys(asset.drawing_markers) k where not (k=any(codes))
      and exists(select from jsonb_array_elements(plan.drawing_points) p where p->>'code'=k) order by k);
  end if;
  if asset.drawing_codes is not distinct from codes then return to_jsonb(asset); end if;
  select username into strict actor from public.app_users where id=p_actor_user_id and is_active;
  prior:=current_setting('app.construction_drawing_plan_id',true);
  perform set_config('app.construction_drawing_plan_id',owner_id::text,true);
  update public.site_assets set drawing_codes=codes,updated_by=actor where id=asset.id returning * into asset;
  perform set_config('app.construction_drawing_plan_id',coalesce(prior,''),true);
  return to_jsonb(asset);
end $$;

-- 4. 設備轉移：規劃錯誤時，把設備移到同案另一個施工主項目，或改到另一個子項目。
-- 一個交易內完成；沿用清冊儲存與子項目指派函式，保留其權限、版本、施工紀錄與定位檢查。
create function public.transfer_construction_equipment_v1(p_actor_user_id uuid,p_project_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare source public.construction_plans; target public.construction_plans; item public.construction_plan_items; other public.construction_plan_items;
  codes text[]; blocked text; moving jsonb; versions jsonb; scope jsonb; base text[]; item_key uuid:=nullif(p_payload->>'to_item_id','')::uuid;
begin
  if jsonb_typeof(p_payload->'codes') is distinct from 'array' or jsonb_array_length(p_payload->'codes') not between 1 and 1000
    or exists(select from jsonb_array_elements(p_payload->'codes') c where jsonb_typeof(c)<>'string')
    or exists(select from jsonb_array_elements_text(p_payload->'codes') c group by lower(c) having count(*)>1)
    then raise exception '請選擇要轉移的設備（1 至 1000 台，不可重複）。'; end if;
  codes:=array(select jsonb_array_elements_text(p_payload->'codes'));
  perform 1 from public.projects where id=p_project_id and deleted_at is null for update;
  if not found then raise exception '找不到施工工作內容。'; end if;
  perform 1 from public.construction_plans where project_id=p_project_id and deleted_at is null order by id for update;
  select * into source from public.construction_plans where id=nullif(p_payload->>'from_plan_id','')::uuid and project_id=p_project_id and deleted_at is null;
  select * into target from public.construction_plans where id=nullif(p_payload->>'to_plan_id','')::uuid and project_id=p_project_id and deleted_at is null;
  if source.id is null or target.id is null then raise exception '施工主項目不屬於此案或已刪除。'; end if;
  scope:=public.construction_scope_v1(p_actor_user_id,p_project_id)->'construction_plans';
  if exists(select from unnest(array[source.id,target.id]) k where not exists(select from jsonb_array_elements(scope) v where v->>'id'=k::text and (v->>'can_manage')::boolean))
    then raise exception '轉移需要來源與目標施工主項目的清冊管理權限。'; end if;
  select string_agg(c,'、') into blocked from unnest(codes) c where not exists(select from jsonb_array_elements(source.drawing_points) p where p->>'code'=c);
  if blocked is not null then raise exception '設備不在「%」清冊內：%',source.content,left(blocked,300); end if;
  if item_key is not null then
    select * into item from public.construction_plan_items where id=item_key and construction_plan_id=target.id and deleted_at is null;
    if not found then raise exception '目標子項目須屬於目標施工主項目。'; end if;
  end if;

  if source.id<>target.id then
    select string_agg(distinct e->>'code','、') into blocked from public.site_work_logs l cross join lateral jsonb_array_elements(l.equipment_progress) e
      where l.construction_plan_id=source.id and e->>'code'=any(codes);
    if blocked is not null then raise exception '已有施工紀錄的設備不能轉移到其他主項目：%',left(blocked,300); end if;
    select string_agg(distinct k,'、') into blocked from public.site_assets a cross join lateral jsonb_object_keys(a.drawing_markers) k
      where a.construction_plan_id=source.id and a.upload_status='uploaded' and k=any(codes);
    if blocked is not null then raise exception '請先移除「%」工程圖上的定位，再轉移：%',source.content,left(blocked,300); end if;
    select string_agg(o->>'code','、') into blocked from jsonb_array_elements(target.drawing_points) o
      where exists(select from unnest(codes) c where lower(c)=lower(o->>'code') and c<>o->>'code');
    if blocked is not null then raise exception '「%」已有大小寫不同的相同編號：%',target.content,left(blocked,300); end if;
    select coalesce(jsonb_agg(p order by ord),'[]') into moving from jsonb_array_elements(source.drawing_points) with ordinality t(p,ord)
      where p->>'code'=any(codes) and not exists(select from jsonb_array_elements(target.drawing_points) o where o->>'code'=p->>'code');
    if jsonb_array_length(target.drawing_points)+jsonb_array_length(moving)>1000 then raise exception '「%」超過 1000 台設備。',target.content; end if;
    select jsonb_object_agg(id::text,row_version) into versions from public.construction_plans where project_id=p_project_id and deleted_at is null;
    perform public.save_construction_roster_v1(p_actor_user_id,target.id,jsonb_build_object('points',target.drawing_points||moving,'versions',versions));
    select jsonb_object_agg(id::text,row_version) into versions from public.construction_plans where project_id=p_project_id and deleted_at is null;
    select * into strict source from public.construction_plans where id=source.id;
    perform public.save_construction_roster_v1(p_actor_user_id,source.id,jsonb_build_object('versions',versions,'points',
      coalesce((select jsonb_agg(p order by ord) from jsonb_array_elements(source.drawing_points) with ordinality t(p,ord) where not (p->>'code'=any(codes))),'[]')));
  else
    if item_key is null then raise exception '同一主項目內轉移，請選擇目標子項目。'; end if;
    -- 從本規劃其他子項目移出（已有施工紀錄者由指派函式拒絕），再加入目標子項目。
    for other in select * from public.construction_plan_items where construction_plan_id=source.id and deleted_at is null and id<>item_key
      and equipment_codes is not null and equipment_codes && codes order by sort_order,id loop
      perform public.assign_construction_item_equipment_v1(p_actor_user_id,other.id,jsonb_build_object('row_version',other.row_version,
        'codes',to_jsonb(array(select c from unnest(other.equipment_codes) with ordinality u(c,o) where not (c=any(codes)) order by o))));
    end loop;
  end if;

  if item_key is not null then
    select * into strict item from public.construction_plan_items where id=item_key;
    base:=coalesce(item.equipment_codes,array(select distinct e->>'code' from public.site_work_logs l cross join lateral jsonb_array_elements(l.equipment_progress) e
      where l.construction_plan_id=target.id and e->>'item'=item.id::text));
    perform public.assign_construction_item_equipment_v1(p_actor_user_id,item.id,jsonb_build_object('row_version',item.row_version,
      'codes',to_jsonb(base||array(select c from unnest(codes) c where not (c=any(base))))));
  end if;
  return jsonb_build_object('moved',cardinality(codes),'from_plan_id',source.id,'to_plan_id',target.id,'to_item_id',item_key);
end $$;

revoke all on function public.prune_drawing_equipment_codes_v1(),public.assign_construction_drawing_equipment_v1(uuid,uuid,jsonb),
  public.transfer_construction_equipment_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.assign_construction_drawing_equipment_v1(uuid,uuid,jsonb),public.transfer_construction_equipment_v1(uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
