-- Extend existing users and work logs; no alternative account or worker master.
alter table public.app_users add column can_work_on_site boolean not null default true;
update public.app_users set can_work_on_site=false where lower(btrim(display_name)) in ('老闆娘','joyce');
alter table public.site_work_logs add column reporter_on_site boolean not null default true,
 add column subcontractor_count integer not null default 0 check(subcontractor_count between 0 and 1000);
alter table public.construction_plans add column subcontractor_count integer not null default 0 check(subcontractor_count between 0 and 1000);
alter table public.work_log_save_requests add column workforce_payload jsonb;

create function public.work_log_pending_lines_v1(p_log public.site_work_logs)
returns table(pending_text text) language sql immutable security invoker set search_path='' as $$
 select distinct btrim(line) from regexp_split_to_table(
  case when p_log.pending_content is not null then p_log.pending_content
   when p_log.status='in_progress' then coalesce(p_log.summary,'') else '' end,E'\r?\n') line where btrim(line)<>'';
$$;

create function public.pending_work_log_items_v1(p_actor_user_id uuid,p_project_id uuid,p_log_date date,p_exclude_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb:='[]'; r public.site_work_logs; item record; allowed boolean; project_visible boolean;
begin
 if p_log_date is null then raise exception '請選擇工作日期。'; end if;
 if not public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW') then raise exception '沒有工作日誌查看權限。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 project_visible:=public.has_project_permission_v1(p_actor_user_id,p_project_id,'VIEW');
 if not project_visible then perform public.construction_scope_v1(p_actor_user_id,p_project_id);end if;
 for r in select l.* from public.site_work_logs l where l.project_id=p_project_id and l.deleted_at is null
  and l.id is distinct from p_exclude_id and l.log_date<p_log_date and l.status in ('in_progress','completed')
  and (project_visible or l.construction_plan_id is not null)
  and nullif(btrim(coalesce(l.pending_content,case when l.status='in_progress' then l.summary end,'')),'') is not null
  and l.work_type not in ('文書作業','送貨','維修紀錄') and public.erp_private_json_visible_v1(to_jsonb(l))
  order by l.log_date,l.id loop
  if r.construction_plan_id is not null and not public.construction_log_visible_v1(p_actor_user_id,r) then continue; end if;
  allowed:=true;
  begin perform public.assert_work_log_access_v1(p_actor_user_id,r.project_id,r.id,'UPDATE'); exception when others then allowed:=false; end;
  for item in select * from public.work_log_pending_lines_v1(r) order by pending_text loop
   result:=result||jsonb_build_array(jsonb_build_object('source_log_id',r.id,'row_version',r.row_version,'log_date',r.log_date,
     'pending_text',item.pending_text,'can_complete',allowed));
  end loop;
 end loop;
 return jsonb_build_object('items',result);
end $$;

-- This transaction reuses the current writer, permission checks, audit and replay table.
create function public.save_work_log_workforce_v1(p_actor_user_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_id uuid:=(p_payload->>'id')::uuid; v_plan uuid:=(p_payload->>'construction_plan_id')::uuid;
 v_project uuid:=(p_payload->>'project_id')::uuid; v_request uuid:=(p_payload->>'request_id')::uuid;
 v_date date:=(p_payload->>'log_date')::date; v_users uuid[]; v_result jsonb; v_previous public.work_log_save_requests;
 v_sources jsonb:=coalesce(p_payload->'resolved_pending_items','[]'); v_item jsonb; v_source public.site_work_logs;
 v_log public.site_work_logs; v_before public.site_work_logs; v_count integer; v_onsite boolean;
 v_pending text; v_completed text; v_notes text[]:='{}'; v_actor text; v_text text; v_body jsonb:=p_payload;
begin
 if v_request is null then raise exception '缺少工作日誌送出識別碼。';end if;
 if v_plan is not null then perform public.assert_construction_log_access_v1(p_actor_user_id,v_plan,v_id,case when v_id is null then 'CREATE' else 'UPDATE' end);
 else perform public.assert_work_log_access_v1(p_actor_user_id,v_project,v_id,case when v_id is null then 'CREATE' else 'UPDATE' end); end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform pg_advisory_xact_lock(hashtextextended(v_request::text,0));
 select * into v_previous from public.work_log_save_requests where request_id=v_request;
 if found then
  if v_previous.reporter_id is distinct from p_actor_user_id or v_previous.workforce_payload is distinct from p_payload then raise exception '送出識別碼已使用，請重新載入。';end if;
  return v_previous.result;
 end if;
 if jsonb_typeof(p_payload->'reporter_on_site') is distinct from 'boolean'
  or jsonb_typeof(p_payload->'subcontractor_count') is distinct from 'number'
  or (p_payload->>'subcontractor_count')::numeric<>trunc((p_payload->>'subcontractor_count')::numeric)
  or (p_payload->>'subcontractor_count')::numeric not between 0 and 1000
  or jsonb_typeof(v_sources)<>'array' or jsonb_array_length(v_sources)>100 then raise exception '到場、代工人數或待辦資料不正確。';end if;
 v_count:=(p_payload->>'subcontractor_count')::integer;v_onsite:=(p_payload->>'reporter_on_site')::boolean;
 select coalesce(array_agg(value::uuid),'{}') into v_users from jsonb_array_elements_text(p_payload->'worker_user_ids');
 if not v_onsite and p_actor_user_id=any(v_users) then raise exception '未至現場的填寫人不可同時列為施工人員。';end if;
 if exists(select 1 from unnest(v_users) w(id) join public.app_users u on u.id=w.id where not u.can_work_on_site
  and not exists(select 1 from public.site_work_log_workers old where old.work_log_id=v_id and old.user_id=w.id)) then raise exception '所選帳號不列入施工人員選項。';end if;
 if jsonb_array_length(v_sources)>0 and (v_project is null or p_payload->'completed_content'='null'::jsonb or p_payload->>'completed_content' is null) then raise exception '此日誌無法結案先前待辦。';end if;
 if (select count(*) from jsonb_array_elements(v_sources))<>(select count(distinct (i->>'source_log_id',i->>'pending_text')) from jsonb_array_elements(v_sources)i) then raise exception '待辦項目不可重複。';end if;
 select username into v_actor from public.app_users where id=p_actor_user_id and is_active;
 -- Deterministic locking, original versions checked before any source is changed.
 for v_source in select l.* from public.site_work_logs l where l.id in(select (i->>'source_log_id')::uuid from jsonb_array_elements(v_sources)i) order by l.id for update loop
  if v_source.id is not distinct from v_id or v_source.project_id is distinct from v_project or v_source.deleted_at is not null
   or v_source.log_date>=v_date or v_source.status not in ('in_progress','completed') or v_source.work_type in ('文書作業','送貨','維修紀錄') then raise exception '待辦不屬於此工作內容的較早未完成日誌。';end if;
  perform public.erp_private_assert_v1(to_jsonb(v_source));
  perform public.assert_work_log_access_v1(p_actor_user_id,v_project,v_source.id,'UPDATE');
  for v_item in select i from jsonb_array_elements(v_sources)i where (i->>'source_log_id')::uuid=v_source.id loop
   if (v_item->>'row_version')::integer is distinct from v_source.row_version then raise exception '先前日誌已更新，請重新讀取未完成項目。';end if;
   if not exists(select 1 from public.work_log_pending_lines_v1(v_source) where pending_text=v_item->>'pending_text') then raise exception '待辦內容已變更或已完成，請重新讀取。';end if;
  end loop;
 end loop;
 if exists(select 1 from jsonb_array_elements(v_sources)i where not exists(select 1 from public.site_work_logs l where l.id=(i->>'source_log_id')::uuid)) then raise exception '找不到先前日誌。';end if;
 for v_item in select i from jsonb_array_elements(v_sources)i order by i->>'source_log_id',i->>'pending_text' loop
  v_notes:=array_append(v_notes,'['||(v_item->>'pending_text')||']('||to_char(v_date,'MM-DD')||'已完成)');
 end loop;
 v_completed:=p_payload->>'completed_content';
 foreach v_text in array v_notes loop
  if not v_text=any(regexp_split_to_array(coalesce(v_completed,''),E'\r?\n')) then v_completed:=concat_ws(E'\n',nullif(btrim(v_completed),''),v_text);end if;
 end loop;
 if v_completed is not null then v_body:=v_body||jsonb_build_object('completed_content',v_completed,'summary',concat_ws(E'\n',nullif(btrim(v_completed),''),nullif(btrim(p_payload->>'pending_content'),'')));end if;
 if v_plan is not null then v_result:=public.save_construction_work_log_v1(p_actor_user_id,v_plan,v_body);
 else v_result:=public.upsert_work_log_sections_v1(v_id,(v_body->>'row_version')::integer,v_project,(v_body->>'customer_id')::uuid,v_body->>'project_name',
  v_date,v_body->>'work_type',v_body->>'summary',v_body->>'time_period',v_body->>'status',v_users,p_actor_user_id,
  coalesce(v_body->'maintenance_events','[]'),v_actor,(v_body->>'department_id')::uuid,v_request,v_body->>'completed_content',v_body->>'pending_content');end if;
 select * into v_before from public.site_work_logs where id=(v_result#>>'{work_log,id}')::uuid;
 update public.site_work_logs set reporter_on_site=v_onsite,subcontractor_count=v_count,updated_by=v_actor
  where id=v_before.id and (reporter_on_site,subcontractor_count) is distinct from (v_onsite,v_count) returning * into v_log;
 if not found then v_log:=v_before;else
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor) values('site_work_logs',v_log.id,'update',to_jsonb(v_before),to_jsonb(v_log),'web',v_actor);
 end if;
 for v_source in select l.* from public.site_work_logs l where l.id in(select (i->>'source_log_id')::uuid from jsonb_array_elements(v_sources)i) order by l.id loop
  select string_agg(pending_text,E'\n' order by pending_text) into v_pending from public.work_log_pending_lines_v1(v_source) p
   where not exists(select 1 from jsonb_array_elements(v_sources)i where (i->>'source_log_id')::uuid=v_source.id and i->>'pending_text'=p.pending_text);
  v_completed:=coalesce(v_source.completed_content,'');
  for v_item in select i from jsonb_array_elements(v_sources)i where (i->>'source_log_id')::uuid=v_source.id order by i->>'pending_text' loop
   v_completed:=concat_ws(E'\n',nullif(v_completed,''),'['||(v_item->>'pending_text')||']('||to_char(v_date,'MM-DD')||'已完成)');
  end loop;
  update public.site_work_logs set completed_content=v_completed,pending_content=coalesce(v_pending,''),summary=concat_ws(E'\n',nullif(v_completed,''),nullif(v_pending,'')),
   status=case when coalesce(v_pending,'')='' then 'completed' else 'in_progress' end,updated_by=v_actor where id=v_source.id returning * into v_before;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
   values('site_work_logs',v_source.id,'update',to_jsonb(v_source),to_jsonb(v_before)||jsonb_build_object('resolved_in_work_log_id',v_log.id),'web',v_actor);
 end loop;
 v_result:=v_result||jsonb_build_object('work_log',to_jsonb(v_log),'resolved_pending_items',v_sources);
 update public.work_log_save_requests set workforce_payload=p_payload,result=v_result where request_id=v_request and reporter_id=p_actor_user_id;
 if not found then raise exception '日誌送出紀錄遺失，操作已取消。';end if;
 return v_result;
end $$;

-- Wages are project-specific costs related to existing users, not another worker directory.
create table public.accounting_worker_wages(
 id uuid primary key default gen_random_uuid(),project_id uuid not null references public.projects(id) on delete restrict,
 worker_user_id uuid references public.app_users(id) on delete restrict,
 daily_wage numeric(14,2) not null check(daily_wage>=0 and daily_wage<1000000000000),
 row_version integer not null default 1,updated_by_user_id uuid not null references public.app_users(id),updated_at timestamptz not null default now(),
 unique nulls not distinct(project_id,worker_user_id)
);
create index accounting_worker_wages_user_idx on public.accounting_worker_wages(worker_user_id);
create index accounting_worker_wages_actor_idx on public.accounting_worker_wages(updated_by_user_id);
alter table public.accounting_worker_wages enable row level security;
revoke all on public.accounting_worker_wages from public,anon,authenticated;
grant select,insert,update,delete on public.accounting_worker_wages to service_role;
grant select,update on public.work_log_save_requests to service_role;

create function public.save_accounting_worker_wage_v1(p_actor_user_id uuid,p_project_id uuid,p_worker_user_id uuid,p_daily_wage numeric,p_row_version integer default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare old public.accounting_worker_wages; after_row public.accounting_worker_wages; needed text;
begin
 perform public.work_content_report_v1(p_actor_user_id,p_project_id,null,null,null,true);
 perform pg_advisory_xact_lock(hashtextextended(p_project_id::text||coalesce(p_worker_user_id::text,'subcontractor'),0));
 select * into old from public.accounting_worker_wages where project_id=p_project_id and worker_user_id is not distinct from p_worker_user_id for update;
 if old.row_version is distinct from p_row_version then raise exception '工資已被其他人修改，請重新讀取。';end if;
 needed:=case when p_daily_wage is null then 'DELETE' when old.id is null then 'CREATE' else 'UPDATE' end;
 if not public.has_app_permission_v1(p_actor_user_id,'accounting_prices','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'accounting_prices',needed) then raise exception '沒有工資操作權限。';end if;
 if not exists(select 1 from public.site_work_logs l where l.project_id=p_project_id and l.deleted_at is null and public.erp_private_json_visible_v1(to_jsonb(l))
  and (case when p_worker_user_id is null then l.subcontractor_count>0 else exists(select 1 from public.site_work_log_workers w where w.work_log_id=l.id and w.user_id=p_worker_user_id and (l.reporter_on_site or w.user_id is distinct from l.reporter_user_id)) end)) then raise exception '此工作內容沒有該施工人員紀錄。';end if;
 if p_daily_wage is not null and (p_daily_wage<0 or p_daily_wage>=1000000000000 or p_daily_wage<>round(p_daily_wage,2)) then raise exception '每日工資須為非負金額，最多小數二位。';end if;
 if p_daily_wage is null then delete from public.accounting_worker_wages where id=old.id;
 else insert into public.accounting_worker_wages(project_id,worker_user_id,daily_wage,updated_by_user_id)
  values(p_project_id,p_worker_user_id,p_daily_wage,p_actor_user_id) on conflict(project_id,worker_user_id) do update
  set daily_wage=excluded.daily_wage,row_version=accounting_worker_wages.row_version+1,updated_at=now(),updated_by_user_id=p_actor_user_id returning * into after_row;
 end if;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
  values('accounting_worker_wages',coalesce(after_row.id,old.id),case when p_daily_wage is null then 'delete' when old.id is null then 'insert' else 'update' end,to_jsonb(old),to_jsonb(after_row),'web',(select username from public.app_users where id=p_actor_user_id));
 return jsonb_build_object('saved',true,'row_version',after_row.row_version);
end $$;

revoke all on function public.work_log_pending_lines_v1(public.site_work_logs),public.pending_work_log_items_v1(uuid,uuid,date,uuid),public.save_work_log_workforce_v1(uuid,jsonb),public.save_accounting_worker_wage_v1(uuid,uuid,uuid,numeric,integer) from public,anon,authenticated;
grant execute on function public.work_log_pending_lines_v1(public.site_work_logs),public.pending_work_log_items_v1(uuid,uuid,date,uuid),public.save_work_log_workforce_v1(uuid,jsonb),public.save_accounting_worker_wage_v1(uuid,uuid,uuid,numeric,integer) to service_role;

CREATE OR REPLACE FUNCTION public.save_construction_plan_without_items_v1(p_actor_user_id uuid, p_payload jsonb, p_delete boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_id uuid:=(p_payload->>'id')::uuid; v_project public.projects; v_old public.construction_plans;
 v_new public.construction_plans; v_users uuid[]; v_before jsonb; v_after jsonb; v_count integer;
begin
 if v_id is null then raise exception '缺少施工規劃編號。'; end if;
 select * into v_old from public.construction_plans where id=v_id for update;
 if p_delete or p_payload->>'row_version' is not null then
  if v_old.id is null or v_old.deleted_at is not null then raise exception '找不到施工規劃。'; end if;
  if (p_payload->>'row_version')::integer is distinct from v_old.row_version then raise exception '施工規劃已被其他使用者更新，請重新載入。'; end if;
 elsif v_old.id is not null then raise exception '施工規劃已建立，請重新整理，勿重複送出。'; end if;
 select * into v_project from public.projects where id=coalesce(v_old.project_id,(p_payload->>'project_id')::uuid) for update;
 if not found or v_project.deleted_at is not null then raise exception '找不到工作內容。'; end if;
 if not public.construction_project_access_v1(p_actor_user_id,v_project.id,true) then raise exception '只有工作內容負責人或管理員可以管理施工規劃。'; end if;
 if not p_delete and (v_project.project_type<>'construction' or coalesce(v_project.construction_category,'') not in ('small_purchase','tender')) then raise exception '僅工程施工的小額採購或標案可使用施工規劃。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform public.erp_private_assert_v1(to_jsonb(v_project));
 if v_old.id is not null then
  select to_jsonb(v_old)||jsonb_build_object('assignee_user_ids',coalesce(jsonb_agg(user_id),'[]')) into v_before from public.construction_plan_assignees where construction_plan_id=v_id;
 end if;
 if p_delete then
  if exists(select 1 from public.site_work_logs where construction_plan_id=v_id) then raise exception '此施工規劃已有工作日誌，請改為取消，保留歷史關聯。'; end if;
  update public.construction_plans set deleted_at=now(),updated_at=now(),row_version=row_version+1 where id=v_id returning * into v_new;
 else
  if (p_payload->>'project_id')::uuid is distinct from v_project.id then raise exception '不能變更施工規劃的工作內容。'; end if;
  if jsonb_typeof(p_payload->'assignee_user_ids') is distinct from 'array' then raise exception '請選擇有效的施工人員。'; end if;
  v_count:=coalesce((p_payload->>'subcontractor_count')::integer,v_old.subcontractor_count,0);
  if v_count not between 0 and 1000 then raise exception '代工人數不正確。';end if;
  if p_payload ? 'subcontractor_count' and (jsonb_typeof(p_payload->'subcontractor_count')<>'number' or (p_payload->>'subcontractor_count')::numeric<>v_count) then raise exception '代工人數須為整數。';end if;
  select coalesce(array_agg(value::uuid),'{}') into v_users from jsonb_array_elements_text(p_payload->'assignee_user_ids');
  if coalesce(cardinality(v_users),0) not between 0 and 30 or (cardinality(v_users)=0 and v_count=0) or array_position(v_users,null) is not null
   or cardinality(v_users)<>(select count(distinct id) from unnest(v_users) id)
   or exists(select 1 from unnest(v_users) x(id) where not exists(select 1 from public.app_users where id=x.id and is_active)) then raise exception '請選擇 1 至 30 位不重複的啟用中施工人員。'; end if;
  if exists(select 1 from unnest(v_users) w(id) join public.app_users u on u.id=w.id where not u.can_work_on_site and not exists(select 1 from public.construction_plan_assignees a where a.construction_plan_id=v_id and a.user_id=w.id)) then raise exception '所選帳號不列入施工人員選項。';end if;
  if nullif(btrim(p_payload->>'content'),'') is null or length(p_payload->>'content')>2000 or length(coalesce(p_payload->>'notes',''))>2000
   or coalesce(p_payload->>'status','') not in ('pending','in_progress','completed','cancelled') or nullif(p_payload->>'construction_date','') is null then raise exception '施工日期、內容或狀態不正確。'; end if;
  if v_old.id is null then
   insert into public.construction_plans(id,project_id,construction_date,content,status,notes,created_by_user_id,planned_days,subcontractor_count)
   values(v_id,v_project.id,(p_payload->>'construction_date')::date,btrim(p_payload->>'content'),p_payload->>'status',coalesce(p_payload->>'notes',''),p_actor_user_id,nullif(p_payload->>'planned_days','')::integer,v_count) returning * into v_new;
  else
   update public.construction_plans set subcontractor_count=v_count,construction_date=(p_payload->>'construction_date')::date,content=btrim(p_payload->>'content'),planned_days=case when p_payload ? 'planned_days' then nullif(p_payload->>'planned_days','')::integer else planned_days end,status=p_payload->>'status',notes=coalesce(p_payload->>'notes',''),updated_at=now(),row_version=row_version+1 where id=v_id returning * into v_new;
  end if;
  delete from public.construction_plan_assignees where construction_plan_id=v_id and not(user_id=any(v_users));
  insert into public.construction_plan_assignees select v_id,id from unnest(v_users) id on conflict do nothing;
 end if;
 select to_jsonb(v_new)||jsonb_build_object('assignee_user_ids',coalesce(jsonb_agg(user_id),'[]')) into v_after from public.construction_plan_assignees where construction_plan_id=v_id;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('construction_plans',v_id,case when p_delete then 'delete' when v_old.id is null then 'insert' else 'update' end,v_before,v_after,'web',(select username from public.app_users where id=p_actor_user_id));
 return v_after;
end $function$;

CREATE OR REPLACE FUNCTION public.assert_construction_log_access_v1(p_user_id uuid, p_plan_id uuid, p_log_id uuid, p_action text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_plan public.construction_plans; v_project public.projects; v_log public.site_work_logs;
begin
 if not public.has_app_permission_v1(p_user_id,'worklogs',p_action) then raise exception '沒有工作日誌操作權限。'; end if;
 -- Serialize reassignment/deletion with log saves; removed workers cannot race a save.
 select * into v_plan from public.construction_plans where id=p_plan_id for update;
 if not found then raise exception '找不到施工規劃。'; end if;
 select * into v_project from public.projects where id=v_plan.project_id for update;
 perform public.erp_private_prepare_v1(p_user_id);
 perform public.erp_private_assert_v1(to_jsonb(v_project));
 if p_log_id is null then
  if p_action<>'CREATE' or v_plan.deleted_at is not null or v_plan.status='cancelled' or v_project.deleted_at is not null
   or v_project.project_type<>'construction' or coalesce(v_project.construction_category,'') not in ('small_purchase','tender')
   or not (exists(select 1 from public.construction_plan_assignees where construction_plan_id=p_plan_id and user_id=p_user_id) or public.construction_project_access_v1(p_user_id,v_project.id,true))
  then raise exception '只有指派施工人員、工作內容負責人或管理員可以新增此規劃日誌。'; end if;
 else
  select * into v_log from public.site_work_logs where id=p_log_id and deleted_at is null for update;
  if not found or v_log.construction_plan_id is distinct from p_plan_id then raise exception '日誌與施工規劃不相符。'; end if;
  perform public.erp_private_assert_v1(to_jsonb(v_log));
  if p_action='VIEW' then
   if not public.construction_log_visible_v1(p_user_id,v_log) then raise exception '沒有此施工日誌查看權限。'; end if;
  elsif v_log.access_creator_user_id is distinct from p_user_id
   and not exists(select 1 from public.app_users where id=p_user_id and is_active and role='admin') then
   raise exception '只能修改或刪除自己建立的施工日誌。';
  end if;
 end if;
end $function$;

CREATE OR REPLACE FUNCTION public.construction_scope_without_progress_v1(p_actor_user_id uuid, p_project_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_projects uuid[]; v_plans uuid[]; v_logs uuid[]; v_result jsonb;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') and not public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW') then
  raise exception '沒有施工規劃查看權限。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 select coalesce(array_agg(p.id),'{}') into v_projects from public.projects p where p.deleted_at is null
 and (p_project_id is null or p.id=p_project_id) and public.erp_private_json_visible_v1(to_jsonb(p))
 and ((p.project_type='construction' and p.construction_category in ('small_purchase','tender')) or exists(select 1 from public.construction_plans where project_id=p.id))
 and (public.construction_project_access_v1(p_actor_user_id,p.id,false)
 or public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW') and exists(select 1 from public.construction_plans c where c.project_id=p.id
  and (exists(select 1 from public.construction_plan_assignees a where a.construction_plan_id=c.id and a.user_id=p_actor_user_id)
   or exists(select 1 from public.site_work_logs l where l.construction_plan_id=c.id and l.access_creator_user_id=p_actor_user_id))));
 if p_project_id is not null and not(p_project_id=any(v_projects)) then raise exception '找不到施工工作內容或沒有查看權限。'; end if;
 select coalesce(array_agg(c.id),'{}') into v_plans from public.construction_plans c where c.project_id=any(v_projects) and c.deleted_at is null
 and (public.construction_project_access_v1(p_actor_user_id,c.project_id,false)
 or exists(select 1 from public.construction_plan_assignees a where a.construction_plan_id=c.id and a.user_id=p_actor_user_id)
 or exists(select 1 from public.site_work_logs l where l.construction_plan_id=c.id and l.access_creator_user_id=p_actor_user_id));
 select coalesce(array_agg(l.id),'{}') into v_logs from public.site_work_logs l where l.construction_plan_id=any(v_plans) and l.deleted_at is null
 and public.construction_log_visible_v1(p_actor_user_id,l) and public.erp_private_json_visible_v1(to_jsonb(l));
 select jsonb_build_object(
 'construction_plans',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object(
  'assignee_user_ids',coalesce((select jsonb_agg(user_id order by user_id) from public.construction_plan_assignees where construction_plan_id=c.id),'[]'),
  'can_manage',public.construction_project_access_v1(p_actor_user_id,c.project_id,true),
  'can_create_log',public.has_app_permission_v1(p_actor_user_id,'worklogs','CREATE') and c.status<>'cancelled'
   and exists(select 1 from public.projects where id=c.project_id and project_type='construction' and construction_category in ('small_purchase','tender'))
   and (exists(select 1 from public.construction_plan_assignees where construction_plan_id=c.id and user_id=p_actor_user_id) or public.construction_project_access_v1(p_actor_user_id,c.project_id,true))) order by c.construction_date,c.created_at,c.id) from public.construction_plans c where c.id=any(v_plans)),'[]'),
 'projects',coalesce((select jsonb_agg(to_jsonb(p)) from public.projects p where p.id=any(v_projects)),'[]'),
 'customers',coalesce((select jsonb_agg(to_jsonb(c)) from public.customers c where c.id in(select customer_id from public.projects where id=any(v_projects))),'[]'),
 'site_work_logs',coalesce((select jsonb_agg(to_jsonb(l)) from public.site_work_logs l where l.id=any(v_logs)),'[]'),
 'site_work_log_workers',coalesce((select jsonb_agg(to_jsonb(w)) from public.site_work_log_workers w where w.work_log_id=any(v_logs)),'[]'),
 'project_workers',coalesce((select jsonb_agg(to_jsonb(w)) from public.project_workers w where w.project_id=any(v_projects) and w.is_assignee),'[]'),
 'site_workers',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'display_name',u.display_name,'is_active',u.is_active,'can_work_on_site',u.can_work_on_site)) from public.app_users u where u.is_active
 or u.id in(select access_creator_user_id from public.site_work_logs where id=any(v_logs))),'[]')) into v_result;
 return v_result;
