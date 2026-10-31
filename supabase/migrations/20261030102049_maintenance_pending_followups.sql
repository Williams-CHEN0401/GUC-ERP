-- New maintenance follow-ups do not reinterpret historical notes.
begin;
alter table public.maintenance_events
 add column pending_content text not null default '' check(length(pending_content)<=2000),
 add column pending_completions jsonb not null default '[]' check(jsonb_typeof(pending_completions)='array'),
 add column pending_sources jsonb not null default '[]' check(jsonb_typeof(pending_sources)='array');
alter table public.projects add column repair_root_project_id uuid references public.projects(id) on delete restrict;
create index projects_repair_root_idx on public.projects(repair_root_project_id) where repair_root_project_id is not null;

create function public.pending_maintenance_items_v1(p_actor_user_id uuid,p_project_id uuid,p_log_date date,p_exclude_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.projects; current_log public.site_work_logs; r record; line text; reason text; result jsonb:='[]';
begin
 if p_log_date is null or not public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW') then raise exception '沒有工作日誌查看權限或日期不正確。';end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 select * into p from public.projects where id=p_project_id and deleted_at is null;
 if not found or not public.has_project_permission_v1(p_actor_user_id,p.id,'VIEW') then raise exception '找不到工作內容或沒有查看權限。';end if;
 perform public.erp_private_assert_v1(to_jsonb(p));
 if p_exclude_id is not null then
  select * into current_log from public.site_work_logs where id=p_exclude_id and deleted_at is null;
  if not found or current_log.project_id<>p.id then raise exception '日誌與工作內容不相符。';end if;
  perform public.assert_work_log_access_v1(p_actor_user_id,p.id,current_log.id,'VIEW');
  perform public.erp_private_assert_v1(to_jsonb(current_log));
 end if;
 for r in select e.*,l.log_date,l.created_at as log_created_at,l.project_id,pr.customer_id,pr.department_id,
   l.row_version as log_version,l.title,pr.project_code,s.name as service_name,
   s.is_active as service_active,exists(select 1 from public.customer_contract_services c where c.customer_id=pr.customer_id and c.service_type_id=e.service_id and c.is_active) as contracted
  from public.maintenance_events e join public.site_work_logs l on l.id=e.work_log_id
  join public.projects pr on pr.id=l.project_id join public.contract_service_types s on s.id=e.service_id
  where coalesce(pr.repair_root_project_id,pr.id)=coalesce(p.repair_root_project_id,p.id)
  and pr.customer_id=p.customer_id and pr.department_id is not distinct from p.department_id
  and coalesce(l.department_id,pr.department_id) is not distinct from coalesce(current_log.department_id,p.department_id)
  and pr.deleted_at is null and l.deleted_at is null and e.status='active' and l.work_type='維修紀錄'
  and l.id is distinct from p_exclude_id and l.log_date<=p_log_date
  -- Only earlier-created visits may be consumed by an existing log: a strict DAG even on the same day.
  and (p_exclude_id is null or (l.created_at,l.id)<(current_log.created_at,current_log.id))
  and btrim(e.pending_content)<>'' and public.erp_private_json_visible_v1(to_jsonb(l))
  and public.erp_private_json_visible_v1(to_jsonb(pr))
  and public.has_project_permission_v1(p_actor_user_id,l.project_id,'VIEW')
  order by l.log_date,l.created_at,e.id loop
  reason:='';
  begin perform public.assert_work_log_access_v1(p_actor_user_id,r.project_id,r.work_log_id,'UPDATE');
   exception when others then reason:='無修改原日誌權限';end;
  if not r.service_active or not r.contracted then reason:='原承攬項目已停用或已不屬於此客戶';end if;
  if r.event_type not in ('SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','REPAIR','REPLACEMENT','EQUIPMENT_TEST') then reason:='原事件類型已停用';end if;
  for line in select distinct btrim(v) from regexp_split_to_table(r.pending_content,E'\r?\n') v where btrim(v)<>'' order by 1 loop
   result:=result||jsonb_build_array(jsonb_build_object('source_event_id',r.id,'source_log_id',r.work_log_id,
    'row_version',r.row_version,'log_row_version',r.log_version,'log_date',r.log_date,'project_name',r.title,'project_code',r.project_code,
    'service_id',r.service_id,'service_name',r.service_name,'event_type',r.event_type,'pending_text',line,'can_complete',reason='','reason',reason));
  end loop;
 end loop;
 return jsonb_build_object('items',result);
end $$;

-- Preserve the established writer and all of its authorization, workforce and construction rules.
alter function public.save_work_log_workforce_v1(uuid,jsonb) rename to save_work_log_workforce_before_maintenance_v1;
create function public.save_work_log_workforce_v1(p_actor_user_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare request uuid:=(p_payload->>'request_id')::uuid; log_id uuid:=(p_payload->>'id')::uuid;
 project_id uuid:=(p_payload->>'project_id')::uuid; plan_id uuid:=(p_payload->>'construction_plan_id')::uuid;
 source_project public.projects; previous public.work_log_save_requests; body jsonb:=p_payload;
 events jsonb:=coalesce(p_payload->'maintenance_events','[]'); selections jsonb:=coalesce(p_payload->'resolved_maintenance_items','[]');
 eligible jsonb; item jsonb; ev jsonb; target jsonb; old_event public.maintenance_events; after_event public.maintenance_events;
 v_result jsonb; new_log public.site_work_logs; source_log public.site_work_logs; actor text; v_notes text; pending text;
 target_id uuid; source_id uuid; completion jsonb; ordinal integer; links jsonb; event_ids uuid[];
begin
 if request is null then raise exception '缺少工作日誌送出識別碼。';end if;
 if plan_id is not null then perform public.assert_construction_log_access_v1(p_actor_user_id,plan_id,log_id,case when log_id is null then 'CREATE' else 'UPDATE' end);
 else perform public.assert_work_log_access_v1(p_actor_user_id,project_id,log_id,case when log_id is null then 'CREATE' else 'UPDATE' end);end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform pg_advisory_xact_lock(hashtextextended(request::text,0));
 select * into previous from public.work_log_save_requests where request_id=request;
 if found then
  if previous.reporter_id is distinct from p_actor_user_id or previous.workforce_payload is distinct from p_payload then raise exception '送出識別碼已使用，請重新載入。';end if;
  return previous.result;
 end if;
 if jsonb_typeof(events)<>'array' or jsonb_array_length(events)>20 or jsonb_typeof(selections)<>'array' or jsonb_array_length(selections)>100 then raise exception '維修未完成資料格式不正確。';end if;
 if jsonb_array_length(selections)>0 and (project_id is null or plan_id is not null or p_payload->>'work_type' is distinct from '維修紀錄') then raise exception '只有同一工作內容的維修日誌能結清維修待辦。';end if;
 if (select count(*) from jsonb_array_elements(selections))<>(select count(distinct (v->>'source_event_id',v->>'pending_text')) from jsonb_array_elements(selections) v) then raise exception '維修待辦不可重複。';end if;
 if (select count(*) from jsonb_array_elements(events) v where v ? 'client_key')<>(select count(distinct v->>'client_key') from jsonb_array_elements(events) v where v ? 'client_key') then raise exception '本次事件識別碼不可重複。';end if;
 -- Lock parent logs before their events, ordered consistently across a multi-item save.
 perform 1 from public.site_work_logs l where l.id in(select (v->>'source_log_id')::uuid from jsonb_array_elements(selections)v) order by l.id for update;
 perform 1 from public.maintenance_events e where e.id in(select (v->>'source_event_id')::uuid from jsonb_array_elements(selections)v) order by e.id for update;
 if jsonb_array_length(selections)>0 then eligible:=public.pending_maintenance_items_v1(p_actor_user_id,project_id,(p_payload->>'log_date')::date,log_id)->'items';end if;
 for item in select v from jsonb_array_elements(selections)v loop
  if not exists(select 1 from jsonb_array_elements(eligible) r where r->>'source_event_id'=item->>'source_event_id'
   and r->>'source_log_id'=item->>'source_log_id' and r->>'pending_text'=item->>'pending_text'
   and r->'row_version'=item->'row_version' and r->'log_row_version'=item->'log_row_version' and (r->>'can_complete')::boolean)
  then raise exception '先前維修待辦已更新、已完成或沒有修改權限，請重新讀取。';end if;
  select * into old_event from public.maintenance_events where id=(item->>'source_event_id')::uuid;
  select v into target from jsonb_array_elements(events)v where (v->>'client_key')::uuid=(item->>'target_client_key')::uuid;
  if target is null or target->>'id' is not null or target->>'service_id' is distinct from old_event.service_id::text or target->>'event_type' is distinct from old_event.event_type
  then raise exception '待辦必須關聯本次新事件，承攬項目與事件類型需與來源一致。';end if;
  if exists(select 1 from jsonb_array_elements(selections) v where v->>'target_client_key'=item->>'target_client_key' and v->>'source_event_id'<>item->>'source_event_id')
   or exists(select 1 from jsonb_array_elements(selections)v where v->>'source_event_id'=item->>'source_event_id' and v->>'target_client_key'<>item->>'target_client_key')
  then raise exception '同一來源事件須集中於同一本次事件，不同來源不可合併。';end if;
 end loop;
 select username into actor from public.app_users where id=p_actor_user_id and is_active;
 if project_id is not null then
  select * into source_project from public.projects where id=project_id for share;
 end if;
 -- Omitted fields are preserved for older clients. Historical notes are never promoted to pending content.
 for ev,ordinal in select v,n::integer from jsonb_array_elements(events) with ordinality t(v,n) loop
  if ev ? 'client_key' and (ev->>'client_key')::uuid is null then raise exception '本次事件識別碼不正確。';end if;
  if ev ? 'pending_content' and (jsonb_typeof(ev->'pending_content') is distinct from 'string' or length(ev->>'pending_content')>2000) then raise exception '每筆未完成內容限 2000 字。';end if;
  if ev ? 'pending_content' and p_payload->>'work_type' is distinct from '維修紀錄' then raise exception '未完成內容僅適用維修日誌。';end if;
  if ev->>'id' is not null and not(ev ? 'notes') then
   select e.notes into v_notes from public.maintenance_events e where e.id=(ev->>'id')::uuid and e.work_log_id=log_id;
   ev:=ev||jsonb_build_object('notes',v_notes);
   events:=jsonb_set(events,array[(ordinal-1)::text],ev);
  end if;
 end loop;
 body:=body||jsonb_build_object('maintenance_events',events);
 if p_payload->>'work_type'='維修紀錄' and p_payload->>'status'='completed' and exists(select 1 from jsonb_array_elements(events)e where btrim(coalesce(e->>'pending_content',(select m.pending_content from public.maintenance_events m where m.id=(e->>'id')::uuid),''))<>'') then
  raise exception '本次事件仍有未完成事項，請將日誌狀態改為進行中。';
 end if;
 v_result:=public.save_work_log_workforce_before_maintenance_v1(p_actor_user_id,body);
 select * into new_log from public.site_work_logs where id=(v_result#>>'{work_log,id}')::uuid;
 if coalesce((v_result->>'repair_visit')::boolean,false) and source_project.id is not null then
  if not exists(select 1 from public.projects pr where pr.id=new_log.project_id and pr.customer_id=source_project.customer_id and pr.department_id is not distinct from source_project.department_id) then raise exception '回訪客戶或科室不相符。';end if;
  update public.projects pr set repair_root_project_id=coalesce(source_project.repair_root_project_id,source_project.id) where id=new_log.project_id returning to_jsonb(pr) into target;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor) values('projects',new_log.project_id,'update',v_result->'project',target,'web',actor);
  v_result:=v_result||jsonb_build_object('project',target);
 end if;
 select array_agg(value::uuid order by n) into event_ids from jsonb_array_elements_text(v_result->'maintenance_event_ids') with ordinality t(value,n);
 if jsonb_array_length(events)<>coalesce(cardinality(event_ids),0) then raise exception '維修事件保存結果不完整。';end if;
 for ev,ordinal in select v,n::integer from jsonb_array_elements(events) with ordinality t(v,n) loop
  if ev ? 'pending_content' or (ev->>'id' is not null and not((p_payload->'maintenance_events'->(ordinal-1)) ? 'notes')) then
   select * into old_event from public.maintenance_events where id=event_ids[ordinal];
   pending:=old_event.pending_content;v_notes:=old_event.notes;
   if ev ? 'pending_content' then
    select coalesce(string_agg(line,E'\n' order by first_line),'') into pending from
     (select btrim(v) line,min(n) first_line from regexp_split_to_table(ev->>'pending_content',E'\r?\n') with ordinality t(v,n) where btrim(v)<>'' group by btrim(v)) q;
   end if;
   if ev->>'id' is not null and not((p_payload->'maintenance_events'->(ordinal-1)) ? 'notes') then v_notes:=ev->>'notes';end if;
   update public.maintenance_events m set pending_content=pending,notes=v_notes where id=old_event.id and (m.pending_content,m.notes) is distinct from (pending,v_notes) returning * into after_event;
   if found then insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor) values('maintenance_events',old_event.id,'update',to_jsonb(old_event),to_jsonb(after_event),'web',actor);end if;
  end if;
 end loop;
 for source_id in select distinct (v->>'source_event_id')::uuid from jsonb_array_elements(selections)v order by 1 loop
  select * into old_event from public.maintenance_events where id=source_id;
  links:='[]';
  for item in select v from jsonb_array_elements(selections)v where (v->>'source_event_id')::uuid=source_id order by v->>'pending_text' loop
   select event_ids[n::integer] into target_id from jsonb_array_elements(events) with ordinality t(v,n) where v->>'client_key'=item->>'target_client_key';
   completion:=jsonb_build_object('source_event_id',source_id,'source_log_id',old_event.work_log_id,'source_row_version',item->'row_version','source_log_row_version',item->'log_row_version',
    'pending_text',item->>'pending_text','target_event_id',target_id,'target_log_id',new_log.id,'completed_date',new_log.log_date,'actor_user_id',p_actor_user_id,'request_id',request);
   links:=links||jsonb_build_array(completion);
  end loop;
  select coalesce(string_agg(line,E'\n' order by n),'') into pending from regexp_split_to_table(old_event.pending_content,E'\r?\n') with ordinality t(line,n)
   where not exists(select 1 from jsonb_array_elements(links)v where v->>'pending_text'=btrim(line));
  update public.maintenance_events set pending_content=pending,pending_completions=pending_completions||links where id=source_id returning * into after_event;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor) values('maintenance_events',source_id,'update',to_jsonb(old_event),to_jsonb(after_event),'web',actor);
  select * into old_event from public.maintenance_events where id=target_id;
  update public.maintenance_events set pending_sources=pending_sources||links where id=target_id returning * into after_event;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor) values('maintenance_events',target_id,'update',to_jsonb(old_event),to_jsonb(after_event),'web',actor);
 end loop;
 select * into new_log from public.site_work_logs where id=new_log.id;
 v_result:=v_result||jsonb_build_object('work_log',to_jsonb(new_log),'resolved_maintenance_items',selections);
 update public.work_log_save_requests set workforce_payload=p_payload,result=v_result where request_id=request and reporter_id=p_actor_user_id;
 return v_result;
