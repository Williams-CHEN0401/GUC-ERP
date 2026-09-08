begin;
set local lock_timeout='5s';

create or replace function public.save_monitoring_device_v4(
  p_id uuid,p_row_version integer,p_customer_id uuid,p_values jsonb,p_credential jsonb,p_actor_user_id uuid
) returns public.site_devices language plpgsql security invoker set search_path='' as $$
declare v_user public.app_users; v_old public.site_devices; v_service uuid; v_result public.site_devices;
begin
  select * into v_user from public.app_users where id=p_actor_user_id and is_active and role in ('admin','operator');
  if not found or (p_credential is not null and v_user.role<>'admin') then raise exception '您沒有執行設備修改的權限。'; end if;
  if p_values is null or jsonb_typeof(p_values)<>'object' or exists(select 1 from jsonb_object_keys(p_values) k where k not in ('device_name','ip_address','device_type','network_cable_no','cabinet','device_brand','device_model','details','http_port','supports_audio','manual_url','status')) then raise exception '設備修改欄位不正確。'; end if;
  if nullif(btrim(p_values->>'device_name'),'') is null or nullif(btrim(p_values->>'device_brand'),'') is null or nullif(btrim(p_values->>'device_model'),'') is null
    or coalesce(p_values->>'device_type','') not in ('camera','monitoring_host','hub') or coalesce(p_values->>'status','') not in ('active','inactive','maintenance') then raise exception '設備名稱、類型、品牌、型號與狀態必須填寫。'; end if;
  select t.id into v_service from public.contract_service_types t join public.customer_contract_services c on c.service_type_id=t.id
    where c.customer_id=p_customer_id and c.is_active and t.is_active and t.code='surveillance' for share of c,t;
  if v_service is null then raise exception '此客戶沒有有效的監控承攬關聯。'; end if;
  if p_id is not null then
    select d.* into v_old from public.site_devices d join public.sites s on s.id=d.site_id
      where d.id=p_id and d.deleted_at is null and s.customer_id=p_customer_id and s.contract_service_type_id=v_service and s.status<>'closed' for update of d;
    if not found or p_row_version is null or v_old.row_version<>p_row_version then raise exception '設備已被其他使用者更新，或不屬於目前客戶，請重新載入。'; end if;
  end if;
  v_result:=public.upsert_monitoring_device_v3(p_id,p_row_version,p_customer_id,
    p_values->>'device_name',p_values->>'ip_address',p_values->>'device_type',p_values->>'network_cable_no',p_values->>'cabinet',p_values->>'device_brand',p_values->>'device_model',p_values->>'details',
    nullif(p_values->>'http_port','')::integer,nullif(p_values->>'supports_audio','')::boolean,
    v_old.resolution_width,v_old.resolution_height,v_old.fps,p_values->>'manual_url',p_values->>'status',p_credential,v_user.username);
  return v_result;
end $$;

create or replace function public.batch_update_monitoring_devices_v1(
  p_customer_id uuid,p_rows jsonb,p_patch jsonb,p_actor_user_id uuid
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_row jsonb; v_old public.site_devices; v_values jsonb; v_saved public.site_devices; v_count integer:=0; v_ids uuid[];
begin
  if not exists(select 1 from public.app_users where id=p_actor_user_id and is_active and role in ('admin','operator')) then raise exception '您沒有執行設備批次修改的權限。'; end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 200 then raise exception '每次請選擇 1 至 200 筆設備。'; end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb or exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('device_type','device_brand','device_model','network_cable_no','cabinet','http_port','supports_audio','status','manual_url','details')) then raise exception '請選擇有效的批次修改欄位。'; end if;
  select array_agg((value->>'id')::uuid) into v_ids from jsonb_array_elements(p_rows);
  if array_position(v_ids,null) is not null or cardinality(v_ids)<>(select count(distinct x) from unnest(v_ids) x) then raise exception '設備清單含重複或無效編號。'; end if;
  -- Stable lock order; any validation or version failure rolls back the entire call.
  for v_row in select value from jsonb_array_elements(p_rows) order by value->>'id' loop
    select d.* into v_old from public.site_devices d join public.sites s on s.id=d.site_id
      where d.id=(v_row->>'id')::uuid and d.deleted_at is null and s.customer_id=p_customer_id for update of d;
    if not found then raise exception '找不到所選客戶的設備。'; end if;
    v_values:=jsonb_build_object('device_name',v_old.device_name,'ip_address',v_old.ip_address,'device_type',v_old.device_type,
      'device_brand',v_old.device_brand,'device_model',v_old.device_model,'network_cable_no',v_old.network_cable_no,'cabinet',v_old.cabinet,
      'http_port',v_old.http_port,'supports_audio',v_old.supports_audio,'status',v_old.status,'manual_url',v_old.manual_url,'details',v_old.details)||p_patch;
    v_saved:=public.save_monitoring_device_v4(v_old.id,(v_row->>'row_version')::integer,p_customer_id,v_values,null,p_actor_user_id);
    v_count:=v_count+1;
  end loop;
  return jsonb_build_object('updated',v_count);
end $$;

revoke all on function public.save_monitoring_device_v4(uuid,integer,uuid,jsonb,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.batch_update_monitoring_devices_v1(uuid,jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.save_monitoring_device_v4(uuid,integer,uuid,jsonb,jsonb,uuid) to service_role;
grant execute on function public.batch_update_monitoring_devices_v1(uuid,jsonb,jsonb,uuid) to service_role;
commit;
