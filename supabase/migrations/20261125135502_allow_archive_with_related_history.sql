begin;
set local lock_timeout='5s';

-- Work-log and project deletion already use soft deletion. Keep the checks on
-- physical removal and historical identity, while allowing an archive.

create or replace function public.guard_maintenance_pending_log_v1()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if not exists(select 1 from public.maintenance_events e where e.work_log_id=old.id
   and (e.pending_completions<>'[]' or e.pending_sources<>'[]' or btrim(e.pending_content)<>'')) then
  return new;
 end if;
 if (new.log_date,new.work_type) is distinct from (old.log_date,old.work_type) then
  raise exception '此日誌有維修未完成事項或結清關聯，不可變更日期與類型；科室及工作內容可修改，事項會同步歸屬。';
 end if;
 if new.project_id is distinct from old.project_id and
  (select p.customer_id from public.projects p where p.id=new.project_id) is distinct from
  (select p.customer_id from public.projects p where p.id=old.project_id) then
  raise exception '此日誌有維修未完成事項或結清關聯，不可移至其他客戶。';
 end if;
 return new;
end $$;

create or replace function public.guard_work_log_pending_history_v1()
returns trigger language plpgsql security invoker set search_path='' as $$
declare current_log public.site_work_logs; h jsonb; label text;
begin
 if old.pending_completions='[]' and old.pending_sources='[]' then return null;end if;
 select * into current_log from public.site_work_logs where id=old.id;
 if not found or (current_log.log_date,current_log.work_type)
  is distinct from (old.log_date,old.work_type) then
  raise exception '此日誌有未完成事項的結清關聯，不可實體刪除或變更日期與類型；科室及工作內容可修改，事項會同步歸屬。';
 end if;
 if current_log.project_id is distinct from old.project_id and
  (select p.customer_id from public.projects p where p.id=current_log.project_id) is distinct from
  (select p.customer_id from public.projects p where p.id=old.project_id) then
  raise exception '此日誌有未完成事項的結清關聯，不可移至其他客戶。';
 end if;
 if not(current_log.pending_completions @> old.pending_completions and current_log.pending_sources @> old.pending_sources) then
  raise exception '工作日誌的未完成結清履歷不可修改或移除。';end if;
 -- Archiving leaves the recorded text intact, including older imported histories.
 if old.deleted_at is null and current_log.deleted_at is not null
  and (current_log.project_id,current_log.department_id,current_log.summary,current_log.completed_content,
       current_log.pending_content,current_log.pending_completions,current_log.pending_sources)
   is not distinct from (old.project_id,old.department_id,old.summary,old.completed_content,
       old.pending_content,old.pending_completions,old.pending_sources) then return null; end if;
 for h in select value from jsonb_array_elements(old.pending_completions) loop
  label:=public.work_log_history_label_v1(h);
  if not(label=any(regexp_split_to_array(coalesce(current_log.pending_content,''),E'\r?\n')))
   or h->>'pending_text'=any(regexp_split_to_array(coalesce(current_log.pending_content,''),E'\r?\n')) then
   raise exception '已結清的未完成事項及完成日期須保留；新的問題請另建日誌。';
  end if;
 end loop;
 for h in select value from jsonb_array_elements(old.pending_sources) loop
  label:=public.work_log_history_label_v1(h);
  if label=any(regexp_split_to_array(coalesce(old.completed_content,''),E'\r?\n')) and
   not(label=any(regexp_split_to_array(coalesce(current_log.completed_content,''),E'\r?\n'))) then
   raise exception '本次承接的已完成事項及完成日期不可移除。';
  end if;
 end loop;
 if current_log.completed_content is null or current_log.pending_content is null or current_log.summary is distinct from
  concat_ws(E'\n',nullif(btrim(current_log.completed_content),''),nullif(btrim(current_log.pending_content),'')) then
  raise exception '此日誌有結清履歷，請使用已完成與未完成欄位編輯並保留歷史事項。';
 end if;
 return null;
