-- 套用 migration 後：每位使用者結果須與套用前完全相同，耗時大幅下降；新稽核資料立即被索引。
do $after$
declare u record; t0 timestamptz; v jsonb; mismatches text:=''; slowest numeric:=0; before_max numeric; probe bigint; hit boolean; private_id uuid;
begin
  for u in select * from _scope_before loop
    t0:=clock_timestamp();v:=public.erp_private_scope_v1(u.id);
    slowest:=greatest(slowest,extract(epoch from clock_timestamp()-t0)*1000);
    if pg_temp.scope_norm(v) is distinct from u.r then mismatches:=mismatches||u.username||' '; end if;
  end loop;
  if mismatches<>'' then raise exception 'erp_private_scope_v1 results changed for: %',mismatches; end if;
  select max(ms) into before_max from _scope_before;
  -- 索引筆數與稽核資料筆數一致。
  if (select count(*) from public.audit_reference_index where source='audit_logs')<>(select count(*) from public.audit_logs) then raise exception 'audit_logs index incomplete'; end if;
  if (select count(*) from public.audit_reference_index where source='quotation_audit_log')<>(select count(*) from public.quotation_audit_log) then raise exception 'quotation_audit_log index incomplete'; end if;
  -- 新增的稽核資料提到受保護的資料時，必須立即出現在非直接檢視者的 audit_logs 篩選中。
  select x::uuid into private_id from _scope_before b cross join lateral jsonb_array_elements_text(b.r->'blocked') x
    where not b.direct and x ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' limit 1;
  if private_id is not null then
    insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('verification',null,'update','{}'::jsonb,jsonb_build_object('ref',private_id),'web','private-scope-verify') returning id into probe;
    select exists(select 1 from jsonb_array_elements_text(public.erp_private_scope_v1((select id from _scope_before where not direct limit 1))#>'{filters,audit_logs,id}') x where x=probe::text) into hit;
    if not hit then raise exception 'new audit row referencing a private record was not filtered'; end if;
    delete from public.audit_logs where id=probe;
    if exists(select 1 from public.audit_reference_index where source='audit_logs' and row_key=probe::text) then raise exception 'deleted audit row still indexed'; end if;
  end if;
  raise notice 'private scope index checks passed: users=% identical results, slowest before=% ms, slowest after=% ms, new-audit-probe=%',
    (select count(*) from _scope_before),round(before_max),round(slowest),coalesce(hit::text,'skipped (no private records)');
end $after$;
