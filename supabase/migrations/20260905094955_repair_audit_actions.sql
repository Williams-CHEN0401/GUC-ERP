-- Repair RPCs emit these three actions. Keep every existing action and audit validation.
-- Schema-only fix: no business rows or historical audit entries are changed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.audit_logs drop constraint audit_logs_action_check;
alter table public.audit_logs add constraint audit_logs_action_check check (
  action in (
    'insert', 'update', 'delete', 'import', 'export',
    'UPDATE_CREDENTIAL', 'IMPORT_DEVICES', 'BATCH_UPDATE', 'BATCH_DELETE',
    'CREATE_REPAIR_ITEM', 'UPDATE_REPAIR_ITEM', 'DELETE_REPAIR_ITEM'
  )
);
commit;
