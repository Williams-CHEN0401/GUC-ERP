begin;

create index if not exists phone_terminal_import_logs_service_idx
  on public.phone_terminal_import_logs(contract_service_type_id);

commit;
