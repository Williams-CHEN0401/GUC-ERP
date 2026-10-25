begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- A per-review version only overrides the immutable monthly default when explicitly applied.
-- Existing reviews retain NULL and keep their original template; no business rows are backfilled.
alter table public.performance_reviews add column template_id uuid references public.performance_templates;
create index performance_review_template_idx on public.performance_reviews(template_id);

create or replace function public.performance_validate_template_v1(p_config jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare r jsonb;v_codes text[];v_expected text[];v_extras jsonb;v_sum numeric;
begin
 if jsonb_typeof(p_config) is distinct from 'object' or p_config->>'schema_version' is distinct from '1.0'
 or p_config->>'timezone' is distinct from 'Asia/Taipei' or p_config->>'rounding' is distinct from 'HALF_UP' or p_config->>'score_decimals' is distinct from '2'
 or p_config->>'review_cycle' is distinct from 'monthly' then raise exception '評分模板格式或計分版本不正確。';end if;
 select array_agg(x->>'code' order by x->>'code') into v_codes from jsonb_array_elements(p_config->'criteria') x;
 if v_codes is distinct from array['LEARNING','QUALITY','RECORD','REPORT','SAFETY','SCHEDULE','TEAM'] then raise exception '必須設定七項唯一指標。';end if;
 if exists(select 1 from jsonb_array_elements(p_config->'criteria') x where
  jsonb_typeof(x->'label') is distinct from 'string' or length(btrim(x->>'label')) not between 1 and 120
  or jsonb_typeof(x->'evidence_guide') is distinct from 'string' or length(x->>'evidence_guide')>2000) then raise exception '項目名稱須為 1 至 120 字，說明不得超過 2000 字。';end if;
 select array_agg(x->>'code' order by x->>'code') into v_codes from jsonb_array_elements(p_config->'job_roles') x;
 if v_codes is distinct from array['construction','lead','maintenance','project_management'] then raise exception '必須設定四種唯一職務。';end if;
 if (select jsonb_agg((x->>'value')::integer order by (x->>'value')::integer) from jsonb_array_elements(p_config->'rating_levels') x) is distinct from '[1,2,3,4,5]'::jsonb
 or (select jsonb_object_agg(x->>'grade',x->'min_inclusive') from jsonb_array_elements(p_config->'grade_thresholds') x) is distinct from '{"A":90,"B":80,"C":70,"D":0}'::jsonb
 or jsonb_array_length(p_config->'grade_thresholds')<>4 then raise exception '評級或等級門檻不正確。';end if;
 for r in select * from jsonb_array_elements(p_config->'job_roles') loop
  v_extras:=coalesce(r->'additional_criteria','[]'::jsonb);
  if jsonb_typeof(v_extras) is distinct from 'array' or jsonb_array_length(v_extras)>20 then raise exception '主管新增子項目須為清單，最多 20 項。';end if;
  if r->>'code'<>'lead' and jsonb_array_length(v_extras)>0 then raise exception '只有主管職務可新增考核子項目。';end if;
  if exists(select 1 from jsonb_array_elements(v_extras) x where jsonb_typeof(x->'code') is distinct from 'string' or x->>'code' !~ '^LEAD_[A-Z0-9_]{1,40}$'
   or jsonb_typeof(x->'label') is distinct from 'string' or length(btrim(x->>'label')) not between 1 and 120
   or jsonb_typeof(x->'evidence_guide') is distinct from 'string' or length(x->>'evidence_guide')>2000)
   or exists(select 1 from jsonb_array_elements(v_extras) x group by x->>'code' having count(*)>1) then raise exception '主管子項目代碼須唯一，名稱須為 1 至 120 字，說明不得超過 2000 字。';end if;
  select array_agg(code order by code) into v_expected from (select x->>'code' code from jsonb_array_elements(p_config->'criteria') x union all select x->>'code' from jsonb_array_elements(v_extras) x) c;
  select array_agg(key order by key),sum(value::numeric) into v_codes,v_sum from jsonb_each_text(r->'weights');
  if v_codes is distinct from v_expected or v_sum<>100
   or exists(select 1 from jsonb_each_text(r->'weights') where value::numeric<0 or value::numeric>100) then raise exception '每種職務所有項目權重合計必須為 100。';end if;
 end loop;
 if p_config#>>'{policy,self_approve_forbidden}' is distinct from 'true' or p_config#>>'{policy,published_review_immutable}' is distinct from 'true'
 or p_config#>>'{policy,automated_negative_score_from_leave}' is distinct from 'false' then raise exception '模板不可停用既有績效防護。';end if;
end $$;

create or replace function public.performance_calculate_v1(p_template uuid,p_allocations jsonb,p_items jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare a jsonb;i jsonb;w record;v_sum numeric:=0;v_den numeric;v_num numeric;v_total numeric:=0;v_score numeric;
 v_jobs jsonb:='[]';v_state text:='READY';v_job_state text;v_seen text[];v_role text;v_expected integer;
begin
 if jsonb_typeof(p_allocations) is distinct from 'array' or jsonb_array_length(p_allocations) not between 1 and 4
 or jsonb_typeof(p_items) is distinct from 'array' then raise exception '職務配比與評級格式不正確。';end if;
 if exists(select 1 from jsonb_array_elements(p_allocations) x group by x->>'job_role' having count(*)>1)
 or exists(select 1 from jsonb_array_elements(p_items) x group by x->>'job_role',x->>'criterion' having count(*)>1) then raise exception '職務或指標不可重複。';end if;
 for a in select * from jsonb_array_elements(p_allocations) loop
  if (a->>'percent')::numeric is null or (a->>'percent')::numeric<=0 or (a->>'percent')::numeric>100 then raise exception '職務配比須大於 0。';end if;
  v_sum:=v_sum+(a->>'percent')::numeric;v_role:=a->>'job_role';v_den:=0;v_num:=0;v_job_state:='READY';
  select jsonb_array_length(t.config->'criteria')+coalesce(jsonb_array_length(j->'additional_criteria'),0) into v_expected
   from public.performance_templates t cross join lateral jsonb_array_elements(t.config->'job_roles') j where t.id=p_template and j->>'code'=v_role;
  if v_expected is null or (select count(*) from public.performance_role_weights where template_id=p_template and job_role=v_role) is distinct from v_expected then raise exception '找不到職務權重。';end if;
  for w in select * from public.performance_role_weights where template_id=p_template and job_role=v_role loop
   select x into i from jsonb_array_elements(p_items) x where x->>'job_role'=v_role and x->>'criterion'=w.criterion;
   if i is null or i->>'rating_state'='UNRATED' then v_job_state:='UNRATED';continue;end if;
   if i->>'rating_state'='NA' then
    if i->>'na_kind' not in ('unassigned','unobservable') or i->>'na_kind' is null or length(btrim(coalesce(i->>'reason','')))<2
     or (i->>'na_kind'='unassigned' and coalesce((i->>'assigned')::boolean,false)) then raise exception 'N/A 只適用未指派或客觀不可觀察，並須填寫原因。';end if;
   elsif i->>'rating_state'='RATED' then
    if (i->>'rating')::numeric is null or (i->>'rating')::numeric<>trunc((i->>'rating')::numeric) or (i->>'rating')::numeric not between 1 and 5 then raise exception '評級須為 1 到 5 整數。';end if;
    v_den:=v_den+w.weight;v_num:=v_num+w.weight*(i->>'rating')::numeric/5;
   else raise exception '評級狀態不正確。';end if;
  end loop;
  if v_den=0 and v_job_state<>'UNRATED' then v_job_state:='NO_DATA';end if;
  if v_job_state<>'READY' then v_state:=case when v_job_state='NO_DATA' or v_state='NO_DATA' then 'NO_DATA' else 'UNRATED' end;end if;
  v_score:=case when v_den>0 then 100*v_num/v_den else null end;
  v_jobs:=v_jobs||jsonb_build_array(jsonb_build_object('job_role',v_role,'percent',(a->>'percent')::numeric,'effective_weight',v_den,'score',v_score,'status',v_job_state));
  v_total:=v_total+coalesce(v_score,0)*(a->>'percent')::numeric/100;
 end loop;
 if v_sum<>100 then raise exception '職務配比合計必須為 100%%。';end if;
 if exists(select 1 from jsonb_array_elements(p_items) x where not exists(select 1 from jsonb_array_elements(p_allocations) alloc_entry join public.performance_role_weights weights_row on weights_row.template_id=p_template and weights_row.job_role=alloc_entry->>'job_role' where weights_row.job_role=x->>'job_role' and weights_row.criterion=x->>'criterion')) then raise exception '包含未核定的職務或指標。';end if;
 v_total:=case when v_state='READY' then round(v_total,2) else null end;
 return jsonb_build_object('status',v_state,'score',v_total,'grade',case when v_total>=90 then 'A' when v_total>=80 then 'B' when v_total>=70 then 'C' when v_total is not null then 'D' end,'roles',v_jobs,'calculation_version','decimal-v1');
end $$;

create or replace function public.performance_command_v1(p_actor uuid,p_operation text,p_payload jsonb) returns jsonb
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
 when 'review_template' then array['request_id','id','row_version','template_id','name','config','reason','confirm_reset']
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
 if p_operation in ('template_create','period_create','review_create','review_allocate','review_template','review_revise','appeal_reply') and not v_admin then raise exception '沒有管理設定權限。';end if;

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
  v_entity:='performance_reviews';select * into v_period from public.performance_periods where id=v_review.period_id;v_template:=coalesce(v_review.template_id,v_period.template_id);
  if p_operation='review_template' then
   if v_review.status<>'DRAFT' then raise exception '只有草稿可修改評核項目版本。';end if;
   if length(btrim(coalesce(p_payload->>'reason',''))) not between 2 and 2000 or p_payload->'confirm_reset' is distinct from 'true'::jsonb then raise exception '請填寫變更原因並確認清除草稿評級。';end if;
   if p_payload ? 'template_id' then
    if p_payload ? 'config' or p_payload ? 'name' then raise exception '請選擇既有版本或建立新版本，不能同時指定。';end if;
    v_template:=(p_payload->>'template_id')::uuid;
    if not exists(select 1 from public.performance_templates where id=v_template) then raise exception '找不到評核項目版本。';end if;
    if v_template=coalesce(v_review.template_id,v_period.template_id) then raise exception '此草稿已使用選取的版本。';end if;
   else
    v_value:=public.performance_command_v1(p_actor,'template_create',jsonb_build_object('request_id',v_request,'name',p_payload->'name','config',p_payload->'config'));
    v_template:=(v_value->>'id')::uuid;
   end if;
   v_review.template_id:=v_template;
   delete from public.performance_review_items where review_id=v_id;
   insert into public.performance_review_items(review_id,job_role,criterion) select v_id,w.job_role,w.criterion from public.performance_role_weights w join public.performance_role_allocations a on a.job_role=w.job_role and a.review_id=v_id where w.template_id=v_template;
  end if;
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
   if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items)<>(select count(*) from public.performance_review_items where review_id=v_id) then raise exception '請保存所有核定職務的評級。';end if;
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
   insert into public.performance_reviews(period_id,employee_id,reviewer_id,approver_id,revision,supersedes_id,revision_reason,created_by,updated_by,template_id)
    values(v_review.period_id,v_review.employee_id,v_review.reviewer_id,v_review.approver_id,v_revision,v_id,p_payload->>'reason',p_actor,p_actor,v_template) returning * into v_review;
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
   update public.performance_reviews set template_id=v_review.template_id,status=v_review.status,is_current=v_review.is_current,score=(v_calculation->>'score')::numeric,grade=v_calculation->>'grade',calculation=v_calculation,
    submitted_at=v_review.submitted_at,response_due_at=v_review.response_due_at,approved_at=v_review.approved_at,published_at=v_review.published_at,row_version=row_version+1,updated_at=now(),updated_by=p_actor where id=v_id returning * into v_review;
  end if;
  v_after:=public.performance_content_v1(v_id);
  if p_operation='appeal_reply' then v_after:=v_after||jsonb_build_object('management_reply',p_payload->>'message');end if;
  if p_operation='skill_set' then v_after:=v_after||jsonb_build_object('skill',p_payload-'request_id');end if;
  if p_operation='review_template' then v_after:=v_after||jsonb_build_object('template_change_reason',p_payload->>'reason','previous_template_id',coalesce((v_before->>'template_id')::uuid,v_period.template_id));end if;
  if p_operation='review_allocate' then v_after:=v_after||jsonb_build_object('allocation_change_reason',p_payload->>'reason');end if;
 end if;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values(v_entity,v_id,case when v_before is null then 'insert' else 'update' end,v_before,v_after||jsonb_build_object('performance_operation',p_operation,'actor_user_id',p_actor,'request_id',v_request),'performance',v_actor_name);
 v_result:=jsonb_build_object('id',v_id,'row_version',coalesce((v_after->>'row_version')::int,1),'status',v_after->>'status');
 insert into public.performance_requests values(p_actor,p_operation,v_request,v_fingerprint,v_result,now());
 return v_result;
end $$;

create or replace function public.performance_read_v1(p_actor uuid,p_mode text default 'list',p_options jsonb default '{}') returns jsonb
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
    'template',(select to_jsonb(t) from public.performance_templates t join public.performance_periods p on coalesce(v_review.template_id,p.template_id)=t.id where p.id=v_review.period_id),
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

-- CREATE OR REPLACE preserves existing ownership and ACLs; restate the RPC boundary explicitly.
revoke all on function public.performance_validate_template_v1(jsonb),public.performance_calculate_v1(uuid,jsonb,jsonb),public.performance_command_v1(uuid,text,jsonb),public.performance_read_v1(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.performance_validate_template_v1(jsonb),public.performance_calculate_v1(uuid,jsonb,jsonb),public.performance_command_v1(uuid,text,jsonb),public.performance_read_v1(uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
