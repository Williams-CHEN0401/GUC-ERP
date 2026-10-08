begin;
set local lock_timeout='5s';
alter table public.construction_plans add column planned_days integer check(planned_days between 1 and 3650);

-- Extend the existing writer in place, preserving its authorization, locks and audit.
do $$ declare d text; begin
 d:=pg_get_functiondef('public.save_construction_plan_v1(uuid,jsonb,boolean)'::regprocedure);
 if position('created_by_user_id)' in d)=0 or position('status=p_payload->>''status''' in d)=0 then raise exception 'Unexpected construction writer'; end if;
 d:=replace(d,'created_by_user_id)','created_by_user_id,planned_days)');
 d:=replace(d,'p_actor_user_id) returning * into v_new','p_actor_user_id,nullif(p_payload->>''planned_days'','''')::integer) returning * into v_new');
 d:=replace(d,'status=p_payload->>''status''','planned_days=case when p_payload ? ''planned_days'' then nullif(p_payload->>''planned_days'','''')::integer else planned_days end,status=p_payload->>''status''');
 execute d;
end $$;

alter function public.construction_scope_v1(uuid,uuid) rename to construction_scope_without_progress_v1;
create function public.construction_scope_v1(p_actor_user_id uuid,p_project_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare data jsonb; plans jsonb;
begin
 data:=public.construction_scope_without_progress_v1(p_actor_user_id,p_project_id);
 -- Only already-authorized plans. Never return another worker's raw log here.
 select coalesce(jsonb_agg(p||jsonb_build_object('completed_days',days.n,
  'remaining_days',case when p->>'planned_days' is not null then greatest((p->>'planned_days')::int-days.n,0) end,
  'overrun_days',case when p->>'planned_days' is not null then greatest(days.n-(p->>'planned_days')::int,0) end,
  'progress_percent',case when p->>'planned_days' is not null then round(100.0*days.n/(p->>'planned_days')::int,1) end)), '[]') into plans
 from jsonb_array_elements(data->'construction_plans') p
 cross join lateral (select count(distinct l.log_date)::int n from public.site_work_logs l
 where l.construction_plan_id=(p->>'id')::uuid and l.deleted_at is null and l.status='completed'
 and l.work_type='工程施工' and public.erp_private_json_visible_v1(to_jsonb(l))) days;
 return jsonb_set(data,'{construction_plans}',plans);
end $$;
revoke all on function public.construction_scope_v1(uuid,uuid),public.construction_scope_without_progress_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.construction_scope_v1(uuid,uuid) to service_role;
-- Invoker wrapper needs this service-only helper; browser roles remain denied.
grant execute on function public.construction_scope_without_progress_v1(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
