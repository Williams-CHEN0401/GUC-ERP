-- Pending items belong to stable log/event IDs, not to a frozen work name or
-- room. The established writer authorizes both ends of a move and preserves
-- those IDs; list RPCs resolve the current project/department from the log.
-- Keep completion history immutable and do not move other logs or projects.
begin;
set local lock_timeout='5s';

create or replace function public.guard_maintenance_pending_log_v1()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if not exists(select 1 from public.maintenance_events e where e.work_log_id=old.id
   and (e.pending_completions<>'[]' or e.pending_sources<>'[]' or btrim(e.pending_content)<>'')) then
  return new;
 end if;
 if (new.log_date,new.work_type,new.deleted_at) is distinct from (old.log_date,old.work_type,old.deleted_at) then
  raise exception '此日誌有維修未完成事項或結清關聯，不可刪除或變更日期與類型；科室及工作內容可修改，事項會同步歸屬。';
 end if;
 if new.project_id is distinct from old.project_id and
  (select p.customer_id from public.projects p where p.id=new.project_id) is distinct from
  (select p.customer_id from public.projects p where p.id=old.project_id) then
  raise exception '此日誌有維修未完成事項或結清關聯，不可移至其他客戶。';
 end if;
 return new;
end $$;

-- This remains a deferred constraint: nested legacy writers set summary and
-- structured sections in separate statements. Inspect only the final state.
create or replace function public.guard_work_log_pending_history_v1()
returns trigger language plpgsql security invoker set search_path='' as $$
declare current_log public.site_work_logs; h jsonb; label text;
begin
 if old.pending_completions='[]' and old.pending_sources='[]' then return null;end if;
 select * into current_log from public.site_work_logs where id=old.id;
 if not found or (current_log.log_date,current_log.work_type,current_log.deleted_at)
  is distinct from (old.log_date,old.work_type,old.deleted_at) then
  raise exception '此日誌有未完成事項的結清關聯，不可刪除或變更日期與類型；科室及工作內容可修改，事項會同步歸屬。';
 end if;
 if current_log.project_id is distinct from old.project_id and
  (select p.customer_id from public.projects p where p.id=current_log.project_id) is distinct from
  (select p.customer_id from public.projects p where p.id=old.project_id) then
  raise exception '此日誌有未完成事項的結清關聯，不可移至其他客戶。';
 end if;
 if not(current_log.pending_completions @> old.pending_completions and current_log.pending_sources @> old.pending_sources) then
  raise exception '工作日誌的未完成結清履歷不可修改或移除。';end if;
 for h in select value from jsonb_array_elements(old.pending_completions) loop
  label:=public.work_log_history_label_v1(h);
  if not(label=any(regexp_split_to_array(coalesce(current_log.pending_content,''),E'\r?\n')))
   or h->>'pending_text'=any(regexp_split_to_array(coalesce(current_log.pending_content,''),E'\r?\n')) then
   raise exception '已結清的未完成事項及完成日期須保留；新的問題請另建日誌。';
  end if;
 end loop;
 for h in select value from jsonb_array_elements(old.pending_sources) loop
  label:=public.work_log_history_label_v1(h);
  if label=any(regexp_split_to_array(coalesce(old.completed_content,''),E'\r?\n')) and
   not(label=any(regexp_split_to_array(coalesce(current_log.completed_content,''),E'\r?\n'))) then
   raise exception '本次承接的已完成事項及完成日期不可移除。';
  end if;
 end loop;
 if current_log.completed_content is null or current_log.pending_content is null or current_log.summary is distinct from
  concat_ws(E'\n',nullif(btrim(current_log.completed_content),''),nullif(btrim(current_log.pending_content),'')) then
  raise exception '此日誌有結清履歷，請使用已完成與未完成欄位編輯並保留歷史事項。';
 end if;
 return null;
end $$;

-- CREATE OR REPLACE retains function OIDs and existing service-only ACLs.
-- No data backfill, RLS, grants, project guard or completion metadata changes.
notify pgrst,'reload schema';
commit;
