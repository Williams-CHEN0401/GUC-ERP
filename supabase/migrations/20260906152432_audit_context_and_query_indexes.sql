-- Forward-compatible audit enrichment. Apply only with the matching Gateway release.
create schema if not exists audit_internal;
revoke all on schema audit_internal from public, anon, authenticated;

alter table public.audit_logs
  add column if not exists actor_user_id uuid,
  add column if not exists source_ip text,
  add column if not exists user_agent text,
  add column if not exists request_id uuid,
  add column if not exists system_module text;

create or replace function audit_internal.redact(value jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare result jsonb; entry record;
begin
  if value is null then return null; end if;
  if jsonb_typeof(value)='object' then
    result='{}'::jsonb;
    for entry in select key,val from jsonb_each(value) as item(key,val) loop
      result=result||jsonb_build_object(entry.key,case when entry.key ~* 'password|passwd|pwd|token|authorization|cookie|secret|credential|cipher|encryption|private.?key|service.?role|api.?key|密碼|金鑰' then to_jsonb('[已遮蔽]'::text) else audit_internal.redact(entry.val) end);
    end loop;
    return result;
  elsif jsonb_typeof(value)='array' then
    select coalesce(jsonb_agg(audit_internal.redact(item)), '[]'::jsonb) into result from jsonb_array_elements(value) as item;
    return result;
  elsif jsonb_typeof(value)='string' then
    return to_jsonb(regexp_replace(value#>>'{}','Bearer[[:space:]]+[^[:space:]]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(password|token|secret|密碼)[[:space:]]*[:=][[:space:]]*[^[:space:],;]+','[已遮蔽]','gi'));
  end if;
  return value;
end $$;

create or replace function audit_internal.enrich() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
declare headers jsonb; context jsonb; claims jsonb;
begin
  new.before_data=audit_internal.redact(new.before_data);
  new.after_data=audit_internal.redact(new.after_data);
  headers=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  claims=coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb;
  if claims->>'role'='service_role' and headers ? 'x-guc-audit-context' then
    context=(headers->>'x-guc-audit-context')::jsonb;
    new.actor=coalesce(nullif(context->>'actor',''),new.actor);
    new.actor_user_id=nullif(context->>'actorId','')::uuid;
    new.source_ip=nullif(left(context->>'sourceIp',64),'');
    new.user_agent=nullif(left(context->>'userAgent',512),'');
    new.request_id=nullif(context->>'requestId','')::uuid;
    new.system_module=case when context->>'system'='site' then 'site' else 'erp' end;
  end if;
  return new;
end $$;
drop trigger if exists audit_logs_enrich on public.audit_logs;
create trigger audit_logs_enrich before insert on public.audit_logs for each row execute function audit_internal.enrich();

-- Link tables have composite identities and cannot use capture_audit_log(), which assumes old.id.
create or replace function audit_internal.capture_links() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare before_row jsonb; after_row jsonb; row_data jsonb; entity_uuid uuid;
begin
  before_row=case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end;
  after_row=case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end;
  row_data=coalesce(after_row,before_row);
  -- Import history already owns the source workbook rows; do not duplicate thousands of rows in Audit.
  before_row=before_row-'source_rows';
  after_row=after_row-'source_rows';
  entity_uuid=coalesce(row_data->>'id',row_data->>'work_log_id',row_data->>'customer_id',row_data->>'project_id')::uuid;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,actor,source)
  values(tg_table_name,entity_uuid,lower(tg_op),before_row,after_row,coalesce(nullif(current_setting('app.actor',true),''),row_data->>'updated_by',row_data->>'actor'),'database');
  return coalesce(new,old);
end $$;
do $$ declare name text; begin
  foreach name in array array['contract_service_types','customer_contract_services','site_work_log_workers','project_workers','phone_terminal_import_logs'] loop
    if not exists(select 1 from pg_trigger where tgrelid=('public.'||name)::regclass and tgname=name||'_context_audit') then
      execute format('create trigger %I after insert or update or delete on public.%I for each row execute function audit_internal.capture_links()',name||'_context_audit',name);
    end if;
  end loop;
end $$;
revoke all on all functions in schema audit_internal from public,anon,authenticated;
grant usage on schema audit_internal to service_role;
grant execute on function audit_internal.redact(jsonb),audit_internal.enrich() to service_role;
alter table public.audit_logs enable row level security;
-- Existing RPCs are the only write path; the browser never inserts logs.
revoke insert,update,delete on public.audit_logs from anon,authenticated;
create index if not exists audit_logs_created_id_idx on public.audit_logs(created_at desc,id desc);
create index if not exists audit_logs_actor_created_idx on public.audit_logs(actor,created_at desc,id desc);
create index if not exists site_work_logs_dashboard_date_idx on public.site_work_logs(log_date desc,created_at desc,id desc) where deleted_at is null;
create index if not exists repair_items_dashboard_date_idx on public.repair_items(received_on desc,created_at desc,id desc);
-- Remove sensitive keys from historic payloads without changing event codes or identity.
update public.audit_logs set before_data=audit_internal.redact(before_data),after_data=audit_internal.redact(after_data)
where before_data is distinct from audit_internal.redact(before_data) or after_data is distinct from audit_internal.redact(after_data);
