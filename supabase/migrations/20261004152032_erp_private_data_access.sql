begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Existing app_users IDs are the sole identity source; never create duplicate accounts.
create table public.erp_private_access (
 singleton boolean primary key default true check(singleton),
 owner_user_id uuid not null references public.app_users(id) on delete restrict,
 viewer_user_ids uuid[] not null default '{}',
 row_version integer not null default 1,
 updated_at timestamptz not null default now()
);
alter table public.erp_private_access enable row level security;
revoke all on public.erp_private_access from public,anon,authenticated;
grant select,insert,update on public.erp_private_access to service_role;
alter table public.customers add column is_private boolean not null default false;
create index customers_private_idx on public.customers(id) where is_private;
alter table public.site_work_logs add column access_creator_user_id uuid references public.app_users(id) on delete restrict;
create index site_work_logs_access_creator_idx on public.site_work_logs(access_creator_user_id,id) where deleted_at is null;
-- Preserve immutable creator on new logs. reporter_user_id is changed by legacy editing RPCs.
create function public.preserve_work_log_access_creator_v1() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if TG_OP='INSERT' then new.access_creator_user_id:=new.reporter_user_id;
 else new.access_creator_user_id:=old.access_creator_user_id; end if;
 return new;
end $$;
create trigger preserve_work_log_access_creator before insert or update on public.site_work_logs
for each row execute function public.preserve_work_log_access_creator_v1();

create table public.work_log_access_requests (
 id uuid primary key default gen_random_uuid(),
 work_log_id uuid not null references public.site_work_logs(id) on delete cascade,
 applicant_user_id uuid not null references public.app_users(id) on delete cascade,
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 requested_at timestamptz not null default now(),
 reviewer_user_id uuid references public.app_users(id) on delete restrict,
 reviewed_at timestamptz,
 acknowledged_at timestamptz,
 row_version integer not null default 1,
 unique(work_log_id,applicant_user_id),
 check((status='pending' and reviewer_user_id is null and reviewed_at is null) or
       (status<>'pending' and reviewer_user_id is not null and reviewed_at is not null))
);
create index work_log_access_requests_applicant_idx on public.work_log_access_requests(applicant_user_id,status);
create index work_log_access_requests_pending_idx on public.work_log_access_requests(requested_at) where status='pending';
create index work_log_access_requests_reviewer_idx on public.work_log_access_requests(reviewer_user_id);
alter table public.work_log_access_requests enable row level security;
revoke all on public.work_log_access_requests from public,anon,authenticated;
grant select,insert,update,delete on public.work_log_access_requests to service_role;

create function public.is_erp_private_viewer_v1(p_user_id uuid) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.app_users u,public.erp_private_access c
 where u.id=p_user_id and u.is_active and (u.id=c.owner_user_id or u.id=any(c.viewer_user_ids)));
