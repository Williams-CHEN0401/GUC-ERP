begin;
-- The plan remains the owner of its point list. A name edit follows the same
-- stable code through this project, without replacing another plan's locations.
create function public.save_construction_roster_v1(p_actor_user_id uuid,p_plan_id uuid,p_payload jsonb)
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
  select coalesce(jsonb_object_agg(p->>'code',p->'name'),'{}') into renames
    from jsonb_array_elements(points) p left join jsonb_array_elements(selected.drawing_points) oldp on oldp->>'code'=p->>'code'
    where p ? 'name' and p->>'code' is not null and p->'name' is distinct from oldp->'name';
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
      select jsonb_agg(case when renames ? (p->>'code') then p||jsonb_build_object('name',renames->(p->>'code')) else p end order by ord)
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
revoke all on function public.save_construction_roster_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_construction_roster_v1(uuid,uuid,jsonb) to service_role;

-- Excel can rename the same equipment. Route its name edits through the roster
-- transaction; its existing cell validation, journal and replay handling remain in charge.
alter function public.import_construction_matrix_v1(uuid,uuid,jsonb) rename to import_construction_matrix_before_roster_v1;
create function public.import_construction_matrix_v1(p_actor_user_id uuid,p_plan_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  names jsonb:=p_payload->'names'; plan public.construction_plans; points jsonb;
  versions jsonb; result jsonb; version_after integer;
begin
  if names='[]'::jsonb then return public.import_construction_matrix_before_roster_v1(p_actor_user_id,p_plan_id,p_payload); end if;
  if jsonb_typeof(names) is distinct from 'array' or jsonb_array_length(names)>1000
    or exists(select from jsonb_array_elements(names) n where jsonb_typeof(n->'name') is distinct from 'string' or jsonb_typeof(n->'code') is distinct from 'string')
    or exists(select from jsonb_array_elements(names) n group by lower(n->>'code') having count(*)>1)
    then raise exception '設備編號或名稱錯誤。'; end if;
  select * into strict plan from public.construction_plans where id=p_plan_id and deleted_at is null;
  select coalesce(jsonb_agg(case when n is null then p else p||jsonb_build_object('name',n->'name') end order by ord),'[]')
    into points from jsonb_array_elements(plan.drawing_points) with ordinality orig(p,ord)
    left join jsonb_array_elements(names) n on n->>'code'=p->>'code';
  select points||coalesce(jsonb_agg(jsonb_build_object('code',n->'code','name',n->'name','location','') order by ord),'[]') into points
    from jsonb_array_elements(names) with ordinality incoming(n,ord)
    where not exists(select from jsonb_array_elements(plan.drawing_points) p where p->>'code'=n->>'code');
  select jsonb_object_agg(v->>'id',v->'row_version') into versions
    from jsonb_array_elements(public.construction_scope_v1(p_actor_user_id,plan.project_id)->'construction_plans') v;
  versions:=coalesce(p_payload->'versions',versions)||jsonb_build_object(p_plan_id::text,p_payload->'row_version');
  perform public.save_construction_roster_v1(p_actor_user_id,p_plan_id,jsonb_build_object('points',points,'versions',versions));
  select row_version into version_after from public.construction_plans where id=p_plan_id;
  result:=public.import_construction_matrix_before_roster_v1(p_actor_user_id,p_plan_id,p_payload||jsonb_build_object('names','[]'::jsonb,'row_version',version_after));
  return result||jsonb_build_object('point_count',jsonb_array_length(names));
end $$;
revoke all on function public.import_construction_matrix_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.import_construction_matrix_v1(uuid,uuid,jsonb) to service_role;
commit;