end $$;

create function public.guard_maintenance_pending_history_v1() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if (old.pending_completions<>'[]' or old.pending_sources<>'[]') and
  (new.status,new.work_log_id,new.service_id,new.event_type,new.occurred_at) is distinct from (old.status,old.work_log_id,old.service_id,old.event_type,old.occurred_at)
 then raise exception '此事件有未完成事項的結清關聯，不可作廢或變更來源、承攬、類型及日期。';end if;
 if new.pending_content is distinct from old.pending_content and exists(select 1 from jsonb_array_elements(old.pending_completions)c
   where c->>'pending_text'=any(regexp_split_to_array(new.pending_content,E'\r?\n')))
 then raise exception '已結清的事項不可重新放回原事件；新的問題請另建事件。';end if;
 return new;
end $$;
create trigger maintenance_pending_history_guard before update on public.maintenance_events for each row execute function public.guard_maintenance_pending_history_v1();

create function public.guard_maintenance_pending_log_v1() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if (new.project_id,new.department_id,new.log_date,new.work_type,new.deleted_at) is distinct from (old.project_id,old.department_id,old.log_date,old.work_type,old.deleted_at)
  and exists(select 1 from public.maintenance_events e where e.work_log_id=old.id and (e.pending_completions<>'[]' or e.pending_sources<>'[]' or btrim(e.pending_content)<>''))
 then raise exception '此日誌有維修待辦結清關聯，不可刪除或變更工作、客戶、科室、日期與類型。';end if;
 return new;
