begin;
set local lock_timeout='5s';

-- One database transaction, using the existing project soft delete and the
-- quotation archive policy. No cross-system HTTP call or duplicate master data.
alter function public.delete_project_record(uuid,integer,text) rename to delete_project_before_accounting_v1;
revoke all on function public.delete_project_before_accounting_v1(uuid,integer,text) from public,anon,authenticated,service_role;
create function public.delete_project_record(p_id uuid,p_row_version integer,p_actor text)
returns integer language plpgsql security definer set search_path='' as $$
declare p public.projects; q public.quotations; actor_id uuid; archived_ids uuid[]:='{}';
begin
 select id into actor_id from public.app_users where username=p_actor and is_active;
 if actor_id is null or not public.has_app_permission_v1(actor_id,'projects','DELETE') then
  raise exception '您的帳號沒有刪除工作內容的權限。';
 end if;
 perform public.erp_private_prepare_v1(actor_id);
 perform public.erp_private_assert_v1(jsonb_build_array(p_id));
 if exists(select 1 from public.app_users u join public.app_roles r on r.code=u.role
  where u.id=actor_id and r.project_scoped) and not exists(
  select 1 from public.project_workers where project_id=p_id and user_id=actor_id and can_view) then
  raise exception '您的帳號沒有此工作內容的存取權限。';
 end if;
 select * into p from public.projects where id=p_id for update;
 if not found then raise exception '找不到工作內容資料。'; end if;
 -- A retry of an already completed soft delete never changes another record.
 if p.deleted_at is not null then return 1; end if;
 if p.row_version is distinct from p_row_version then raise exception '工作內容資料已被其他使用者更新，請重新載入後再刪除。'; end if;
 for q in select quote.* from public.quotations quote where quote.archived_at is null
  and (quote.project_id=p_id or exists(select 1 from public.quotation_work_links l where l.quotation_id=quote.id and l.project_id=p_id))
  order by quote.id for update loop
  perform public.erp_private_assert_v1(to_jsonb(q));
  -- A merged quote also represents another case. Require explicit separation
  -- instead of silently removing that other case's accounting row.
  if exists(select 1 from public.quotation_work_links l join public.projects other on other.id=l.project_id
    where l.quotation_id=q.id and l.project_id<>p_id and other.deleted_at is null)
    or (q.project_id is not null and q.project_id<>p_id and exists(select 1 from public.projects where id=q.project_id and deleted_at is null)) then
   raise exception '報價單 % 同時關聯其他工作內容，請先在報價單管理調整關聯後再刪除；本次未刪除任何資料。',q.quotation_number;
  end if;
  update public.quotations set archived_at=statement_timestamp(),archived_by_user_id=actor_id,
   archive_reason='ERP 工作內容刪除：'||p_id::text,updated_by_user_id=actor_id where id=q.id;
  perform public.quotation_write_audit_v1(actor_id,q.id,q.current_version_id,'delete',to_jsonb(q),
   jsonb_build_object('event','erp_work_deleted','work_content_id',p_id,'archived',true,'financial_history_preserved',true));
  archived_ids:=array_append(archived_ids,q.id);
 end loop;
 perform public.delete_project_before_accounting_v1(p_id,p_row_version,p_actor);
 insert into public.audit_logs(entity_type,entity_id,action,source,actor,actor_user_id,system_module,before_data,after_data)
 values('project',p_id,'update','web',p_actor,actor_id,'projects',jsonb_build_object('row_version',p_row_version),
  jsonb_build_object('event','work_accounting_delete','archived_quotation_ids',to_jsonb(archived_ids),'financial_history_preserved',true));
 return 1;
end $$;
revoke all on function public.delete_project_record(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.delete_project_record(uuid,integer,text) to service_role;
notify pgrst,'reload schema';
commit;
