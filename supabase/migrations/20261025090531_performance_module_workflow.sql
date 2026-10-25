begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Recheck current source authorization on EVERY read, including frozen snapshots.
create function public.performance_source_v1(p_actor uuid,p_employee uuid,p_kind text,p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v jsonb;v_project uuid;v_date date;v_member boolean:=false;v_module text;v_summary text;
begin
 perform public.performance_assert_actor_v1(p_actor);
 case p_kind
 when 'site_work_log' then
  select to_jsonb(l),exists(select 1 from public.site_work_log_workers w where w.work_log_id=l.id and w.user_id=p_employee) into v,v_member from public.site_work_logs l where l.id=p_id and l.deleted_at is null;
  v_date:=(v->>'log_date')::date;v_summary:=v->>'summary';v_module:='worklogs';
 when 'work_assignment' then
  select to_jsonb(a),a.assignee_user_id=p_employee into v,v_member from public.work_assignments a where a.id=p_id;
  if not(public.performance_admin_v1(p_actor) or p_actor in ((v->>'assignee_user_id')::uuid,(v->>'created_by_user_id')::uuid)) then return null;end if;
  v_date:=coalesce((v->>'assigned_date')::date,(v->>'appointment_date')::date,((v->>'created_at')::timestamptz at time zone 'Asia/Taipei')::date);v_summary:=v->>'instructions';v_module:='projects';
 when 'construction_plan' then
  select to_jsonb(c),exists(select 1 from public.construction_plan_assignees a where a.construction_plan_id=c.id and a.user_id=p_employee) into v,v_member from public.construction_plans c where c.id=p_id and c.deleted_at is null;
  v_date:=(v->>'construction_date')::date;v_summary:=v->>'content';v_module:='projects';
 when 'maintenance_event' then
  select to_jsonb(e)||jsonb_build_object('project_id',l.project_id),
   exists(select 1 from public.maintenance_event_workers w where w.event_id=e.id and w.user_id=p_employee)
   or exists(select 1 from public.site_work_log_workers w where w.work_log_id=e.work_log_id and w.user_id=p_employee)
  into v,v_member from public.maintenance_events e left join public.site_work_logs l on l.id=e.work_log_id where e.id=p_id and e.status<>'voided' and l.deleted_at is null;
  v_date:=(v->>'occurred_at')::date;v_summary:=v->>'description';v_module:='history';
 when 'shared_task' then
  select to_jsonb(t),t.assignee_id=p_employee into v,v_member from public.performance_shared_tasks t where t.id=p_id and t.status<>'CANCELLED'
   and (p_actor in (t.assignee_id,t.assigned_by) or public.performance_admin_v1(p_actor));
  v_date:=(v->>'due_date')::date;v_summary:=concat_ws('：',v->>'title',v->>'completion_note');v_module:='performance';
 else return null;
 end case;
 if v is null or not coalesce(v_member,false) or not public.has_app_permission_v1(p_actor,v_module,'VIEW') or not public.erp_private_json_visible_v1(v) then return null;end if;
 v_project:=(v->>'project_id')::uuid;
 if v_project is not null and (not public.has_project_permission_v1(p_actor,v_project,'VIEW') or not exists(select 1 from public.projects where id=v_project and deleted_at is null)) then return null;end if;
 if p_kind='construction_plan' and not public.construction_project_access_v1(p_actor,v_project,false) then return null;end if;
 if p_kind='maintenance_event' then
  if not public.has_app_permission_v1(p_actor,'site','VIEW') then return null;end if;
  begin perform public.assert_work_log_access_v1(p_actor,v_project,(v->>'work_log_id')::uuid,'VIEW');exception when raise_exception then return null;end;
 end if;
 if p_kind='site_work_log' then
  begin perform public.assert_work_log_access_v1(p_actor,v_project,p_id,'VIEW');exception when raise_exception then return null;end;
 end if;
 return jsonb_build_object('source_type',p_kind,'source_id',p_id,'source_version',v->'row_version','date',v_date,'summary',left(coalesce(v_summary,''),500),'project_id',v_project,'captured_at',now());
end $$;

create function public.performance_content_v1(p_review uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select to_jsonb(r)||jsonb_build_object(
 'allocations',coalesce((select jsonb_agg(to_jsonb(a) order by job_role) from public.performance_role_allocations a where review_id=r.id),'[]'),
 'items',coalesce((select jsonb_agg(to_jsonb(i) order by job_role,criterion) from public.performance_review_items i where review_id=r.id),'[]'),
 'evidence',coalesce((select jsonb_agg(to_jsonb(e) order by created_at,id) from public.performance_evidence_links e where review_id=r.id),'[]'),
 'responses',coalesce((select jsonb_agg(to_jsonb(s)) from public.performance_responses s where review_id=r.id),'[]'),
 'goals',coalesce((select jsonb_agg(to_jsonb(g)) from public.performance_goals g where review_id=r.id),'[]'))
 from public.performance_reviews r where id=p_review;
$$;

create function public.performance_deadline_v1(p_at timestamptz,p_days integer,p_calendar jsonb) returns timestamptz
language plpgsql immutable security invoker set search_path='' as $$
declare d date:=(p_at at time zone 'Asia/Taipei')::date;n integer:=0;guard integer:=0;
begin
 if p_days is null or p_calendar is null then return null;end if;
 if jsonb_typeof(p_calendar->'weekdays') is distinct from 'array' or jsonb_array_length(p_calendar->'weekdays') not between 1 and 7
 or exists(select 1 from jsonb_array_elements_text(p_calendar->'weekdays') x where x::int not between 1 and 7)
 or jsonb_typeof(p_calendar->'holidays') is distinct from 'array' then raise exception '請設定有效工作日曆。';end if;
 while n<p_days loop
  d:=d+1;guard:=guard+1;
  if guard>730 then raise exception '工作日曆找不到有效回覆期限。';end if;
  if (p_calendar->'weekdays') @> to_jsonb(extract(isodow from d)::integer) and not (p_calendar->'holidays' ? d::text) then n:=n+1;end if;
 end loop;
 return (d+time '23:59:59') at time zone 'Asia/Taipei';
end $$;

create function public.performance_command_v1(p_actor uuid,p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_request uuid:=(p_payload->>'request_id')::uuid;v_id uuid;v_review public.performance_reviews;v_period public.performance_periods;
 v_before jsonb;v_after jsonb;v_result jsonb;v_receipt public.performance_requests;v_fingerprint text;
 v_admin boolean;v_template uuid;v_alloc jsonb;v_items jsonb;v_calculation jsonb;v_item jsonb;v_value jsonb;
 v_task public.performance_shared_tasks;v_allowed text[];v_action text;v_entity text;v_actor_name text;v_revision integer;
begin
 perform public.performance_assert_actor_v1(p_actor);
 v_admin:=public.performance_admin_v1(p_actor);
 select username into v_actor_name from public.app_users where id=p_actor;
 if v_request is null or jsonb_typeof(p_payload) is distinct from 'object' then raise exception '請提供有效 request_id。';end if;
 v_allowed:=case p_operation
 when 'template_create' then array['request_id','name','config']
 when 'period_create' then array['request_id','month','template_id','trial_start','effective_date','response_workdays','business_calendar']
 when 'review_create' then array['request_id','period_id','employee_id','reviewer_id','approver_id','allocations']
 when 'review_allocate' then array['request_id','id','row_version','allocations','reason']
 when 'review_score' then array['request_id','id','row_version','items']
 when 'review_respond' then array['request_id','id','row_version','response_type','message']
 when 'review_revise' then array['request_id','id','row_version','reason']
 when 'evidence_add' then array['request_id','id','row_version','source_type','source_id']
 when 'evidence_confirm' then array['request_id','id','row_version','evidence_id']
 when 'goal_add' then array['request_id','id','row_version','description','due_date']
 when 'appeal_reply' then array['request_id','id','row_version','message']
 when 'task_create' then array['request_id','title','category','assignee_id','due_date']
 when 'task_complete' then array['request_id','id','row_version','completion_note']
 when 'task_verify' then array['request_id','id','row_version']
 when 'task_return' then array['request_id','id','row_version','reason']
 when 'task_cancel' then array['request_id','id','row_version','reason']
 when 'skill_set' then array['request_id','id','row_version','skill_code','level','evidence']
 when 'review_submit' then array['request_id','id','row_version']
 when 'review_timeout' then array['request_id','id','row_version']
 when 'review_approve' then array['request_id','id','row_version']
 when 'review_publish' then array['request_id','id','row_version']
 else null end;
 if v_allowed is null or exists(select 1 from jsonb_object_keys(p_payload) k where not(k=any(v_allowed))) then raise exception '操作或欄位不正確；不可提交計算總分或操作人。';end if;
 v_action:=case when p_operation in ('review_respond','evidence_add','task_complete') then 'VIEW' when p_operation in ('template_create','period_create','review_create','task_create') then 'CREATE' else 'UPDATE' end;
 perform public.performance_assert_actor_v1(p_actor,v_action);
 -- A transaction lock makes simultaneous retries observe the committed receipt.
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text||':'||p_operation||':'||v_request,0));
 v_fingerprint:=md5((p_payload-'request_id')::text);
 select * into v_receipt from public.performance_requests where actor_id=p_actor and operation=p_operation and request_id=v_request;
 if found then
  if v_receipt.fingerprint<>v_fingerprint then raise exception '此 request_id 已被其他使用者內容使用，請重新載入。';end if;
  -- Receipts contain identifiers/versions only, never frozen private text.
  return v_receipt.result;
 end if;
 if p_operation in ('template_create','period_create','review_create','review_allocate','review_revise','appeal_reply') and not v_admin then raise exception '沒有管理設定權限。';end if;

 if p_operation='template_create' then
  perform public.performance_validate_template_v1(p_payload->'config');
  insert into public.performance_templates(name,config,created_by) values(p_payload->>'name',p_payload->'config',p_actor) returning id into v_id;
  insert into public.performance_role_weights select v_id,r->>'code',w.key,w.value::numeric from jsonb_array_elements(p_payload#>'{config,job_roles}') r cross join lateral jsonb_each_text(r->'weights') w;
  v_entity:='performance_templates';select to_jsonb(t) into v_after from public.performance_templates t where id=v_id;
 elsif p_operation='period_create' then
  if not exists(select 1 from public.performance_templates where id=(p_payload->>'template_id')::uuid) then raise exception '找不到評分模板。';end if;
  if p_payload->>'response_workdays' is not null then perform public.performance_deadline_v1(now(),(p_payload->>'response_workdays')::int,p_payload->'business_calendar');end if;
  insert into public.performance_periods(month,template_id,trial_start,effective_date,response_workdays,business_calendar,created_by)
  values((p_payload->>'month')::date,(p_payload->>'template_id')::uuid,(p_payload->>'trial_start')::date,(p_payload->>'effective_date')::date,(p_payload->>'response_workdays')::int,nullif(p_payload->'business_calendar','null'),p_actor) returning * into v_period;
  v_id:=v_period.id;v_after:=to_jsonb(v_period);v_entity:='performance_periods';
 elsif p_operation='review_create' then
  if (select count(*) from public.app_users where id in ((p_payload->>'employee_id')::uuid,(p_payload->>'reviewer_id')::uuid,(p_payload->>'approver_id')::uuid) and is_active) <2
   or not public.has_app_permission_v1((p_payload->>'reviewer_id')::uuid,'performance','UPDATE')
   or not public.performance_admin_v1((p_payload->>'approver_id')::uuid) then raise exception '請指定有效員工、評核主管與其他管理員核定人。';end if;
  if not exists(select 1 from public.app_users where id=(p_payload->>'employee_id')::uuid and is_active) then raise exception '找不到有效員工。';end if;
  insert into public.performance_reviews(period_id,employee_id,reviewer_id,approver_id,created_by,updated_by)
  values((p_payload->>'period_id')::uuid,(p_payload->>'employee_id')::uuid,(p_payload->>'reviewer_id')::uuid,(p_payload->>'approver_id')::uuid,p_actor,p_actor) returning * into v_review;
  v_id:=v_review.id;v_alloc:=p_payload->'allocations';
 elsif p_operation='task_create' then
  if not v_admin and not exists(select 1 from public.performance_reviews r join public.performance_periods p on p.id=r.period_id where r.reviewer_id=p_actor and r.employee_id=(p_payload->>'assignee_id')::uuid and (p_payload->>'due_date')::date>=p.month and (p_payload->>'due_date')::date<p.month+interval '1 month') then raise exception '沒有此月份人員的共同任務指派權限。';end if;
  if not exists(select 1 from public.app_users where id=(p_payload->>'assignee_id')::uuid and is_active) then raise exception '找不到有效任務負責人。';end if;
  insert into public.performance_shared_tasks(title,category,assignee_id,assigned_by,due_date,updated_by)
  values(p_payload->>'title',p_payload->>'category',(p_payload->>'assignee_id')::uuid,p_actor,(p_payload->>'due_date')::date,p_actor) returning * into v_task;
  v_id:=v_task.id;v_after:=to_jsonb(v_task);v_entity:='performance_shared_tasks';
 elsif p_operation like 'task_%' then
  select * into v_task from public.performance_shared_tasks where id=(p_payload->>'id')::uuid for update;
  if not found then raise exception '找不到共同任務。';end if;
  if not(v_admin or p_actor in (v_task.assignee_id,v_task.assigned_by)) then raise exception '沒有此任務權限。';end if;
  if v_task.row_version is distinct from (p_payload->>'row_version')::int then raise exception '資料已被其他使用者修改，請重新載入。';end if;
  v_id:=v_task.id;v_before:=to_jsonb(v_task);v_entity:='performance_shared_tasks';
  if p_operation='task_complete' then
   if p_actor<>v_task.assignee_id or v_task.status<>'ASSIGNED' or length(btrim(coalesce(p_payload->>'completion_note','')))<2 then raise exception '請由負責人填寫完成證明。';end if;
   v_task.status:='COMPLETED';v_task.completion_note:=p_payload->>'completion_note';v_task.completed_at:=now();
  else
   if p_actor=v_task.assignee_id or not(v_admin or p_actor=v_task.assigned_by) then raise exception '沒有驗證或取消此任務權限。';end if;
   if p_operation='task_verify' then
    if v_task.status<>'COMPLETED' then raise exception '任務尚未完成。';end if;v_task.status:='VERIFIED';v_task.verified_by:=p_actor;
   else
    if v_task.status='CANCELLED' or length(btrim(coalesce(p_payload->>'reason','')))<2 then raise exception '請填寫退回或取消原因。';end if;
    v_task.status:=case when p_operation='task_return' then 'ASSIGNED' else 'CANCELLED' end;v_task.reason:=p_payload->>'reason';v_task.verified_by:=null;
   end if;
  end if;
  update public.performance_shared_tasks set status=v_task.status,completion_note=v_task.completion_note,completed_at=v_task.completed_at,verified_by=v_task.verified_by,reason=v_task.reason,row_version=row_version+1,updated_at=now(),updated_by=p_actor where id=v_id returning to_jsonb(performance_shared_tasks) into v_after;
 else
  select * into v_review from public.performance_reviews where id=(p_payload->>'id')::uuid for update;
  if not found then raise exception '找不到考核。';end if;
  if not public.performance_can_read_v1(p_actor,v_review) and not(p_operation='evidence_add' and p_actor=v_review.employee_id) then raise exception '沒有此考核權限。';end if;
  if v_review.row_version is distinct from (p_payload->>'row_version')::int then raise exception '資料已被其他使用者修改，請重新載入。';end if;
  v_id:=v_review.id;v_before:=public.performance_content_v1(v_id);
  if v_review.status='PUBLISHED' and p_operation not in ('review_revise','appeal_reply','skill_set') then raise exception '已發布評核不可修改，請建立新修訂。';end if;
 end if;

 if v_review.id is not null then
  v_entity:='performance_reviews';select * into v_period from public.performance_periods where id=v_review.period_id;v_template:=v_period.template_id;
  if p_operation='review_allocate' then
   if v_review.status<>'DRAFT' or length(btrim(coalesce(p_payload->>'reason','')))<2 then raise exception '僅草稿可重新核定配比，並須填寫原因。';end if;
   delete from public.performance_review_items where review_id=v_id;delete from public.performance_role_allocations where review_id=v_id;v_alloc:=p_payload->'allocations';
  end if;
  if v_alloc is not null then
   perform public.performance_calculate_v1(v_template,v_alloc,'[]');
   insert into public.performance_role_allocations select v_id,a->>'job_role',(a->>'percent')::numeric,p_actor,now() from jsonb_array_elements(v_alloc) a;
   insert into public.performance_review_items(review_id,job_role,criterion) select v_id,w.job_role,w.criterion from public.performance_role_weights w join public.performance_role_allocations a on a.job_role=w.job_role and a.review_id=v_id where w.template_id=v_template;
  end if;
  if p_operation in ('review_score','review_submit','evidence_confirm','goal_add') then
   if p_actor<>v_review.reviewer_id or p_actor=v_review.employee_id or v_review.status<>'DRAFT' then raise exception '沒有草稿評核權限。';end if;
  end if;
  if p_operation='review_score' then
   v_items:=p_payload->'items';
   select jsonb_agg(to_jsonb(a)) into v_alloc from public.performance_role_allocations a where review_id=v_id;
   perform public.performance_calculate_v1(v_template,v_alloc,v_items);
   if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items)<>(select count(*) from public.performance_review_items where review_id=v_id) then raise exception '請保存所有核定職務的七項評級。';end if;
   for v_item in select * from jsonb_array_elements(v_items) loop
    if exists(select 1 from jsonb_object_keys(v_item) k where k not in ('job_role','criterion','rating_state','rating','reason','na_kind','assigned')) then raise exception '評級包含不支援欄位。';end if;
    update public.performance_review_items set rating_state=v_item->>'rating_state',rating=(v_item->>'rating')::smallint,reason=coalesce(v_item->>'reason',''),na_kind=v_item->>'na_kind',assigned=coalesce((v_item->>'assigned')::boolean,false)
     where review_id=v_id and job_role=v_item->>'job_role' and criterion=v_item->>'criterion';
    if not found then raise exception '未核定的職務或指標。';end if;
   end loop;
  elsif p_operation='evidence_add' then
   if v_review.status<>'DRAFT' or p_actor not in (v_review.employee_id,v_review.reviewer_id) then raise exception '僅本人或指定主管可於草稿新增佐證。';end if;
   v_value:=public.performance_source_v1(p_actor,v_review.employee_id,p_payload->>'source_type',(p_payload->>'source_id')::uuid);
   if v_value is null or (v_value->>'date')::date<v_period.month or (v_value->>'date')::date>=v_period.month+interval '1 month' then raise exception '沒有此月份來源的佐證權限。';end if;
   insert into public.performance_evidence_links(review_id,source_type,source_id,snapshot,confirmed_by,created_by) values(v_id,p_payload->>'source_type',(p_payload->>'source_id')::uuid,v_value,case when p_actor=v_review.reviewer_id then p_actor end,p_actor);
  elsif p_operation='evidence_confirm' then
   select public.performance_source_v1(p_actor,v_review.employee_id,e.source_type,e.source_id) into v_value from public.performance_evidence_links e where e.id=(p_payload->>'evidence_id')::uuid and review_id=v_id;
   if v_value is null then raise exception '沒有佐證確認權限。';end if;
   update public.performance_evidence_links set confirmed_by=p_actor,snapshot=v_value where id=(p_payload->>'evidence_id')::uuid and review_id=v_id;
  elsif p_operation='goal_add' then
   insert into public.performance_goals(review_id,description,due_date,created_by) values(v_id,p_payload->>'description',(p_payload->>'due_date')::date,p_actor);
  elsif p_operation='review_respond' then
   if p_actor<>v_review.employee_id or v_review.status<>'SUBMITTED' then raise exception '沒有此版本回覆權限。';end if;
   insert into public.performance_responses(review_id,response_type,message,created_by) values(v_id,p_payload->>'response_type',coalesce(p_payload->>'message',''),p_actor);v_review.status:='EMPLOYEE_RESPONDED';
  elsif p_operation='review_timeout' then
   if not v_admin or v_review.status<>'SUBMITTED' or v_review.response_due_at is null or now()<=v_review.response_due_at then raise exception '尚未超過已設定的工作日回覆期限。';end if;v_review.status:='ACK_TIMEOUT';
  elsif p_operation in ('review_approve','review_publish') then
   if not v_admin or p_actor<>v_review.approver_id or p_actor=v_review.employee_id then raise exception '沒有核定權限；不可核定自己的評核。';end if;
   if p_operation='review_approve' then
    if v_review.status not in ('EMPLOYEE_RESPONDED','ACK_TIMEOUT') then raise exception '請先取得員工回覆或依法定工作日曆等待回覆期限。';end if;
    v_review.status:='APPROVED';v_review.approved_at:=now();
   else
    if v_review.status<>'APPROVED' then raise exception '評核尚未核定。';end if;
    perform pg_advisory_xact_lock(hashtextextended(v_review.period_id::text||v_review.employee_id,0));
    update public.performance_reviews set is_current=false where period_id=v_review.period_id and employee_id=v_review.employee_id and is_current;
    v_review.status:='PUBLISHED';v_review.is_current:=true;v_review.published_at:=now();
   end if;
  elsif p_operation='review_revise' then
   if v_review.status<>'PUBLISHED' or not v_review.is_current or length(btrim(coalesce(p_payload->>'reason','')))<2 then raise exception '請由目前發布版本建立修訂並說明原因。';end if;
   perform pg_advisory_xact_lock(hashtextextended(v_review.period_id::text||v_review.employee_id,0));
   v_revision:=v_review.revision+1;
   insert into public.performance_reviews(period_id,employee_id,reviewer_id,approver_id,revision,supersedes_id,revision_reason,created_by,updated_by)
    values(v_review.period_id,v_review.employee_id,v_review.reviewer_id,v_review.approver_id,v_revision,v_id,p_payload->>'reason',p_actor,p_actor) returning * into v_review;
   insert into public.performance_role_allocations select v_review.id,job_role,percent,p_actor,now() from public.performance_role_allocations where review_id=v_id;
   insert into public.performance_review_items select v_review.id,job_role,criterion,rating_state,rating,reason,na_kind,assigned from public.performance_review_items where review_id=v_id;
   insert into public.performance_evidence_links(review_id,source_type,source_id,snapshot,created_by) select v_review.id,source_type,source_id,snapshot,p_actor from public.performance_evidence_links where review_id=v_id;
   insert into public.performance_goals(review_id,description,due_date,created_by) select v_review.id,description,due_date,p_actor from public.performance_goals where review_id=v_id;
   v_id:=v_review.id;
  elsif p_operation='appeal_reply' then
   insert into public.performance_appeals(review_id,message,created_by) values(v_id,p_payload->>'message',p_actor);
  elsif p_operation='skill_set' then
   if p_actor=v_review.employee_id or not(v_admin or p_actor=v_review.reviewer_id) or v_review.status<>'PUBLISHED' then raise exception '沒有核定技能等級權限。';end if;
   perform pg_advisory_xact_lock(hashtextextended(v_review.employee_id::text||':'||(p_payload->>'skill_code'),0));
   insert into public.performance_user_skills(employee_id,skill_code,level,evidence,assessor_id,review_id,version)
    select v_review.employee_id,p_payload->>'skill_code',(p_payload->>'level')::int,p_payload->>'evidence',p_actor,v_id,coalesce(max(version),0)+1 from public.performance_user_skills where employee_id=v_review.employee_id and skill_code=p_payload->>'skill_code';
  end if;
  if p_operation not in ('appeal_reply','skill_set') then
   select jsonb_agg(to_jsonb(a)) into v_alloc from public.performance_role_allocations a where review_id=v_id;
   select jsonb_agg(to_jsonb(i)) into v_items from public.performance_review_items i where review_id=v_id;
   v_calculation:=public.performance_calculate_v1(v_template,v_alloc,v_items);
   if p_operation in ('review_submit','review_approve','review_publish') then
    if v_calculation->>'status'<>'READY' then raise exception '資料不足或尚未完成評級，不可送出或發布。';end if;
    if exists(select 1 from public.performance_review_items where review_id=v_id and rating_state='RATED' and length(btrim(reason))<2)
     and not exists(select 1 from public.performance_evidence_links e where review_id=v_id and confirmed_by=v_review.reviewer_id and public.performance_source_v1(v_review.reviewer_id,v_review.employee_id,e.source_type,e.source_id) is not null) then raise exception '評級須附具體說明或主管確認的佐證。';end if;
   end if;
   if p_operation='review_submit' then
    v_review.status:='SUBMITTED';v_review.submitted_at:=now();v_review.response_due_at:=public.performance_deadline_v1(now(),v_period.response_workdays,v_period.business_calendar);
   end if;
   update public.performance_reviews set status=v_review.status,is_current=v_review.is_current,score=(v_calculation->>'score')::numeric,grade=v_calculation->>'grade',calculation=v_calculation,
    submitted_at=v_review.submitted_at,response_due_at=v_review.response_due_at,approved_at=v_review.approved_at,published_at=v_review.published_at,row_version=row_version+1,updated_at=now(),updated_by=p_actor where id=v_id returning * into v_review;
  end if;
  v_after:=public.performance_content_v1(v_id);
  if p_operation='appeal_reply' then v_after:=v_after||jsonb_build_object('management_reply',p_payload->>'message');end if;
  if p_operation='skill_set' then v_after:=v_after||jsonb_build_object('skill',p_payload-'request_id');end if;
  if p_operation='review_allocate' then v_after:=v_after||jsonb_build_object('allocation_change_reason',p_payload->>'reason');end if;
 end if;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values(v_entity,v_id,case when v_before is null then 'insert' else 'update' end,v_before,v_after||jsonb_build_object('performance_operation',p_operation,'actor_user_id',p_actor,'request_id',v_request),'performance',v_actor_name);
 v_result:=jsonb_build_object('id',v_id,'row_version',coalesce((v_after->>'row_version')::int,1),'status',v_after->>'status');
 insert into public.performance_requests values(p_actor,p_operation,v_request,v_fingerprint,v_result,now());
 return v_result;
end $$;

do $$ declare r record;begin
 for r in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'performance\_%' escape '\' loop
 execute format('revoke all on function %s from public,anon,authenticated;grant execute on function %s to service_role',r.signature,r.signature);
 end loop;
end $$;
commit;
