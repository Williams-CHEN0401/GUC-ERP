begin;
do $$begin if current_database() not like 'guc_website_permissions_%' then raise exception 'Run only on an isolated website-permissions test database';end if;end $$;
insert into app_roles(code,name,project_scoped)values('website_test','跨站權限測試角色',false)on conflict(code)do nothing;
update app_roles set row_version=1 where code='website_test';
insert into auth.users(id,email)values('00000000-0000-4000-8000-000000000001','isolated-role-admin@inventory.local'),('00000000-0000-4000-8000-000000000002','isolated-role-member@inventory.local')on conflict(id)do nothing;
insert into app_users(id,auth_user_id,username,display_name,role,is_active)values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','isolated_role_admin','隔離角色管理員','admin',true),('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','isolated_role_member','隔離角色人員','website_test',true)on conflict(id)do nothing;
insert into role_permissions(role_code,module,can_view,can_create,can_update,can_delete)select 'website_test',module,true,true,false,false from unnest(array['website_erp','website_accounting','website_site','quotations'])module on conflict(role_code,module)do update set can_view=true,can_create=true,can_update=false,can_delete=false;

create function pg_temp.expect(value boolean,label text) returns void language plpgsql as $$begin if value is distinct from true then raise exception 'FAIL: %',label;end if;end $$;
select pg_temp.expect(public.website_access_v1('00000000-0000-4000-8000-000000000002','erp','LOGIN'),'ERP allowed');
select pg_temp.expect(public.website_access_v1('00000000-0000-4000-8000-000000000002','accounting','LOGIN'),'Accounting role allow without legacy allowlist');
select pg_temp.expect(public.website_access_v1('00000000-0000-4000-8000-000000000002','site','LOGIN'),'Site allowed');
select pg_temp.expect(public.quotation_feature_permission_v1('00000000-0000-4000-8000-000000000002','quotations','CREATE'),'Quotation create allowed');
update role_permissions set can_create=false where role_code='website_test' and module='website_erp';
select pg_temp.expect(not public.website_access_v1('00000000-0000-4000-8000-000000000002','erp','LOGIN') and public.website_access_v1('00000000-0000-4000-8000-000000000002','erp','VIEW'),'Visible but login denied');
select pg_temp.expect(public.website_access_v1('00000000-0000-4000-8000-000000000002','accounting','LOGIN') and public.website_access_v1('00000000-0000-4000-8000-000000000002','site','LOGIN'),'Other sites unaffected');
update role_permissions set can_view=false,can_create=false where role_code='website_test' and module='website_site';
select pg_temp.expect(not public.website_access_v1('00000000-0000-4000-8000-000000000002','site','LOGIN') and not public.website_access_v1('00000000-0000-4000-8000-000000000002','site','VIEW'),'Hidden and login denied');
update role_permissions set can_create=false where role_code='website_test' and module='website_accounting';
select pg_temp.expect(not public.quotation_feature_permission_v1('00000000-0000-4000-8000-000000000002','quotations','VIEW'),'Accounting revoke overrides saved feature grant');
do $$begin
 begin perform public.quotation_require_access_v1('00000000-0000-4000-8000-000000000002');raise exception 'Expected deny';exception when raise_exception then if SQLERRM='Expected deny' then raise;end if;end;
 begin update role_permissions set can_update=true where role_code='website_test' and module='website_erp';raise exception 'Expected constraint';exception when check_violation then null;end;
 begin perform public.save_app_role_v1('00000000-0000-4000-8000-000000000002','website_test','Escalation',false,1,'[]');raise exception 'Expected admin deny';exception when raise_exception then if SQLERRM='Expected admin deny' then raise;end if;end;
end $$;
select pg_temp.expect(public.website_access_v1('00000000-0000-4000-8000-000000000001','erp','LOGIN') and public.website_access_v1('00000000-0000-4000-8000-000000000001','accounting','LOGIN') and public.website_access_v1('00000000-0000-4000-8000-000000000001','site','LOGIN'),'Admin cannot be locked out');
delete from role_permissions where role_code='website_test' and module like 'website_%';
select pg_temp.expect(not public.website_access_v1('00000000-0000-4000-8000-000000000002','accounting','LOGIN'),'Legacy no allowlist stays denied');
insert into quotation_access_users(app_user_id) values('00000000-0000-4000-8000-000000000002');
select pg_temp.expect(public.website_access_v1('00000000-0000-4000-8000-000000000002','accounting','LOGIN'),'Legacy individual allowlist retained');
delete from role_permissions where role_code='website_test' and module='quotations';
select pg_temp.expect(public.quotation_feature_permission_v1('00000000-0000-4000-8000-000000000002','quotations','VIEW'),'Legacy feature fallback retained');
select public.save_app_role_v1('00000000-0000-4000-8000-000000000001','website_test','跨站權限測試角色',false,(select row_version from app_roles where code='website_test'),
 '[{"module":"website_erp","can_view":true,"can_create":false},{"module":"website_accounting","can_view":true,"can_create":true},{"module":"website_site","can_view":false},{"module":"quotations","can_view":true,"can_create":false}]');
select pg_temp.expect(not public.website_access_v1('00000000-0000-4000-8000-000000000002','erp','LOGIN') and public.website_access_v1('00000000-0000-4000-8000-000000000002','accounting','LOGIN') and not public.website_access_v1('00000000-0000-4000-8000-000000000002','site','LOGIN'),'Existing role save persists three independent site flags');
select pg_temp.expect(public.quotation_feature_permission_v1('00000000-0000-4000-8000-000000000002','quotations','VIEW') and not public.quotation_feature_permission_v1('00000000-0000-4000-8000-000000000002','quotations','CREATE'),'View only action separation');
do $$begin begin perform public.save_app_role_v1('00000000-0000-4000-8000-000000000001','website_test','Conflict',false,1,'[]');raise exception 'Expected version conflict';exception when raise_exception then if SQLERRM='Expected version conflict' then raise;end if;end;end $$;
select pg_temp.expect(not has_function_privilege('anon','public.website_access_v1(uuid,text,text)','execute') and not has_function_privilege('authenticated','public.website_access_summary_v1(uuid)','execute') and not has_function_privilege('anon','public.quotation_feature_permission_v1(uuid,text,text)','execute'),'Internal RPC ACL');
rollback;