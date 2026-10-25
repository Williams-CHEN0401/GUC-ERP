begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create function public.performance_read_v1(p_actor uuid,p_mode text default 'list',p_options jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_review public.performance_reviews;v_result jsonb;v_reviews jsonb;v_evidence jsonb;v_candidates jsonb:='[]';
 v_item record;v_source jsonb;v_employee uuid;v_month date;v_year integer;v_quarter integer;v_start date;
begin
 perform public.performance_assert_actor_v1(p_actor);
 if exists(select 1 from jsonb_object_keys(p_options) k where k not in ('id','year','quarter','evidence_id')) then raise exception '績效查詢欄位不正確。';end if;
 if p_mode in ('detail','candidates','source') then
  select * into v_review from public.performance_reviews where id=(p_options->>'id')::uuid;
  if not found or not public.performance_can_read_v1(p_actor,v_review) then
   if not coalesce(p_mode='candidates' and v_review.employee_id=p_actor and v_review.status='DRAFT',false) then raise exception '沒有此考核查閱權限。';end if;
  end if;
  if p_mode='detail' then
   v_result:=public.performance_content_v1(v_review.id);
   select coalesce(jsonb_agg(case when public.performance_source_v1(p_actor,v_review.employee_id,e.source_type,e.source_id) is not null and public.erp_private_json_visible_v1(e.snapshot)
    then to_jsonb(e) else jsonb_build_object('id',e.id,'redacted',true,'message','來源已失效或目前無權限') end order by e.created_at,e.id),'[]') into v_evidence
    from public.performance_evidence_links e where e.review_id=v_review.id;
   v_result:=v_result||jsonb_build_object('evidence',v_evidence,
    'employee_name',(select display_name from public.app_users where id=v_review.employee_id),
    'period',(select to_jsonb(p) from public.performance_periods p where p.id=v_review.period_id),
    'template',(select to_jsonb(t) from public.performance_templates t join public.performance_periods p on p.template_id=t.id where p.id=v_review.period_id),
    'management_replies',coalesce((select jsonb_agg(to_jsonb(a) order by created_at) from public.performance_appeals a where review_id=v_review.id),'[]'));
  elsif p_mode='source' then
   select public.performance_source_v1(p_actor,v_review.employee_id,e.source_type,e.source_id) into v_source from public.performance_evidence_links e
    where e.review_id=v_review.id and e.id=(p_options->>'evidence_id')::uuid and public.erp_private_json_visible_v1(e.snapshot);
   if v_source is null then raise exception '沒有目前來源的查閱權限。';end if;
   v_result:=jsonb_build_object('source',v_source);
  else
   select month into v_month from public.performance_periods where id=v_review.period_id;
   for v_item in
    select 'site_work_log' kind,l.id from public.site_work_logs l join public.site_work_log_workers w on w.work_log_id=l.id
     where w.user_id=v_review.employee_id and l.log_date>=v_month and l.log_date<v_month+interval '1 month' and l.deleted_at is null
    union all select 'work_assignment',a.id from public.work_assignments a where a.assignee_user_id=v_review.employee_id
     and (a.created_at at time zone 'Asia/Taipei')::date>=v_month and (a.created_at at time zone 'Asia/Taipei')::date<v_month+interval '1 month'
    union all select 'construction_plan',c.id from public.construction_plans c join public.construction_plan_assignees a on a.construction_plan_id=c.id
     where a.user_id=v_review.employee_id and c.construction_date>=v_month and c.construction_date<v_month+interval '1 month'
    union all select 'maintenance_event',e.id from public.maintenance_events e where e.occurred_at>=v_month and e.occurred_at<v_month+interval '1 month'
     and (exists(select 1 from public.maintenance_event_workers w where w.event_id=e.id and w.user_id=v_review.employee_id) or exists(select 1 from public.site_work_log_workers w where w.work_log_id=e.work_log_id and w.user_id=v_review.employee_id))
    union all select 'shared_task',t.id from public.performance_shared_tasks t where t.assignee_id=v_review.employee_id and t.due_date>=v_month and t.due_date<v_month+interval '1 month'
   loop
    v_source:=public.performance_source_v1(p_actor,v_review.employee_id,v_item.kind,v_item.id);
    if v_source is not null and (v_source->>'date')::date>=v_month and (v_source->>'date')::date<v_month+interval '1 month' then v_candidates:=v_candidates||jsonb_build_array(v_source);end if;
   end loop;
   v_result:=jsonb_build_object('candidates',v_candidates,'notice','候選佐證不會自動產生評分；由主管逐人確認。');
  end if;
 elsif p_mode in ('list','export') then
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'period_id',r.period_id,'month',p.month,'employee_id',r.employee_id,'employee_name',u.display_name,
   'reviewer_id',r.reviewer_id,'approver_id',r.approver_id,'revision',r.revision,'status',r.status,'score',r.score,'grade',r.grade,'calculation',r.calculation,
   'is_current',r.is_current,'row_version',r.row_version,'response_due_at',r.response_due_at) order by p.month desc,u.display_name,r.revision desc),'[]') into v_reviews
   from public.performance_reviews r join public.performance_periods p on p.id=r.period_id join public.app_users u on u.id=r.employee_id
   where public.performance_can_read_v1(p_actor,r);
  v_result:=jsonb_build_object('reviews',v_reviews);
  if p_mode='list' then
   v_result:=v_result||jsonb_build_object(
    'periods',coalesce((select jsonb_agg(to_jsonb(p) order by month desc) from public.performance_periods p),'[]'),
    'templates',coalesce((select jsonb_agg(to_jsonb(t) order by created_at desc) from public.performance_templates t),'[]'),
    'pending_reviews',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'row_version',r.row_version,'month',p.month,'status',r.status)) from public.performance_reviews r join public.performance_periods p on p.id=r.period_id where employee_id=p_actor and status='DRAFT'),'[]'),
    'people',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'display_name',u.display_name,'can_review',public.has_app_permission_v1(u.id,'performance','UPDATE'),'can_approve',public.performance_admin_v1(u.id)) order by u.display_name) from public.app_users u where u.is_active and (public.performance_admin_v1(p_actor) or exists(select 1 from public.performance_reviews r where r.employee_id=u.id and r.reviewer_id=p_actor))),'[]'),
    'tasks',coalesce((select jsonb_agg(to_jsonb(t) order by due_date,created_at) from public.performance_shared_tasks t where p_actor in (assignee_id,assigned_by) or public.performance_admin_v1(p_actor)),'[]'),
    'skill_catalog',(select jsonb_agg(to_jsonb(c) order by code) from public.performance_skill_catalog c),
    'skills',coalesce((select jsonb_agg(to_jsonb(s)) from public.performance_user_skills s join public.performance_reviews r on r.id=s.review_id where public.performance_can_read_v1(p_actor,r)),'[]'));
  end if;
 elsif p_mode='quarter' then
  v_year:=(p_options->>'year')::int;v_quarter:=(p_options->>'quarter')::int;
  if v_year is null or v_year not between 2000 and 2200 or v_quarter is null or v_quarter not between 1 and 4 then raise exception '請選擇有效年份及季度。';end if;
  v_start:=make_date(v_year,1+(v_quarter-1)*3,1);
  select jsonb_build_object('year',v_year,'quarter',v_quarter,'results',coalesce(jsonb_agg(q),'[]')) into v_result from (
   select r.employee_id,u.display_name,count(*) as sample_count,round(avg(r.score),2) as average_score,
    jsonb_agg(jsonb_build_object('month',p.month,'score',r.score,'grade',r.grade,'effective_role_weights',r.calculation->'roles') order by p.month) as months,
    3-count(*) as missing_months,round(100::numeric/count(*),4) as effective_month_weight
   from public.performance_reviews r join public.performance_periods p on p.id=r.period_id join public.app_users u on u.id=r.employee_id
   where r.status='PUBLISHED' and r.is_current and r.score is not null and p.month>=v_start and p.month<v_start+interval '3 months' and public.performance_can_read_v1(p_actor,r)
   group by r.employee_id,u.display_name
  ) q;
 else raise exception '不支援此績效查詢。';end if;
 insert into public.audit_logs(entity_type,entity_id,action,after_data,actor,source)
 values('performance_access',p_actor,case when p_mode='export' then 'export' else 'insert' end,
  jsonb_build_object('event_kind',p_mode,'review_id',v_review.id,'actor_user_id',p_actor,'at',now()),(select username from public.app_users where id=p_actor),'performance');
 return v_result;
end $$;

-- Template/period configuration is versioned by creating another row, never overwritten.
create function public.performance_config_immutable_v1() returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception '設定版本不可覆寫，請建立新版本。';end $$;
create trigger performance_template_immutable before update or delete on public.performance_templates for each row execute function public.performance_config_immutable_v1();
create trigger performance_weight_immutable before update or delete on public.performance_role_weights for each row execute function public.performance_config_immutable_v1();
create trigger performance_period_immutable before update or delete on public.performance_periods for each row execute function public.performance_config_immutable_v1();
do $$ declare r record;begin
 for r in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'performance\_%' escape '\' loop
 execute format('revoke all on function %s from public,anon,authenticated;grant execute on function %s to service_role',r.signature,r.signature);
 end loop;
end $$;
commit;
