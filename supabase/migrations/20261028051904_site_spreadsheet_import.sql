begin;
set local lock_timeout='5s';

-- Excel business values are optional and may repeat. UUID remains authoritative.
-- Existing manual writers retain their own validation; no writer uses this key
-- as an ON CONFLICT target (equipment_registry still keys source_table/source_id).
drop index public.site_devices_active_ip_unique;
alter table public.site_devices drop constraint site_devices_site_id_device_no_key;
create index site_devices_active_ip_idx on public.site_devices(site_id,(ip_address::inet))
 where deleted_at is null and ip_address is not null and btrim(ip_address)<>'';
create index site_devices_site_number_idx on public.site_devices(site_id,device_no);

-- Request receipts only; devices/history remain in their existing master tables.
create table public.site_spreadsheet_imports (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null unique,
 customer_id uuid not null references public.customers(id),
 service_id uuid not null references public.contract_service_types(id),
 site_id uuid not null references public.sites(id),
 kind text not null check(kind in ('devices','history')),
 source_id uuid references public.site_devices(id),
 actor_user_id uuid not null references public.app_users(id),
 file_name text not null check(length(file_name) between 1 and 255),
 sheet_name text not null check(length(sheet_name) between 1 and 120),
 file_hash text not null check(file_hash ~ '^[0-9a-f]{64}$'),
 inserted_count integer not null check(inserted_count between 1 and 1000),
 created_at timestamptz not null default now(),
 check((kind='devices' and source_id is null) or (kind='history' and source_id is not null))
);
alter table public.site_spreadsheet_imports enable row level security;
revoke all on public.site_spreadsheet_imports from public,anon,authenticated;
grant select,insert on public.site_spreadsheet_imports to service_role;
create index site_spreadsheet_imports_scope_idx on public.site_spreadsheet_imports(customer_id,service_id,created_at desc);
alter table public.site_devices add column spreadsheet_import_id uuid references public.site_spreadsheet_imports(id);
create index site_devices_spreadsheet_import_idx on public.site_devices(spreadsheet_import_id) where spreadsheet_import_id is not null;

-- Preserve legacy manual duplicate validation after replacing the unique indexes.
-- Only inserts made by the new transactional Excel writer have a scoped receipt.
create function public.site_devices_legacy_unique_v1() returns trigger
language plpgsql security invoker set search_path='' as $$
declare check_number boolean; check_ip boolean;
begin
 check_number:=tg_op='INSERT';check_ip:=tg_op='INSERT';
 if tg_op='UPDATE' then
  check_number:=new.site_id is distinct from old.site_id or new.device_no is distinct from old.device_no;
  check_ip:=new.site_id is distinct from old.site_id or new.ip_address is distinct from old.ip_address or new.deleted_at is distinct from old.deleted_at;
 end if;
 if not check_number and not check_ip then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended('site-device-values:'||new.site_id,0));
 if tg_op='INSERT' and new.spreadsheet_import_id is not null then
  if not exists(select 1 from public.site_spreadsheet_imports where id=new.spreadsheet_import_id and site_id=new.site_id and kind='devices') then raise exception '設備匯入批次範圍不正確。'; end if;
  return new;
 end if;
 if check_number and exists(select 1 from public.site_devices d where d.site_id=new.site_id and d.id<>new.id and d.device_no=new.device_no)
 then raise unique_violation using message='此設備編號已存在。'; end if;
 if check_ip and new.deleted_at is null and nullif(btrim(new.ip_address),'') is not null and exists(select 1 from public.site_devices d
  where d.site_id=new.site_id and d.id<>new.id and d.deleted_at is null and nullif(btrim(d.ip_address),'') is not null and d.ip_address::inet=new.ip_address::inet)
 then raise unique_violation using message='此 IP 位址已被其他有效設備使用。'; end if;
 return new;
end $$;
revoke all on function public.site_devices_legacy_unique_v1() from public,anon,authenticated;
grant execute on function public.site_devices_legacy_unique_v1() to service_role;
create trigger site_devices_legacy_unique before insert or update of site_id,device_no,ip_address,deleted_at on public.site_devices for each row execute function public.site_devices_legacy_unique_v1();