end $$;

create or replace function public.guard_maintenance_pending_project_v1() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if (new.customer_id,new.department_id) is distinct from (old.customer_id,old.department_id)
  and (old.repair_root_project_id is not null or exists(select 1 from public.projects p where p.repair_root_project_id=old.id)
   or exists(select 1 from public.maintenance_events e join public.site_work_logs l on l.id=e.work_log_id where l.project_id=old.id and (btrim(e.pending_content)<>'' or e.pending_completions<>'[]' or e.pending_sources<>'[]')))
 then raise exception '此工作有維修待辦或回訪關聯，不可變更客戶、科室。';end if;
 if old.repair_root_project_id is not null and new.repair_root_project_id is distinct from old.repair_root_project_id then raise exception '維修回訪來源不可變更。';end if;
 return new;
end $$;

create or replace function public.guard_work_log_pending_project_v1() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if (new.customer_id,new.department_id) is distinct from (old.customer_id,old.department_id)
  and exists(select 1 from public.site_work_logs l where l.project_id=old.id and (l.pending_completions<>'[]' or l.pending_sources<>'[]')) then
  raise exception '此工作有日誌待辦結清關聯，不可變更客戶、科室。';end if;
 return new;
end $$;

create or replace function public.delete_project_record(p_id uuid,p_row_version integer,p_actor text)
returns integer language plpgsql security definer set search_path='' as $$
declare p public.projects; q public.quotations; actor_id uuid; archived_ids uuid[]:='{}';
begin
 select id into actor_id from public.app_users where username=p_actor and is_active;
 if actor_id is null or not public.has_app_permission_v1(actor_id,'projects','DELETE') then
  raise exception '您的帳號沒有刪除工作內容的權限。';
 end if;
 perform public.erp_private_prepare_v1(actor_id);
 perform public.erp_private_assert_v1(jsonb_build_array(p_id));
 if exists(select 1 from public.app_users u join public.app_roles r on r.code=u.role
  where u.id=actor_id and r.project_scoped) and not exists(
  select 1 from public.project_workers where project_id=p_id and user_id=actor_id and can_view) then
  raise exception '您的帳號沒有此工作內容的存取權限。';
 end if;
 select * into p from public.projects where id=p_id for update;
 if not found then raise exception '找不到工作內容資料。'; end if;
 -- A retry of an already completed soft delete never changes another record.
 if p.deleted_at is not null then return 1; end if;
 if p.row_version is distinct from p_row_version then raise exception '工作內容資料已被其他使用者更新，請重新載入後再刪除。'; end if;
 for q in select quote.* from public.quotations quote where quote.archived_at is null
  and (quote.project_id=p_id or exists(select 1 from public.quotation_work_links l where l.quotation_id=quote.id and l.project_id=p_id))
  order by quote.id for update loop
  -- Leave shared quotes and their historical links available to the other work.
  if exists(select 1 from public.quotation_work_links l join public.projects other on other.id=l.project_id
    where l.quotation_id=q.id and l.project_id<>p_id and other.deleted_at is null)
    or (q.project_id is not null and q.project_id<>p_id and exists(select 1 from public.projects where id=q.project_id and deleted_at is null)) then
   continue;
  end if;
  perform public.erp_private_assert_v1(to_jsonb(q));
  update public.quotations set archived_at=statement_timestamp(),archived_by_user_id=actor_id,
   archive_reason='ERP 工作內容刪除：'||p_id::text,updated_by_user_id=actor_id where id=q.id;
  perform public.quotation_write_audit_v1(actor_id,q.id,q.current_version_id,'delete',to_jsonb(q),
   jsonb_build_object('event','erp_work_deleted','work_content_id',p_id,'archived',true,'financial_history_preserved',true));
  archived_ids:=array_append(archived_ids,q.id);
 end loop;
 perform public.delete_project_before_accounting_v1(p_id,p_row_version,p_actor);
 insert into public.audit_logs(entity_type,entity_id,action,source,actor,actor_user_id,system_module,before_data,after_data)
 values('project',p_id,'update','web',p_actor,actor_id,'projects',jsonb_build_object('row_version',p_row_version),
  jsonb_build_object('event','work_accounting_delete','archived_quotation_ids',to_jsonb(archived_ids),'financial_history_preserved',true));
 return 1;
