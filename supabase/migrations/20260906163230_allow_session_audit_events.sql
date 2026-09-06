-- Preserve every existing event code and allow authenticated session auditing.
alter table public.audit_logs drop constraint audit_logs_action_check;
alter table public.audit_logs add constraint audit_logs_action_check check (action = any (array['insert','update','delete','import','export','UPDATE_CREDENTIAL','IMPORT_DEVICES','BATCH_UPDATE','BATCH_DELETE','CREATE_REPAIR_ITEM','UPDATE_REPAIR_ITEM','DELETE_REPAIR_ITEM','LOGIN','LOGOUT']::text[]));
