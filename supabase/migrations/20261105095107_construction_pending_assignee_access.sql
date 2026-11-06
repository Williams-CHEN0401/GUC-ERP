begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Resolving an assigned plan's pending line is narrower than editing its
-- author's log. Reuse the canonical assignment and construction-log grants.
create function public.construction_pending_completion_allowed_v1(p_actor_user_id uuid,p_source public.site_work_logs)
returns boolean language sql stable security invoker set search_path='' as $$
 select coalesce(p_source.work_type='工程施工' and p_source.deleted_at is null
  and public.construction_permission_v1(p_actor_user_id,'construction_plans','VIEW')
  and public.construction_permission_v1(p_actor_user_id,'construction_logs','VIEW')
  and (public.construction_permission_v1(p_actor_user_id,'construction_logs','CREATE')
    or public.construction_permission_v1(p_actor_user_id,'construction_logs','UPDATE'))
  and public.erp_private_json_visible_v1(to_jsonb(p_source))
  and exists(select 1 from public.construction_plans c
   join public.projects p on p.id=c.project_id
   join public.construction_plan_assignees a on a.construction_plan_id=c.id
   where c.id=p_source.construction_plan_id and c.project_id=p_source.project_id
    and a.user_id=p_actor_user_id and c.deleted_at is null and c.status<>'cancelled'
    and p.deleted_at is null and p.project_type='construction'
    and p.construction_category in ('small_purchase','tender')
    and public.erp_private_json_visible_v1(to_jsonb(p))),false);
$$;
revoke all on function public.construction_pending_completion_allowed_v1(uuid,public.site_work_logs) from public,anon,authenticated;
grant execute on function public.construction_pending_completion_allowed_v1(uuid,public.site_work_logs) to service_role;

-- Preserve the released projection, date boundary, privacy filters and fields.
do $pending_list$
declare d text; old text; replacement text;
begin
 d:=replace(pg_get_functiondef('public.pending_work_log_items_v1(uuid,uuid,date,uuid)'::regprocedure),E'\r\n',E'\n');
 old:=$old$if not public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW') then$old$;
 replacement:=$new$if not public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW') and not (
  public.construction_permission_v1(p_actor_user_id,'construction_plans','VIEW')
  and public.construction_permission_v1(p_actor_user_id,'construction_logs','VIEW')) then$new$;
 if strpos(d,old)=0 then raise exception 'Unexpected pending-list permission baseline';end if;
 d:=replace(d,old,replacement);
 old:=$old$and (project_visible or l.construction_plan_id is not null)$old$;
 replacement:=$new$and (project_visible or l.construction_plan_id is not null)
  and (public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW') or l.construction_plan_id is not null)$new$;
 if strpos(d,old)=0 then raise exception 'Unexpected pending-list scope baseline';end if;
 d:=replace(d,old,replacement);
 old:=$old$  if r.construction_plan_id is not null and not public.construction_log_visible_v1(p_actor_user_id,r) then continue; end if;
  allowed:=true;
  begin perform public.assert_work_log_access_v1(p_actor_user_id,r.project_id,r.id,'UPDATE'); exception when others then allowed:=false; end;$old$;
 replacement:=$new$  allowed:=public.construction_pending_completion_allowed_v1(p_actor_user_id,r);
  if r.construction_plan_id is not null and not public.construction_log_visible_v1(p_actor_user_id,r) and not allowed then continue; end if;
  if not allowed then
   begin perform public.assert_work_log_access_v1(p_actor_user_id,r.project_id,r.id,'UPDATE');allowed:=true; exception when others then allowed:=false; end;
  end if;$new$;
 if strpos(d,old)=0 then raise exception 'Unexpected pending-list completion baseline';end if;
 execute replace(d,old,replacement);
end $pending_list$;

-- Keep the established transactional writer, history links, versions, replay
-- checks and target-log authorization; change only source-line authorization.
do $pending_save$
declare d text; old text; replacement text;
begin
 d:=replace(pg_get_functiondef('public.save_work_log_workforce_before_maintenance_v1(uuid,jsonb)'::regprocedure),E'\r\n',E'\n');
 old:=$old$ -- Deterministic locking, original versions checked before any source is changed.$old$;
 replacement:=$new$ -- Lock source plans before their logs: assignment removal takes the same
 -- plan lock, so a revoked assignee cannot race a pending-line resolution.
 perform 1 from public.construction_plans c where c.id in (
  select l.construction_plan_id from public.site_work_logs l
  where l.id in(select (i->>'source_log_id')::uuid from jsonb_array_elements(v_sources)i))
 order by c.id for update;
 -- Deterministic locking, original versions checked before any source is changed.$new$;
 if strpos(d,old)=0 then raise exception 'Unexpected pending writer lock baseline';end if;
 d:=replace(d,old,replacement);
 old:=$old$  perform public.assert_work_log_access_v1(p_actor_user_id,v_project,v_source.id,'UPDATE');$old$;
 replacement:=$new$  if not public.construction_pending_completion_allowed_v1(p_actor_user_id,v_source) then
   perform public.assert_work_log_access_v1(p_actor_user_id,v_project,v_source.id,'UPDATE');
  end if;$new$;
 if strpos(d,old)=0 then raise exception 'Unexpected pending writer permission baseline';end if;
 execute replace(d,old,replacement);
end $pending_save$;
notify pgrst,'reload schema';
commit;