end $$;

-- The phone system is optional on each extension. Keep the extensions,
-- terminal points and their maintenance registry, and remove only the phone system.
create or replace function public.delete_phone_system_v1(p_id uuid,p_row_version integer,p_actor text)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.phone_systems where id=p_id and row_version=p_row_version for update;
 if not found then raise exception '總機資料已被其他使用者更新，請重新載入後再刪除。'; end if;

 perform pg_catalog.set_config('app.actor',coalesce(p_actor,''),true);
 update public.phone_extensions
 set phone_system_id=null,updated_by=p_actor,updated_at=statement_timestamp()
 where phone_system_id=p_id;

 delete from public.phone_systems where id=p_id;
end $$;

-- The existing inactive state removes a used category from new-item forms
-- while preserving its ID and name on existing inventory and repair records.
create or replace function public.delete_product_category_v1(p_id uuid,p_row_version integer,p_actor text)
returns void language plpgsql security invoker set search_path='' as $$
declare
 existing public.product_categories;
begin
 select * into existing from public.product_categories where id=p_id for update;
 if not found or p_row_version is null or existing.row_version<>p_row_version then
  raise exception '此貨品種類已被更新或刪除，請重新載入後再操作。';
 end if;
 perform pg_catalog.set_config('app.actor',coalesce(p_actor,''),true);
 begin
  delete from public.product_categories where id=p_id;
 exception when foreign_key_violation then
  update public.product_categories set is_active=false,updated_by=p_actor where id=p_id and is_active;
 end;
end $$;

-- Custom catalog entries keep their links when they leave active forms.
create or replace function public.manage_contract_service_type_v1(
 p_action text,p_id uuid,p_row_version integer,p_name text,p_sort_order integer,p_actor text
) returns public.contract_service_types
language plpgsql security invoker set search_path='' as $$
declare v_existing public.contract_service_types; v_result public.contract_service_types; v_name text:=btrim(coalesce(p_name,''));
begin
 if p_action is null or p_action not in ('create','update','delete') then raise exception '不支援的承攬內容操作。'; end if;
 if p_action<>'delete' and (char_length(v_name) not between 1 and 80 or p_sort_order is null or p_sort_order not between 0 and 100000) then
  raise exception '承攬名稱須為 1–80 個字；排序須為 0–100000 的整數。';
 end if;
 perform pg_catalog.set_config('app.actor',coalesce(p_actor,''),true);
 if p_action<>'create' then
  select * into v_existing from public.contract_service_types where id=p_id for update;
  if not found or p_row_version is null or v_existing.row_version<>p_row_version then
   raise exception '此承攬內容已被更新或刪除，請重新載入後再操作。';
  end if;
 end if;
 if p_action='create' then
  insert into public.contract_service_types(code,name,sort_order)
  values('custom_'||replace(gen_random_uuid()::text,'-',''),v_name,p_sort_order) returning * into v_result;
 elsif p_action='update' then
  update public.contract_service_types set name=v_name,sort_order=p_sort_order where id=p_id returning * into v_result;
 else
  if v_existing.code in ('phone_system','surveillance') then
   raise exception '電話與監控承攬為系統必要項目，可修改名稱但不能刪除。';
  end if;
  -- Existing customers, equipment and history still use the original ID.
  update public.contract_service_types set is_active=false where id=p_id and is_active returning * into v_result;
  if not found then v_result:=v_existing; end if;
 end if;
 return v_result;
exception
 when unique_violation then raise exception '此承攬內容名稱已存在。';
end $$;

notify pgrst,'reload schema';
commit;
