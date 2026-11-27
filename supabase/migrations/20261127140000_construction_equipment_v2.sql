begin;
-- 工作管理第二版：設備清冊沿用各施工規劃的 drawing_points（同案同編號即同一設備），
-- 只擴充欄位、子項目指派、批次建立及工程圖管理；既有函式以包裝方式延伸。

-- 1. 子項目指派的設備編號。null 表示沿用舊行為：本規劃清冊全部設備都適用此子項目。
alter table public.construction_plan_items add column equipment_codes text[]
  check (equipment_codes is null or cardinality(equipment_codes)<=1000);

-- 2. 工程圖分類（建築物／樓層／區域）。工程類型沿用既有 contract_service_type_id。
alter table public.site_assets add column drawing_category jsonb not null default '{}'
  check (jsonb_typeof(drawing_category)='object');

-- 3. 設備欄位：類型、型號、建築物、備註，與名稱一樣為選填文字；舊版用戶端未送出時保留原值。
do $upgrade$
declare original text; revised text;
begin
  original:=pg_get_functiondef('public.apply_plan_drawing_points_v1()'::regprocedure);
  revised:=replace(original,$old$(p-'code'-'location'-'name')<>'{}'::jsonb$old$,
    $new$exists(select from jsonb_each(p-'code'-'location') f where f.key not in ('name','type','model','building','note')
        or jsonb_typeof(f.value) is distinct from 'string'
        or length(f.value#>>'{}')>case when f.key='note' then 500 else 160 end
        or (f.value#>>'{}') ~ '[[:cntrl:]]')$new$);
  if original=revised then raise exception 'Unexpected point validator'; end if;
  original:=revised;
  revised:=regexp_replace(original,
    $old$case when not point \? 'name' and old_point \? 'name'\s+then point\|\|jsonb_build_object\('name',old_point->'name'\) else point end$old$,
    $new$point||coalesce((select jsonb_object_agg(k,old_point->k) from unnest(array['name','type','model','building','note']) k
        where not point ? k and old_point ? k),'{}'::jsonb)$new$);
  if original=revised then raise exception 'Unexpected point retention'; end if;
  execute revised;
end $upgrade$;

-- 4. 清冊移除設備時，同步移除子項目指派（已有施工紀錄的設備本來就不能移除）。
create function public.prune_item_equipment_codes_v1() returns trigger
language plpgsql set search_path='' as $$
begin
  update public.construction_plan_items i
    set equipment_codes=array(select c from unnest(i.equipment_codes) with ordinality u(c,o)
        where exists(select from jsonb_array_elements(new.drawing_points) p where p->>'code'=u.c) order by u.o),
      updated_at=now(),row_version=row_version+1
  where i.construction_plan_id=new.id and i.deleted_at is null and i.equipment_codes is not null
    and exists(select from unnest(i.equipment_codes) c where not exists(select from jsonb_array_elements(new.drawing_points) p where p->>'code'=c));
  return null;
end $$;
create trigger prune_item_equipment_codes after update of drawing_points on public.construction_plans
for each row when (old.drawing_points is distinct from new.drawing_points) execute function public.prune_item_equipment_codes_v1();

-- 5. 清冊儲存：名稱以外的設備基本資料（類型、型號、建築物、備註）也依編號同步本案其他規劃。
create or replace function public.save_construction_roster_v1(p_actor_user_id uuid,p_plan_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  project_key uuid; selected public.construction_plans; sibling public.construction_plans;
  scope jsonb; permissions jsonb; points jsonb:=p_payload->'points'; renames jsonb; revised jsonb;
  previous_context text:=current_setting('app.plan_drawing_points',true); actor_name text; affected integer:=0;
begin
  select project_id into strict project_key from public.construction_plans where id=p_plan_id and deleted_at is null;
  scope:=public.construction_scope_v1(p_actor_user_id,project_key)->'construction_plans';
  if not exists(select from jsonb_array_elements(scope) v where v->>'id'=p_plan_id::text and (v->>'can_manage')::boolean)
    then raise exception '沒有管理設備清冊的權限。'; end if;
  if jsonb_typeof(points) is distinct from 'array' or jsonb_array_length(points)>1000
    then raise exception '清冊格式錯誤或超過 1000 筆。'; end if;
  perform 1 from public.projects where id=project_key for update;
  perform 1 from public.construction_plans where project_id=project_key and deleted_at is null order by id for update;
  select * into strict selected from public.construction_plans where id=p_plan_id and deleted_at is null;
  scope:=public.construction_scope_v1(p_actor_user_id,project_key)->'construction_plans';
  if selected.row_version is distinct from (p_payload->'versions'->>p_plan_id::text)::integer
    then raise exception '清冊已變更，請重新開啟後核對。'; end if;
  select coalesce(jsonb_object_agg(x.code,x.changes),'{}') into renames from (
    select p->>'code' code,(select jsonb_object_agg(k,p->k) from unnest(array['name','type','model','building','note']) k
      where p ? k and p->k is distinct from oldp->k) changes
    from jsonb_array_elements(points) p left join jsonb_array_elements(selected.drawing_points) oldp on oldp->>'code'=p->>'code'
    where p->>'code' is not null) x where x.changes is not null;
  if exists(select from public.site_assets a cross join lateral jsonb_object_keys(a.drawing_markers) as k(code)
    where a.construction_plan_id=p_plan_id and a.upload_status='uploaded'
    and exists(select from jsonb_array_elements(selected.drawing_points) oldp where oldp->>'code'=k.code)
    and not exists(select from jsonb_array_elements(points) p where p->>'code'=k.code))
    then raise exception '請先移除工程圖上的定位，再刪除該設備。'; end if;
  select username into strict actor_name from public.app_users where id=p_actor_user_id and is_active;
  for sibling in select * from public.construction_plans where project_id=project_key and deleted_at is null order by id loop
    if sibling.id=p_plan_id then revised:=points;
    else
      if not exists(select from jsonb_array_elements(sibling.drawing_points) p where renames ? (p->>'code')) then continue; end if;
      select jsonb_agg(case when renames ? (p->>'code') then p||(renames->(p->>'code')) else p end order by ord)
        into revised from jsonb_array_elements(sibling.drawing_points) with ordinality t(p,ord);
    end if;
    if revised=sibling.drawing_points then continue; end if;
    select v into permissions from jsonb_array_elements(scope) v where v->>'id'=sibling.id::text;
    if not coalesce((permissions->>'can_manage')::boolean,false) then raise exception '此變更需要相關施工規劃的管理權限。'; end if;
    if sibling.row_version is distinct from (p_payload->'versions'->>sibling.id::text)::integer then raise exception '相關規劃已變更，請重新開啟後核對。'; end if;
    perform set_config('app.plan_drawing_points',jsonb_build_object('id',sibling.id,'points',revised)::text,true);
    update public.construction_plans set drawing_points=revised,row_version=row_version+1,updated_at=now() where id=sibling.id;
    insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values ('construction_plans',sibling.id,'update',jsonb_build_object('drawing_points',sibling.drawing_points),jsonb_build_object('drawing_points',revised),'web',actor_name);
    affected:=affected+1;
  end loop;
  perform set_config('app.plan_drawing_points',coalesce(previous_context,''),true);
  return jsonb_build_object('plan_count',affected);
end $$;

-- 6. 將設備指派到施工子項目。codes=null 代表取消指派、恢復適用本規劃全部設備。
create function public.assign_construction_item_equipment_v1(p_actor_user_id uuid,p_item_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare item public.construction_plan_items; plan public.construction_plans; visible jsonb; codes text[]; blocked text; actor text;
begin
  select * into item from public.construction_plan_items where id=p_item_id and deleted_at is null;
  if not found then raise exception '找不到施工子項目。'; end if;
  select * into strict plan from public.construction_plans where id=item.construction_plan_id and deleted_at is null;
  perform 1 from public.projects where id=plan.project_id for update;
  select * into strict plan from public.construction_plans where id=item.construction_plan_id for update;
  select * into strict item from public.construction_plan_items where id=p_item_id for update;
  if item.deleted_at is not null then raise exception '找不到施工子項目。'; end if;
  select value into visible from jsonb_array_elements(public.construction_scope_v1(p_actor_user_id,plan.project_id)->'construction_plans') where value->>'id'=plan.id::text;
  if not coalesce((visible->>'can_manage')::boolean,false) then raise exception '沒有管理設備清冊的權限。'; end if;
  if item.row_version is distinct from (p_payload->>'row_version')::integer then raise exception '子項目已變更，請重新開啟後再指派。'; end if;
  if p_payload->'codes' is null or p_payload->'codes'='null'::jsonb then codes:=null;
  else
    if jsonb_typeof(p_payload->'codes')<>'array' or jsonb_array_length(p_payload->'codes')>1000
      or exists(select from jsonb_array_elements(p_payload->'codes') c where jsonb_typeof(c)<>'string')
      or exists(select from jsonb_array_elements_text(p_payload->'codes') c group by lower(c) having count(*)>1)
      then raise exception '指派的設備編號格式錯誤或重複。'; end if;
    select string_agg(c,'、') into blocked from jsonb_array_elements_text(p_payload->'codes') c
      where not exists(select from jsonb_array_elements(plan.drawing_points) p where p->>'code'=c);
    if blocked is not null then raise exception '設備不在本施工規劃清冊內：%',blocked; end if;
    codes:=array(select jsonb_array_elements_text(p_payload->'codes'));
  end if;
  select string_agg(distinct e->>'code','、') into blocked from public.site_work_logs l cross join lateral jsonb_array_elements(l.equipment_progress) e
    where l.construction_plan_id=plan.id and e->>'item'=item.id::text and codes is not null and not (e->>'code'=any(codes));
  if blocked is not null then raise exception '已有施工紀錄的設備不能從此子項目移除：%',blocked; end if;
  if item.equipment_codes is not distinct from codes then return to_jsonb(item); end if;
  select username into strict actor from public.app_users where id=p_actor_user_id and is_active;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
    values('construction_plan_items',item.id,'update',jsonb_build_object('equipment_codes',to_jsonb(item.equipment_codes)),jsonb_build_object('equipment_codes',to_jsonb(codes)),'web',actor);
  update public.construction_plan_items set equipment_codes=codes,row_version=row_version+1,updated_at=now() where id=item.id returning * into item;
  return to_jsonb(item);
end $$;

-- 7. 系統批次建立設備：同一交易加入一或多筆施工規劃，可同時指派到一個子項目。
create function public.batch_construction_roster_v1(p_actor_user_id uuid,p_project_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare plan_key uuid; target public.construction_plans; versions jsonb; duplicate text; plan_count integer:=0;
  incoming jsonb:=p_payload->'points'; item public.construction_plan_items; assigned jsonb;
begin
  if jsonb_typeof(p_payload->'plans') is distinct from 'array' or jsonb_array_length(p_payload->'plans') not between 1 and 50
    then raise exception '請選擇要加入的施工規劃。'; end if;
  if jsonb_typeof(incoming) is distinct from 'array' or jsonb_array_length(incoming) not between 1 and 1000
    then raise exception '每次可建立 1 至 1000 筆設備。'; end if;
  if exists(select from jsonb_array_elements(incoming) n group by lower(n->>'code') having count(*)>1)
    then raise exception '批次設備編號重複。'; end if;
  perform 1 from public.projects where id=p_project_id and deleted_at is null for update;
  if not found then raise exception '找不到施工工作內容。'; end if;
  for plan_key in select distinct (value#>>'{}')::uuid from jsonb_array_elements(p_payload->'plans') loop
    select * into target from public.construction_plans where id=plan_key and project_id=p_project_id and deleted_at is null for update;
    if not found then raise exception '施工規劃不屬於此案或已刪除。'; end if;
    if target.row_version is distinct from (p_payload->'versions'->>plan_key::text)::integer
      then raise exception '「%」已變更，請重新開啟後再建立。',target.content; end if;
    select string_agg(o->>'code','、') into duplicate from jsonb_array_elements(target.drawing_points) o
      where exists(select from jsonb_array_elements(incoming) n where lower(n->>'code')=lower(o->>'code'));
    if duplicate is not null then raise exception '「%」已有相同設備編號：%',target.content,left(duplicate,300); end if;
  end loop;
  for plan_key in select distinct (value#>>'{}')::uuid from jsonb_array_elements(p_payload->'plans') loop
    select * into strict target from public.construction_plans where id=plan_key;
    select jsonb_object_agg(id::text,row_version) into versions from public.construction_plans where project_id=p_project_id and deleted_at is null;
    perform public.save_construction_roster_v1(p_actor_user_id,plan_key,jsonb_build_object('points',target.drawing_points||incoming,'versions',versions));
    plan_count:=plan_count+1;
  end loop;
  if p_payload ? 'assign_item_id' and nullif(p_payload->>'assign_item_id','') is not null then
    select * into item from public.construction_plan_items where id=(p_payload->>'assign_item_id')::uuid and deleted_at is null;
    if not found or not exists(select from jsonb_array_elements_text(p_payload->'plans') p where p=item.construction_plan_id::text)
      then raise exception '指派的子項目須屬於所選施工規劃。'; end if;
    -- 由「適用全部」改為指定設備時，保留已有施工紀錄的設備，避免歷史進度失去對應。
    assigned:=to_jsonb(coalesce(item.equipment_codes,array(select distinct e->>'code' from public.site_work_logs l
      cross join lateral jsonb_array_elements(l.equipment_progress) e where l.construction_plan_id=item.construction_plan_id and e->>'item'=item.id::text)))
      ||(select jsonb_agg(n->'code') from jsonb_array_elements(incoming) n);
    perform public.assign_construction_item_equipment_v1(p_actor_user_id,item.id,jsonb_build_object('row_version',item.row_version,'codes',assigned));
  end if;
  return jsonb_build_object('plan_count',plan_count,'point_count',jsonb_array_length(incoming));
end $$;

-- 8. 日誌填報只能選擇已指派至該子項目的設備；保留舊日誌已存在的紀錄。
alter function public.save_construction_work_log_v1(uuid,uuid,jsonb) rename to save_construction_log_before_assignment_v1;
create function public.save_construction_work_log_v1(p_actor_user_id uuid,p_plan_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare prior jsonb; blocked text;
begin
  if jsonb_typeof(p_payload->'equipment_progress')='array' then
    select equipment_progress into prior from public.site_work_logs where id=(p_payload->>'id')::uuid and construction_plan_id=p_plan_id;
    select string_agg(distinct e->>'code','、') into blocked from jsonb_array_elements(p_payload->'equipment_progress') e
      join public.construction_plan_items i on i.id::text=e->>'item' and i.construction_plan_id=p_plan_id
      where i.equipment_codes is not null and not (e->>'code'=any(i.equipment_codes))
        and not exists(select from jsonb_array_elements(coalesce(prior,'[]')) pe where pe->>'code'=e->>'code' and pe->>'item'=e->>'item');
    if blocked is not null then raise exception '設備未指派至所選子項目：%。請先在施工規劃清冊指派。',blocked; end if;
  end if;
  return public.save_construction_log_before_assignment_v1(p_actor_user_id,p_plan_id,p_payload);
end $$;

-- 9. 工程圖名稱、說明、分類修改與封存（不刪除 NAS 原檔；封存後點位資料仍保留於原列）。
create function public.manage_construction_drawing_v1(p_actor_user_id uuid,p_asset_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare asset public.site_assets; owner_id uuid; actor text; prior text; category jsonb:=coalesce(p_payload->'category','{}'); service uuid;
begin
  select construction_plan_id into owner_id from public.site_assets where id=p_asset_id;
  if owner_id is null then raise exception '找不到工程圖。'; end if;
  perform 1 from public.construction_plans where id=owner_id for update;
  perform public.construction_drawings_v1(p_actor_user_id,owner_id,true);
  select * into strict asset from public.site_assets where id=p_asset_id and construction_plan_id=owner_id and upload_status='uploaded' for update;
  if asset.row_version is distinct from (p_payload->>'row_version')::integer then raise exception '工程圖已變更，請重新讀取。'; end if;
  select username into strict actor from public.app_users where id=p_actor_user_id and is_active;
  prior:=current_setting('app.construction_drawing_plan_id',true);
  perform set_config('app.construction_drawing_plan_id',owner_id::text,true);
  if p_payload->>'action'='archive' then
    if asset.drawing_markers<>'{}' and coalesce((p_payload->>'confirm_markers')::boolean,false) is not true
      then raise exception '此工程圖已有 % 個設備點位，請確認後再刪除。',(select count(*) from jsonb_object_keys(asset.drawing_markers)); end if;
    update public.site_assets set upload_status='archived',updated_by=actor,updated_at=statement_timestamp() where id=asset.id returning * into asset;
  elsif p_payload->>'action'='update' then
    if nullif(btrim(p_payload->>'title'),'') is null or length(p_payload->>'title')>200 or length(coalesce(p_payload->>'description',''))>1000
      then raise exception '請填寫工程圖名稱（200 字內），說明 1000 字內。'; end if;
    if jsonb_typeof(category)<>'object' or exists(select from jsonb_each(category) f where f.key not in ('building','floor','area')
      or jsonb_typeof(f.value)<>'string' or length(f.value#>>'{}')>80 or (f.value#>>'{}') ~ '[[:cntrl:]]')
      then raise exception '工程圖分類格式錯誤。'; end if;
    service:=nullif(p_payload->>'contract_service_type_id','')::uuid;
    if service is not null and not exists(select from public.contract_service_types s where s.id=service and s.is_active)
      then raise exception '工程類型不存在或已停用。'; end if;
    update public.site_assets set title=btrim(p_payload->>'title'),description=nullif(btrim(coalesce(p_payload->>'description','')),''),
      drawing_category=(select coalesce(jsonb_object_agg(key,to_jsonb(btrim(value#>>'{}'))),'{}') from jsonb_each(category) where btrim(value#>>'{}')<>''),
      contract_service_type_id=coalesce(service,contract_service_type_id),updated_by=actor,updated_at=statement_timestamp()
      where id=asset.id returning * into asset;
  else raise exception '不支援的工程圖操作。'; end if;
  perform set_config('app.construction_drawing_plan_id',coalesce(prior,''),true);
  return to_jsonb(asset);
end $$;

revoke all on function public.prune_item_equipment_codes_v1(),public.assign_construction_item_equipment_v1(uuid,uuid,jsonb),
  public.batch_construction_roster_v1(uuid,uuid,jsonb),public.save_construction_work_log_v1(uuid,uuid,jsonb),
  public.save_construction_log_before_assignment_v1(uuid,uuid,jsonb),public.manage_construction_drawing_v1(uuid,uuid,jsonb),
  public.save_construction_roster_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.assign_construction_item_equipment_v1(uuid,uuid,jsonb),public.batch_construction_roster_v1(uuid,uuid,jsonb),
  public.save_construction_work_log_v1(uuid,uuid,jsonb),public.manage_construction_drawing_v1(uuid,uuid,jsonb),
  public.save_construction_roster_v1(uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
