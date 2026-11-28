begin;
-- 私人資料權限檢查效能修正：erp_private_scope_v1 每次 Gateway 請求都要把 audit_logs、quotation_audit_log、
-- data_conflicts 全部轉成文字並以正規表示式找出 UUID（audit_logs 約 2.2 萬筆，每次約 3 秒，且隨紀錄增加變慢）。
-- 改為寫入時記錄每筆稽核資料提到的 UUID，查詢時走 GIN 索引；判斷規則與結果不變，稽核表本身欄位不變。

-- 1. 與原查詢相同的 UUID 擷取規則：lower(to_jsonb(row)::text) 中所有 8-4-4-4-12 十六進位字串。
create function public.text_uuid_refs_v1(p_text text) returns uuid[]
language sql immutable parallel safe set search_path='' as $$
  select coalesce(array_agg(distinct m[1]::uuid),'{}')
  from regexp_matches(lower(coalesce(p_text,'')),'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}','g') m
$$;

-- 2. 稽核資料的 UUID 索引（只供私人資料權限函式使用，不對外開放）。
create table public.audit_reference_index (
  source text not null check (source in ('audit_logs','quotation_audit_log','data_conflicts')),
  row_key text not null,
  referenced_ids uuid[] not null default '{}',
  primary key (source,row_key)
);
create index audit_reference_index_ids on public.audit_reference_index using gin (referenced_ids);
alter table public.audit_reference_index enable row level security;
revoke all on table public.audit_reference_index from public,anon,authenticated,service_role;

-- 3. 新增、修改、刪除稽核資料時同步維護索引（以寫入後的整列內容計算，與原查詢看到的內容相同）。
create function public.maintain_audit_reference_index_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    delete from public.audit_reference_index where source=tg_table_name and row_key=old.id::text;
    return null;
  end if;
  if tg_op='UPDATE' and old.id is distinct from new.id then
    delete from public.audit_reference_index where source=tg_table_name and row_key=old.id::text;
  end if;
  insert into public.audit_reference_index(source,row_key,referenced_ids)
    values(tg_table_name,new.id::text,public.text_uuid_refs_v1(to_jsonb(new)::text))
    on conflict (source,row_key) do update set referenced_ids=excluded.referenced_ids;
  return null;
end $$;
revoke all on function public.maintain_audit_reference_index_v1(),public.text_uuid_refs_v1(text) from public,anon,authenticated;

do $setup$
declare t text;
begin
  foreach t in array array['audit_logs','quotation_audit_log','data_conflicts'] loop
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('create trigger zz_audit_reference_index after insert or update or delete on public.%I for each row execute function public.maintain_audit_reference_index_v1()',t);
    execute format('insert into public.audit_reference_index(source,row_key,referenced_ids) select %L,a.id::text,public.text_uuid_refs_v1(to_jsonb(a)::text) from public.%I a',t,t);
  end loop;
end $setup$;

-- 4. erp_private_scope_v1：三處正規表示式掃描改為查索引，其餘邏輯不變。
do $upgrade$
declare original text; revised text;
begin
  original:=pg_get_functiondef('public.erp_private_scope_v1(uuid)'::regprocedure);
  -- 4a. 報價歷史快照（迴圈內）。
  revised:=replace(original,
    $old$or exists(select 1 from regexp_matches(lower(to_jsonb(a)::text),''[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'',''g'') m where m[1]::uuid=any($2::uuid[]))'$old$,
    $new$or a.id::text in(select r.row_key from public.audit_reference_index r where r.source=''quotation_audit_log'' and r.referenced_ids && $2::uuid[])'$new$);
  if revised=original then raise exception 'Unexpected quotation audit scan in erp_private_scope_v1'; end if;
  original:=revised;
  -- 4b. audit_logs、data_conflicts（迴圈結束後）。
  revised:=replace(original,
    $old$execute format('select coalesce(jsonb_agg(id),''[]''::jsonb) from public.%I a where exists(select 1 from regexp_matches(lower(to_jsonb(a)::text),''[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'',''g'') m where m[1]::uuid=any($1::uuid[]))',v_doc.tbl)$old$,
    $new$execute format('select coalesce(jsonb_agg(a.id),''[]''::jsonb) from public.%I a where a.id::text in(select r.row_key from public.audit_reference_index r where r.source=%L and r.referenced_ids && $1::uuid[])',v_doc.tbl,v_doc.tbl)$new$);
  if revised=original then raise exception 'Unexpected audit log scan in erp_private_scope_v1'; end if;
  if position('regexp_matches' in revised)>0 then raise exception 'erp_private_scope_v1 still scans audit text'; end if;
  execute revised;
end $upgrade$;

notify pgrst,'reload schema';
commit;
