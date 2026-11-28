-- 私人資料權限檢查效能修正驗證（在含正式資料的隔離資料庫執行，最後一律 ROLLBACK）。
-- 本檔在套用 migration 前執行：記錄每位啟用中使用者的 erp_private_scope_v1 結果與耗時。
create or replace function pg_temp.scope_norm(r jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'filters',coalesce((select jsonb_object_agg(t.key,(select coalesce(jsonb_object_agg(c.key,(select coalesce(jsonb_agg(x order by x),'[]') from jsonb_array_elements_text(c.value) x)),'{}') from jsonb_each(t.value) c)) from jsonb_each(r->'filters') t),'{}'),
    'blocked',(select coalesce(jsonb_agg(x order by x),'[]') from jsonb_array_elements_text(r->'blocked_ids') x),
    'mutation',(select coalesce(jsonb_agg(x order by x),'[]') from jsonb_array_elements_text(r->'mutation_project_ids') x),
    'rest',r-'filters'-'blocked_ids'-'mutation_project_ids')
$$;
create temp table _scope_before(id uuid,username text,direct boolean,r jsonb,ms numeric) on commit drop;
do $before$
declare u record; t0 timestamptz; v jsonb;
begin
  for u in select id,username from public.app_users where is_active order by username loop
    t0:=clock_timestamp();v:=public.erp_private_scope_v1(u.id);
    insert into _scope_before values(u.id,u.username,(v->>'direct')::boolean,pg_temp.scope_norm(v),extract(epoch from clock_timestamp()-t0)*1000);
  end loop;
end $before$;
