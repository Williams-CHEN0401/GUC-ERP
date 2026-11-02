begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Extend the same role_permissions matrix. No separate Auth or access table.
do $constraint$ declare definition text;begin
 select pg_get_constraintdef(oid) into definition from pg_constraint
 where conrelid='public.role_permissions'::regclass and conname='role_permissions_module_check';
 if position('website_erp' in definition)=0 then
  alter table public.role_permissions drop constraint role_permissions_module_check;
  execute 'alter table public.role_permissions add constraint role_permissions_module_check check (('||
   substring(definition from 8 for length(definition)-8)||') or module in (''website_erp'',''website_accounting'',''website_site'',''quotation_dashboard'',''quotations'',''quotation_billing'',''quotation_warranty''))';
 end if;
end $constraint$;
alter table public.role_permissions add constraint role_permissions_website_flags_check
 check(module not in ('website_erp','website_accounting','website_site') or not(can_update or can_delete));
comment on constraint role_permissions_website_flags_check on public.role_permissions is
 'Website entries reuse can_view=show entry and can_create=allow login. Missing entries preserve legacy access until explicitly configured.';

create function public.website_access_v1(p_user_id uuid,p_website text,p_action text default 'LOGIN')
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare actor public.app_users; permission public.role_permissions;begin
 if p_website not in ('erp','accounting','site') or p_action not in ('VIEW','LOGIN') then return false;end if;
 select * into actor from public.app_users where id=p_user_id and is_active;
 if not found then return false;end if;
 if actor.role='admin' then return true;end if;
 select * into permission from public.role_permissions where role_code=actor.role and module='website_'||p_website;
 if found then return permission.can_view and (p_action='VIEW' or permission.can_create);end if;
 -- Compatibility uses existing per-user accounting authorization, not a grant
 -- to every member of a role that happens to contain one authorized employee.
 if p_website='erp' then return true;end if;
 if p_website='site' then return public.has_app_permission_v1(p_user_id,'site','VIEW');end if;
 return exists(select 1 from public.quotation_access_users where app_user_id=p_user_id)
  or exists(select 1 from public.role_permissions where role_code=actor.role and can_view
   and module in ('performance','accounting_payables','accounting_payroll','accounting_tax'));
end $$;

create function public.website_access_summary_v1(p_user_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_object_agg(website,jsonb_build_object('visible',public.website_access_v1(p_user_id,website,'VIEW'),
  'login',public.website_access_v1(p_user_id,website,'LOGIN'))) from unnest(array['erp','accounting','site']) website;
$$;

create function public.quotation_feature_permission_v1(p_user_id uuid,p_module text,p_action text default 'VIEW')
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare actor public.app_users; permission public.role_permissions;begin
 if p_module not in ('quotation_dashboard','quotations','quotation_billing','quotation_warranty')
  or p_action not in ('VIEW','CREATE','UPDATE','DELETE') then return false;end if;
 if not public.website_access_v1(p_user_id,'accounting','LOGIN') then return false;end if;
 select * into actor from public.app_users where id=p_user_id and is_active;
 if actor.role='admin' then return true;end if;
 select * into permission from public.role_permissions where role_code=actor.role and module=p_module;
 if found then return case p_action when 'VIEW' then permission.can_view when 'CREATE' then permission.can_create
  when 'UPDATE' then permission.can_update when 'DELETE' then permission.can_delete else false end;end if;
 return exists(select 1 from public.quotation_access_users where app_user_id=p_user_id);
end $$;

create function public.quotation_feature_summary_v1(p_user_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_object_agg(module,jsonb_build_object('view',public.quotation_feature_permission_v1(p_user_id,module,'VIEW'),
  'create',public.quotation_feature_permission_v1(p_user_id,module,'CREATE'),
  'update',public.quotation_feature_permission_v1(p_user_id,module,'UPDATE'),
  'delete',public.quotation_feature_permission_v1(p_user_id,module,'DELETE')))
 from unnest(array['quotation_dashboard','quotations','quotation_billing','quotation_warranty']) module;
$$;

create or replace function public.quotation_require_access_v1(p_actor_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.website_access_v1(p_actor_user_id,'accounting','LOGIN') then
  raise exception '您沒有登入會計管理系統的權限。';end if;
end $$;

-- Keep owner options, login and the existing owner trigger on the same source.
-- Change only the predicate inside the existing private base; retain the outer
-- private-identity preparation/assertions and all customer/contact filtering.
do $owners$ declare target regprocedure; definition text; old_predicate text:=
 'exists (select 1 from public.quotation_access_users access where access.app_user_id=users.id)';
 new_predicate text:='(public.website_access_v1(users.id,''accounting'',''LOGIN'') and public.quotation_feature_permission_v1(users.id,''quotations'',''VIEW'') and public.erp_private_json_visible_v1(to_jsonb(users)))';
begin
 target:=coalesce(to_regprocedure('public.private_base_quotation_options_v1(uuid)'),to_regprocedure('public.quotation_options_v1(uuid)'));
 if target is null then raise exception 'Missing quotation owner options';end if;
 definition:=pg_get_functiondef(target);
 if position(old_predicate in definition)>0 then execute replace(definition,old_predicate,new_predicate);
 elsif position('(public.website_access_v1(users.id,''accounting'',''LOGIN'') and public.quotation_feature_permission_v1(users.id,''quotations'',''VIEW''))' in definition)>0 then
  execute replace(definition,'(public.website_access_v1(users.id,''accounting'',''LOGIN'') and public.quotation_feature_permission_v1(users.id,''quotations'',''VIEW''))',new_predicate);
 elsif position(new_predicate in definition)=0 then raise exception 'Quotation owner option source differs; review before migrating';end if;
end $owners$;

create or replace function public.quotation_validate_owner_access_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not public.website_access_v1(new.owner_user_id,'accounting','LOGIN')
  or not public.quotation_feature_permission_v1(new.owner_user_id,'quotations','VIEW') then
  raise exception '請選擇具有報價管理系統存取權限的負責人。';end if;
 return new;
end $$;

revoke all on function public.website_access_v1(uuid,text,text),public.website_access_summary_v1(uuid),
 public.quotation_feature_permission_v1(uuid,text,text),public.quotation_feature_summary_v1(uuid) from public,anon,authenticated;
grant execute on function public.website_access_v1(uuid,text,text),public.website_access_summary_v1(uuid),
 public.quotation_feature_permission_v1(uuid,text,text),public.quotation_feature_summary_v1(uuid) to service_role;

-- Keep the existing role save API, row-version checks, audit log and private
-- identity guards. Its current implementation accepts at most 100 modules.
notify pgrst,'reload schema';
commit;
