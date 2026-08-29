-- Contract-centric site data. Existing project-linked sites and assets are preserved.
-- New records use sites(customer_id, contract_service_type_id); no legacy row is
-- guessed, relinked or deleted by this migration.

alter table public.sites
  add column if not exists contract_service_type_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sites_customer_contract_service_fkey'
      and conrelid = 'public.sites'::regclass
  ) then
    alter table public.sites
      add constraint sites_customer_contract_service_fkey
      foreign key (customer_id, contract_service_type_id)
      references public.customer_contract_services(customer_id, service_type_id)
      on delete restrict
      not valid;
  end if;
end;
$$;

alter table public.sites
  validate constraint sites_customer_contract_service_fkey;

create unique index if not exists sites_customer_contract_service_uidx
  on public.sites(customer_id, contract_service_type_id)
  where contract_service_type_id is not null;

create index if not exists sites_contract_service_type_id_idx
  on public.sites(contract_service_type_id)
  where contract_service_type_id is not null;

create or replace function public.ensure_customer_contract_site_v1(
  p_customer_id uuid,
  p_service_type_id uuid,
  p_actor text
)
returns public.sites
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_site public.sites;
  v_customer public.customers;
  v_service public.contract_service_types;
begin
  if p_customer_id is null or p_service_type_id is null then
    raise exception '客戶或承攬內容不完整。';
  end if;

  select * into v_site
  from public.sites
  where customer_id = p_customer_id
    and contract_service_type_id = p_service_type_id
  limit 1;
  if found then return v_site; end if;

  select * into v_customer from public.customers where id = p_customer_id;
  if not found then raise exception '找不到案場所屬客戶。'; end if;

  select types.* into v_service
  from public.contract_service_types types
  join public.customer_contract_services links
    on links.service_type_id = types.id
   and links.customer_id = p_customer_id
  where types.id = p_service_type_id
    and types.is_active = true;
  if not found then raise exception '承攬內容不存在、已停用或不屬於此客戶。'; end if;

  begin
    select * into v_site
    from public.create_site_auto_number_v1(
      v_customer.name || '｜' || v_service.name,
      v_customer.id,
      null,
      null,
      v_customer.address,
      v_customer.phone,
      'active',
      '依客戶承攬內容建立',
      p_actor
    );

    update public.sites
    set contract_service_type_id = v_service.id,
        updated_by = nullif(btrim(coalesce(p_actor, '')), '')
    where id = v_site.id
    returning * into v_site;
  exception
    when unique_violation then
      select * into v_site
      from public.sites
      where customer_id = p_customer_id
        and contract_service_type_id = p_service_type_id
      limit 1;
  end;

  if v_site.id is null then
    raise exception '無法建立案場與承攬內容的關聯。';
  end if;
  return v_site;
end;
$$;

create or replace function public.register_contract_site_attachments_v1(
  p_customer_id uuid,
  p_service_type_id uuid,
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
        (v_row->>'id')::uuid, v_site.id, null,
        nullif(v_row->>'work_log_id','')::uuid,
        v_row->>'asset_type', v_row->>'title', nullif(v_row->>'description',''),
        v_row->>'original_name', v_row->>'mime_type',
        (v_row->>'file_size')::bigint, v_row->>'nas_path', 'uploaded',
        p_actor, (v_row->>'uploaded_at')::timestamptz,
        v_row->>'sha256', 'nas_webdav', p_actor
      ) returning * into v_asset;
    else
      update public.site_assets
      set work_log_id = nullif(v_row->>'work_log_id','')::uuid,
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

revoke all on function public.ensure_customer_contract_site_v1(uuid,uuid,text)
  from public, anon, authenticated;
revoke all on function public.register_contract_site_attachments_v1(uuid,uuid,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.ensure_customer_contract_site_v1(uuid,uuid,text)
  to service_role;
grant execute on function public.register_contract_site_attachments_v1(uuid,uuid,jsonb,text)
  to service_role;
