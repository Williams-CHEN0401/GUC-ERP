begin;
-- Extend the released point validator without changing its access path or history checks.
do $upgrade$
declare original text; revised text;
begin
  original:=pg_get_functiondef('public.apply_plan_drawing_points_v1()'::regprocedure);
  revised:=replace(original,'(p-''code''-''location'')', $rule$(p ? 'name' and
        (jsonb_typeof(p->'name') is distinct from 'string' or length(p->>'name')>160 or (p->>'name') ~ '[[:cntrl:]]'))
      or (p-'code'-'location'-'name')$rule$);
  if original=revised then raise exception 'Unexpected point validator'; end if;
  -- Older clients do not submit the optional name. Keep it when the same code survives.
  revised:=replace(revised,'new.drawing_points:=points;', $keep$
    if tg_op='UPDATE' then
      select coalesce(jsonb_agg(case when not point ? 'name' and old_point ? 'name'
        then point||jsonb_build_object('name',old_point->'name') else point end order by ord),'[]')
      into points from jsonb_array_elements(points) with ordinality as p(point,ord)
      left join jsonb_array_elements(old.drawing_points) as prev(old_point) on old_point->>'code'=point->>'code';
    end if;
    new.drawing_points:=points;$keep$);
  if strpos(revised,'old_point')=0 then raise exception 'Unexpected point assignment'; end if;
  execute revised;
end $upgrade$;

create function public.import_construction_matrix_v1(p_actor_user_id uuid,p_plan_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  plan public.construction_plans; project public.projects; visible jsonb;
  names jsonb:=p_payload->'names'; changes jsonb:=p_payload->'changes'; points jsonb; items jsonb;
  saved jsonb; log_id uuid; previous_context text; message text;
begin
  select * into strict plan from public.construction_plans where id=p_plan_id and deleted_at is null for update;
  select value into visible from jsonb_array_elements(public.construction_scope_v1(p_actor_user_id,plan.project_id)->'construction_plans') where value->>'id'=p_plan_id::text;
  if visible is null then raise exception '沒有此施工規劃的權限。'; end if;
  if plan.row_version is distinct from (p_payload->>'row_version')::integer then raise exception '規劃已變更，請重新匯出核對。'; end if;
  if jsonb_typeof(names) is distinct from 'array' or jsonb_typeof(changes) is distinct from 'array'
      or jsonb_array_length(names)>1000 or jsonb_array_length(changes)>2000 then raise exception '匯入資料格式或數量錯誤。'; end if;
  if jsonb_array_length(names)>0 then
    if not coalesce((visible->>'can_manage')::boolean,false) then raise exception '沒有管理設備清冊的權限。'; end if;
    if exists(select from jsonb_array_elements(names) n where jsonb_typeof(n->'name') is distinct from 'string' or jsonb_typeof(n->'code') is distinct from 'string')
      or exists(select from jsonb_array_elements(names) n group by lower(n->>'code') having count(*)>1) then raise exception '設備編號或名稱錯誤。'; end if;
    select coalesce(jsonb_agg(case when n is null then p else p||jsonb_build_object('name',n->'name') end order by ord),'[]')
      into points from jsonb_array_elements(plan.drawing_points) with ordinality orig(p,ord)
      left join jsonb_array_elements(names) n on n->>'code'=p->>'code';
    select points||coalesce(jsonb_agg(jsonb_build_object('code',n->'code','name',n->'name','location','') order by ord),'[]') into points
      from jsonb_array_elements(names) with ordinality incoming(n,ord) where not exists(select from jsonb_array_elements(plan.drawing_points) p where p->>'code'=n->>'code');
    previous_context:=current_setting('app.plan_drawing_points',true);
    perform set_config('app.plan_drawing_points',jsonb_build_object('id',plan.id,'points',points)::text,true);
    update public.construction_plans set drawing_points=points,row_version=row_version+1,updated_at=now() where id=plan.id;
    perform set_config('app.plan_drawing_points',coalesce(previous_context,''),true);
  end if;
  if jsonb_array_length(changes)>0 then
    if not coalesce((visible->>'can_complete_items')::boolean,false) or not coalesce((visible->>'can_create_log')::boolean,false) then raise exception '沒有填報施工進度的權限。'; end if;
    if exists(select from jsonb_array_elements(changes) c where (c->>'before') is distinct from
      (select e->>'status' from jsonb_array_elements(visible->'equipment_state') e where (e->>'code',e->>'item')=(c->>'code',c->>'item'))) then raise exception '進度已變更，請重新核對匯入資料。'; end if;
    select * into strict project from public.projects where id=plan.project_id;
    select jsonb_agg(distinct c->'item') into items from jsonb_array_elements(changes) c;
    message:='Excel 匯入設備施工進度，共 '||jsonb_array_length(changes)||' 格。';
    saved:=public.save_construction_work_log_v1(p_actor_user_id,plan.id,jsonb_build_object('request_id',(p_payload->>'request_id')::uuid,
      'construction_plan_id',plan.id,'construction_item_ids',items,'construction_item_id',items->0,
      'equipment_progress',(select jsonb_agg(c-'before') from jsonb_array_elements(changes) c),
      'project_id',project.id,'project_name',project.name,'customer_id',project.customer_id,'department_id',project.department_id,
      'worker_user_ids',jsonb_build_array(p_actor_user_id),'log_date',(p_payload->>'log_date')::date,'work_type','工程施工',
      'status','in_progress','time_period','','summary',message,'completed_content',message,'pending_content','','maintenance_events','[]'::jsonb));
    log_id:=(saved#>>'{work_log,id}')::uuid;
    select value into visible from jsonb_array_elements(public.construction_scope_v1(p_actor_user_id,plan.project_id)->'construction_plans') where value->>'id'=plan.id::text;
    if exists(select from jsonb_array_elements(changes) c where not exists(select from jsonb_array_elements(visible->'equipment_state') e where e @> (c-'before'))) then raise exception '選擇的日誌日期早於既有進度，請重新核對。'; end if;
  end if;
  return jsonb_build_object('point_count',jsonb_array_length(names),'cell_count',jsonb_array_length(changes),'log_id',log_id);
end $$;
revoke all on function public.import_construction_matrix_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.import_construction_matrix_v1(uuid,uuid,jsonb) to service_role;
commit;