end $function$;

alter table public.stock_transaction_documents add column receipt_discount_amount numeric(14,0) not null default 0 check(receipt_discount_amount>=0);
create function public.receipt_money_totals_v2(p_lines jsonb,p_mode text,p_rate integer,p_discount numeric default 0)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare base jsonb; amount numeric; net numeric; tax numeric; total numeric;
begin
 base:=public.receipt_money_totals_v1(p_lines,p_mode,p_rate);amount:=(base->>'input_amount')::numeric;
 if p_discount is null or p_discount<0 or p_discount<>trunc(p_discount) or p_discount>=100000000000000 then raise exception '折扣須為非負整數金額。';end if;
 if (base->>'missing_price_count')::integer=0 and p_discount>amount then raise exception '折扣不可超過進貨金額。';end if;
 if p_mode is not null and (base->>'missing_price_count')::integer=0 then
  if p_mode='inclusive' then total:=amount-p_discount;net:=round(total*10000/(10000+p_rate),0);tax:=total-net;
  else net:=amount-p_discount;tax:=round(net*p_rate/10000,0);total:=net+tax;end if;
 end if;
 return base||jsonb_build_object('discount_amount',p_discount,'net_amount',net,'tax_amount',tax,'total_amount',total);
end $$;
revoke all on function public.receipt_money_totals_v2(jsonb,text,integer,numeric) from public,anon,authenticated;
grant execute on function public.receipt_money_totals_v2(jsonb,text,integer,numeric) to service_role;

