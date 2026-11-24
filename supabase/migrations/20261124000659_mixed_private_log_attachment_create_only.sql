begin;

create or replace function public.register_contract_site_attachments_v2(
  p_customer_id uuid,
  p_service_type_id uuid,
  p_project_id uuid,
  p_rows jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site public.sites;
  v_row jsonb;
  v_asset public.site_assets;
  v_existing public.site_assets;
  v_result jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 10 then
    raise exception '附件索引格式不正確。';
  end if;

  if not exists (
    select 1
    from public.projects p
    where p.id = p_project_id
      and p.customer_id = p_customer_id
  ) then
    raise exception '找不到此客戶的專案；缺少專案時禁止上傳。';
  end if;

  select * into v_site
  from public.ensure_customer_contract_site_v1(
    p_customer_id, p_service_type_id, p_actor
  );

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_existing := null;
    select * into v_existing
    from public.site_assets
    where nas_path = v_row->>'nas_path'
    for update;

    if v_existing.id is not null and (v_row->>'create_only')::boolean is true then
      -- The NAS only accepts creates for this request. A same-ID retry can
      -- return the already registered asset without changing its metadata.
      if v_existing.id is distinct from (v_row->>'id')::uuid
         or v_existing.site_id is distinct from v_site.id
         or v_existing.project_id is distinct from p_project_id
         or v_existing.work_log_id is distinct from (v_row->>'target_work_log_id')::uuid
         or v_existing.uploaded_by is distinct from p_actor
         or v_existing.sha256 is distinct from v_row->>'sha256' then
        raise exception '同名附件已有紀錄，請選擇另存新檔。';
      end if;
      v_result := v_result || jsonb_build_array(to_jsonb(v_existing));
      continue;
    end if;

    if v_existing.id is not null
       and v_existing.site_id is distinct from v_site.id then
      raise exception '同名 NAS 檔案屬於其他案場或歷史資料，請改用另存新檔。';
    end if;

    if v_existing.id is null then
      insert into public.site_assets (
        id, site_id, project_id, work_log_id, asset_type, title, description,
        original_name, mime_type, file_size, nas_path, upload_status,
        uploaded_by, uploaded_at, sha256, source, updated_by
      ) values (
        (v_row->>'id')::uuid, v_site.id, p_project_id,
        null,
        v_row->>'asset_type', v_row->>'title', nullif(v_row->>'description',''),
        v_row->>'original_name', v_row->>'mime_type',
        (v_row->>'file_size')::bigint, v_row->>'nas_path', 'uploaded',
        p_actor, (v_row->>'uploaded_at')::timestamptz,
        v_row->>'sha256', 'nas_webdav', p_actor
      ) returning * into v_asset;
    else
      update public.site_assets
      set project_id = p_project_id,
          work_log_id = null,
          asset_type = v_row->>'asset_type',
          title = v_row->>'title',
          description = nullif(v_row->>'description',''),
          original_name = v_row->>'original_name',
          mime_type = v_row->>'mime_type',
          file_size = (v_row->>'file_size')::bigint,
          upload_status = 'uploaded',
          uploaded_by = p_actor,
          uploaded_at = (v_row->>'uploaded_at')::timestamptz,
          sha256 = v_row->>'sha256',
          source = 'nas_webdav',
          updated_by = p_actor
      where id = v_existing.id
      returning * into v_asset;
    end if;

    v_result := v_result || jsonb_build_array(to_jsonb(v_asset));
  end loop;

  return v_result;
end;
$$;

create or replace function public.register_work_log_attachments_v1(p_customer_id uuid,p_service_type_id uuid,p_project_id uuid,
  p_work_log_id uuid,p_rows jsonb,p_actor text) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_result jsonb; v_ids uuid[];
begin
  perform 1 from public.site_work_logs where id=p_work_log_id and project_id=p_project_id and deleted_at is null for share;
  if not found then raise exception '工作日誌與工作內容不相符，請重新整理。'; end if;
  if exists(select 1 from public.site_assets a join jsonb_array_elements(p_rows) r on a.nas_path=r->>'nas_path'
    where a.work_log_id is not null and a.work_log_id<>p_work_log_id) then
    raise exception '同名檔案已關聯其他工作日誌，請選擇另存新檔。';
  end if;
  v_result:=public.register_contract_site_attachments_v2(p_customer_id,p_service_type_id,p_project_id,p_rows,p_actor);
  select array_agg((r->>'id')::uuid) into v_ids from jsonb_array_elements(v_result) r;
  update public.site_assets set work_log_id=p_work_log_id where id=any(v_ids) and work_log_id is distinct from p_work_log_id;
  return (select coalesce(jsonb_agg(to_jsonb(a)),'[]') from public.site_assets a where id=any(v_ids));
end $$;

commit;
