begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
-- Keep concurrent status writes out of the gap between backfill and trigger setup.
lock table public.projects in share row exclusive mode;

-- Reuse projects.completed_on. Recover only a recorded transition, never updated_at
-- or a work log's user-entered log_date. Missing history stays unknown (NULL).
with completion_history as (
  select a.entity_id, (max(a.created_at) at time zone 'Asia/Taipei')::date as completed_on
  from public.audit_logs a
  join public.projects p on p.id = a.entity_id
  where a.entity_type = 'project'
    and p.status = 'completed' and p.completed_on is null
    and a.after_data ->> 'status' = 'completed'
    and (a.action = 'insert' or
      (a.action = 'update' and a.before_data ->> 'status' is distinct from 'completed'))
  group by a.entity_id
)
update public.projects p
set completed_on = h.completed_on, updated_by = 'project_completion_date_migration'
from completion_history h
where p.id = h.entity_id and p.completed_on is null;

create or replace function public.track_project_completion_date_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status is distinct from 'completed' then
    new.completed_on := null;
  elsif tg_op = 'INSERT' then
    new.completed_on := (statement_timestamp() at time zone 'Asia/Taipei')::date;
  elsif old.status is distinct from 'completed' then
    new.completed_on := (statement_timestamp() at time zone 'Asia/Taipei')::date;
  else
    new.completed_on := old.completed_on;
  end if;
  return new;
end;
$$;

revoke all on function public.track_project_completion_date_v1() from public, anon, authenticated;

-- All entry points (project form, work-log sync and existing RPCs) share this rule.
create trigger projects_track_completion_date_v1
before insert or update on public.projects
for each row execute function public.track_project_completion_date_v1();

commit;