CREATE OR REPLACE FUNCTION public.stock_receipt_financials_v1(p_document_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select public.receipt_money_totals_v2(
 coalesce((select jsonb_agg(jsonb_build_object('quantity',s.quantity,'unit_price',s.unit_price))
 from public.stock_receipts s where s.receipt_document_id=d.id),'[]'),d.receipt_tax_mode,d.receipt_tax_rate_basis_points,d.receipt_discount_amount)
 from public.stock_transaction_documents d where d.kind='receipt' and d.id=p_document_id;
$function$;

CREATE OR REPLACE FUNCTION public.save_stock_receipt_document_v4(p_document_id uuid, p_create boolean, p_existing jsonb, p_receipt_date date, p_supplier_id uuid, p_rows jsonb, p_customer_ids uuid[], p_customer_departments jsonb, p_actor_user_id uuid, p_document_no text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare d public.stock_transaction_documents; result jsonb; financials jsonb; mode text; rate integer; project uuid; needed text; discount numeric;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_document_id::text,0));
 select * into d from public.stock_transaction_documents where kind='receipt' and id=p_document_id for update;
 if jsonb_typeof(p_metadata)<>'object' or exists(select 1 from jsonb_object_keys(p_metadata) k where k not in ('tax_mode','tax_rate_basis_points','project_id','discount_amount')) then raise exception '進貨單設定不正確。';end if;
 mode:=d.receipt_tax_mode;rate:=d.receipt_tax_rate_basis_points;project:=d.receipt_project_id;
 if p_metadata ? 'tax_mode' or p_metadata ? 'tax_rate_basis_points' then
  if not (p_metadata ? 'tax_mode' and p_metadata ? 'tax_rate_basis_points') then raise exception '請完整填寫計價模式與稅率。';end if;
  if jsonb_typeof(p_metadata->'tax_rate_basis_points')<>'number' or (p_metadata->>'tax_rate_basis_points')::numeric<>trunc((p_metadata->>'tax_rate_basis_points')::numeric) then raise exception '稅率不正確。';end if;
  mode:=p_metadata->>'tax_mode';rate:=(p_metadata->>'tax_rate_basis_points')::integer;
  if mode not in ('exclusive','inclusive') or mode is null or rate is null or rate<0 or rate>10000 then raise exception '計價模式或稅率不正確。';end if;
  if mode is distinct from d.receipt_tax_mode or rate is distinct from d.receipt_tax_rate_basis_points then
   needed:=case when d.receipt_tax_mode is null then 'CREATE' else 'UPDATE' end;
   if not public.has_app_permission_v1(p_actor_user_id,'purchase_prices','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'purchase_prices',needed) then raise exception '沒有進貨價格操作權限。';end if;
  end if;
 end if;
 discount:=coalesce(d.receipt_discount_amount,0);
 if p_metadata ? 'discount_amount' then
  if jsonb_typeof(p_metadata->'discount_amount') is distinct from 'number' then raise exception '折扣金額不正確。';end if;
  discount:=(p_metadata->>'discount_amount')::numeric;
  if discount<0 or discount<>trunc(discount) or discount>=100000000000000 then raise exception '折扣須為非負整數金額。';end if;
  if discount is distinct from coalesce(d.receipt_discount_amount,0) then
   needed:=case when d.receipt_tax_mode is null then 'CREATE' else 'UPDATE' end;
   if not public.has_app_permission_v1(p_actor_user_id,'purchase_prices','VIEW') or not public.has_app_permission_v1(p_actor_user_id,'purchase_prices',needed) then raise exception '沒有進貨價格操作權限。';end if;
  end if;
 end if;
 if p_metadata ? 'project_id' then project:=nullif(p_metadata->>'project_id','')::uuid; end if;
 if project is not null then
  perform public.erp_private_prepare_v1(p_actor_user_id);
  if not public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') or not exists(
   select 1 from public.projects p join public.app_users u on u.id=p_actor_user_id and u.is_active
   join public.app_roles r on r.code=u.role where p.id=project and p.deleted_at is null
   and p.customer_id=any(p_customer_ids) and public.erp_private_json_visible_v1(to_jsonb(p))
   and (not r.project_scoped or exists(select 1 from public.project_workers w where w.project_id=p.id and w.user_id=u.id and (w.can_view or w.is_assignee))))
   then raise exception '所選工作內容不屬於訂貨客戶，或沒有查看權限。';end if;
 end if;
 -- Existing v3 checks stock permissions, per-price CREATE/UPDATE/DELETE, private
 -- visibility, optimistic row versions, numbering and inventory in one transaction.
 result:=public.save_stock_receipt_document_v3(p_document_id,p_create,p_existing,p_receipt_date,p_supplier_id,p_rows,p_customer_ids,p_customer_departments,p_actor_user_id,p_document_no);
 update public.stock_transaction_documents set receipt_discount_amount=discount,receipt_tax_mode=mode,receipt_tax_rate_basis_points=rate,receipt_project_id=project where kind='receipt' and id=p_document_id;
 if (mode,rate,project,discount) is distinct from (d.receipt_tax_mode,d.receipt_tax_rate_basis_points,d.receipt_project_id,coalesce(d.receipt_discount_amount,0)) then
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
  values('stock_transaction_documents',p_document_id,'update',jsonb_build_object('receipt_discount_amount',d.receipt_discount_amount,'receipt_tax_mode',d.receipt_tax_mode,'receipt_tax_rate_basis_points',d.receipt_tax_rate_basis_points,'receipt_project_id',d.receipt_project_id),
  jsonb_build_object('receipt_discount_amount',discount,'receipt_tax_mode',mode,'receipt_tax_rate_basis_points',rate,'receipt_project_id',project),'web',(select username from public.app_users where id=p_actor_user_id));
 end if;
 -- Compute from saved quantities/prices, never accept client totals.
 financials:=public.stock_receipt_financials_v1(p_document_id);
 if public.has_app_permission_v1(p_actor_user_id,'purchase_prices','VIEW') then result:=result||jsonb_build_object('receipt_financials',financials);end if;
 return result;
