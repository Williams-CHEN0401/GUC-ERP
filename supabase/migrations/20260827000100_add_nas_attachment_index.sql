alter table public.site_assets
  alter column site_id drop not null,
  add column if not exists project_id uuid references public.projects(id) on delete restrict,
  add column if not exists work_log_id uuid references public.site_work_logs(id) on delete set null,
  add column if not exists original_name text,
  add column if not exists mime_type text,
  add column if not exists file_size bigint,
  add column if not exists nas_path text,
  add column if not exists upload_status text,
  add column if not exists uploaded_by text,
  add column if not exists uploaded_at timestamptz,
  add column if not exists sha256 text;

alter table public.site_assets drop constraint if exists site_assets_asset_type_check;
alter table public.site_assets
  add constraint site_assets_asset_type_check
  check (asset_type = any (array['drawing','architecture','photo','document','work_log','acceptance','maintenance','other']::text[]));

alter table public.site_assets
  add constraint site_assets_owner_check check (site_id is not null or project_id is not null),
  add constraint site_assets_file_size_check check (file_size is null or file_size >= 0),
  add constraint site_assets_upload_status_check check (upload_status is null or upload_status = any (array['uploaded','failed','archived']::text[])),
  add constraint site_assets_sha256_check check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');

create unique index if not exists site_assets_nas_path_uidx
  on public.site_assets(nas_path) where nas_path is not null;
create index if not exists site_assets_project_id_idx on public.site_assets(project_id);
create index if not exists site_assets_work_log_id_idx on public.site_assets(work_log_id);

create or replace function public.register_site_attachments_v1(
  p_project_id uuid,
  p_rows jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_result jsonb := '[]'::jsonb;
  v_row jsonb;
  v_asset public.site_assets%rowtype;
begin
  if not exists (select 1 from public.projects where id = p_project_id) then
    raise exception '找不到附件所屬專案。';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception '附件索引格式不正確。';
  end if;
  v_count := jsonb_array_length(p_rows);
  if v_count < 1 or v_count > 10 then
    raise exception '每次必須登錄 1 至 10 筆附件索引。';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    insert into public.site_assets (
      id, site_id, project_id, work_log_id, asset_type, title, description,
      original_name, mime_type, file_size, nas_path, upload_status,
      uploaded_by, uploaded_at, sha256, source, updated_by
    )
    values (
      (v_row->>'id')::uuid, null, p_project_id, nullif(v_row->>'work_log_id','')::uuid,
      v_row->>'asset_type', v_row->>'title', nullif(v_row->>'description',''),
      v_row->>'original_name', v_row->>'mime_type', (v_row->>'file_size')::bigint,
      v_row->>'nas_path', 'uploaded', p_actor, (v_row->>'uploaded_at')::timestamptz,
      v_row->>'sha256', 'nas_webdav', p_actor
    )
    returning * into v_asset;

    v_result := v_result || jsonb_build_array(to_jsonb(v_asset));
  end loop;

  return v_result;
end;
$$;

revoke all on function public.register_site_attachments_v1(uuid,jsonb,text) from public, anon, authenticated;
grant execute on function public.register_site_attachments_v1(uuid,jsonb,text) to service_role;
