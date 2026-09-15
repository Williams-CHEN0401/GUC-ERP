begin;
set local lock_timeout = '5s';
-- Canonical ERP catalogue. Existing internal codes and persisted values are unchanged.
create or replace function public.erp_work_content_types_v1()
returns table(code text,label text,work_log_value text,construction_categories jsonb)
language sql immutable security invoker set search_path = '' as $$
 values
 ('construction','工程施工','工程施工','[{"code":"small_purchase","label":"小額採購"},{"code":"tender","label":"標案"}]'::jsonb),
 ('repair','維修/查修','維修紀錄','[]'::jsonb),
 ('maintenance','維護保養','維護保養','[]'::jsonb),
 ('delivery','送貨','送貨','[]'::jsonb),
 ('clerical','文書作業','文書作業','[]'::jsonb),
 ('site_survey','場勘','場勘','[]'::jsonb)
$$;
revoke all on function public.erp_work_content_types_v1() from public,anon,authenticated;
grant execute on function public.erp_work_content_types_v1() to service_role;

CREATE OR REPLACE FUNCTION public.sync_project_fields_to_work_logs_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_work_type text;
  v_renamed boolean := false;
begin
  if tg_op = 'UPDATE' then v_renamed := old.name is distinct from new.name; end if;
  v_work_type := case new.project_type
    when 'construction' then '工程施工'
    when 'delivery' then '送貨'
    when 'clerical' then '文書作業'
    when 'site_survey' then '場勘'
    when 'repair' then '維修紀錄'
    else '維護保養'
  end;

  update public.site_work_logs
  set title = case when v_renamed then new.name else title end,
      work_type = v_work_type,
      status = new.status,
      updated_by = coalesce(nullif(btrim(coalesce(new.updated_by, '')), ''), 'project_sync')
  where project_id = new.id
    and (
      v_renamed or work_type is distinct from v_work_type
      or status is distinct from new.status
    );

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_customer_project_work_log_v3(p_id uuid, p_row_version integer, p_project_id uuid, p_customer_id uuid, p_project_name text, p_log_date date, p_work_type text, p_summary text, p_time_period text, p_status text, p_worker_user_ids uuid[], p_reporter_user_id uuid, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_project public.projects;
  v_existing public.site_work_logs;
  v_save_version integer := p_row_version;
begin
  perform public.assert_work_log_access_v1(p_reporter_user_id,p_project_id,p_id,case when p_id is null then 'CREATE' else 'UPDATE' end);
  if p_customer_id is null or nullif(btrim(p_project_name), '') is null then
    raise exception '請選擇客戶並輸入專案／日誌標題。';
  end if;
  if char_length(btrim(p_project_name)) > 120 then
    raise exception '專案／日誌標題不可超過 120 個字。';
  end if;
  if p_status not in ('in_progress', 'completed') then
    raise exception '工作日誌狀態不正確。';
  end if;

  if p_id is not null then
    perform 1 from public.customers where id = p_customer_id for update;
    select * into v_existing from public.site_work_logs where id = p_id;
    if not found then raise exception '找不到工作日誌。'; end if;
    select * into v_project from public.projects where id = v_existing.project_id for update;
    if not found or v_project.customer_id <> p_customer_id then
      raise exception '工作日誌的客戶與原專案不相符。';
    end if;
  elsif p_project_id is not null then
    select * into v_project
    from public.projects
    where id = p_project_id and customer_id = p_customer_id;
    if not found then raise exception '所選專案不屬於此客戶。'; end if;
  else
    select * into v_project
    from public.projects
    where customer_id = p_customer_id
      and lower(btrim(name)) = lower(btrim(p_project_name))
    limit 1;
    if not found then
      select * into v_project
      from public.create_project_auto_number_v1(
        btrim(p_project_name), p_customer_id,
        case p_work_type when '工程施工' then 'construction' when '維修紀錄' then 'repair' when '送貨' then 'delivery' when '文書作業' then 'clerical' when '場勘' then 'site_survey' else 'maintenance' end,
        p_status, null, '由工作日誌自動建立', null, null, p_actor
      );
    end if;
  end if;

  if p_id is not null and v_project.name is distinct from btrim(p_project_name) then
    -- Project first, then logs: same order as the existing writer.
    select * into v_existing from public.site_work_logs where id = p_id for update;
    if p_row_version is null or v_existing.row_version <> p_row_version then
      raise exception '工作日誌已被其他使用者更新，請重新載入後再修改。';
    end if;
    if not public.has_app_permission_v1(p_reporter_user_id,'projects','UPDATE')
       or exists(select 1 from public.app_users u join public.app_roles r on r.code=u.role
                 where u.id=p_reporter_user_id and r.project_scoped) then
      raise exception '沒有修改共用工作內容名稱的權限。' using errcode='42501';
    end if;
    if exists(select 1 from public.projects p where p.customer_id=p_customer_id and p.id<>v_project.id
              and lower(regexp_replace(normalize(btrim(p.name),NFKC),'\s+',' ','g')) =
                  lower(regexp_replace(normalize(btrim(p_project_name),NFKC),'\s+',' ','g'))) then
      raise exception '此客戶已有相同工作內容名稱，請使用不同名稱。';
    end if;
    -- Keep all other project fields and historical quotation snapshots unchanged.
    update public.projects set name=btrim(p_project_name),updated_by=p_actor,source='web'
      where id=v_project.id returning * into v_project;
    -- The shared-name trigger legitimately advanced related log versions.
    select row_version into v_save_version from public.site_work_logs where id=p_id;
  end if;

  return public.upsert_project_site_work_log_v2(
    v_project.id, p_id, v_save_version, p_log_date, v_project.name,
    p_summary, p_work_type, p_time_period, p_status, p_worker_user_ids,
    p_reporter_user_id, p_actor
  );
end;
$function$
;

drop trigger if exists projects_sync_work_logs_v1 on public.projects;
create trigger projects_sync_work_logs_v1 after insert or update of name,project_type,status on public.projects
for each row execute function public.sync_project_fields_to_work_logs_v1();
-- CREATE OR REPLACE preserves existing RPC ACLs and security attributes.
commit;