end $function$;

CREATE OR REPLACE FUNCTION public.work_content_report_v1(p_actor_user_id uuid, p_project_id uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_work_type text DEFAULT NULL::text, p_accounting boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare allowed uuid[]; result jsonb; price_visible boolean; scope_module text;
begin
 scope_module:=case when p_accounting then 'accounting_reports' else 'reports' end;
 if not public.has_app_permission_v1(p_actor_user_id,scope_module,'VIEW') then raise exception '沒有工作內容統計報表查看權限。'; end if;
 if p_from>p_to then raise exception '起始日期不可晚於結束日期。'; end if;
 if p_work_type in ('clerical','site_survey') then raise exception '此工作類型不列入統計報表。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 select coalesce(array_agg(p.id),'{}') into allowed from public.projects p
 join public.app_users u on u.id=p_actor_user_id and u.is_active
 join public.app_roles role on role.code=u.role
 where p.deleted_at is null and p.project_type not in ('clerical','site_survey')
 and (nullif(p_work_type,'') is null or p.project_type=p_work_type)
 and public.erp_private_json_visible_v1(to_jsonb(p))
 and (not role.project_scoped or exists(select 1 from public.project_workers w
 where w.project_id=p.id and w.user_id=u.id and (w.can_view or w.is_assignee)));
 if p_project_id is not null and not(p_project_id=any(allowed)) then raise exception '找不到工作內容或沒有統計查看權限。'; end if;
 price_visible:=p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','VIEW');
 select jsonb_build_object('work_types',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.erp_work_content_types_v1() t where t.code not in ('clerical','site_survey')),
 'projects',coalesce((select jsonb_agg(to_jsonb(p) order by p.project_code) from public.projects p where p.id=any(allowed)),'[]'),
 'customers',coalesce((select jsonb_agg(to_jsonb(c)) from public.customers c where c.id in(select customer_id from public.projects where id=any(allowed))),'[]'),
 'customer_departments',coalesce((select jsonb_agg(to_jsonb(d)) from public.customer_departments d where d.customer_id in(select customer_id from public.projects where id=any(allowed))),'[]'),
 'price_permissions',jsonb_build_object('view',price_visible,'create',p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','CREATE'),
 'update',p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','UPDATE'),'delete',p_accounting and public.has_app_permission_v1(p_actor_user_id,'accounting_prices','DELETE'))) into result;
 if p_project_id is null then return result; end if;
 with logs as materialized (
 select l.* from public.site_work_logs l where l.project_id=p_project_id and l.deleted_at is null
 and l.work_type not in ('文書作業','場勘') and l.status in ('in_progress','completed')
 and (p_from is null or l.log_date>=p_from) and (p_to is null or l.log_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(l))),
 materials as materialized (
 select r.*,i.item_name,i.brand,i.model,i.unit,i.category_id,
 coalesce(nullif(btrim(c.name),''),'未分類') category_name
 from public.pickup_records r join public.inventory_items i on i.id=r.inventory_item_id
 left join public.product_categories c on c.id=i.category_id
 where r.project_id=p_project_id and (p_from is null or r.pickup_date>=p_from) and (p_to is null or r.pickup_date<=p_to)
 and public.erp_private_json_visible_v1(to_jsonb(r))),
 workers as materialized (
 select w.user_id,l.id,l.log_date,u.display_name,u.is_active from logs l
 join public.site_work_log_workers w on w.work_log_id=l.id join public.app_users u on u.id=w.user_id where l.reporter_on_site or w.user_id is distinct from l.reporter_user_id),
 contractor_days as (select log_date,max(subcontractor_count) headcount,count(*) records from logs where subcontractor_count>0 group by log_date),
 mat as (
 select m.inventory_item_id id,max(m.item_name) name,max(m.brand) brand,max(m.model) model,max(coalesce(nullif(m.unit,''),'未標示單位')) unit,
 m.category_id "categoryId",m.category_name "categoryName",
 sum(m.quantity) quantity,count(*) "recordCount",min(m.pickup_date) "firstDate",max(m.pickup_date) "recentDate"
 from materials m group by m.inventory_item_id,m.category_id,m.category_name),
 material_stats as (
 select m."categoryId",m."categoryName",m.unit,m.quantity,m."recordCount",
 to_jsonb(m)||case when price_visible then jsonb_build_object('unit_price',coalesce(manual.unit_price,latest.unit_price),
 'amount',round(m.quantity*coalesce(manual.unit_price,latest.unit_price),2),
 'price_source',case when manual.unit_price is not null then 'manual' when latest.id is not null then 'receipt' else 'missing' end,
 'price_date',case when manual.unit_price is not null then (manual.updated_at at time zone 'Asia/Taipei')::date else latest.receipt_date end,
 'source_receipt_id',case when manual.unit_price is null then latest.id end,
 'source_document_id',case when manual.unit_price is null then latest.receipt_document_id end,
 'source_tax_mode',case when manual.unit_price is null then latest.receipt_tax_mode end,
 'source_tax_rate_basis_points',case when manual.unit_price is null then latest.receipt_tax_rate_basis_points end,
 'source_input_unit_price',case when manual.unit_price is null then latest.input_unit_price end,
 'price_row_version',manual.row_version) else '{}'::jsonb end data from mat m
 left join public.accounting_material_prices manual on manual.project_id=p_project_id and manual.inventory_item_id=m.id
 left join lateral(select s.id,s.receipt_date,s.receipt_document_id,s.unit_price input_unit_price,
 d.receipt_tax_mode,d.receipt_tax_rate_basis_points,
 case when d.receipt_tax_mode='inclusive' then round(s.unit_price*10000/(10000+d.receipt_tax_rate_basis_points),2) else s.unit_price end unit_price
 from public.stock_receipts s left join public.stock_transaction_documents d on d.kind='receipt' and d.id=s.receipt_document_id
 where s.inventory_item_id=m.id and s.unit_price is not null and public.erp_private_json_visible_v1(to_jsonb(s))
 order by s.receipt_date desc,s.created_at desc,s.id desc limit 1) latest on true),
 category_stats as (
 select s."categoryId" id,max(s."categoryName") name,count(*) "itemCount",sum(s."recordCount") "recordCount",
 sum((s.data->>'amount')::numeric) amount,
 count(*) filter(where s.data->>'unit_price' is null) "unpricedItemCount"
 from material_stats s group by s."categoryId"
 ),
 category_json as (
 select jsonb_build_object('id',c.id,'name',c.name,'itemCount',c."itemCount",'recordCount',c."recordCount",
 'totalsByUnit',coalesce((select jsonb_agg(to_jsonb(t) order by t.unit) from (
  select m.unit,sum(m.quantity) total from mat m where m."categoryId" is not distinct from c.id group by m.unit
 )t),'[]'))||case when price_visible then jsonb_build_object('amount',c.amount,'unpricedItemCount',c."unpricedItemCount") else '{}'::jsonb end data
 from category_stats c
 ),
 worker_stats as (
 select user_id::text id,max(display_name) name,max(display_name)||'（'||left(user_id::text,8)||'）' label,
 bool_or(is_active) active,count(distinct log_date) "constructionDays",count(distinct id) "recordCount",
 min(log_date) "firstDate",max(log_date) "lastDate",max(log_date) "recentDate" from workers group by user_id
 union all select 'subcontractor','代工','代工（人天）',true,sum(headcount),sum(records),min(log_date),max(log_date),max(log_date) from contractor_days having count(*)>0),
 worker_json as (select w.*,to_jsonb(w)||jsonb_build_object('unit',case when w.id='subcontractor' then '人天' else '天' end)
 ||case when price_visible then jsonb_build_object('daily_wage',cost.daily_wage,'labor_amount',round(w."constructionDays"*cost.daily_wage,2),'wage_row_version',cost.row_version) else '{}'::jsonb end data
 from worker_stats w left join public.accounting_worker_wages cost on cost.project_id=p_project_id and coalesce(cost.worker_user_id::text,'subcontractor')=w.id)
 select result||jsonb_build_object('report',jsonb_build_object('error','',
 'materialStats',coalesce((select jsonb_agg(data order by (data->>'recordCount')::int desc,data->>'id') from material_stats),'[]'),
 'materialCategoryStats',coalesce((select jsonb_agg(data order by data->>'name',data->>'id') from category_json),'[]'),
 'workerStats',coalesce((select jsonb_agg(w.data order by w."constructionDays" desc,w.id) from worker_json w),'[]'),
 'materialRows',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'date',m.pickup_date,'itemId',m.inventory_item_id,
 'categoryId',m.category_id,'categoryName',m.category_name,'quantity',m.quantity,'account',m.created_by_username,'item',jsonb_build_object('name',m.item_name,'brand',m.brand,'model',m.model,'unit',m.unit)) order by m.pickup_date desc,m.id) from materials m),'[]'),
 'dailyRows',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'date',l.log_date,'timePeriod',l.time_period,'summary',l.summary,'status',l.status,
 'workerIds',coalesce((select jsonb_agg(w.user_id) from workers w where w.id=l.id),'[]'),
 'workerNames',coalesce((select jsonb_agg(w.display_name) from workers w where w.id=l.id),'[]'),
 'subcontractorCount',l.subcontractor_count,'reporterOnSite',l.reporter_on_site,'dailyHeadcount',(select count(distinct w.user_id) from workers w where w.log_date=l.log_date)+coalesce((select headcount from contractor_days d where d.log_date=l.log_date),0)) order by l.log_date desc,l.id) from logs l),'[]'),
 'totalsByUnit',coalesce((select jsonb_agg(to_jsonb(t)) from(select unit,sum(quantity) total from mat group by unit)t),'[]'),
 'laborTotals',case when price_visible then (select jsonb_build_object('knownAmount',coalesce(sum((data->>'labor_amount')::numeric),0),'unpricedWorkerCount',count(*) filter(where data->>'daily_wage' is null),'personDays',coalesce(sum("constructionDays"),0)) from worker_json) else null end,
 'kpis',jsonb_build_object('materialTypeCount',(select count(*) from mat),'materialRecordCount',(select count(*) from materials),
 'primaryMaterial',(select data from material_stats order by (data->>'recordCount')::int desc,data->>'id' limit 1),
 'constructionDays',(select count(distinct log_date) from logs),'workerCount',(select count(*) from worker_stats where id<>'subcontractor'),'subcontractorPersonDays',(select coalesce(sum(headcount),0) from contractor_days),
 'workerDays',(select count(distinct(user_id,log_date)) from workers)+(select coalesce(sum(headcount),0) from contractor_days),'recentConstructionDate',(select max(log_date) from logs)))) into result;
 -- Plans are left-joined to completed dates, so zero-log plans/items stay visible.
 -- The report authorization and private scope above remain the single boundary.
 with plans as materialized (
  select c.* from public.construction_plans c where c.project_id=p_project_id and c.deleted_at is null
  and public.erp_private_json_visible_v1(to_jsonb(c))
 ), logs as materialized (
  select l.* from public.site_work_logs l join plans c on c.id=l.construction_plan_id
  where l.deleted_at is null and l.work_type='工程施工' and l.log_date<=(now() at time zone 'Asia/Taipei')::date
  and (p_from is null or l.log_date>=p_from) and (p_to is null or l.log_date<=p_to)
  and public.erp_private_json_visible_v1(to_jsonb(l))
 ),
 item_stats as (
  select i.*,case when i.is_completed then i.planned_days else 0 end completed_days,
   (select count(distinct l.log_date)::int from logs l where l.construction_item_id=i.id) worked_days
  from public.construction_plan_items i join plans p on p.id=i.construction_plan_id where i.deleted_at is null
 ), plan_stats as (
  select c.*,(completion->>'completed_days')::numeric completed_days,(completion->>'completion_percent')::numeric completion_percent,
  (select count(distinct l.log_date)::int from logs l where l.construction_plan_id=c.id) worked_days,
  coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object(
   'remaining_days',case when i.planned_days>0 then greatest(i.planned_days-i.completed_days,0) end,
   'overrun_days',case when i.planned_days>0 then greatest(i.worked_days-i.planned_days,0) else 0 end,
   'progress_percent',case when i.is_completed then 100 else 0 end,
   'logs',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'date',l.log_date,'status',l.status,
    'summary',l.summary,'can_open',public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW')) order by l.log_date,l.id)
    from logs l where l.construction_item_id=i.id and public.construction_log_visible_v1(p_actor_user_id,l)),'[]')) order by i.sort_order,i.id)
   from item_stats i where i.construction_plan_id=c.id),'[]') items,
  coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'name',u.display_name) order by u.display_name,u.id)
   from public.construction_plan_assignees a join public.app_users u on u.id=a.user_id where a.construction_plan_id=c.id),'[]') assignees,
  coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'date',l.log_date,'status',l.status,'item_id',l.construction_item_id,
   'summary',l.summary,'can_open',public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW')) order by l.log_date,l.id)
   from logs l where l.construction_plan_id=c.id and public.construction_log_visible_v1(p_actor_user_id,l)),'[]') logs
  from plans c cross join lateral (select public.construction_completion_totals_v1(
   coalesce((select jsonb_agg(to_jsonb(i)) from item_stats i where i.construction_plan_id=c.id),'[]'),c.planned_days,c.status) completion) metrics
 ), enriched as (
  select to_jsonb(p)||jsonb_build_object(
   'remaining_days',case when p.planned_days>0 then greatest(p.planned_days-p.completed_days,0) end,
   'overrun_days',case when p.planned_days>0 then greatest(p.worked_days-p.planned_days,0) else 0 end,
   'progress_percent',p.completion_percent,
   'can_open',public.has_app_permission_v1(p_actor_user_id,'projects','VIEW') and public.construction_project_access_v1(p_actor_user_id,p.project_id,false),
   'completed_item_count',(select count(*) from item_stats i where i.construction_plan_id=p.id and i.is_completed)) data from plan_stats p
 )
 select result||jsonb_build_object('report',(result->'report')||jsonb_build_object(
  'project', (select jsonb_build_object('id',p.id,'code',p.project_code,'name',p.name,'type',t.label,'status',p.status,
   'customer',c.name,'owner',coalesce(nullif(p.assigned_to,''),(select string_agg(u.display_name,'、' order by u.id) from public.project_workers w join public.app_users u on u.id=w.user_id where w.project_id=p.id and w.is_assignee)),
   'createdAt',p.created_at,'completedOn',p.completed_on,'date',p.project_date)
   from public.projects p join public.customers c on c.id=p.customer_id left join public.erp_work_content_types_v1() t on t.code=p.project_type where p.id=p_project_id),
  'constructionPlans',coalesce((select jsonb_agg(data order by data->>'construction_date',data->>'id') from enriched),'[]'),
  'constructionSummary',jsonb_build_object(
   'planCount',(select count(*) from plans),
   'plannedDays',(select coalesce(sum(planned_days),0) from plan_stats where status<>'cancelled'),
   'completedDays',(select coalesce(sum(completed_days),0) from plan_stats where status<>'cancelled'),
   'remainingDays',(select coalesce(sum(greatest(planned_days-completed_days,0)),0) from plan_stats where status<>'cancelled' and planned_days>0),
   'unsetPlanCount',(select count(*) from plans where status<>'cancelled' and coalesce(planned_days,0)=0),
   'workedDays',(select coalesce(sum(worked_days),0) from plan_stats where status<>'cancelled'),
   'progressPercent',(select case when sum(planned_days)>0 then round(100.0*sum(completed_days)/sum(planned_days),1) end from plan_stats where status<>'cancelled'),
   'projectDays',(select count(distinct l.log_date) from logs l join plans c on c.id=l.construction_plan_id where c.status<>'cancelled'),
   'overdueItemCount',(select count(*) from item_stats i join plans p on p.id=i.construction_plan_id where p.status<>'cancelled' and i.planned_days>0 and i.worked_days>i.planned_days)
    +(select count(*) from plan_stats p where p.status<>'cancelled' and jsonb_array_length(p.items)=0 and p.planned_days>0 and p.worked_days>p.planned_days)
  ))) into result;

 if price_visible then
  with documents as (
   select d.*,public.stock_receipt_financials_v1(d.id) financials from public.stock_transaction_documents d
   where d.kind='receipt' and d.receipt_project_id=p_project_id
   and exists(select 1 from public.stock_receipts s where s.receipt_document_id=d.id
     and (p_from is null or s.receipt_date>=p_from) and (p_to is null or s.receipt_date<=p_to))
   and not exists(select 1 from public.stock_receipts s where s.receipt_document_id=d.id
     and not public.erp_private_json_visible_v1(to_jsonb(s)))
  ), doc_rows as (
   select jsonb_build_object('id',d.id,'documentNo',d.document_no,'projectId',d.receipt_project_id,
    'date',(select min(s.receipt_date) from public.stock_receipts s where s.receipt_document_id=d.id),
    'financials',d.financials,'lines',coalesce((select jsonb_agg(jsonb_build_object(
      'id',s.id,'itemId',s.inventory_item_id,'name',i.item_name,'quantity',s.quantity,'unit',i.unit,
      'categoryId',i.category_id,'categoryName',coalesce(c.name,'未分類'),'unit_price',s.unit_price,
      'input_amount',round(s.quantity*s.unit_price,0)) order by s.receipt_line_no,s.id)
      from public.stock_receipts s join public.inventory_items i on i.id=s.inventory_item_id
      left join public.product_categories c on c.id=i.category_id where s.receipt_document_id=d.id),'[]')) data from documents d
  )
  select jsonb_set(result,'{report}',(result->'report')||jsonb_build_object(
   'receiptDocuments',coalesce((select jsonb_agg(data order by data->>'date' desc,data->>'id') from doc_rows),'[]'),
   'receiptTotals',jsonb_build_object('documentCount',(select count(*) from documents),
    'unpricedDocumentCount',(select count(*) from documents where financials->>'total_amount' is null),
    'netAmount',(select sum((financials->>'net_amount')::numeric) from documents),
    'discountAmount',(select sum((financials->>'discount_amount')::numeric) from documents),
    'taxAmount',(select sum((financials->>'tax_amount')::numeric) from documents),
    'totalAmount',(select sum((financials->>'total_amount')::numeric) from documents)),
   'receiptAssociationNote','僅列出以工作內容 ID 明確關聯的進貨單；未分配單據請至進貨管理補選工作內容。進貨歷史總額與領用量乘參考單價分開呈現，不合併加總。')) into result;
 end if;
 return result;
end $function$;
