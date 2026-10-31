-- Retain the originating pending item and its full dated relationship.
-- Existing permissions, request replay, deterministic locks and optimistic versions remain in place.
begin;
set local lock_timeout='5s';
alter table public.site_work_logs
 add column pending_completions jsonb not null default '[]' check(jsonb_typeof(pending_completions)='array'),
 add column pending_sources jsonb not null default '[]' check(jsonb_typeof(pending_sources)='array');
-- PostgreSQL expands a view's `*` at creation time. Append the new read fields
-- through the existing private-data-filtered view, with the same invoker policy.
create or replace view public.erp_private_site_work_logs with(security_invoker=true) as
 select r.* from public.site_work_logs r where public.erp_private_json_visible_v1(to_jsonb(r));

create function public.work_log_pending_label_v1(p_text text,p_date date)
returns text language sql immutable security invoker set search_path='' as $$
 select p_text||'('||to_char(p_date,'MM-DD')||'已完成)';
$$;
create function public.work_log_history_label_v1(p_history jsonb)
returns text language sql immutable security invoker set search_path='' as $$
 select coalesce(p_history->>'display_text',public.work_log_pending_label_v1(p_history->>'pending_text',(p_history->>'completed_date')::date));
$$;
create function public.work_log_open_pending_lines_v1(p_content text,p_history jsonb)
returns table(pending_text text) language sql immutable security invoker set search_path='' as $$
 select distinct btrim(line) from regexp_split_to_table(coalesce(p_content,''),E'\r?\n') line
 where btrim(line)<>'' and not exists(select 1 from jsonb_array_elements(coalesce(p_history,'[]')) h
   where btrim(line)=public.work_log_history_label_v1(h));
$$;
create or replace function public.work_log_pending_lines_v1(p_log public.site_work_logs)
returns table(pending_text text) language sql immutable security invoker set search_path='' as $$
 select * from public.work_log_open_pending_lines_v1(case when p_log.pending_content is not null then p_log.pending_content
  when p_log.status='in_progress' then coalesce(p_log.summary,'') else '' end,p_log.pending_completions);
$$;

