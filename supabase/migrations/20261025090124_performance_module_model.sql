begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Extend the existing matrix. Existing roles receive no new permissions implicitly.
alter table public.role_permissions drop constraint role_permissions_module_check;
alter table public.role_permissions add constraint role_permissions_module_check check(module in
 ('dashboard','worklogs','purchases','pickups','inventory','customers','projects','suppliers','repairs','reports','backup','settings','site','phone','monitoring','equipment','history','credentials','monitoring_import','users','audit','appointments','purchase_prices','accounting_reports','accounting_prices','data_export','quotation_invoices','system_backups','performance'));

create table public.performance_templates(
 id uuid primary key default gen_random_uuid(), name text not null check(length(btrim(name)) between 1 and 120),
 config jsonb not null, calculation_version text not null default 'decimal-v1' check(calculation_version='decimal-v1'),
 created_by uuid not null references public.app_users, created_at timestamptz not null default now()
);
create table public.performance_role_weights(
 template_id uuid not null references public.performance_templates, job_role text not null,
 criterion text not null, weight numeric not null check(weight>=0 and weight<=100),
 primary key(template_id,job_role,criterion)
);
create table public.performance_periods(
 id uuid primary key default gen_random_uuid(), month date not null unique check(extract(day from month)=1),
 template_id uuid not null references public.performance_templates, trial_start date,
 effective_date date, response_workdays integer check(response_workdays between 1 and 30),
 business_calendar jsonb, created_by uuid not null references public.app_users, created_at timestamptz not null default now(),
 check((response_workdays is null)=(business_calendar is null))
);
create table public.performance_reviews(
 id uuid primary key default gen_random_uuid(),period_id uuid not null references public.performance_periods,
 employee_id uuid not null references public.app_users,reviewer_id uuid not null references public.app_users,
 approver_id uuid not null references public.app_users,revision integer not null default 1 check(revision>0),
 supersedes_id uuid references public.performance_reviews,revision_reason text not null default '',
 status text not null default 'DRAFT' check(status in ('DRAFT','SUBMITTED','EMPLOYEE_RESPONDED','ACK_TIMEOUT','APPROVED','PUBLISHED')),
 is_current boolean not null default false,score numeric(5,2),grade text check(grade in ('A','B','C','D')),
 calculation jsonb,submitted_at timestamptz,response_due_at timestamptz,approved_at timestamptz,published_at timestamptz,
 row_version integer not null default 1,created_by uuid not null references public.app_users,
 updated_by uuid not null references public.app_users,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(period_id,employee_id,revision),check(approver_id<>employee_id),check(reviewer_id<>employee_id),
 check(not is_current or status='PUBLISHED'),check((score is null)=(grade is null))
);
create unique index performance_current_review_idx on public.performance_reviews(period_id,employee_id) where is_current;
create unique index performance_open_review_idx on public.performance_reviews(period_id,employee_id) where status<>'PUBLISHED';
create index performance_reviewer_idx on public.performance_reviews(reviewer_id,status,period_id);
create index performance_employee_idx on public.performance_reviews(employee_id,period_id);
create index performance_approver_idx on public.performance_reviews(approver_id,status);
create index performance_revision_idx on public.performance_reviews(supersedes_id);
create table public.performance_role_allocations(
 review_id uuid not null references public.performance_reviews,job_role text not null,
 percent numeric not null check(percent>0 and percent<=100),approved_by uuid not null references public.app_users,
 approved_at timestamptz not null default now(),primary key(review_id,job_role)
);
create table public.performance_review_items(
 review_id uuid not null,job_role text not null,criterion text not null,
 rating_state text not null default 'UNRATED' check(rating_state in ('UNRATED','NA','RATED')),
 rating smallint check(rating between 1 and 5),reason text not null default '' check(length(reason)<=4000),
 na_kind text check(na_kind in ('unassigned','unobservable')),assigned boolean not null default false,
 primary key(review_id,job_role,criterion),foreign key(review_id,job_role) references public.performance_role_allocations,
 check((rating_state='RATED')=(rating is not null)),
 check(rating_state<>'NA' or (length(btrim(reason))>=2 and na_kind is not null and (na_kind<>'unassigned' or not assigned)))
);
create table public.performance_evidence_links(
 id uuid primary key default gen_random_uuid(),review_id uuid not null references public.performance_reviews,
 source_type text not null check(source_type in ('site_work_log','work_assignment','construction_plan','maintenance_event','shared_task')),
 source_id uuid not null, snapshot jsonb not null,confirmed_by uuid references public.app_users,
 created_by uuid not null references public.app_users,created_at timestamptz not null default now(),
 unique(review_id,source_type,source_id)
);
create table public.performance_responses(
 id uuid primary key default gen_random_uuid(),review_id uuid not null unique references public.performance_reviews,
 response_type text not null check(response_type in ('acknowledged','agreed','concern')),
 message text not null check(length(message)<=4000),created_by uuid not null references public.app_users,
 created_at timestamptz not null default now()
);
create table public.performance_shared_tasks(
 id uuid primary key default gen_random_uuid(),title text not null check(length(btrim(title)) between 1 and 200),
 category text not null check(category in ('tools','vehicle','materials','handover','other')),
 assignee_id uuid not null references public.app_users,assigned_by uuid not null references public.app_users,
 due_date date not null,status text not null default 'ASSIGNED' check(status in ('ASSIGNED','COMPLETED','VERIFIED','CANCELLED')),
 completion_note text not null default '' check(length(completion_note)<=4000),reason text not null default '',
 completed_at timestamptz,verified_by uuid references public.app_users,row_version integer not null default 1,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),updated_by uuid not null references public.app_users
);
create index performance_shared_assignee_idx on public.performance_shared_tasks(assignee_id,status,due_date);
create index performance_shared_assigner_idx on public.performance_shared_tasks(assigned_by);
create table public.performance_goals(
 id uuid primary key default gen_random_uuid(),review_id uuid not null references public.performance_reviews,
 description text not null check(length(btrim(description)) between 1 and 2000),due_date date not null,
 created_by uuid not null references public.app_users,created_at timestamptz not null default now()
);
create index performance_goals_review_idx on public.performance_goals(review_id);
create table public.performance_appeals(
 id uuid primary key default gen_random_uuid(),review_id uuid not null references public.performance_reviews,
 message text not null check(length(btrim(message)) between 1 and 4000),created_by uuid not null references public.app_users,
 created_at timestamptz not null default now()
);
create index performance_appeals_review_idx on public.performance_appeals(review_id);
create table public.performance_requests(
 actor_id uuid not null references public.app_users,operation text not null,request_id uuid not null,
 fingerprint text not null,result jsonb not null,created_at timestamptz not null default now(),primary key(actor_id,operation,request_id)
);
create table public.performance_skill_catalog(code text primary key,label text not null);
insert into public.performance_skill_catalog values('monitoring','監控系統'),('network','網路佈線'),('phone','電話系統'),('access','門禁系統'),('audio','音響系統');
create table public.performance_user_skills(
 id uuid primary key default gen_random_uuid(),employee_id uuid not null references public.app_users,
 skill_code text not null references public.performance_skill_catalog,level integer not null check(level between 1 and 4),
 evidence text not null check(length(btrim(evidence)) between 2 and 2000),assessor_id uuid not null references public.app_users,
 review_id uuid not null references public.performance_reviews,version integer not null check(version>0),
 created_at timestamptz not null default now(),unique(employee_id,skill_code,version),check(employee_id<>assessor_id)
);
create index performance_skill_review_idx on public.performance_user_skills(review_id);

