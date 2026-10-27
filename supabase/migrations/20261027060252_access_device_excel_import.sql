begin;
set local lock_timeout='5s';

-- Bind the capability once to the existing catalog ID, including renamed legacy services.
-- Later display-name edits must not change equipment behavior.
alter table public.contract_service_types add column equipment_import_template text
 check(equipment_import_template in ('access_control'));
update public.contract_service_types set equipment_import_template='access_control'
 where code='access_control' or name like '%門禁%';

alter table public.site_devices add column access_station_no text
  check (char_length(access_station_no)<=80);
comment on column public.site_devices.access_station_no is '門禁卡機站號；文字保存 0 與前置零，不作設備主鍵。';

-- Import metadata only. Equipment and encrypted credentials retain their existing masters.
create table public.access_device_imports (
 id uuid primary key default gen_random_uuid(),
 customer_id uuid not null references public.customers(id),
 service_id uuid not null references public.contract_service_types(id),
 site_id uuid not null references public.sites(id),
 file_hash text not null check(file_hash ~ '^[0-9a-f]{64}$'),
 file_name text not null check(length(file_name) between 1 and 255),
 sheet_name text not null check(length(sheet_name) between 1 and 120),
 inserted_count integer not null check(inserted_count between 1 and 1000),
 actor_user_id uuid not null references public.app_users(id),
 created_at timestamptz not null default now(),
 unique(customer_id,service_id,file_hash,sheet_name)
);
alter table public.access_device_imports enable row level security;
revoke all on public.access_device_imports from public,anon,authenticated;
grant select,insert on public.access_device_imports to service_role;