create function public.site_spreadsheet_custom_name_valid_v1(p_name text) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(length(btrim(p_name)) between 1 and 120 and p_name !~ '[[:cntrl:]]'
  and lower(p_name) not in ('__proto__','constructor','prototype')
  and regexp_replace(lower(normalize(p_name,NFKC)),'[[:space:]_/／（）()-]','','g') not in ('帳號','登入帳號','使用者帳號','登入密碼','username','loginusername','loginpassword','password')
  and p_name !~* 'password|passwd|密碼|帳密|secret|token|api.?key',false);
$$;
create function public.site_spreadsheet_fields_valid_v1(p_fields jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare field record;
begin
 if jsonb_typeof(p_fields) is distinct from 'object' or octet_length(p_fields::text)>262144 then return false; end if;
 if (select count(*) from jsonb_object_keys(p_fields))>50 then return false; end if;
 for field in select * from jsonb_each(p_fields) loop
  if not public.site_spreadsheet_custom_name_valid_v1(field.key) or jsonb_typeof(field.value) not in ('string','null') or char_length(field.value#>>'{}')>4000 then return false; end if;
 end loop;
 return true;
end $$;
create function public.site_spreadsheet_columns_valid_v1(p_kind text,p_columns jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare col jsonb; keys text[]:='{}'; known text[]; k text; label text;
begin
 if p_kind not in ('devices','history') or p_kind is null or jsonb_typeof(p_columns) is distinct from 'array' then return false; end if;
 if jsonb_array_length(p_columns) not between 1 and 50 then return false; end if;
 known:=case when p_kind='history' then array['occurred_at','event_type','description','cause','result','worker_names_text','notes']
  else array['device_no','device_name','device_type','device_brand','device_model','ip_address','http_port','access_station_no','network_cable_no','cabinet','status','details','notes','manual_url','serial_number','installed_on','warranty_end_on','supports_audio','resolution_width','resolution_height','fps','login_username','login_password'] end;
 for col in select value from jsonb_array_elements(p_columns) loop
  k:=col->>'key';label:=col->>'label';
  if jsonb_typeof(col) is distinct from 'object' or jsonb_typeof(col->'key') is distinct from 'string' or jsonb_typeof(col->'label') is distinct from 'string'
   or char_length(k) not between 1 and 127 or char_length(btrim(label)) not between 1 and 120 or (k||label)~'[[:cntrl:]]' or k=any(keys) then return false; end if;
  if k not in ('login_username','login_password') and (regexp_replace(lower(normalize(label,NFKC)),'[[:space:]_/／（）()-]','','g') in ('帳號','登入帳號','使用者帳號','登入密碼','username','loginusername','loginpassword','password') or label ~* 'password|passwd|密碼|帳密|secret|token|api.?key') then return false; end if;
  if not k=any(known) and not (left(k,7)='custom:' and public.site_spreadsheet_custom_name_valid_v1(substr(k,8)) and public.site_spreadsheet_custom_name_valid_v1(label)) then return false; end if;
  keys:=array_append(keys,k);
 end loop;
 return true;
end $$;
revoke all on function public.site_spreadsheet_custom_name_valid_v1(text),public.site_spreadsheet_fields_valid_v1(jsonb),public.site_spreadsheet_columns_valid_v1(text,jsonb) from public,anon,authenticated;
grant execute on function public.site_spreadsheet_custom_name_valid_v1(text),public.site_spreadsheet_fields_valid_v1(jsonb),public.site_spreadsheet_columns_valid_v1(text,jsonb) to service_role;

create table public.site_spreadsheet_templates (
 id uuid primary key default gen_random_uuid(),
 service_id uuid not null references public.contract_service_types(id),
 kind text not null check(kind in ('devices','history')),
 device_type text not null default '' check(device_type in ('','monitoring_host','camera','hub')),
 name text not null check(char_length(btrim(name)) between 1 and 120),
 columns jsonb not null check(public.site_spreadsheet_columns_valid_v1(kind,columns)),
 row_version integer not null default 1 check(row_version>=1),
 created_by uuid not null references public.app_users(id),
 updated_by uuid not null references public.app_users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(service_id,kind,device_type),check(kind='devices' or device_type='')
);
alter table public.site_spreadsheet_templates enable row level security;
revoke all on public.site_spreadsheet_templates from public,anon,authenticated;
grant select,insert,update on public.site_spreadsheet_templates to service_role;
alter table public.site_devices add column spreadsheet_fields jsonb not null default '{}' check(public.site_spreadsheet_fields_valid_v1(spreadsheet_fields));
alter table public.maintenance_events add column spreadsheet_fields jsonb not null default '{}' check(public.site_spreadsheet_fields_valid_v1(spreadsheet_fields));

create function public.save_site_spreadsheet_template_v1(p_actor_user_id uuid,p_customer_id uuid,p_service_id uuid,p_kind text,p_device_type text,p_name text,p_columns jsonb,p_row_version integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare service public.contract_service_types; old_row public.site_spreadsheet_templates; new_row public.site_spreadsheet_templates; actor text;
begin
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform public.erp_private_assert_v1(jsonb_build_object('customer_id',p_customer_id));
 select username into actor from public.app_users where id=p_actor_user_id and is_active;
 select * into service from public.contract_service_types where id=p_service_id and is_active and code<>'phone_system';
 if service.id is null or actor is null or not exists(select 1 from public.customer_contract_services c join public.customers u on u.id=c.customer_id where c.customer_id=p_customer_id and c.service_type_id=p_service_id and c.is_active and u.deleted_at is null) then raise exception '找不到可用的非電話客戶承攬資料。'; end if;
 if not public.has_app_permission_v1(p_actor_user_id,'site','VIEW')
 or not public.has_app_permission_v1(p_actor_user_id,case when service.code='surveillance' then 'monitoring' else 'equipment' end,'VIEW')
 or not public.has_app_permission_v1(p_actor_user_id,case when p_kind='history' then 'history' when service.code='surveillance' then 'monitoring' else 'equipment' end,'UPDATE')
 or (p_kind='history' and not public.has_app_permission_v1(p_actor_user_id,'history','VIEW')) then raise exception '沒有修改此承攬範本的權限。'; end if;
 if not public.site_spreadsheet_columns_valid_v1(p_kind,p_columns) or p_device_type is null or p_device_type not in ('','monitoring_host','camera','hub') or (p_kind='history' and p_device_type<>'')
 or coalesce(char_length(btrim(p_name)),0) not between 1 and 120 then raise exception '範本名稱或欄位對應格式不正確。'; end if;
 perform pg_advisory_xact_lock(hashtextextended('site-template:'||p_service_id||':'||p_kind||':'||p_device_type,0));
 select * into old_row from public.site_spreadsheet_templates where service_id=p_service_id and kind=p_kind and device_type=p_device_type for update;
 if found then
  if old_row.row_version is distinct from p_row_version then raise exception '範本已被其他使用者更新，請重新載入。'; end if;
  update public.site_spreadsheet_templates set name=btrim(p_name),columns=p_columns,row_version=row_version+1,updated_by=p_actor_user_id,updated_at=now() where id=old_row.id returning * into new_row;
 else
  if p_row_version is not null then raise exception '範本版本已變動，請重新載入。'; end if;
  insert into public.site_spreadsheet_templates(service_id,kind,device_type,name,columns,created_by,updated_by) values(p_service_id,p_kind,p_device_type,btrim(p_name),p_columns,p_actor_user_id,p_actor_user_id) returning * into new_row;
 end if;
 insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
 values('site_spreadsheet_templates',new_row.id,case when old_row.id is null then 'insert' else 'update' end,to_jsonb(old_row),to_jsonb(new_row),'site_data',actor);
 return to_jsonb(new_row);
end $$;
revoke all on function public.save_site_spreadsheet_template_v1(uuid,uuid,uuid,text,text,text,jsonb,integer) from public,anon,authenticated;
grant execute on function public.save_site_spreadsheet_template_v1(uuid,uuid,uuid,text,text,text,jsonb,integer) to service_role;

-- Optional imported history must not fabricate work logs, workers or dates.
-- Legacy/manual/telephone rows keep their original required-field constraints.
alter table public.maintenance_events
 add column spreadsheet_import_id uuid references public.site_spreadsheet_imports(id),
 add column worker_names_text text check(char_length(worker_names_text)<=2000),
 alter column work_log_id drop not null,
 alter column occurred_at drop not null,
 drop constraint maintenance_events_description_check,
 drop constraint maintenance_events_result_check,
 add constraint maintenance_events_description_check check(char_length(btrim(description))<=4000 and (spreadsheet_import_id is not null or char_length(btrim(description))>=1)),
 add constraint maintenance_events_result_check check(char_length(btrim(result))<=2000 and (spreadsheet_import_id is not null or char_length(btrim(result))>=1)),
 add constraint maintenance_events_original_required_check check(spreadsheet_import_id is not null or (work_log_id is not null and occurred_at is not null));
comment on column public.maintenance_events.worker_names_text is 'Excel 匯入原始處理人員文字；不建立或推測帳號關聯。';
create index maintenance_events_spreadsheet_import_idx on public.maintenance_events(spreadsheet_import_id) where spreadsheet_import_id is not null;

-- Preserve the shared privacy traversal, including a private customer's history
-- imported without a work log: customer -> import receipt -> maintenance event.
do $$
declare definition text;
begin
 select pg_get_functiondef('public.erp_private_scope_v1(uuid)'::regprocedure) into definition;
 if strpos(definition,'''work_log_save_requests'',''monitoring_device_imports''')=0 then raise exception '私人資料關聯定義已變更，請重新確認 migration。'; end if;
 execute replace(definition,'''work_log_save_requests'',''monitoring_device_imports''','''work_log_save_requests'',''site_spreadsheet_imports'',''monitoring_device_imports''');
end $$;

create function public.import_site_spreadsheet_v1(
 p_customer_id uuid,p_service_id uuid,p_kind text,p_source_id uuid,p_file_name text,p_sheet_name text,p_file_hash text,p_request_id uuid,p_rows jsonb,p_actor_user_id uuid
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 v_actor text; v_service public.contract_service_types; v_site_id uuid; v_equipment public.equipment_registry;
 v_receipt public.site_spreadsheet_imports; v_import_id uuid; v_row jsonb; v_credential jsonb; v_device_id uuid; v_event_id uuid;
 v_count integer:=0; v_key text; v_limit integer; v_text text; v_port integer; v_type text; v_status text; v_date date;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'site','VIEW') then raise exception '沒有案場資料權限。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform public.erp_private_assert_v1(jsonb_build_object('customer_id',p_customer_id));
 select username into v_actor from public.app_users where id=p_actor_user_id and is_active;
 select * into v_service from public.contract_service_types where id=p_service_id and is_active and code<>'phone_system';
 if v_actor is null or v_service.id is null or not exists(select 1 from public.customer_contract_services c join public.customers u on u.id=c.customer_id
  where c.customer_id=p_customer_id and c.service_type_id=p_service_id and c.is_active and u.deleted_at is null)
 then raise exception '找不到可用的非電話客戶承攬資料。'; end if;
 if not public.has_app_permission_v1(p_actor_user_id,case when v_service.code='surveillance' then 'monitoring' else 'equipment' end,'VIEW')
 or not public.has_app_permission_v1(p_actor_user_id,case when p_kind='history' then 'history' when v_service.code='surveillance' then 'monitoring_import' else 'equipment' end,'CREATE')
 or (p_kind='history' and not public.has_app_permission_v1(p_actor_user_id,'history','VIEW')) then raise exception '沒有此承攬項目的 Excel 匯入權限。'; end if;
 if p_kind is null or p_kind not in ('devices','history') or p_request_id is null
 or coalesce(length(btrim(p_file_name)),0) not between 1 and 255 or coalesce(length(btrim(p_sheet_name)),0) not between 1 and 120
 or p_file_hash is null or p_file_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_rows) is distinct from 'array'
 then raise exception 'Excel 匯入資料不完整。'; end if;
 if jsonb_array_length(p_rows) not between 1 and 1000 or octet_length(p_rows::text)>8388608 then raise exception '每次須匯入 1 至 1,000 筆，資料總量不可超過 8 MB。'; end if;
 if p_kind='devices' and p_source_id is not null then raise exception '新增設備不可指定覆寫來源。'; end if;
 if p_kind='history' then
  select r.* into v_equipment from public.equipment_registry r join public.site_devices d on d.id=r.source_id join public.sites s on s.id=d.site_id
   where r.source_table='site_devices' and r.source_id=p_source_id and r.customer_id=p_customer_id and r.service_id=p_service_id
   and s.customer_id=p_customer_id and s.contract_service_type_id=p_service_id and d.deleted_at is null and r.status<>'retired' for share of d;
  if v_equipment.id is null then raise exception '找不到所選客戶承攬的有效設備。'; end if;
  perform public.erp_private_assert_v1(to_jsonb(v_equipment));
  v_site_id:=v_equipment.site_id;
 end if;
 -- The same confirmation is idempotent; a fresh request can import the same file.
 perform pg_advisory_xact_lock(hashtextextended('site-spreadsheet:'||p_request_id,0));
 select * into v_receipt from public.site_spreadsheet_imports where request_id=p_request_id;
 if found then
  if v_receipt.actor_user_id<>p_actor_user_id or v_receipt.customer_id<>p_customer_id or v_receipt.service_id<>p_service_id
   or v_receipt.kind<>p_kind or v_receipt.source_id is distinct from p_source_id or v_receipt.file_hash<>p_file_hash or v_receipt.sheet_name<>p_sheet_name
  then raise exception '送出識別碼已使用，請重新預覽。'; end if;
  return jsonb_build_object('import_id',v_receipt.id,'inserted',v_receipt.inserted_count,'replayed',true);
 end if;
 if p_kind='devices' then
  perform public.ensure_customer_contract_site_v1(p_customer_id,p_service_id,v_actor);
  select id into strict v_site_id from public.sites where customer_id=p_customer_id and contract_service_type_id=p_service_id and status<>'closed';
 end if;
 insert into public.site_spreadsheet_imports(request_id,customer_id,service_id,site_id,kind,source_id,actor_user_id,file_name,sheet_name,file_hash,inserted_count)
 values(p_request_id,p_customer_id,p_service_id,v_site_id,p_kind,p_source_id,p_actor_user_id,p_file_name,p_sheet_name,p_file_hash,jsonb_array_length(p_rows)) returning id into v_import_id;
 perform set_config('app.actor',v_actor,true);
 for v_row in select value from jsonb_array_elements(p_rows) loop
  if jsonb_typeof(v_row) is distinct from 'object' or coalesce(v_row->>'source_row','') !~ '^[0-9]+$' or (v_row->>'source_row')::numeric not between 2 and 1048576
  then raise exception 'Excel 資料列格式不正確。'; end if;
  if not public.site_spreadsheet_fields_valid_v1(coalesce(v_row->'spreadsheet_fields','{}')) then raise exception 'Excel 自訂欄位格式不正確或包含帳密保留名稱。'; end if;
  if p_kind='devices' then
   foreach v_key in array array['device_type','status','ip_address','manual_url','installed_on','warranty_end_on'] loop
    if v_row ? v_key and jsonb_typeof(v_row->v_key) not in ('string','null') then raise exception 'Excel 欄位 % 格式不正確。',v_key; end if;
   end loop;
   for v_key,v_limit in select * from (values ('device_no',120),('device_name',160),('device_brand',120),('device_model',160),('network_cable_no',120),('cabinet',160),('details',4000),('notes',4000),('access_station_no',80),('serial_number',160)) fields(k,n) loop
    if v_row ? v_key and jsonb_typeof(v_row->v_key) not in ('string','null') or char_length(coalesce(v_row->>v_key,''))>v_limit then raise exception 'Excel 欄位 % 格式或長度不正確。',v_key; end if;
   end loop;
   v_type:=nullif(btrim(v_row->>'device_type'),'');
   if v_type is not null and v_type not in ('monitoring_host','camera','hub') then raise exception '設備種類格式不正確。'; end if;
   v_status:=coalesce(nullif(v_row->>'status',''),'planned');
   if v_status not in ('planned','installed','tested','active','inactive','maintenance') then raise exception '設備狀態格式不正確。'; end if;
   v_text:=nullif(btrim(v_row->>'ip_address'),'');
   if v_text is not null and (not pg_input_is_valid(v_text,'inet') or v_text like '%/%') then raise exception 'IP 格式不正確。'; end if;
   for v_key,v_limit in select * from (values ('http_port',65535),('resolution_width',16384),('resolution_height',16384),('fps',240)) fields(k,n) loop
    v_text:=nullif(v_row->>v_key,'');
    if v_text is not null and (v_text !~ '^[0-9]+$' or v_text::numeric not between 1 and v_limit) then raise exception 'Excel 數值欄位 % 超出範圍。',v_key; end if;
   end loop;
   if coalesce(jsonb_typeof(v_row->'supports_audio'),'null') not in ('null','boolean') then raise exception '音訊欄位格式不正確。'; end if;
   for v_key in select unnest(array['installed_on','warranty_end_on']) loop
    if nullif(v_row->>v_key,'') is not null and ((v_row->>v_key) !~ '^\d{4}-\d{2}-\d{2}$' or not pg_input_is_valid(v_row->>v_key,'date')) then raise exception 'Excel 日期格式不正確。'; end if;
   end loop;
   v_text:=nullif(v_row->>'manual_url','');
   if v_text is not null and (char_length(v_text)>1000 or v_text !~* '^https?://') then raise exception '說明網址格式不正確。'; end if;
   v_credential:=nullif(v_row->'credential','null'::jsonb);
   if v_credential is not null then
    if not public.has_app_permission_v1(p_actor_user_id,'credentials','UPDATE') then raise exception '沒有設備帳密修改權限。'; end if;
    if jsonb_typeof(v_credential) is distinct from 'object' or coalesce(v_credential->>'key_version','')<>'v1' or coalesce(v_credential->>'masked_username','')=''
     or octet_length(decode(coalesce(v_credential->>'username_iv',''),'base64'))<>12 or octet_length(decode(coalesce(v_credential->>'password_iv',''),'base64'))<>12
     or octet_length(decode(coalesce(v_credential->>'username_authentication_tag',''),'base64'))<>16 or octet_length(decode(coalesce(v_credential->>'password_authentication_tag',''),'base64'))<>16
     or not (v_credential ? 'username_ciphertext' and v_credential ? 'password_ciphertext')
    then raise exception '設備帳密加密資料不完整。'; end if;
   end if;
   v_device_id:=gen_random_uuid();
   insert into public.site_devices(id,site_id,device_no,device_name,device_type,device_brand,device_model,ip_address,http_port,access_station_no,network_cable_no,cabinet,details,notes,manual_url,status,serial_number,installed_on,warranty_end_on,supports_audio,resolution_width,resolution_height,fps,credential_configured,created_by,updated_by,source,spreadsheet_fields,spreadsheet_import_id)
   values(v_device_id,v_site_id,coalesce(nullif(btrim(v_row->>'device_no'),''),(case when v_service.code='surveillance' then 'MON-' when v_service.equipment_import_template='access_control' then 'ACS-' else 'DEV-' end)||lpad(nextval('public.site_device_monitoring_no_seq')::text,6,'0')),
    coalesce(btrim(v_row->>'device_name'),''),v_type,nullif(v_row->>'device_brand',''),nullif(v_row->>'device_model',''),case when nullif(v_row->>'ip_address','') is not null then host((v_row->>'ip_address')::inet) end,
    nullif(v_row->>'http_port','')::integer,nullif(v_row->>'access_station_no',''),nullif(v_row->>'network_cable_no',''),nullif(v_row->>'cabinet',''),nullif(v_row->>'details',''),nullif(v_row->>'notes',''),nullif(v_row->>'manual_url',''),v_status,
    nullif(v_row->>'serial_number',''),nullif(v_row->>'installed_on','')::date,nullif(v_row->>'warranty_end_on','')::date,(v_row->>'supports_audio')::boolean,
    nullif(v_row->>'resolution_width','')::integer,nullif(v_row->>'resolution_height','')::integer,nullif(v_row->>'fps','')::integer,v_credential is not null,v_actor,v_actor,'site_data',coalesce(v_row->'spreadsheet_fields','{}'),v_import_id);
   if v_credential is not null then
    insert into public.site_device_credentials(device_id,username_ciphertext,username_iv,username_authentication_tag,password_ciphertext,password_iv,password_authentication_tag,masked_username,key_version,updated_by)
    values(v_device_id,decode(v_credential->>'username_ciphertext','base64'),decode(v_credential->>'username_iv','base64'),decode(v_credential->>'username_authentication_tag','base64'),decode(v_credential->>'password_ciphertext','base64'),decode(v_credential->>'password_iv','base64'),decode(v_credential->>'password_authentication_tag','base64'),v_credential->>'masked_username','v1',v_actor);
   end if;
  else
   foreach v_key in array array['event_type','occurred_at'] loop
    if v_row ? v_key and jsonb_typeof(v_row->v_key) not in ('string','null') then raise exception 'Excel 欄位 % 格式不正確。',v_key; end if;
   end loop;
   for v_key,v_limit in select * from (values ('description',4000),('cause',2000),('handling_process',2000),('result',2000),('notes',2000),('worker_names_text',2000)) fields(k,n) loop
    if v_row ? v_key and jsonb_typeof(v_row->v_key) not in ('string','null') or char_length(coalesce(v_row->>v_key,''))>v_limit then raise exception 'Excel 欄位 % 格式或長度不正確。',v_key; end if;
   end loop;
   v_text:=nullif(v_row->>'occurred_at','');
   if v_text is not null and (v_text !~ '^\d{4}-\d{2}-\d{2}$' or not pg_input_is_valid(v_text,'date')) then raise exception '紀錄日期格式不正確。'; end if;
   v_date:=v_text::date; v_type:=coalesce(nullif(v_row->>'event_type',''),'OTHER');
   if v_type not in ('SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','REPAIR','REPLACEMENT','EQUIPMENT_TEST','INSTALLATION','MAINTENANCE','PROGRAM_CONFIG','INSPECTION','OTHER') then raise exception '事件類型格式不正確。'; end if;
   insert into public.maintenance_events(work_log_id,service_id,event_type,occurred_at,description,cause,handling_process,result,notes,created_by,updated_by,spreadsheet_import_id,worker_names_text,spreadsheet_fields)
   values(null,p_service_id,v_type,v_date,coalesce(v_row->>'description',''),nullif(v_row->>'cause',''),nullif(v_row->>'handling_process',''),coalesce(v_row->>'result',''),nullif(v_row->>'notes',''),p_actor_user_id,p_actor_user_id,v_import_id,nullif(v_row->>'worker_names_text',''),coalesce(v_row->'spreadsheet_fields','{}')) returning id into v_event_id;
   insert into public.maintenance_event_equipment(event_id,equipment_id) values(v_event_id,v_equipment.id);
   insert into public.audit_logs(entity_type,entity_id,action,after_data,source,actor)
   values('maintenance_events',v_event_id,'insert',jsonb_build_object('spreadsheet_import_id',v_import_id,'customer_id',p_customer_id,'service_id',p_service_id,'equipment_id',v_equipment.id),'site_data',v_actor);
  end if;
  v_count:=v_count+1;
 end loop;
 insert into public.audit_logs(entity_type,entity_id,action,after_data,source,actor)
 values('site_spreadsheet_imports',v_import_id,'insert',jsonb_build_object('customer_id',p_customer_id,'service_id',p_service_id,'kind',p_kind,'inserted',v_count),'site_data',v_actor);
 return jsonb_build_object('import_id',v_import_id,'inserted',v_count,'replayed',false);
end $$;
revoke all on function public.import_site_spreadsheet_v1(uuid,uuid,text,uuid,text,text,text,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.import_site_spreadsheet_v1(uuid,uuid,text,uuid,text,text,text,uuid,jsonb,uuid) to service_role;
notify pgrst,'reload schema';
commit;