$$;
create function public.configure_erp_private_access_v1(p_actor_user_id uuid,p_owner_user_id uuid,p_viewer_user_ids uuid[],p_row_version integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_old public.erp_private_access; v_new public.erp_private_access;
begin
 perform pg_catalog.pg_advisory_xact_lock(hashtext('erp_private_access_configuration'));
 select * into v_old from public.erp_private_access for update;
 if v_old.singleton is null then
  if not exists(select 1 from public.app_users where id=p_actor_user_id and is_active and role='admin') then raise exception '沒有設定權限。'; end if;
  if p_row_version is not null then raise exception '設定已變更，請重新整理。'; end if;
 else
  -- A general administrator cannot add themselves to the private allowlist.
  if p_actor_user_id<>v_old.owner_user_id or not exists(select 1 from public.app_users where id=p_actor_user_id and is_active) then raise exception '只有私人資料擁有者有修改名單權限。'; end if;
  if p_row_version is distinct from v_old.row_version then raise exception '設定已被其他使用者修改。'; end if;
 end if;
 if p_owner_user_id is null or coalesce(cardinality(p_viewer_user_ids),0)>30 or
 not exists(select 1 from public.app_users where id=p_owner_user_id and is_active) or
 exists(select 1 from unnest(p_viewer_user_ids) x(id) where not exists(select 1 from public.app_users u where u.id=x.id and u.is_active))
 then raise exception '請選擇有效且啟用中的使用者。'; end if;
 insert into public.erp_private_access(singleton,owner_user_id,viewer_user_ids)
 values(true,p_owner_user_id,coalesce(p_viewer_user_ids,'{}'))
 on conflict(singleton) do update set owner_user_id=excluded.owner_user_id,viewer_user_ids=excluded.viewer_user_ids,
 row_version=erp_private_access.row_version+1,updated_at=now() returning * into v_new;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('erp_private_access',p_actor_user_id,case when v_old.singleton is null then 'insert' else 'update' end,to_jsonb(v_old),to_jsonb(v_new),'web',(select username from public.app_users where id=p_actor_user_id));
 return to_jsonb(v_new);
end $$;

create function public.set_customer_private_v1(p_actor_user_id uuid,p_customer_id uuid,p_row_version integer,p_is_private boolean)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_old public.customers; v_new public.customers;
begin
 if not exists(select 1 from public.app_users where id=p_actor_user_id and is_active and role='admin') then raise exception '只有管理員有逐筆標記私人客戶的權限。'; end if;
 if not exists(select 1 from public.erp_private_access) then raise exception '請先設定私人資料擁有者與可查看名單。'; end if;
 select * into v_old from public.customers where id=p_customer_id for update;
 if not found then raise exception '找不到客戶。'; end if;
 if v_old.is_private and not public.is_erp_private_viewer_v1(p_actor_user_id) then raise exception '沒有此私人客戶的操作權限。'; end if;
 if p_row_version is distinct from v_old.row_version then raise exception '客戶已被其他使用者修改。'; end if;
 if p_is_private is null then raise exception '請選擇私人客戶狀態。'; end if;
 update public.customers set is_private=p_is_private,updated_at=now() where id=p_customer_id returning * into v_new;
 update public.erp_private_access set row_version=row_version+1,updated_at=now();
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('customers',p_customer_id,'update',to_jsonb(v_old),to_jsonb(v_new),'web',(select username from public.app_users where id=p_actor_user_id));
 return jsonb_build_object('id',p_customer_id,'is_private',p_is_private,'row_version',v_new.row_version);
end $$;

-- Build a server-only denial set using existing FK relationships, not display names.
-- The Gateway applies these predicates BEFORE search/order/limit/count. Private child
-- records (repairs, attachments, equipment history, exports) cannot bypass a parent ACL.
create function public.erp_private_scope_v1(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_config public.erp_private_access; v_direct boolean; v_filters jsonb:='{}'; v_ids jsonb; v_prior jsonb; v_complete boolean:=false;
 v_blocked uuid[]:='{}'; v_document_ids uuid[]:='{}'; v_logs uuid[]:='{}'; v_fk record; v_doc record; v_round integer; v_requests jsonb; v_metadata jsonb; v_mutation_projects uuid[]:='{}';
 v_tables text[]:=array['customers','customer_contacts','customer_departments','customer_contract_services','projects','project_workers',
 'construction_details','maintenance_details','project_costs','sites','site_floors','site_locations','site_routes','site_route_segments',
 'site_devices','site_work_logs','site_work_log_workers','site_assets','site_notes','phone_systems','phone_extensions','phone_terminal_points',
 'phone_terminal_versions','phone_credential_access_logs','equipment_registry','maintenance_events','maintenance_event_equipment',
 'maintenance_event_workers','repair_items','pickup_records','stock_receipts','stock_receipt_customers','work_assignments',
 'work_log_save_requests','monitoring_device_imports','monitoring_device_import_rows','phone_terminal_import_logs',
 'phone_terminal_version_items','quotations','quotation_versions','quotation_items','quotation_status_history',
 'quotation_billing_history','quotation_audit_log','quotation_work_links','quotation_warranty_work','quotation_unquoted_deletions'];
begin
 if not exists(select 1 from public.app_users where id=p_user_id and is_active) then raise exception '沒有資料存取權限。'; end if;
 select * into v_config from public.erp_private_access;
 v_direct:=public.is_erp_private_viewer_v1(p_user_id);
 if v_config.singleton is not null and not v_direct then
  select coalesce(jsonb_agg(id),'[]') into v_ids from public.customers where is_private;
  v_filters:=jsonb_build_object('customers',jsonb_build_object('id',v_ids));
  select coalesce(jsonb_agg(distinct stock_receipt_id order by stock_receipt_id),'[]') into v_ids
  from public.stock_receipt_customers where customer_id in(select value::uuid from jsonb_array_elements_text(v_filters#>'{customers,id}'));
  v_filters:=v_filters||jsonb_build_object('stock_receipts',jsonb_build_object('id',v_ids));
  -- Legacy creation evidence: first audit before/after reporter ID, then legacy reporter
  -- when no creation evidence survives. Immutable creator is authoritative for new logs.
  select coalesce(array_agg(l.id),'{}') into v_logs from public.site_work_logs l
  where coalesce(l.access_creator_user_id,
   (select (coalesce(a.before_data->>'reporter_user_id',a.after_data->>'reporter_user_id'))::uuid
    from public.audit_logs a where a.entity_id=l.id and a.entity_type='site_work_logs'
    and coalesce(a.before_data->>'reporter_user_id',a.after_data->>'reporter_user_id') ~ '^[0-9a-fA-F-]{36}$'
    order by a.created_at asc,a.id asc limit 1),l.reporter_user_id)=v_config.owner_user_id;
  v_filters:=v_filters||jsonb_build_object('site_work_logs',jsonb_build_object('id',to_jsonb(v_logs)));
  -- Automatically created repair work names mirror log titles. A work containing
  -- only private logs must not reveal that title through projects/search/dashboard.
  -- Mixed work stays visible for its public logs; shared writes are guarded separately.
  select coalesce(jsonb_agg(p.id),'[]') into v_ids from public.projects p
  where exists(select 1 from public.site_work_logs l where l.project_id=p.id and l.id=any(v_logs))
   and not exists(select 1 from public.site_work_logs l where l.project_id=p.id and l.deleted_at is null and not(l.id=any(v_logs)));
  v_filters:=v_filters||jsonb_build_object('projects',jsonb_build_object('id',v_ids));
  for v_round in 1..30 loop
   v_prior:=v_filters;
   -- Polymorphic equipment sources and multi-work quotation links do not have a
   -- simple parent->child UUID FK. Preserve the entire quotation as one boundary.
   select coalesce(jsonb_agg(e.id),'[]') into v_ids from public.equipment_registry e
   where e.source_id in(select value::uuid from jsonb_array_elements_text(coalesce(v_filters#>array[e.source_table,'id'],'[]')))
      or e.id in(select value::uuid from jsonb_array_elements_text(coalesce(v_filters#>'{equipment_registry,id}','[]')));
   v_filters:=v_filters||jsonb_build_object('equipment_registry',jsonb_build_object('id',v_ids));
   if to_regclass('public.quotation_work_links') is not null then
    execute 'select coalesce(jsonb_agg(distinct quotation_id),''[]''::jsonb) from public.quotation_work_links
     where project_id in(select value::uuid from jsonb_array_elements_text($1))
        or quotation_id in(select value::uuid from jsonb_array_elements_text($2))'
     into v_ids using coalesce(v_filters#>'{projects,id}','[]'),coalesce(v_filters#>'{quotations,id}','[]');
    v_filters:=v_filters||jsonb_build_object('quotations',jsonb_build_object('id',v_ids));
   end if;
   -- Historical quote snapshots can retain private customer/work data after an
   -- ERP reassignment. Their existing audit UUIDs remain authoritative evidence.
   if to_regclass('public.quotation_audit_log') is not null then
    select coalesce(array_agg(distinct x.value::uuid),'{}') into v_blocked
     from jsonb_each(v_filters) t cross join lateral jsonb_each(t.value) c cross join lateral jsonb_array_elements_text(c.value) x;
    execute 'select coalesce(jsonb_agg(distinct quotation_id),''[]''::jsonb) from public.quotation_audit_log a
     where quotation_id in(select value::uuid from jsonb_array_elements_text($1))
       or exists(select 1 from regexp_matches(lower(to_jsonb(a)::text),''[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'',''g'') m where m[1]::uuid=any($2::uuid[]))'
     into v_ids using coalesce(v_filters#>'{quotations,id}','[]'),v_blocked;
    v_filters:=v_filters||jsonb_build_object('quotations',jsonb_build_object('id',v_ids));
   end if;
   for v_fk in
    select child.relname child_table,ca.attname child_column,parent.relname parent_table,
     exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=child.oid and a.attname='id' and a.atttypid='uuid'::regtype and not a.attisdropped) has_id
    from pg_catalog.pg_constraint f
    join pg_catalog.pg_class child on child.oid=f.conrelid join pg_catalog.pg_namespace n on n.oid=child.relnamespace
    join pg_catalog.pg_class parent on parent.oid=f.confrelid
    join pg_catalog.pg_attribute ca on ca.attrelid=child.oid and ca.attnum=f.conkey[1]
    join pg_catalog.pg_attribute pa on pa.attrelid=parent.oid and pa.attnum=f.confkey[1]
    where f.contype='f' and cardinality(f.conkey)=1 and cardinality(f.confkey)=1
     and n.nspname='public' and pa.attname='id' and ca.atttypid='uuid'::regtype
     and child.relname=any(v_tables) and jsonb_array_length(coalesce(v_filters#>array[parent.relname,'id'],'[]'))>0
   loop
    if v_fk.has_id then
     execute format('select coalesce(jsonb_agg(distinct id order by id),''[]''::jsonb) from public.%I where %I in (select value::uuid from jsonb_array_elements_text($1)) or id in (select value::uuid from jsonb_array_elements_text($2))',v_fk.child_table,v_fk.child_column)
      into v_ids using v_filters#>array[v_fk.parent_table,'id'],coalesce(v_filters#>array[v_fk.child_table,'id'],'[]');
     v_filters:=v_filters||jsonb_build_object(v_fk.child_table,jsonb_build_object('id',v_ids));
    else
     v_filters:=v_filters||jsonb_build_object(v_fk.child_table,coalesce(v_filters->v_fk.child_table,'{}')||
      jsonb_build_object(v_fk.child_column,v_filters#>array[v_fk.parent_table,'id']));
    end if;
   end loop;
   -- A document is edited atomically. Hide/block the complete document rather than
   -- exposing a partial set of lines whose save could alter a private line.
   for v_doc in select * from (values('stock_receipts','receipt_document_id'),('pickup_records','pickup_document_id')) x(tbl,col) loop
    if exists(select 1 from pg_catalog.pg_attribute where attrelid=to_regclass('public.'||v_doc.tbl) and attname=v_doc.col and not attisdropped) then
     execute format('select coalesce(jsonb_agg(distinct %I),''[]''::jsonb) from public.%I where id in (select value::uuid from jsonb_array_elements_text($1)) and %I is not null',v_doc.col,v_doc.tbl,v_doc.col)
     into v_ids using coalesce(v_filters#>array[v_doc.tbl,'id'],'[]');
     select array_agg(distinct id) into v_document_ids from (select unnest(v_document_ids) id union all select value::uuid from jsonb_array_elements_text(v_ids)) d;
     execute format('select coalesce(jsonb_agg(distinct id order by id),''[]''::jsonb) from public.%I where %I in(select value::uuid from jsonb_array_elements_text($1)) or id in(select value::uuid from jsonb_array_elements_text($2))',v_doc.tbl,v_doc.col)
     into v_ids using v_ids,coalesce(v_filters#>array[v_doc.tbl,'id'],'[]');
     v_filters:=v_filters||jsonb_build_object(v_doc.tbl,jsonb_build_object('id',v_ids));
    end if;
   end loop;
   if v_filters=v_prior then v_complete:=true;exit;end if;
  end loop;
  if not v_complete then raise exception '私人資料關聯檢查未完成，請稍後重試。'; end if;
  select coalesce(array_agg(distinct x.value::uuid),'{}') into v_blocked
  from jsonb_each(v_filters) t cross join lateral jsonb_each(t.value) c cross join lateral jsonb_array_elements_text(c.value) x;
  v_blocked:=v_blocked||coalesce(v_document_ids,'{}');
  -- Audit JSON contains historical copies. Filter matching entries before pagination,
  -- without hiding unrelated administrators' audit records.
  if cardinality(v_blocked)>0 then
   for v_doc in select unnest(array['audit_logs','data_conflicts']) tbl loop
    if to_regclass('public.'||v_doc.tbl) is not null then
     execute format('select coalesce(jsonb_agg(id),''[]''::jsonb) from public.%I a where exists(select 1 from regexp_matches(lower(to_jsonb(a)::text),''[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'',''g'') m where m[1]::uuid=any($1::uuid[]))',v_doc.tbl)
      into v_ids using v_blocked;
     v_filters:=v_filters||jsonb_build_object(v_doc.tbl,jsonb_build_object('id',v_ids));
    end if;
   end loop;
  end if;
  select coalesce(array_agg(distinct project_id) filter(where project_id is not null),'{}') into v_mutation_projects
  from public.site_work_logs where id in(select value::uuid from jsonb_array_elements_text(coalesce(v_filters#>'{site_work_logs,id}','[]')));
 end if;
 if public.has_app_permission_v1(p_user_id,'worklogs','VIEW') then
  select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'status',r.status,'request_id',r.id)),'[]') into v_metadata
  from public.site_work_logs l left join public.work_log_access_requests r on r.work_log_id=l.id and r.applicant_user_id=p_user_id
  where l.id=any(v_logs) and l.deleted_at is null and public.has_project_permission_v1(p_user_id,l.project_id,'VIEW');
 end if;
 select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('applicant',u.display_name)||
  case when v_direct then jsonb_build_object('log_title',l.title,'log_date',l.log_date) else '{}'::jsonb end order by r.requested_at,r.id),'[]') into v_requests
 from public.work_log_access_requests r join public.app_users u on u.id=r.applicant_user_id
 join public.site_work_logs l on l.id=r.work_log_id and l.deleted_at is null
 where (v_direct and r.status='pending' and public.has_app_permission_v1(p_user_id,'worklogs','VIEW') and public.has_project_permission_v1(p_user_id,l.project_id,'VIEW'))
 or (r.applicant_user_id=p_user_id and r.status<>'pending' and r.acknowledged_at is null);
 return jsonb_build_object('configured',v_config.singleton is not null,'visibility_version',v_config.row_version,'direct',v_direct,'filters',v_filters,'blocked_ids',v_blocked,
 'protected_user_ids',array_remove(array_prepend(v_config.owner_user_id,coalesce(v_config.viewer_user_ids,'{}')),null),'mutation_project_ids',v_mutation_projects,
 'restricted_logs',coalesce(v_metadata,'[]'),'requests',v_requests,
 'configuration',case when v_config.owner_user_id=p_user_id or exists(select 1 from public.app_users where id=p_user_id and role='admin') then to_jsonb(v_config) else null end,
 'configuration_users',case when v_config.owner_user_id=p_user_id or (v_config.singleton is null and exists(select 1 from public.app_users where id=p_user_id and role='admin'))
  then (select coalesce(jsonb_agg(jsonb_build_object('id',id,'username',username,'display_name',display_name) order by username),'[]') from public.app_users where is_active) else '[]'::jsonb end,
 'can_configure',case when v_config.singleton is null then exists(select 1 from public.app_users where id=p_user_id and role='admin') else v_config.owner_user_id=p_user_id end);
end $$;

create function public.request_work_log_access_v1(p_actor_user_id uuid,p_work_log_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_scope jsonb; v_row public.work_log_access_requests;
begin
 v_scope:=public.erp_private_scope_v1(p_actor_user_id);
 if not exists(select 1 from jsonb_array_elements(v_scope->'restricted_logs') x where x->>'id'=p_work_log_id::text) then raise exception '沒有此日誌的申請權限。'; end if;
 insert into public.work_log_access_requests(work_log_id,applicant_user_id) values(p_work_log_id,p_actor_user_id)
 on conflict(work_log_id,applicant_user_id) do update set
 status=case when work_log_access_requests.status='rejected' then 'pending' else work_log_access_requests.status end,
 requested_at=case when work_log_access_requests.status='rejected' then now() else work_log_access_requests.requested_at end,
 reviewer_user_id=case when work_log_access_requests.status='rejected' then null else work_log_access_requests.reviewer_user_id end,
 reviewed_at=case when work_log_access_requests.status='rejected' then null else work_log_access_requests.reviewed_at end,
 acknowledged_at=null,row_version=work_log_access_requests.row_version+1 returning * into v_row;
 insert into public.audit_logs(entity_type,entity_id,action,after_data,source,actor)
 values('work_log_access_requests',v_row.id,'insert',to_jsonb(v_row),'web',(select username from public.app_users where id=p_actor_user_id));
 return to_jsonb(v_row);
end $$;
create function public.review_work_log_access_v1(p_actor_user_id uuid,p_request_id uuid,p_row_version integer,p_approved boolean) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_old public.work_log_access_requests; v_row public.work_log_access_requests;
begin
 if not public.is_erp_private_viewer_v1(p_actor_user_id) then raise exception '沒有審核權限。'; end if;
 select * into v_old from public.work_log_access_requests where id=p_request_id for update;
 if not found or v_old.status<>'pending' or v_old.row_version is distinct from p_row_version then raise exception '申請已被其他使用者處理，請重新整理。'; end if;
 if p_approved is null then raise exception '請選擇同意或拒絕。'; end if;
 if not exists(select 1 from public.site_work_logs where id=v_old.work_log_id and deleted_at is null
  and public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW') and public.has_project_permission_v1(p_actor_user_id,project_id,'VIEW')) then raise exception '沒有此日誌的審核權限。'; end if;
 update public.work_log_access_requests set status=case when p_approved then 'approved' else 'rejected' end,
 reviewer_user_id=p_actor_user_id,reviewed_at=now(),acknowledged_at=null,row_version=row_version+1 where id=p_request_id returning * into v_row;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('work_log_access_requests',p_request_id,'update',to_jsonb(v_old),to_jsonb(v_row),'web',(select username from public.app_users where id=p_actor_user_id));
 return to_jsonb(v_row);
end $$;
create function public.read_shared_work_log_v1(p_actor_user_id uuid,p_work_log_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_log public.site_work_logs;
begin
 select * into v_log from public.site_work_logs where id=p_work_log_id and deleted_at is null;
 if not found or not public.has_app_permission_v1(p_actor_user_id,'worklogs','VIEW') or
 not public.has_project_permission_v1(p_actor_user_id,v_log.project_id,'VIEW') or
 not (public.is_erp_private_viewer_v1(p_actor_user_id) or exists(select 1 from public.work_log_access_requests
 where work_log_id=p_work_log_id and applicant_user_id=p_actor_user_id and status='approved')) then raise exception '沒有此日誌的查看權限。'; end if;
 -- Explicit projection: no Customer/Project lookup or attachments, no write grant.
 return jsonb_build_object('id',v_log.id,'log_date',v_log.log_date,'title',v_log.title,'summary',v_log.summary,
 'work_type',v_log.work_type,'status',v_log.status,'completed_content',to_jsonb(v_log)->'completed_content','pending_content',to_jsonb(v_log)->'pending_content','maintenance_events',
 (select coalesce(jsonb_agg(jsonb_build_object('event_type',m.event_type,'occurred_at',m.occurred_at,
 'description',m.description,'cause',m.cause,'handling_process',m.handling_process,'result',m.result,'notes',m.notes)),'[]')
 from public.maintenance_events m where m.work_log_id=p_work_log_id));
end $$;
create function public.acknowledge_work_log_access_v1(p_actor_user_id uuid,p_request_id uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
 update public.work_log_access_requests set acknowledged_at=now()
 where id=p_request_id and applicant_user_id=p_actor_user_id and status<>'pending';
 if not found then raise exception '沒有此通知的操作權限。'; end if;
end $$;

revoke all on function public.preserve_work_log_access_creator_v1(),public.is_erp_private_viewer_v1(uuid),
 public.configure_erp_private_access_v1(uuid,uuid,uuid[],integer),public.set_customer_private_v1(uuid,uuid,integer,boolean),
 public.erp_private_scope_v1(uuid),public.request_work_log_access_v1(uuid,uuid),public.review_work_log_access_v1(uuid,uuid,integer,boolean),
 public.read_shared_work_log_v1(uuid,uuid),public.acknowledge_work_log_access_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.preserve_work_log_access_creator_v1(),public.is_erp_private_viewer_v1(uuid),
 public.configure_erp_private_access_v1(uuid,uuid,uuid[],integer),public.set_customer_private_v1(uuid,uuid,integer,boolean),
 public.erp_private_scope_v1(uuid),public.request_work_log_access_v1(uuid,uuid),public.review_work_log_access_v1(uuid,uuid,integer,boolean),
 public.read_shared_work_log_v1(uuid,uuid),public.acknowledge_work_log_access_v1(uuid,uuid) to service_role;
-- Ledger totals remain correct after private transaction details are filtered out.
-- No customer, document, note, date, or actor information is returned.
create function public.erp_stock_totals_v1(p_actor_user_id uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
begin
 if not exists(select 1 from unnest(array['inventory','purchases','pickups','worklogs','repairs','reports']) m
  where public.has_app_permission_v1(p_actor_user_id,m,'VIEW')) then raise exception '沒有庫存查看權限。'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'quantity',coalesce(i.opening_quantity,0)+coalesce(r.q,0)-coalesce(p.q,0)+coalesce(a.q,0))),'[]')
 from public.inventory_items i
 left join (select inventory_item_id,sum(quantity) q from public.stock_receipts group by inventory_item_id) r on r.inventory_item_id=i.id
 left join (select inventory_item_id,sum(quantity) q from public.pickup_records group by inventory_item_id) p on p.inventory_item_id=i.id
 left join (select inventory_item_id,sum(difference_quantity) q from public.stock_adjustments group by inventory_item_id) a on a.inventory_item_id=i.id);
end $$;
revoke all on function public.erp_stock_totals_v1(uuid) from public,anon,authenticated;
grant execute on function public.erp_stock_totals_v1(uuid) to service_role;
-- Defaults verified read-only in the production user list on 2026-10-05.
-- This guarded seed is inert in other/test databases; an existing configuration wins.
do $$
declare v_count integer;v_present integer;
begin
 select count(*) into v_present from public.app_users where id in('bb880df3-a731-4735-8e1a-c95575aec875','5926554a-b8cc-4756-8d66-0a9a0877f94e','677ea242-1b1a-4c24-906a-3a28cd9621c7','79ce8566-898e-4dd3-a67b-d4eba7c088f5');
 select count(*) into v_count from public.app_users u join (values
 ('bb880df3-a731-4735-8e1a-c95575aec875'::uuid,'chent8241'),
 ('5926554a-b8cc-4756-8d66-0a9a0877f94e'::uuid,'williams'),
 ('677ea242-1b1a-4c24-906a-3a28cd9621c7'::uuid,'7289xl'),
 ('79ce8566-898e-4dd3-a67b-d4eba7c088f5'::uuid,'joyce')) expected(id,username)
 on u.id=expected.id and u.username=expected.username and u.is_active;
 if v_present>0 and v_count<>4 then raise exception '私人資料預設帳號不完整，請先重新核對既有帳號。'; end if;
 if v_count=4 then
  insert into public.erp_private_access(owner_user_id,viewer_user_ids) values
  ('bb880df3-a731-4735-8e1a-c95575aec875',array['5926554a-b8cc-4756-8d66-0a9a0877f94e','677ea242-1b1a-4c24-906a-3a28cd9621c7','79ce8566-898e-4dd3-a67b-d4eba7c088f5']::uuid[])
  on conflict(singleton) do nothing;
 end if;
end $$;
commit;