create function public.performance_assert_actor_v1(p_actor uuid,p_action text default 'VIEW') returns void
language plpgsql security invoker set search_path='' as $$
begin
 if not public.has_app_permission_v1(p_actor,'performance',p_action) then raise exception '沒有績效管理操作權限。';end if;
 perform public.erp_private_prepare_v1(p_actor);
end $$;
create function public.performance_admin_v1(p_actor uuid) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.app_users where id=p_actor and is_active and role='admin');
$$;
create function public.performance_can_read_v1(p_actor uuid,p_review public.performance_reviews) returns boolean
language sql stable security invoker set search_path='' as $$
 select public.has_app_permission_v1(p_actor,'performance','VIEW') and
 (public.performance_admin_v1(p_actor) or p_review.reviewer_id=p_actor or p_review.approver_id=p_actor or
 (p_review.employee_id=p_actor and p_review.status<>'DRAFT'));
$$;

create function public.performance_validate_template_v1(p_config jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare r jsonb;v_codes text[];v_sum numeric;
begin
 if jsonb_typeof(p_config) is distinct from 'object' or p_config->>'schema_version' is distinct from '1.0'
 or p_config->>'timezone' is distinct from 'Asia/Taipei' or p_config->>'rounding' is distinct from 'HALF_UP' or p_config->>'score_decimals' is distinct from '2'
 or p_config->>'review_cycle' is distinct from 'monthly' then raise exception '評分模板格式或計分版本不正確。';end if;
 select array_agg(x->>'code' order by x->>'code') into v_codes from jsonb_array_elements(p_config->'criteria') x;
 if v_codes is distinct from array['LEARNING','QUALITY','RECORD','REPORT','SAFETY','SCHEDULE','TEAM'] then raise exception '必須設定七項唯一指標。';end if;
 select array_agg(x->>'code' order by x->>'code') into v_codes from jsonb_array_elements(p_config->'job_roles') x;
 if v_codes is distinct from array['construction','lead','maintenance','project_management'] then raise exception '必須設定四種唯一職務。';end if;
 if (select jsonb_agg((x->>'value')::integer order by (x->>'value')::integer) from jsonb_array_elements(p_config->'rating_levels') x) is distinct from '[1,2,3,4,5]'::jsonb
 or (select jsonb_object_agg(x->>'grade',x->'min_inclusive') from jsonb_array_elements(p_config->'grade_thresholds') x) is distinct from '{"A":90,"B":80,"C":70,"D":0}'::jsonb
 or jsonb_array_length(p_config->'grade_thresholds')<>4 then raise exception '評級或等級門檻不正確。';end if;
 for r in select * from jsonb_array_elements(p_config->'job_roles') loop
  select array_agg(key order by key),sum(value::numeric) into v_codes,v_sum from jsonb_each_text(r->'weights');
  if v_codes is distinct from array['LEARNING','QUALITY','RECORD','REPORT','SAFETY','SCHEDULE','TEAM'] or v_sum<>100
   or exists(select 1 from jsonb_each_text(r->'weights') where value::numeric<0 or value::numeric>100) then raise exception '每種職務七項權重合計必須為 100。';end if;
 end loop;
 if p_config#>>'{policy,self_approve_forbidden}' is distinct from 'true' or p_config#>>'{policy,published_review_immutable}' is distinct from 'true'
 or p_config#>>'{policy,automated_negative_score_from_leave}' is distinct from 'false' then raise exception '模板不可停用既有績效防護。';end if;
end $$;

-- Pure calculation, also used by the transactional workflow. Never trusts submitted totals.
create function public.performance_calculate_v1(p_template uuid,p_allocations jsonb,p_items jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare a jsonb;i jsonb;w record;v_sum numeric:=0;v_den numeric;v_num numeric;v_total numeric:=0;v_score numeric;
 v_jobs jsonb:='[]';v_state text:='READY';v_job_state text;v_seen text[];v_role text;
begin
 if jsonb_typeof(p_allocations) is distinct from 'array' or jsonb_array_length(p_allocations) not between 1 and 4
 or jsonb_typeof(p_items) is distinct from 'array' then raise exception '職務配比與評級格式不正確。';end if;
 if exists(select 1 from jsonb_array_elements(p_allocations) x group by x->>'job_role' having count(*)>1)
 or exists(select 1 from jsonb_array_elements(p_items) x group by x->>'job_role',x->>'criterion' having count(*)>1) then raise exception '職務或指標不可重複。';end if;
 for a in select * from jsonb_array_elements(p_allocations) loop
  if (a->>'percent')::numeric is null or (a->>'percent')::numeric<=0 or (a->>'percent')::numeric>100 then raise exception '職務配比須大於 0。';end if;
  v_sum:=v_sum+(a->>'percent')::numeric;v_role:=a->>'job_role';v_den:=0;v_num:=0;v_job_state:='READY';
  if (select count(*) from public.performance_role_weights where template_id=p_template and job_role=v_role)<>7 then raise exception '找不到職務權重。';end if;
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

-- Defense in depth: immutable published content, including child rows.
create function public.performance_immutable_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare v_review uuid;
begin
 if tg_table_name='performance_reviews' then
  if old.status='PUBLISHED' and (tg_op='DELETE' or (to_jsonb(new)-'is_current') is distinct from (to_jsonb(old)-'is_current') or new.is_current) then raise exception '已發布評核不可修改，請建立新修訂。';end if;
 else
  v_review:=case when tg_op='DELETE' then old.review_id else new.review_id end;
  if exists(select 1 from public.performance_reviews where id=v_review and status='PUBLISHED') then raise exception '已發布內容已封存。';end if;
 end if;
 if tg_op='DELETE' then return old;else return new;end if;
end $$;
create trigger performance_review_immutable before update or delete on public.performance_reviews for each row execute function public.performance_immutable_v1();
do $$ declare t text;begin
 foreach t in array array['role_allocations','review_items','evidence_links','responses','goals'] loop
 execute format('create trigger performance_child_immutable before insert or update or delete on public.performance_%I for each row execute function public.performance_immutable_v1()',t);
 end loop;
end $$;

-- No browser/client grants. All actor arguments originate in authenticated Gateway.
do $$ declare r record;begin
 for r in select tablename from pg_tables where schemaname='public' and tablename like 'performance\_%' escape '\' loop
 execute format('alter table public.%I enable row level security; revoke all on public.%I from public,anon,authenticated; grant select,insert,update,delete on public.%I to service_role',r.tablename,r.tablename,r.tablename);
 end loop;
 for r in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'performance\_%' escape '\' loop
 execute format('revoke all on function %s from public,anon,authenticated;grant execute on function %s to service_role',r.signature,r.signature);
 end loop;
end $$;
commit;
