begin;
alter table public.site_assets add column drawing_markers jsonb not null default '{}';

create function public.clear_replaced_drawing_markers_v1() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.sha256 is distinct from old.sha256 then new.drawing_markers := '{}'; end if;
  return new;
end $$;
create trigger clear_replaced_drawing_markers before update of sha256 on public.site_assets
for each row execute function public.clear_replaced_drawing_markers_v1();

create function public.save_construction_drawing_marker_v1(p_actor_user_id uuid,p_asset_id uuid,p_sha256 text,p_code text,p_expected jsonb,p_position jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare asset public.site_assets; owner_id uuid; actor text; prior text; anchor jsonb;
begin
  select construction_plan_id into owner_id from public.site_assets where id=p_asset_id;
  perform 1 from public.construction_plans where id=owner_id for update;
  perform public.construction_drawings_v1(p_actor_user_id,owner_id,true);
  select * into strict asset from public.site_assets where id=p_asset_id and construction_plan_id=owner_id and upload_status='uploaded' for update;
  if asset.sha256 is distinct from p_sha256 or lower(asset.original_name) !~ '\.(jpeg|jpg|png|webp)$' then
    raise exception '工程圖已變更或格式不支援，請重新開啟。';
  end if;
  if not exists(select 1 from public.construction_plans p cross join lateral jsonb_array_elements(p.drawing_points) pt where p.id=owner_id and pt->>'code'=p_code) then
    raise exception '設備編號不在工程圖所屬規劃的清冊內。';
  end if;
  -- Existing x/y identifies the icon. A numbered label can be set independently.
  if p_position is not null then
    if jsonb_typeof(p_position) is distinct from 'object' or p_position = '{}'
        or (p_position-'x'-'y'-'label') <> '{}' then raise exception '點位格式不正確。'; end if;
    for anchor in
      select p_position-'label' where p_position ?| array['x','y']
      union all select p_position->'label' where p_position ? 'label'
    loop
      if jsonb_typeof(anchor) is distinct from 'object' or jsonb_typeof(anchor->'x') is distinct from 'number'
          or jsonb_typeof(anchor->'y') is distinct from 'number' then raise exception '點位座標格式不正確。'; end if;
      if (anchor-'x'-'y') <> '{}' or (anchor->>'x')::numeric not between 0 and 1
          or (anchor->>'y')::numeric not between 0 and 1 then raise exception '點位必須在工程圖範圍內。'; end if;
    end loop;
  end if;
  if asset.drawing_markers->p_code is not distinct from p_position then return asset.drawing_markers; end if;
  if asset.drawing_markers->p_code is distinct from p_expected then raise exception '其他人已變更點位，請重新讀取工程圖。'; end if;
  select username into strict actor from public.app_users where id=p_actor_user_id and is_active;
  prior:=current_setting('app.construction_drawing_plan_id',true);
  perform set_config('app.construction_drawing_plan_id',owner_id::text,true);
  update public.site_assets set drawing_markers=case when p_position is null then drawing_markers-p_code else jsonb_set(drawing_markers,array[p_code],p_position) end,
    updated_by=actor,updated_at=statement_timestamp(),row_version=row_version+1 where id=p_asset_id returning * into asset;
  perform set_config('app.construction_drawing_plan_id',coalesce(prior,''),true);
  return asset.drawing_markers;
end $$;
revoke all on function public.save_construction_drawing_marker_v1(uuid,uuid,text,text,jsonb,jsonb),public.clear_replaced_drawing_markers_v1() from public,anon,authenticated;
grant execute on function public.save_construction_drawing_marker_v1(uuid,uuid,text,text,jsonb,jsonb) to service_role;
commit;
