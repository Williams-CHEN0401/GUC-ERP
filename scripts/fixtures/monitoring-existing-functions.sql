CREATE OR REPLACE FUNCTION public.ensure_monitoring_customer_site_v1(p_customer_id uuid, p_actor text)
 RETURNS sites
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_customer public.customers;
  v_service_id uuid;
  v_site public.sites;
begin
  if p_customer_id is null
     or nullif(btrim(coalesce(p_actor, '')), '') is null
     or char_length(p_actor) > 160 then
    raise exception '監控設備的客戶或操作者資料不正確。';
  end if;

  select id into v_service_id
  from public.contract_service_types
  where code = 'surveillance' and is_active = true
  order by id
  limit 1;

  if v_service_id is null or not exists (
    select 1
    from public.customer_contract_services
    where customer_id = p_customer_id and service_type_id = v_service_id
  ) then
    raise exception '此客戶沒有有效的監控承攬關聯。';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('monitoring-site:' || p_customer_id::text, 0)
  );

  select * into v_site
  from public.sites
  where customer_id = p_customer_id
    and contract_service_type_id = v_service_id
    and status <> 'closed'
  order by created_at, id
  limit 1;

  if found then
    return v_site;
  end if;

  select * into v_customer
  from public.customers
  where id = p_customer_id;

  if not found then
    raise exception '找不到指定客戶。';
  end if;

  perform set_config('app.actor', p_actor, true);
  select * into v_site
  from public.create_site_auto_number_v1(
    v_customer.name || '｜監控系統',
    p_customer_id,
    null,
    null,
    v_customer.address,
    v_customer.phone,
    'active',
    '由監控設備管理依有效承攬關聯自動建立。',
    p_actor
  );

  update public.sites
  set contract_service_type_id = v_service_id,
      source = 'site_data',
      updated_by = p_actor
  where id = v_site.id
  returning * into v_site;

  return v_site;
end;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_monitoring_device_v2(p_id uuid, p_row_version integer, p_customer_id uuid, p_device_name text, p_ip_address text, p_device_type text, p_network_cable_no text, p_cabinet text, p_device_brand text, p_device_model text, p_details text, p_http_port integer, p_supports_audio boolean, p_resolution_width integer, p_resolution_height integer, p_fps integer, p_manual_url text, p_status text, p_credential jsonb, p_actor text)
 RETURNS site_devices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_device public.site_devices;
  v_device_no text;
  v_service_id uuid;
  v_site_id uuid;
