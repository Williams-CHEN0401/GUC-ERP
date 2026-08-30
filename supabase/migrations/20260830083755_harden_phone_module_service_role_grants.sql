begin;

-- Supabase default privileges grant broad rights to service_role when a table
-- is created. Replace those defaults with the exact privileges used by the
-- inventory gateway. Credential writes and reveals remain RPC-only.
revoke all on public.phone_systems from service_role;
revoke all on public.phone_extensions from service_role;
revoke all on public.phone_terminal_points from service_role;
revoke all on public.phone_system_credentials from service_role;
revoke all on public.phone_credential_access_logs from service_role;
revoke all on sequence public.phone_credential_access_logs_id_seq from service_role;

grant select, insert, update, delete on public.phone_systems to service_role;
grant select, insert, update, delete on public.phone_extensions to service_role;
grant select, insert, update, delete on public.phone_terminal_points to service_role;
grant select on public.phone_credential_access_logs to service_role;

commit;
