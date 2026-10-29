-- Additive audit coverage. Existing events/identities/timestamps are not rewritten.
begin;
-- Request failures/exports and code-keyed forms may have no UUID record ID.
-- Keep their real request_id/entity_key instead of fabricating an entity UUID.
alter table public.audit_logs alter column entity_id drop not null;
alter table public.audit_logs
 add column if not exists event_kind text not null default 'legacy',
 add column if not exists outcome text not null default 'recorded',
 add column if not exists operation text,
 add column if not exists entity_key jsonb,
 add column if not exists record_label text;
alter table public.audit_logs add constraint audit_event_kind_check check(event_kind in ('legacy','change','request'));
alter table public.audit_logs add constraint audit_outcome_check check(outcome in ('recorded','completed','failed'));

create or replace function audit_internal.enrich() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
declare headers jsonb; context jsonb; claims jsonb;
begin
 new.before_data=audit_internal.redact(new.before_data);
 new.after_data=audit_internal.redact(new.after_data);
 headers=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
 claims=coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb;
 if new.event_kind='legacy' then new.event_kind='change'; end if;
 if claims->>'role'='service_role' and headers ? 'x-guc-audit-context' then
  context=(headers->>'x-guc-audit-context')::jsonb;
  new.actor=coalesce(nullif(context->>'actor',''),new.actor);
  new.actor_user_id=nullif(context->>'actorId','')::uuid;
  new.source_ip=nullif(left(context->>'sourceIp',64),'');
  new.user_agent=nullif(left(context->>'userAgent',512),'');
  new.request_id=nullif(context->>'requestId','')::uuid;
  new.system_module=case when context->>'system'='site' then 'site' else 'erp' end;
  new.operation=nullif(left(context->>'operation',100),'');
 end if;
 return new;
end $$;

-- Trigger-only internal function: not callable through the public Data API.
-- Runs in the business transaction: failed/rolled-back writes leave no change event.
create or replace function audit_internal.capture_form() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare b jsonb; a jsonb; r jsonb; identity jsonb='{}'; k text; entity uuid; label text; kind text;
begin
 b=case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
 a=case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
 if tg_op='UPDATE' and (b-array['updated_at','row_version','updated_by']) is not distinct from (a-array['updated_at','row_version','updated_by']) then return new; end if;
 r=coalesce(a,b);
 foreach k in array string_to_array(tg_argv[0],',') loop identity=identity||jsonb_build_object(k,r->k); end loop;
 foreach k in array array['id','project_id','work_log_id','document_id','construction_plan_id','customer_id','inventory_item_id','supplier_id','user_id'] loop
  if (r->>k) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then entity=(r->>k)::uuid;exit;end if;
 end loop;
 label=left(coalesce(r->>'document_no',r->>'receipt_document_no',r->>'pickup_document_no',r->>'log_no',r->>'repair_no',r->>'inventory_code',r->>'project_code',r->>'customer_code',r->>'item_name',r->>'name',r->>'title',r->>'display_name',r->>'role_code',r->>'code',''),240);
 -- Financial detail remains in its finance-restricted history, not general audit.
 if tg_table_name in ('accounting_payroll','accounting_worker_wages','accounting_material_prices') then
  select jsonb_object_agg(key,value) into b from jsonb_each(b) where key=any(array['id','project_id','inventory_item_id','worker_user_id','employee_id','work_date','month','deleted_at','row_version']);
  select jsonb_object_agg(key,value) into a from jsonb_each(a) where key=any(array['id','project_id','inventory_item_id','worker_user_id','employee_id','work_date','month','deleted_at','row_version']);
 end if;
 b=b-array['auth_user_id','source_rows'];a=a-array['auth_user_id','source_rows'];
 kind=case tg_table_name when 'inventory_items' then 'inventory_item' when 'pickup_records' then 'pickup_record' when 'stock_receipts' then 'stock_receipt' when 'stock_adjustments' then 'stock_adjustment' when 'projects' then 'project' else tg_table_name end;
 insert into public.audit_logs(entity_type,entity_id,entity_key,record_label,action,before_data,after_data,source,actor,event_kind)
 values(kind,entity,identity,label,lower(tg_op),b,a,coalesce(r->>'source','database'),nullif(current_setting('app.actor',true),''),'change');
 return coalesce(new,old);
end $$;
revoke all on function audit_internal.capture_form() from public,anon,authenticated,service_role;

-- Replace only audit triggers; all business/validation triggers stay intact.
do $$ declare spec text; tbl text; keys text; tr record; begin
 foreach spec in array array[
 'customers:id','customer_contacts:id','customer_departments:id','customer_categories:id','customer_contract_services:customer_id,service_type_id','contract_service_types:id',
 'suppliers:id','inventory_items:id','product_categories:id','stock_receipts:id','stock_receipt_customers:stock_receipt_id,customer_id','stock_transaction_documents:kind,id','pickup_records:id','stock_adjustments:id',
 'supplier_return_documents:id','supplier_return_lines:id','supplier_return_customers:document_id,customer_id','site_return_documents:id','site_return_lines:id',
 'projects:id','project_workers:project_id,user_id','construction_details:project_id','maintenance_details:project_id','project_costs:id','construction_plans:id','construction_plan_items:id','construction_plan_assignees:construction_plan_id,user_id',
 'work_assignments:id','site_work_logs:id','site_work_log_workers:work_log_id,user_id','work_log_access_requests:id','repair_items:id','site_assets:id','attachments:id',
 'maintenance_events:id','maintenance_event_equipment:event_id,equipment_id','maintenance_event_workers:event_id,user_id',
 'app_users:id','app_roles:code','role_permissions:role_code,module','supplier_payment_terms:supplier_id,effective_month','accounting_worker_wages:id','accounting_material_prices:project_id,inventory_item_id','accounting_payroll:id'
 ] loop
  tbl=split_part(spec,':',1);keys=split_part(spec,':',2);
  if to_regclass('public.'||tbl) is null then raise exception 'Required audit table missing: %',tbl;end if;
  for tr in select t.tgname from pg_trigger t join pg_proc p on p.oid=t.tgfoid where t.tgrelid=('public.'||tbl)::regclass and not t.tgisinternal and p.proname in ('capture_audit_log','capture_links','capture_form') loop
   execute format('drop trigger %I on public.%I',tr.tgname,tbl);
  end loop;
  execute format('create trigger %I after insert or update or delete on public.%I for each row execute function audit_internal.capture_form(%L)',tbl||'_form_audit',tbl,keys);
 end loop;
end $$;
alter table public.audit_logs enable row level security;
revoke insert,update,delete,truncate on public.audit_logs from anon,authenticated;
create index if not exists audit_logs_request_idx on public.audit_logs(request_id,created_at,id) where request_id is not null;
create index if not exists audit_logs_entity_history_idx on public.audit_logs(entity_type,entity_id,created_at desc,id desc);
create index if not exists audit_logs_outcome_idx on public.audit_logs(outcome,created_at desc,id desc);
commit;