begin
  if p_customer_id is null
     or nullif(btrim(coalesce(p_device_name, '')), '') is null
     or char_length(p_device_name) > 160
     or (nullif(btrim(coalesce(p_ip_address, '')), '') is not null
         and not pg_catalog.pg_input_is_valid(btrim(p_ip_address), 'inet'))
     or p_device_type not in ('monitoring_host', 'camera', 'hub')
     or char_length(coalesce(p_network_cable_no, '')) > 120
     or char_length(coalesce(p_cabinet, '')) > 160
     or nullif(btrim(coalesce(p_device_brand, '')), '') is null
     or char_length(p_device_brand) > 120
     or nullif(btrim(coalesce(p_device_model, '')), '') is null
     or char_length(p_device_model) > 160
     or char_length(coalesce(p_details, '')) > 4000
     or (p_http_port is not null and p_http_port not between 1 and 65535)
     or (p_resolution_width is not null and p_resolution_width not between 1 and 16384)
     or (p_resolution_height is not null and p_resolution_height not between 1 and 16384)
     or (p_fps is not null and p_fps not between 1 and 240)
     or char_length(coalesce(p_manual_url, '')) > 1000
     or (nullif(btrim(coalesce(p_manual_url, '')), '') is not null and p_manual_url !~* '^https?://')
     or p_status not in ('active', 'inactive', 'maintenance')
     or nullif(btrim(coalesce(p_actor, '')), '') is null
     or char_length(p_actor) > 160 then
    raise exception '監控設備資料不完整或格式不正確。';
  end if;

  select id into v_service_id
  from public.contract_service_types
  where code = 'surveillance' and is_active = true
  order by id
  limit 1;
  if v_service_id is null or not exists (
    select 1 from public.customer_contract_services
    where customer_id = p_customer_id and service_type_id = v_service_id
  ) then
    raise exception '此客戶沒有有效的監控承攬關聯。';
  end if;

  select id into v_site_id
  from public.sites
  where customer_id = p_customer_id
    and contract_service_type_id = v_service_id
    and status <> 'closed'
  order by created_at, id
  limit 1;
  if v_site_id is null then
    raise exception '此客戶尚未建立監控承攬資料，請先建立承攬資料。';
  end if;

  if not exists (select 1 from public.monitoring_device_types where code = p_device_type and is_active = true) then
    raise exception '設備類型不存在或已停用。';
  end if;

  if p_credential is not null and (
       p_credential->>'key_version' !~ '^v[1-9][0-9]*$'
       or nullif(p_credential->>'masked_username', '') is null
       or octet_length(decode(coalesce(p_credential->>'username_iv', ''), 'base64')) <> 12
       or octet_length(decode(coalesce(p_credential->>'password_iv', ''), 'base64')) <> 12
       or octet_length(decode(coalesce(p_credential->>'username_authentication_tag', ''), 'base64')) <> 16
       or octet_length(decode(coalesce(p_credential->>'password_authentication_tag', ''), 'base64')) <> 16
     ) then
    raise exception '設備登入資料加密封裝不完整。';
  end if;

  perform set_config('app.actor', p_actor, true);
  if p_id is null then
    v_device_no := concat('MON-', lpad(nextval('public.site_device_monitoring_no_seq')::text, 6, '0'));
    insert into public.site_devices (
      site_id, device_no, device_name, ip_address, device_type, network_cable_no,
      cabinet, device_brand, device_model, details, http_port, supports_audio,
      resolution_width, resolution_height, fps, manual_url, status, notes,
      credential_configured, source, created_by, updated_by
    ) values (
      v_site_id, v_device_no, btrim(p_device_name), case when nullif(btrim(coalesce(p_ip_address, '')), '') is null then null else pg_catalog.host(btrim(p_ip_address)::pg_catalog.inet) end, p_device_type,
      nullif(btrim(coalesce(p_network_cable_no, '')), ''), nullif(btrim(coalesce(p_cabinet, '')), ''),
      btrim(p_device_brand), btrim(p_device_model), nullif(btrim(coalesce(p_details, '')), ''),
      p_http_port, p_supports_audio, p_resolution_width, p_resolution_height, p_fps,
      nullif(btrim(coalesce(p_manual_url, '')), ''), p_status, nullif(btrim(coalesce(p_details, '')), ''),
      p_credential is not null, 'site_data', p_actor, p_actor
    ) returning * into v_device;
  else
    if p_row_version is null or p_row_version < 1 then raise exception '監控設備版本不正確。'; end if;
    update public.site_devices
    set site_id = v_site_id,
        device_name = btrim(p_device_name),
        ip_address = case when nullif(btrim(coalesce(p_ip_address, '')), '') is null then null else pg_catalog.host(btrim(p_ip_address)::pg_catalog.inet) end,
        device_type = p_device_type,
        network_cable_no = nullif(btrim(coalesce(p_network_cable_no, '')), ''),
        cabinet = nullif(btrim(coalesce(p_cabinet, '')), ''),
        device_brand = btrim(p_device_brand),
        device_model = btrim(p_device_model),
        details = nullif(btrim(coalesce(p_details, '')), ''),
        http_port = p_http_port,
        supports_audio = p_supports_audio,
        resolution_width = p_resolution_width,
        resolution_height = p_resolution_height,
        fps = p_fps,
        manual_url = nullif(btrim(coalesce(p_manual_url, '')), ''),
        status = p_status,
        notes = nullif(btrim(coalesce(p_details, '')), ''),
        credential_configured = case when p_credential is null then credential_configured else true end,
        source = 'site_data',
        updated_by = p_actor
    where id = p_id and site_id in (
      select id from public.sites where customer_id = p_customer_id and contract_service_type_id = v_service_id
    ) and row_version = p_row_version and deleted_at is null
    returning * into v_device;
    if not found then raise exception '監控設備已被其他使用者更新，或不屬於目前客戶。'; end if;
  end if;

  if p_credential is not null then
    insert into public.site_device_credentials (
      device_id, username_ciphertext, username_iv, username_authentication_tag,
      password_ciphertext, password_iv, password_authentication_tag,
      masked_username, key_version, updated_by
    ) values (
      v_device.id,
      decode(p_credential->>'username_ciphertext', 'base64'),
      decode(p_credential->>'username_iv', 'base64'),
      decode(p_credential->>'username_authentication_tag', 'base64'),
      decode(p_credential->>'password_ciphertext', 'base64'),
      decode(p_credential->>'password_iv', 'base64'),
      decode(p_credential->>'password_authentication_tag', 'base64'),
      p_credential->>'masked_username', p_credential->>'key_version', p_actor
    )
    on conflict (device_id) do update
    set username_ciphertext = excluded.username_ciphertext,
        username_iv = excluded.username_iv,
        username_authentication_tag = excluded.username_authentication_tag,
        password_ciphertext = excluded.password_ciphertext,
        password_iv = excluded.password_iv,
        password_authentication_tag = excluded.password_authentication_tag,
        masked_username = excluded.masked_username,
        key_version = excluded.key_version,
        updated_by = excluded.updated_by;

    insert into public.audit_logs (entity_type, entity_id, action, before_data, after_data, source, actor)
    values ('site_device_credentials', v_device.id, 'UPDATE_CREDENTIAL', null,
      jsonb_build_object('masked_username', p_credential->>'masked_username', 'key_version', p_credential->>'key_version'),
      'site_data', p_actor);
  end if;
  return v_device;
exception
  when unique_violation then raise exception '此 IP 位址已被其他有效設備使用。';
  when invalid_text_representation then raise exception 'IP 位址或加密資料格式不正確。';
end;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_monitoring_device_v3(p_id uuid, p_row_version integer, p_customer_id uuid, p_device_name text, p_ip_address text, p_device_type text, p_network_cable_no text, p_cabinet text, p_device_brand text, p_device_model text, p_details text, p_http_port integer, p_supports_audio boolean, p_resolution_width integer, p_resolution_height integer, p_fps integer, p_manual_url text, p_status text, p_credential jsonb, p_actor text)
 RETURNS site_devices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.ensure_monitoring_customer_site_v1(p_customer_id, p_actor);
  return public.upsert_monitoring_device_v2(
    p_id, p_row_version, p_customer_id, p_device_name, p_ip_address,
    p_device_type, p_network_cable_no, p_cabinet, p_device_brand,
    p_device_model, p_details, p_http_port, p_supports_audio,
    p_resolution_width, p_resolution_height, p_fps, p_manual_url,
    p_status, p_credential, p_actor
  );
end;
$function$;

