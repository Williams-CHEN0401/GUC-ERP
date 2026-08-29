-- Trigger-only security-definer functions must not be exposed through PostgREST RPC.
revoke all on function public.set_site_work_log_project_id_v1()
  from public, anon, authenticated;