create function public.import_access_devices_v1(
 p_customer_id uuid,p_service_id uuid,p_file_name text,p_sheet_name text,p_file_hash text,p_rows jsonb,p_actor_user_id uuid
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 v_actor text; v_site_id uuid; v_import_id uuid; v_row jsonb; v_credential jsonb; v_device_id uuid; v_count integer:=0;
begin
 if not public.has_app_permission_v1(p_actor_user_id,'site','VIEW')
    or not public.has_app_permission_v1(p_actor_user_id,'equipment','CREATE') then raise exception '沒有門禁設備匯入權限。'; end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 perform public.erp_private_assert_v1(jsonb_build_object('customer_id',p_customer_id));
 select username into v_actor from public.app_users where id=p_actor_user_id and is_active;
 if v_actor is null or p_customer_id is null or p_service_id is null
    or coalesce(length(btrim(p_file_name)),0) not between 1 and 255
    or coalesce(length(btrim(p_sheet_name)),0) not between 1 and 120
    or p_file_hash is null or p_file_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_rows) is distinct from 'array' then raise exception '門禁匯入資料不完整。'; end if;
 if jsonb_array_length(p_rows) not between 1 and 1000 then raise exception '每次須匯入 1 至 1,000 筆。'; end if;
 if not exists(select 1 from public.customer_contract_services c
   join public.contract_service_types t on t.id=c.service_type_id
   join public.customers u on u.id=c.customer_id
   where c.customer_id=p_customer_id and c.service_type_id=p_service_id and c.is_active and t.is_active
     and t.equipment_import_template='access_control' and u.deleted_at is null)
 then raise exception '此客戶沒有有效的門禁承攬關聯。'; end if;
 perform pg_advisory_xact_lock(hashtextextended('access-import:'||p_customer_id||':'||p_service_id,0));
 if exists(select 1 from public.access_device_imports where customer_id=p_customer_id and service_id=p_service_id and file_hash=p_file_hash and sheet_name=p_sheet_name)
 then raise exception '這個工作表已匯入，請勿重複送出。'; end if;
 perform public.ensure_customer_contract_site_v1(p_customer_id,p_service_id,v_actor);
 select id into strict v_site_id from public.sites where customer_id=p_customer_id and contract_service_type_id=p_service_id and status<>'closed';
 perform set_config('app.actor',v_actor,true);
 for v_row in select value from jsonb_array_elements(p_rows) loop
   if coalesce(length(btrim(v_row->>'device_name')),0) not between 1 and 160
      or coalesce(length(btrim(v_row->>'device_model')),0) not between 1 and 160
      or length(coalesce(v_row->>'access_station_no',''))>80 or length(coalesce(v_row->>'notes',''))>1000
      or coalesce(v_row->>'source_row','') !~ '^[0-9]+$' then raise exception '門禁匯入列資料不完整。'; end if;
   if nullif(v_row->>'ip_address','') is not null and (
      not pg_input_is_valid(v_row->>'ip_address','inet') or v_row->>'ip_address' like '%/%') then raise exception 'IP 格式不正確。'; end if;
   if v_row->>'http_port' is not null and (v_row->>'http_port' !~ '^[0-9]+$' or (v_row->>'http_port')::numeric not between 1 and 65535) then raise exception 'Port 必須介於 1–65535。'; end if;
   if exists(select 1 from public.site_devices d join public.sites s on s.id=d.site_id
     where s.customer_id=p_customer_id and s.contract_service_type_id=p_service_id and d.deleted_at is null
       and (lower(btrim(d.device_name))=lower(btrim(v_row->>'device_name'))
         or (nullif(v_row->>'ip_address','') is not null and nullif(d.ip_address,'')::inet=(v_row->>'ip_address')::inet)))
   then raise exception '卡機名稱或 IP 已存在，請重新預覽；本次未匯入任何資料。'; end if;
   v_credential:=nullif(v_row->'credential','null'::jsonb);
   if v_credential is not null then
     if not public.has_app_permission_v1(p_actor_user_id,'credentials','UPDATE') then raise exception '沒有設備帳密修改權限。'; end if;
     if coalesce(v_credential->>'key_version','')<>'v1' or coalesce(v_credential->>'masked_username','')=''
       or octet_length(decode(coalesce(v_credential->>'username_iv',''),'base64'))<>12
       or octet_length(decode(coalesce(v_credential->>'password_iv',''),'base64'))<>12
       or octet_length(decode(coalesce(v_credential->>'username_authentication_tag',''),'base64'))<>16
       or octet_length(decode(coalesce(v_credential->>'password_authentication_tag',''),'base64'))<>16
       or octet_length(decode(coalesce(v_credential->>'username_ciphertext',''),'base64'))=0
       or octet_length(decode(coalesce(v_credential->>'password_ciphertext',''),'base64'))=0
     then raise exception '設備帳密加密資料不完整。'; end if;
   end if;
   v_device_id:=gen_random_uuid();
   insert into public.site_devices(id,site_id,device_no,device_name,device_model,ip_address,http_port,access_station_no,notes,status,credential_configured,created_by,updated_by,source)
   values(v_device_id,v_site_id,'ACS-'||lpad(nextval('public.site_device_monitoring_no_seq')::text,6,'0'),btrim(v_row->>'device_name'),btrim(v_row->>'device_model'),
     case when nullif(v_row->>'ip_address','') is null then null else host((v_row->>'ip_address')::inet) end,
     (v_row->>'http_port')::integer,nullif(v_row->>'access_station_no',''),nullif(v_row->>'notes',''),'planned',v_credential is not null,v_actor,v_actor,'site_data');
   if v_credential is not null then
     insert into public.site_device_credentials(device_id,username_ciphertext,username_iv,username_authentication_tag,password_ciphertext,password_iv,password_authentication_tag,masked_username,key_version,updated_by)
     values(v_device_id,decode(v_credential->>'username_ciphertext','base64'),decode(v_credential->>'username_iv','base64'),decode(v_credential->>'username_authentication_tag','base64'),
       decode(v_credential->>'password_ciphertext','base64'),decode(v_credential->>'password_iv','base64'),decode(v_credential->>'password_authentication_tag','base64'),v_credential->>'masked_username','v1',v_actor);
   end if;
   v_count:=v_count+1;
 end loop;
 insert into public.access_device_imports(customer_id,service_id,site_id,file_name,sheet_name,file_hash,inserted_count,actor_user_id)
 values(p_customer_id,p_service_id,v_site_id,p_file_name,p_sheet_name,p_file_hash,v_count,p_actor_user_id) returning id into v_import_id;
 insert into public.audit_logs(entity_type,entity_id,action,after_data,source,actor)
 values('access_device_imports',v_import_id,'IMPORT_DEVICES',jsonb_build_object('customer_id',p_customer_id,'service_id',p_service_id,'inserted',v_count),'site_data',v_actor);
 return jsonb_build_object('import_id',v_import_id,'inserted',v_count);
end $$;
revoke all on function public.import_access_devices_v1(uuid,uuid,text,text,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.import_access_devices_v1(uuid,uuid,text,text,text,jsonb,uuid) to service_role;
notify pgrst,'reload schema';
commit;
