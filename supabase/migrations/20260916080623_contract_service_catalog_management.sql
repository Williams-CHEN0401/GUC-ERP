-- Extend the existing shared catalog. No reseeding, renaming, or changing customer links.
begin;
set local lock_timeout = '5s';
alter table public.contract_service_types add column row_version integer not null default 1 check(row_version>0);
create unique index contract_service_types_name_ci_uidx on public.contract_service_types(lower(btrim(name)));

create function public.version_contract_service_type_v1() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.id is distinct from old.id or new.code is distinct from old.code then
  raise exception '承攬內容代碼不可變更，請修改名稱。';
 end if;
 new.row_version:=old.row_version+1;
 new.updated_at:=now();
 return new;
end $$;
revoke all on function public.version_contract_service_type_v1() from public,anon,authenticated;
grant execute on function public.version_contract_service_type_v1() to service_role;
create trigger contract_service_types_version before update on public.contract_service_types
for each row execute function public.version_contract_service_type_v1();

create function public.manage_contract_service_type_v1(
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
  -- Include inactive customer links and historical rows. Existing FKs serialize concurrent references.
  if exists(select 1 from public.customer_contract_services where service_type_id=p_id)
    or exists(select 1 from public.sites where contract_service_type_id=p_id)
    or exists(select 1 from public.equipment_registry where service_id=p_id)
    or exists(select 1 from public.maintenance_events where service_id=p_id)
    or exists(select 1 from public.phone_terminal_import_logs where contract_service_type_id=p_id)
    or exists(select 1 from public.phone_terminal_versions where service_id=p_id) then
   raise exception '此承攬內容已有客戶、設備或歷史紀錄使用，不能刪除；可修改名稱。';
  end if;
  delete from public.contract_service_types where id=p_id returning * into v_result;
 end if;
 return v_result;
exception
 when unique_violation then raise exception '此承攬內容名稱已存在。';
 when foreign_key_violation then raise exception '此承攬內容已有客戶、設備或歷史紀錄使用，不能刪除；可修改名稱。';
end $$;
revoke all on function public.manage_contract_service_type_v1(text,uuid,integer,text,integer,text) from public,anon,authenticated;
grant execute on function public.manage_contract_service_type_v1(text,uuid,integer,text,integer,text) to service_role;
-- Existing RLS, service-role-only table grants and audit_internal.capture_links trigger remain in force.
commit;
