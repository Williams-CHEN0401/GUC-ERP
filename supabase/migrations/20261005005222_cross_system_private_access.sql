begin;
set local lock_timeout='5s';

-- Request-local, server-only scope. No session-global cache or client-supplied
-- allowlist; each transaction starts from the existing ERP privacy authority.
create function public.erp_private_prepare_v1(p_actor_user_id uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if p_actor_user_id is null then raise exception '沒有資料存取權限。'; end if;
 if current_setting('app.private_actor',true) is distinct from p_actor_user_id::text
    or nullif(current_setting('app.private_scope',true),'') is null then
  perform set_config('app.private_scope',public.erp_private_scope_v1(p_actor_user_id)::text,true);
  perform set_config('app.private_actor',p_actor_user_id::text,true);
 end if;
end $$;

create function public.erp_private_json_visible_v1(p_value jsonb) returns boolean
language plpgsql stable security invoker set search_path='' as $$
declare v_scope jsonb:=nullif(current_setting('app.private_scope',true),'')::jsonb;
begin
 if v_scope is null or not(v_scope ? 'blocked_ids') then raise exception '私人資料權限檢查尚未完成。'; end if;
 if not (v_scope->>'configured')::boolean or (v_scope->>'direct')::boolean then return true; end if;
 return not exists(select 1 from regexp_matches(coalesce(p_value::text,''),'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}','g') m
   where (v_scope->'blocked_ids') ? lower(m[1]));
end $$;

create function public.erp_private_assert_v1(p_value jsonb) returns void
language plpgsql stable security invoker set search_path='' as $$
begin
 if not public.erp_private_json_visible_v1(p_value) then raise exception '沒有此私人資料的操作權限。'; end if;
end $$;

-- Views are used only by the guarded read functions below (and quotation RPCs).
-- Filtering happens before joins, search, count, pagination and aggregation.
do $$
declare t text;
begin
 foreach t in array array['customers','customer_contacts','customer_departments','projects','project_workers',
 'site_work_logs','site_work_log_workers','maintenance_events','maintenance_event_equipment','maintenance_event_workers',
 'equipment_registry','site_devices','sites','phone_terminal_versions'] loop
  if to_regclass('public.'||t) is not null then
   execute format('create view public.%I with(security_invoker=true) as select r.* from public.%I r where public.erp_private_json_visible_v1(to_jsonb(r))','erp_private_'||t,t);
   execute format('revoke all on public.%I from public,anon,authenticated; grant select on public.%I to service_role','erp_private_'||t,'erp_private_'||t);
  end if;
 end loop;
end $$;

-- Preserve installed read-function bodies and return shapes. The new, explicit
-- actor argument comes only from inventory-gateway's authenticated app_user.
-- The old service-only RPCs are retained for staged rollout, never browser grants.
do $$
declare f record; definition text; t text; internal_name text; arg_names text; json_args text; wrapper_name text;
begin
 for f in select p.oid,p.proname,pg_get_function_arguments(p.oid) args,
   pg_get_function_identity_arguments(p.oid) identity_args,p.proargnames
   from pg_proc p where p.pronamespace='public'::regnamespace
   and p.proname in ('get_equipment_history_v1','search_equipment_history_v1','monitoring_customer_filters_v1','work_log_scope_v1') loop
  internal_name:='private_read_'||f.proname;
  wrapper_name:='private_'||f.proname;
  definition:=pg_get_functiondef(f.oid);
  definition:=replace(definition,'public.'||f.proname||'(', 'public.'||internal_name||'(');
  foreach t in array array['customers','customer_contacts','customer_departments','projects','project_workers',
   'site_work_logs','site_work_log_workers','maintenance_events','maintenance_event_equipment','maintenance_event_workers',
   'equipment_registry','site_devices','sites','phone_terminal_versions'] loop
   definition:=regexp_replace(definition,'(from|join)(\s+)public\.'||t||'\M','\1\2public.erp_private_'||t,'gi');
  end loop;
  execute definition;
  execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',internal_name,f.identity_args);
  select string_agg(quote_ident(a),','),string_agg('to_jsonb('||quote_ident(a)||')',',') into arg_names,json_args from unnest(f.proargnames) a;
  execute format($wrapper$
   create function public.%I(p_private_actor uuid,%s) returns jsonb language plpgsql security definer set search_path='' as $body$
   declare result jsonb;
   begin
    perform public.erp_private_prepare_v1(p_private_actor);
    perform public.erp_private_assert_v1(jsonb_build_array(%s));
    %s
    result:=public.%I(%s);
    perform public.erp_private_assert_v1(result);
    return result;
   end $body$;
  $wrapper$,wrapper_name,f.args,json_args,
   case when f.proname='work_log_scope_v1' then 'if p_user_id is distinct from p_private_actor then raise exception ''沒有資料存取權限。''; end if;' else '' end,
   internal_name,arg_names);
  execute format('revoke all on function public.%I(uuid,%s) from public,anon,authenticated; grant execute on function public.%I(uuid,%s) to service_role',wrapper_name,f.identity_args,wrapper_name,f.identity_args);
 end loop;
end $$;

revoke all on function public.erp_private_prepare_v1(uuid),public.erp_private_json_visible_v1(jsonb),public.erp_private_assert_v1(jsonb) from public,anon,authenticated;
grant execute on function public.erp_private_prepare_v1(uuid),public.erp_private_json_visible_v1(jsonb),public.erp_private_assert_v1(jsonb) to service_role;

-- Large exclusion lists must not become unbounded PostgREST URLs. These
-- table-valued RPCs preserve select/filter/order/range and FK embedding while
-- computing the exclusions inside the database from the authenticated actor.
-- Only tables already readable by service_role receive such an entrypoint.
create function public.erp_private_row_visible_v1(p_exclusions jsonb,p_row jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select not exists(select 1 from jsonb_each(p_exclusions) x where x.value ? (p_row->>x.key));
$$;
revoke all on function public.erp_private_row_visible_v1(jsonb,jsonb) from public,anon,authenticated,service_role;
do $$
declare t text;
begin
 foreach t in array array['customers','customer_contacts','customer_departments','customer_contract_services','projects','project_workers',
 'construction_details','maintenance_details','project_costs','sites','site_floors','site_locations','site_routes','site_route_segments',
 'site_devices','site_work_logs','site_work_log_workers','site_assets','site_notes','phone_systems','phone_extensions','phone_terminal_points',
 'phone_terminal_versions','phone_credential_access_logs','equipment_registry','maintenance_events','maintenance_event_equipment',
 'maintenance_event_workers','repair_items','pickup_records','stock_receipts','stock_receipt_customers','work_assignments',
 'monitoring_device_imports','monitoring_device_import_rows','phone_terminal_import_logs','phone_terminal_version_items','audit_logs','data_conflicts'] loop
  if to_regclass('public.'||t) is null then continue; end if;
  if not has_table_privilege('service_role','public.'||t,'SELECT') then continue; end if;
  execute format($function$
   create function public.%I(p_private_actor uuid) returns setof public.%I
   language plpgsql security definer set search_path='' as $body$
   declare v_scope jsonb; v_filters jsonb; v_exclusions jsonb;
   begin
    v_scope:=public.erp_private_scope_v1(p_private_actor);
    v_filters:=coalesce(v_scope#>array['filters',%L],'{}'::jsonb);
    if coalesce((v_filters->>'_deny_all')::boolean,false) then return; end if;
    select coalesce(jsonb_object_agg(x.key,coalesce((select jsonb_object_agg(a.value#>>'{}',true)
     from jsonb_array_elements(x.value) a),'{}'::jsonb)),'{}'::jsonb) into v_exclusions
    from jsonb_each(v_filters) x where jsonb_typeof(x.value)='array';
    return query select r.* from public.%I r where public.erp_private_row_visible_v1(v_exclusions,to_jsonb(r));
   end $body$;
  $function$,'private_select_'||t||'_v1',t,t,t);
  execute format('revoke all on function public.%I(uuid) from public,anon,authenticated; grant execute on function public.%I(uuid) to service_role','private_select_'||t||'_v1','private_select_'||t||'_v1');
 end loop;
end $$;
commit;
