-- Allow authorized editors to attach an existing log to a plan in the same project.
-- Existing service-only entry points, privacy scope, ownership and row versions remain authoritative.
begin;
CREATE OR REPLACE FUNCTION public.assert_construction_log_access_v1(p_user_id uuid, p_plan_id uuid, p_log_id uuid, p_action text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_plan public.construction_plans; v_project public.projects; v_log public.site_work_logs;
begin
 if not public.has_app_permission_v1(p_user_id,'worklogs',p_action) then raise exception '沒有工作日誌操作權限。'; end if;
 -- Serialize reassignment/deletion with log saves; removed workers cannot race a save.
 select * into v_plan from public.construction_plans where id=p_plan_id for update;
 if not found then raise exception '找不到施工規劃。'; end if;
 select * into v_project from public.projects where id=v_plan.project_id for update;
 perform public.erp_private_prepare_v1(p_user_id);
 perform public.erp_private_assert_v1(to_jsonb(v_project));
 if p_log_id is null then
  if p_action<>'CREATE' or v_plan.deleted_at is not null or v_plan.status='cancelled' or v_project.deleted_at is not null
   or v_project.project_type<>'construction' or coalesce(v_project.construction_category,'') not in ('small_purchase','tender')
   or not (exists(select 1 from public.construction_plan_assignees where construction_plan_id=p_plan_id and user_id=p_user_id) or public.construction_project_access_v1(p_user_id,v_project.id,true))
  then raise exception '只有指派施工人員、工作內容負責人或管理員可以新增此規劃日誌。'; end if;
 else
  select * into v_log from public.site_work_logs where id=p_log_id and deleted_at is null for update;
  if not found or v_log.project_id is distinct from v_project.id then raise exception '日誌與施工規劃必須屬於同一工作內容。'; end if;
  if v_log.construction_plan_id is distinct from p_plan_id then
   if p_action<>'UPDATE' or v_plan.deleted_at is not null or v_plan.status='cancelled' or v_project.deleted_at is not null
    or v_project.project_type<>'construction'
    or not (exists(select 1 from public.construction_plan_assignees where construction_plan_id=p_plan_id and user_id=p_user_id) or public.construction_project_access_v1(p_user_id,v_project.id,true))
   then raise exception '沒有指定此施工規劃的權限。'; end if;
  end if;
  perform public.erp_private_assert_v1(to_jsonb(v_log));
  if p_action='VIEW' then
   if not public.construction_log_visible_v1(p_user_id,v_log) then raise exception '沒有此施工日誌查看權限。'; end if;
  elsif v_log.access_creator_user_id is distinct from p_user_id
   and not exists(select 1 from public.app_users where id=p_user_id and is_active and role='admin') then
   raise exception '只能修改或刪除自己建立的施工日誌。';
  end if;
 end if;
end $function$;

CREATE OR REPLACE FUNCTION public.save_construction_work_log_v1(p_actor_user_id uuid,p_plan_id uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
declare item_id uuid:=nullif(p_payload->>'construction_item_id','')::uuid; log_id uuid:=nullif(p_payload->>'id','')::uuid;
 old_item uuid; old_plan uuid; result jsonb;
 old_context text:=current_setting('app.construction_item_id',true);
 old_log_context text:=current_setting('app.construction_link_log_id',true);
begin
 perform public.assert_construction_log_access_v1(p_actor_user_id,p_plan_id,log_id,case when log_id is null then 'CREATE' else 'UPDATE' end);
 if log_id is not null then
  select construction_item_id,construction_plan_id into old_item,old_plan from public.site_work_logs where id=log_id;
  if not (p_payload ? 'construction_item_id') then item_id:=old_item; end if;
 end if;
 -- Historical uncategorized logs can still be saved unchanged; new assignments require an item.
 if item_id is null and (log_id is null or old_plan is distinct from p_plan_id or old_item is not null)
  and exists(select 1 from public.construction_plan_items where construction_plan_id=p_plan_id and deleted_at is null)
 then raise exception '請選擇工作日誌所屬的施工子項目。'; end if;
 if item_id is not null and not exists(select 1 from public.construction_plan_items where id=item_id and construction_plan_id=p_plan_id and deleted_at is null)
 then raise exception '子項目不屬於此施工規劃。'; end if;
 perform set_config('app.construction_link_log_id',coalesce(log_id::text,''),true);
 perform set_config('app.construction_item_id',coalesce(item_id::text,''),true);
 result:=public.save_construction_work_log_without_item_v1(p_actor_user_id,p_plan_id,p_payload);
 if (result#>>'{work_log,construction_item_id}')::uuid is distinct from item_id then raise exception '送出識別碼已用於其他子項目，請重新載入。'; end if;
 perform set_config('app.construction_item_id',coalesce(old_context,''),true);
 perform set_config('app.construction_link_log_id',coalesce(old_log_context,''),true);
 return result;
end $$;
CREATE OR REPLACE FUNCTION public.preserve_construction_log_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
declare v_plan_id uuid:=nullif(current_setting('app.construction_plan_id',true),'')::uuid; v_project uuid;
begin
 if TG_OP='INSERT' or new.id::text=current_setting('app.construction_link_log_id',true) then
  if TG_OP='INSERT' and new.construction_plan_id is not null and new.construction_plan_id is distinct from v_plan_id then raise exception '施工規劃關聯必須由受驗證的日誌流程建立。'; end if;
  new.construction_plan_id:=v_plan_id;
 elsif new.construction_plan_id is distinct from old.construction_plan_id then raise exception '施工規劃關聯必須由受驗證的日誌流程變更。'; end if;
 if new.construction_plan_id is not null then
  select project_id into v_project from public.construction_plans where id=new.construction_plan_id;
  if new.project_id is distinct from v_project or new.work_type is distinct from '工程施工' then raise exception '施工日誌的工作內容或工作類型不相符。'; end if;
 end if;
 return new;
end $$;
CREATE OR REPLACE FUNCTION public.preserve_construction_item_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
declare expected uuid:=nullif(current_setting('app.construction_item_id',true),'')::uuid;
begin
 if TG_OP='INSERT' or new.id::text=current_setting('app.construction_link_log_id',true) then
  if TG_OP='INSERT' and new.construction_item_id is not null and new.construction_item_id is distinct from expected then raise exception '子項目關聯需由施工日誌流程建立。'; end if;
  new.construction_item_id:=expected;
 elsif new.construction_item_id is distinct from old.construction_item_id then raise exception '子項目關聯需由受驗證的施工日誌流程變更。'; end if;
 if new.construction_item_id is not null and not exists(select 1 from public.construction_plan_items where id=new.construction_item_id and construction_plan_id=new.construction_plan_id and deleted_at is null) then raise exception '日誌與施工子項目不相符。'; end if;
 return new;
end $$;
commit;