end $$;
create trigger maintenance_pending_log_guard before update on public.site_work_logs for each row execute function public.guard_maintenance_pending_log_v1();

create function public.guard_maintenance_pending_project_v1() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if (new.customer_id,new.department_id,new.deleted_at) is distinct from (old.customer_id,old.department_id,old.deleted_at)
  and (old.repair_root_project_id is not null or exists(select 1 from public.projects p where p.repair_root_project_id=old.id)
   or exists(select 1 from public.maintenance_events e join public.site_work_logs l on l.id=e.work_log_id where l.project_id=old.id and (btrim(e.pending_content)<>'' or e.pending_completions<>'[]' or e.pending_sources<>'[]')))
 then raise exception '此工作有維修待辦或回訪關聯，不可刪除或變更客戶、科室。';end if;
 if old.repair_root_project_id is not null and new.repair_root_project_id is distinct from old.repair_root_project_id then raise exception '維修回訪來源不可變更。';end if;
 return new;
end $$;
create trigger maintenance_pending_project_guard before update on public.projects for each row execute function public.guard_maintenance_pending_project_v1();

revoke all on function public.pending_maintenance_items_v1(uuid,uuid,date,uuid),public.save_work_log_workforce_v1(uuid,jsonb),public.save_work_log_workforce_before_maintenance_v1(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.pending_maintenance_items_v1(uuid,uuid,date,uuid),public.save_work_log_workforce_v1(uuid,jsonb),public.save_work_log_workforce_before_maintenance_v1(uuid,jsonb) to service_role;
revoke all on function public.guard_maintenance_pending_history_v1(),public.guard_maintenance_pending_log_v1(),public.guard_maintenance_pending_project_v1() from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
