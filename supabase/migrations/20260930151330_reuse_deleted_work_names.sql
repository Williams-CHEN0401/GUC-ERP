begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Deleted work retains its ID/history but no longer reserves a customer/name.
-- Create the replacement before removing the old index; the transaction makes
-- the change atomic and still rejects duplicate non-deleted (including closed) work.
create unique index projects_customer_active_name_uidx
  on public.projects(customer_id, lower(btrim(name))) where deleted_at is null;
drop index public.projects_customer_normalized_name_uidx;
alter index public.projects_customer_active_name_uidx rename to projects_customer_normalized_name_uidx;

-- Same customer lock, normalization, date suffix and length limit as before.
create or replace function public.repair_visit_name_v1(p_customer_id uuid,p_name text,p_date date)
returns text language plpgsql security invoker set search_path='' as $$
declare v_name text:=btrim(p_name); v_base text; v_suffix integer:=2;
begin
  if p_customer_id is null or nullif(v_name,'') is null or p_date is null then
    raise exception '請選擇客戶、填寫工作內容名稱與日誌日期。';
  end if;
  if exists(select 1 from public.projects where customer_id=p_customer_id and deleted_at is null and lower(btrim(name))=lower(v_name)) then
    v_base:=v_name||to_char(p_date,'YYMMDD'); v_name:=v_base;
    while exists(select 1 from public.projects where customer_id=p_customer_id and deleted_at is null and lower(btrim(name))=lower(v_name)) loop
      v_name:=v_base||'-'||v_suffix; v_suffix:=v_suffix+1;
    end loop;
  end if;
  if char_length(v_name)>120 then raise exception '加上日期／流水尾碼後，工作內容名稱不可超過 120 個字，請縮短名稱。'; end if;
  return v_name;
end $$;
revoke all on function public.repair_visit_name_v1(uuid,text,date) from public,anon,authenticated;
grant execute on function public.repair_visit_name_v1(uuid,text,date) to service_role;

-- Other writers share the same name namespace. Do not resolve new work to a
-- deleted ID or reject a released name in the department / assignment paths.
-- Exact guarded edits preserve all existing authorization, ID-based edits,
-- replay handling, grants and unrelated workflow behavior.
do $$
declare v_patch record; v_oid oid; v_definition text;
begin
  for v_patch in select * from (values
    ('upsert_customer_project_work_log_v2',
      E'and lower(btrim(name)) = lower(btrim(p_project_name))\n    limit 1;',
      E'and lower(btrim(name)) = lower(btrim(p_project_name)) and deleted_at is null\n    limit 1;'),
    ('upsert_customer_project_work_log_v3',
      E'and lower(btrim(name)) = lower(btrim(p_project_name))\n    limit 1;',
      E'and lower(btrim(name)) = lower(btrim(p_project_name)) and deleted_at is null\n    limit 1;'),
    ('upsert_customer_project_work_log_v3',
      'where p.customer_id=p_customer_id and p.id<>v_project.id',
      'where p.customer_id=p_customer_id and p.id<>v_project.id and p.deleted_at is null'),
    ('upsert_customer_project_work_log_department_v1',
      'and lower(btrim(name))=lower(btrim(p_project_name)) for update;',
      'and lower(btrim(name))=lower(btrim(p_project_name)) and deleted_at is null for update;'),
    ('upsert_erp_project_department_v1',
      'and id is distinct from p_id and department_id is distinct from p_department_id)',
      'and deleted_at is null and id is distinct from p_id and department_id is distinct from p_department_id)'),
    ('create_work_assignment_with_project_v1',
      'and lower(btrim(name)) = lower(btrim(p_project_name))) then',
      'and lower(btrim(name)) = lower(btrim(p_project_name)) and deleted_at is null) then')
  ) as changes(function_name,old_text,new_text) loop
    select oid into strict v_oid from pg_proc
      where pronamespace='public'::regnamespace and proname=v_patch.function_name;
    v_definition:=replace(pg_get_functiondef(v_oid),chr(13),'');
    if (length(v_definition)-length(replace(v_definition,v_patch.old_text,'')))/length(v_patch.old_text) <> 1 then
      raise exception 'Unexpected work-name lookup baseline: %',v_patch.function_name;
    end if;
    execute replace(v_definition,v_patch.old_text,v_patch.new_text);
  end loop;
end $$;
commit;