-- Replace only proven selected lines, preserving all other text and line order.
create function public.work_log_annotate_pending_v1(p_content text,p_links jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare result text; link jsonb;
begin
 for link in select value from jsonb_array_elements(p_links) loop
  if public.work_log_history_label_v1(link)=any(regexp_split_to_array(coalesce(p_content,''),E'\r?\n')) then
   raise exception '未完成欄已有相同完成註記，請先確認內容後再儲存。';
  end if;
 end loop;
 select coalesce(string_agg(coalesce((select public.work_log_history_label_v1(h) from jsonb_array_elements(p_links) h
  where h->>'pending_text'=btrim(line)),line),E'\n' order by n),'') into result
 from regexp_split_to_table(coalesce(p_content,''),E'\r?\n') with ordinality t(line,n);
 if length(result)>2000 then raise exception '來源未完成內容加上完成日期後超過 2000 字；請先精簡未結清內容，再重新勾選儲存。';end if;
 return result;
end $$;

-- Patch the established writer instead of duplicating or bypassing its authorization chain.
do $patch$
declare definition text; original text; replacement text;
begin
 select pg_get_functiondef('public.save_work_log_workforce_before_maintenance_v1(uuid,jsonb)'::regprocedure) into definition;
 definition:=replace(definition,E'\r\n',E'\n');
 original:=$old$v_pending text; v_completed text; v_notes text[]:='{}';$old$;
 replacement:=$new$v_pending text; v_completed text; v_links jsonb; v_link jsonb; v_open boolean; v_target_before public.site_work_logs; v_notes text[]:='{}';$new$;
 if strpos(definition,original)=0 then raise exception 'Unexpected workforce declaration; migration cancelled';end if;
 definition:=replace(definition,original,replacement);
 original:=$old$v_notes:=array_append(v_notes,'['||(v_item->>'pending_text')||']('||to_char(v_date,'MM-DD')||'已完成)');$old$;
 replacement:=$new$v_notes:=array_append(v_notes,public.work_log_pending_label_v1(v_item->>'pending_text',v_date));$new$;
 if strpos(definition,original)=0 then raise exception 'Unexpected workforce label; migration cancelled';end if;
 definition:=replace(definition,original,replacement);
 original:=$old$v_completed:=p_payload->>'completed_content';
 foreach v_text in array v_notes loop$old$;
 replacement:=$new$v_completed:=p_payload->>'completed_content';
 -- Older browser builds may still submit the previous generated bracketed label.
 for v_item in select i from jsonb_array_elements(v_sources)i loop
  select string_agg(case when line='['||(v_item->>'pending_text')||']('||to_char(v_date,'MM-DD')||'已完成)'
    then public.work_log_pending_label_v1(v_item->>'pending_text',v_date) else line end,E'\n' order by n)
    into v_completed from regexp_split_to_table(coalesce(v_completed,''),E'\r?\n') with ordinality t(line,n);
 end loop;
 foreach v_text in array v_notes loop$new$;
 if strpos(definition,original)=0 then raise exception 'Unexpected workforce completed content; migration cancelled';end if;
 definition:=replace(definition,original,replacement);
 original:=$old$ if v_completed is not null then v_body:=v_body||jsonb_build_object$old$;
 replacement:=$new$ if length(v_completed)>2000 or length(concat_ws(E'\n',nullif(btrim(v_completed),''),nullif(btrim(p_payload->>'pending_content'),'')))>2000 then
  raise exception '本次日誌加上完成日期後超過 2000 字；請精簡內容後再儲存。';end if;
 if v_completed is not null then v_body:=v_body||jsonb_build_object$new$;
 if strpos(definition,original)=0 then raise exception 'Unexpected workforce final content; migration cancelled';end if;
 definition:=replace(definition,original,replacement);
 original:=$old$  select string_agg(pending_text,E'\n' order by pending_text) into v_pending from public.work_log_pending_lines_v1(v_source) p
   where not exists(select 1 from jsonb_array_elements(v_sources)i where (i->>'source_log_id')::uuid=v_source.id and i->>'pending_text'=p.pending_text);
  v_completed:=coalesce(v_source.completed_content,'');
  for v_item in select i from jsonb_array_elements(v_sources)i where (i->>'source_log_id')::uuid=v_source.id order by i->>'pending_text' loop
   v_completed:=concat_ws(E'\n',nullif(v_completed,''),'['||(v_item->>'pending_text')||']('||to_char(v_date,'MM-DD')||'已完成)');
  end loop;
  update public.site_work_logs set completed_content=v_completed,pending_content=coalesce(v_pending,''),summary=concat_ws(E'\n',nullif(v_completed,''),nullif(v_pending,'')),
   status=case when coalesce(v_pending,'')='' then 'completed' else 'in_progress' end,updated_by=v_actor where id=v_source.id returning * into v_before;$old$;
 replacement:=$new$  v_links:='[]';
  for v_item in select i from jsonb_array_elements(v_sources)i where (i->>'source_log_id')::uuid=v_source.id order by i->>'pending_text' loop
   v_link:=jsonb_build_object('source_log_id',v_source.id,'source_log_date',v_source.log_date,'source_row_version',v_item->'row_version',
    'pending_text',v_item->>'pending_text','display_text',public.work_log_pending_label_v1(v_item->>'pending_text',v_date),
    'target_log_id',v_log.id,'completed_date',v_date,'actor_user_id',p_actor_user_id,'request_id',v_request);
   v_links:=v_links||jsonb_build_array(v_link);
  end loop;
  v_pending:=public.work_log_annotate_pending_v1(coalesce(v_source.pending_content,case when v_source.status='in_progress' then v_source.summary end,''),v_links);
  v_completed:=coalesce(v_source.completed_content,'');
  select exists(select 1 from public.work_log_open_pending_lines_v1(v_pending,v_source.pending_completions||v_links)) into v_open;
  if length(concat_ws(E'\n',nullif(v_completed,''),nullif(v_pending,'')))>2000 then
   raise exception '來源日誌加上完成日期後超過 2000 字；請先精簡未結清內容，再重新勾選儲存。';end if;
  update public.site_work_logs set completed_content=v_completed,pending_content=v_pending,summary=concat_ws(E'\n',nullif(v_completed,''),nullif(v_pending,'')),
   pending_completions=pending_completions||v_links,status=case when v_open then 'in_progress' else 'completed' end,updated_by=v_actor where id=v_source.id returning * into v_before;
  v_target_before:=v_log;
  update public.site_work_logs set pending_sources=pending_sources||v_links where id=v_log.id returning * into v_log;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
   values('site_work_logs',v_log.id,'update',to_jsonb(v_target_before),to_jsonb(v_log),'web',v_actor);$new$;
 if strpos(definition,original)=0 then raise exception 'Unexpected workforce pending resolver; migration cancelled';end if;
 definition:=replace(definition,original,replacement);
 execute definition;

 select pg_get_functiondef('public.pending_maintenance_items_v1(uuid,uuid,date,uuid)'::regprocedure) into definition;
 definition:=replace(definition,E'\r\n',E'\n');
 original:=$old$select distinct btrim(v) from regexp_split_to_table(r.pending_content,E'\r?\n') v where btrim(v)<>'' order by 1$old$;
 replacement:=$new$select pending_text from public.work_log_open_pending_lines_v1(r.pending_content,r.pending_completions) order by 1$new$;
 if strpos(definition,original)=0 then raise exception 'Unexpected maintenance pending list; migration cancelled';end if;
 execute replace(definition,original,replacement);

 select pg_get_functiondef('public.save_work_log_workforce_v1(uuid,jsonb)'::regprocedure) into definition;
 definition:=replace(definition,E'\r\n',E'\n');
 original:=$old$if p_payload->>'work_type'='維修紀錄' and p_payload->>'status'='completed' and exists(select 1 from jsonb_array_elements(events)e where btrim(coalesce(e->>'pending_content',(select m.pending_content from public.maintenance_events m where m.id=(e->>'id')::uuid),''))<>'') then$old$;
 replacement:=$new$if p_payload->>'work_type'='維修紀錄' and p_payload->>'status'='completed' and exists(select 1 from jsonb_array_elements(events)e
  cross join lateral public.work_log_open_pending_lines_v1(coalesce(e->>'pending_content',(select m.pending_content from public.maintenance_events m where m.id=(e->>'id')::uuid),''),
   coalesce((select m.pending_completions from public.maintenance_events m where m.id=(e->>'id')::uuid),'[]'))) then$new$;
 if strpos(definition,original)=0 then raise exception 'Unexpected maintenance pending status; migration cancelled';end if;
 definition:=replace(definition,original,replacement);
 original:=$old$ body:=body||jsonb_build_object('maintenance_events',events);$old$;
 replacement:=$new$ -- Canonical completion text is generated by the server as well as the form.
 for ev,ordinal in select v,n::integer from jsonb_array_elements(events) with ordinality t(v,n) loop
  v_notes:=coalesce(ev->>'handling_process','');
  for item in select v from jsonb_array_elements(selections)v where v->>'target_client_key'=ev->>'client_key' loop
   select string_agg(case when line='['||(item->>'pending_text')||']('||to_char((p_payload->>'log_date')::date,'MM-DD')||'已完成)'
    then public.work_log_pending_label_v1(item->>'pending_text',(p_payload->>'log_date')::date) else line end,E'\n' order by n)
    into v_notes from regexp_split_to_table(v_notes,E'\r?\n') with ordinality t(line,n);
   pending:=public.work_log_pending_label_v1(item->>'pending_text',(p_payload->>'log_date')::date);
   if not pending=any(regexp_split_to_array(coalesce(v_notes,''),E'\r?\n')) then v_notes:=concat_ws(E'\n',nullif(v_notes,''),pending);end if;
  end loop;
  if v_notes is distinct from coalesce(ev->>'handling_process','') then
   ev:=ev||jsonb_build_object('handling_process',v_notes);
   events:=jsonb_set(events,array[(ordinal-1)::text],ev);
  end if;
 end loop;
 body:=body||jsonb_build_object('maintenance_events',events);$new$;
 if strpos(definition,original)=0 then raise exception 'Unexpected maintenance body; migration cancelled';end if;
 definition:=replace(definition,original,replacement);
 original:=$old$'pending_text',item->>'pending_text','target_event_id',target_id$old$;
 replacement:=$new$'pending_text',item->>'pending_text','display_text',public.work_log_pending_label_v1(item->>'pending_text',new_log.log_date),
    'source_log_date',(select l.log_date from public.site_work_logs l where l.id=old_event.work_log_id),'target_event_id',target_id$new$;
 if strpos(definition,original)=0 then raise exception 'Unexpected maintenance completion link; migration cancelled';end if;
 definition:=replace(definition,original,replacement);
 original:=$old$  select coalesce(string_agg(line,E'\n' order by n),'') into pending from regexp_split_to_table(old_event.pending_content,E'\r?\n') with ordinality t(line,n)
   where not exists(select 1 from jsonb_array_elements(links)v where v->>'pending_text'=btrim(line));$old$;
 replacement:=$new$  pending:=public.work_log_annotate_pending_v1(old_event.pending_content,links);$new$;
 if strpos(definition,original)=0 then raise exception 'Unexpected maintenance source resolver; migration cancelled';end if;
 definition:=replace(definition,original,replacement);
 execute definition;
end $patch$;

-- Recover only a unique, exact audit + saved-request + still-visible pair.
-- A request alone is insufficient: users may have edited the target afterwards.
-- No dates or identities are inferred from labels or project names.
do $recover$
declare r record; source_log public.site_work_logs; target_log public.site_work_logs; link jsonb;
 pending text; completed text; target_completed text; recovered integer:=0; skipped integer:=0;
begin
 create temporary table work_log_pending_recovery on commit drop as
 select s.id source_id,t.id target_id,s.log_date source_date,t.log_date completed_date,
  i->>'pending_text' pending_text,'['||(i->>'pending_text')||']('||to_char(t.log_date,'MM-DD')||'已完成)' old_label,
  q.request_id,q.reporter_id, i->'row_version' source_version,a.id audit_id,
  count(*) over(partition by s.id,i->>'pending_text') matches
 from public.work_log_save_requests q
 cross join lateral jsonb_array_elements(case when jsonb_typeof(q.workforce_payload->'resolved_pending_items')='array' then q.workforce_payload->'resolved_pending_items' else '[]' end)i
 join public.site_work_logs s on s.id::text=i->>'source_log_id'
 join public.site_work_logs t on t.id::text=q.result#>>'{work_log,id}'
 join public.audit_logs a on a.entity_type='site_work_logs' and a.entity_id::text=s.id::text and a.action='update'
  and a.after_data->>'resolved_in_work_log_id'=t.id::text
  and a.before_data->>'row_version'=i->>'row_version'
  and a.before_data->>'log_date'=s.log_date::text
  and a.before_data->>'project_id'=s.project_id::text
 where s.deleted_at is null and t.deleted_at is null and s.id<>t.id and s.project_id=t.project_id
  and s.log_date<t.log_date and t.log_date::text=q.workforce_payload->>'log_date'
  and q.workforce_payload->>'project_id'=s.project_id::text
  and s.pending_completions='[]' and s.work_type not in ('維修紀錄','送貨','文書作業')
  and i->>'pending_text'<>''
  and i->>'pending_text'=any(regexp_split_to_array(coalesce(a.before_data->>'pending_content',case when a.before_data->>'status'='in_progress' then a.before_data->>'summary' end,''),E'\r?\n'))
  and not(i->>'pending_text'=any(regexp_split_to_array(coalesce(a.after_data->>'pending_content',''),E'\r?\n')))
  and ('['||(i->>'pending_text')||']('||to_char(t.log_date,'MM-DD')||'已完成)')=any(regexp_split_to_array(coalesce(a.after_data->>'completed_content',''),E'\r?\n'))
  and not(('['||(i->>'pending_text')||']('||to_char(t.log_date,'MM-DD')||'已完成)')=any(regexp_split_to_array(coalesce(a.before_data->>'completed_content',''),E'\r?\n')));
 for r in select * from work_log_pending_recovery order by source_id,pending_text loop
  select * into source_log from public.site_work_logs where id=r.source_id for update;
  select * into target_log from public.site_work_logs where id=r.target_id for update;
  if r.matches<>1
   or (select count(*) from regexp_split_to_table(coalesce(source_log.completed_content,''),E'\r?\n') line where line=r.old_label)<>1
   or (select count(*) from regexp_split_to_table(coalesce(target_log.completed_content,''),E'\r?\n') line where line in(r.old_label,public.work_log_pending_label_v1(r.pending_text,r.completed_date)))<>1
   or exists(select 1 from regexp_split_to_table(coalesce(source_log.pending_content,''),E'\r?\n') line where btrim(line) in(r.pending_text,public.work_log_pending_label_v1(r.pending_text,r.completed_date)))
  then skipped:=skipped+1;continue;end if;
  link:=jsonb_build_object('source_log_id',r.source_id,'source_log_date',r.source_date,'source_row_version',r.source_version,
    'pending_text',r.pending_text,'display_text',public.work_log_pending_label_v1(r.pending_text,r.completed_date),
    'target_log_id',r.target_id,'completed_date',r.completed_date,'actor_user_id',r.reporter_id,'request_id',r.request_id,
    'recovered_from_audit_id',r.audit_id);
  pending:=concat_ws(E'\n',nullif(source_log.pending_content,''),link->>'display_text');
  select coalesce(string_agg(line,E'\n' order by n),'') into completed from regexp_split_to_table(source_log.completed_content,E'\r?\n') with ordinality t(line,n) where line<>r.old_label;
  if length(pending)>2000 or length(concat_ws(E'\n',nullif(completed,''),nullif(pending,'')))>2000 then skipped:=skipped+1;continue;end if;
  select coalesce(string_agg(case when line=r.old_label then link->>'display_text' else line end,E'\n' order by n),'') into target_completed from regexp_split_to_table(target_log.completed_content,E'\r?\n') with ordinality t(line,n);
  update public.site_work_logs set pending_content=pending,completed_content=completed,
   summary=concat_ws(E'\n',nullif(completed,''),nullif(pending,'')),pending_completions=pending_completions||jsonb_build_array(link) where id=source_log.id;
  update public.site_work_logs set completed_content=target_completed,
   summary=concat_ws(E'\n',nullif(target_completed,''),nullif(pending_content,'')),pending_sources=pending_sources||jsonb_build_array(link) where id=target_log.id;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
   select 'site_work_logs',s.id,'update',to_jsonb(source_log),to_jsonb(s),'migration','pending-history-recovery' from public.site_work_logs s where s.id=source_log.id;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
   select 'site_work_logs',t.id,'update',to_jsonb(target_log),to_jsonb(t),'migration','pending-history-recovery' from public.site_work_logs t where t.id=target_log.id;
  recovered:=recovered+1;
 end loop;
 raise notice 'Pending history recovery: % exact pairs restored; % candidates skipped without guessing.',recovered,skipped;
end $recover$;

-- Maintenance already has explicit reciprocal references. Restore source display only;
-- never reconstruct edited target handling text or reinterpret historical notes.
do $repair_history$
declare source_event public.maintenance_events; target_event public.maintenance_events; h jsonb; link jsonb; links jsonb;
 source_date date; pending text; old_pending text; restored integer:=0;
begin
 for source_event in select * from public.maintenance_events where pending_completions<>'[]' order by id for update loop
  select log_date into source_date from public.site_work_logs where id=source_event.work_log_id;
  pending:=source_event.pending_content;links:='[]';
  for h in select value from jsonb_array_elements(source_event.pending_completions) loop
   select * into target_event from public.maintenance_events where id::text=h->>'target_event_id' and work_log_id::text=h->>'target_log_id';
   if not found or not exists(select 1 from jsonb_array_elements(target_event.pending_sources) s where s=h)
    or h->>'source_event_id'<>source_event.id::text or h->>'source_log_id'<>source_event.work_log_id::text
    or (select log_date::text from public.site_work_logs where id=target_event.work_log_id) is distinct from h->>'completed_date'
   then links:=links||jsonb_build_array(h);continue;end if;
   link:=h||jsonb_build_object('source_log_date',source_date,'display_text',public.work_log_pending_label_v1(h->>'pending_text',(h->>'completed_date')::date));
   old_pending:=pending;
   if not(link->>'display_text'=any(regexp_split_to_array(pending,E'\r?\n'))) then
    if h->>'pending_text'=any(regexp_split_to_array(pending,E'\r?\n')) then links:=links||jsonb_build_array(h);continue;end if;
    pending:=concat_ws(E'\n',nullif(pending,''),link->>'display_text');
   end if;
   if length(pending)>2000 then pending:=old_pending;links:=links||jsonb_build_array(h);continue;end if;
   links:=links||jsonb_build_array(link);
   update public.maintenance_events set pending_sources=(select jsonb_agg(case when v=h then link else v end order by n) from jsonb_array_elements(pending_sources) with ordinality t(v,n)) where id=target_event.id;
   restored:=restored+1;
  end loop;
  update public.maintenance_events set pending_content=pending,pending_completions=links where id=source_event.id;
 end loop;
 raise notice 'Maintenance history: % explicit reciprocal links restored.',restored;
end $repair_history$;

-- A deferred guard inspects the final row: legacy nested writers briefly change summary
-- before setting structured sections. Direct writers cannot bypass the final invariant.
create function public.guard_work_log_pending_history_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare current_log public.site_work_logs; h jsonb; label text;
begin
 if old.pending_completions='[]' and old.pending_sources='[]' then return null;end if;
 select * into current_log from public.site_work_logs where id=old.id;
 if not found or (current_log.project_id,current_log.department_id,current_log.log_date,current_log.work_type,current_log.deleted_at)
  is distinct from (old.project_id,old.department_id,old.log_date,old.work_type,old.deleted_at)
 then raise exception '此日誌有未完成事項的結清關聯，不可刪除或變更工作、科室、日期與類型。';end if;
 if not(current_log.pending_completions @> old.pending_completions and current_log.pending_sources @> old.pending_sources) then
  raise exception '工作日誌的未完成結清履歷不可修改或移除。';end if;
 for h in select value from jsonb_array_elements(old.pending_completions) loop
  label:=public.work_log_history_label_v1(h);
  if not(label=any(regexp_split_to_array(coalesce(current_log.pending_content,''),E'\r?\n')))
   or h->>'pending_text'=any(regexp_split_to_array(coalesce(current_log.pending_content,''),E'\r?\n'))
  then raise exception '已結清的未完成事項及完成日期須保留；新的問題請另建日誌。';end if;
 end loop;
 for h in select value from jsonb_array_elements(old.pending_sources) loop
  label:=public.work_log_history_label_v1(h);
  if label=any(regexp_split_to_array(coalesce(old.completed_content,''),E'\r?\n')) and
   not(label=any(regexp_split_to_array(coalesce(current_log.completed_content,''),E'\r?\n'))) then
   raise exception '本次承接的已完成事項及完成日期不可移除。';end if;
 end loop;
 if current_log.completed_content is null or current_log.pending_content is null or current_log.summary is distinct from
  concat_ws(E'\n',nullif(btrim(current_log.completed_content),''),nullif(btrim(current_log.pending_content),'')) then
  raise exception '此日誌有結清履歷，請使用已完成與未完成欄位編輯並保留歷史事項。';end if;
 return null;
end $$;
create constraint trigger work_log_pending_history_guard after update or delete on public.site_work_logs
 deferrable initially deferred for each row execute function public.guard_work_log_pending_history_v1();

create function public.guard_work_log_pending_project_v1() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if (new.customer_id,new.department_id,new.deleted_at) is distinct from (old.customer_id,old.department_id,old.deleted_at)
  and exists(select 1 from public.site_work_logs l where l.project_id=old.id and (l.pending_completions<>'[]' or l.pending_sources<>'[]')) then
  raise exception '此工作有日誌待辦結清關聯，不可刪除或變更客戶、科室。';end if;
 return new;
end $$;
create trigger work_log_pending_project_guard before update on public.projects for each row execute function public.guard_work_log_pending_project_v1();

create or replace function public.guard_maintenance_pending_history_v1() returns trigger language plpgsql security invoker set search_path='' as $$
declare h jsonb; label text;
begin
 if (old.pending_completions<>'[]' or old.pending_sources<>'[]') and
  (new.status,new.work_log_id,new.service_id,new.event_type,new.occurred_at) is distinct from (old.status,old.work_log_id,old.service_id,old.event_type,old.occurred_at)
 then raise exception '此事件有未完成事項的結清關聯，不可作廢或變更來源、承攬、類型及日期。';end if;
 if not(new.pending_completions @> old.pending_completions and new.pending_sources @> old.pending_sources) then raise exception '維修待辦結清履歷不可修改或移除。';end if;
 for h in select value from jsonb_array_elements(old.pending_completions) loop
  label:=public.work_log_history_label_v1(h);
  -- Ambiguous legacy rows skipped by recovery retain their prior state without forcing a guess.
  if label=any(regexp_split_to_array(old.pending_content,E'\r?\n')) and not(label=any(regexp_split_to_array(new.pending_content,E'\r?\n')))
   or (new.pending_content is distinct from old.pending_content and h->>'pending_text'=any(regexp_split_to_array(new.pending_content,E'\r?\n')))
  then raise exception '已結清的未完成事項及完成日期須保留；新的問題請另建事件。';end if;
 end loop;
 for h in select value from jsonb_array_elements(old.pending_sources) loop
  label:=public.work_log_history_label_v1(h);
  if label=any(regexp_split_to_array(coalesce(old.handling_process,''),E'\r?\n')) and not(label=any(regexp_split_to_array(coalesce(new.handling_process,''),E'\r?\n'))) then
   raise exception '本次承接的維修已完成事項及完成日期不可移除。';end if;
 end loop;
 return new;
end $$;

revoke all on function public.work_log_pending_label_v1(text,date),public.work_log_history_label_v1(jsonb),public.work_log_open_pending_lines_v1(text,jsonb),public.work_log_annotate_pending_v1(text,jsonb) from public,anon,authenticated;
grant execute on function public.work_log_pending_label_v1(text,date),public.work_log_history_label_v1(jsonb),public.work_log_open_pending_lines_v1(text,jsonb),public.work_log_annotate_pending_v1(text,jsonb) to service_role;
revoke all on function public.guard_work_log_pending_history_v1(),public.guard_work_log_pending_project_v1() from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
