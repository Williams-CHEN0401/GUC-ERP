begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Retain issued identities/numbers after the separately reviewed one-time repair.
-- No new public access: the existing registry remains service-role only.
alter table public.stock_transaction_documents add column merged_into uuid;
alter table public.stock_transaction_documents add constraint stock_document_merge_target_fkey
  foreign key(kind,merged_into) references public.stock_transaction_documents(kind,id);
alter table public.stock_transaction_documents add constraint stock_document_merge_receipt_only
  check(merged_into is null or (kind='receipt' and merged_into<>id));
create unique index receipt_document_number_uidx on public.stock_transaction_documents
  (numbering_scope_id,lower(document_no)) where kind='receipt';

-- Automatic and manual receipt numbers share the same supplier namespace lock.
-- Skip manually reserved numbers even when they look like a future date/sequence.
do $$
declare s text;needle text;
begin
  select pg_get_functiondef('public.ensure_stock_document_v1(text,uuid,date,uuid,uuid)'::regprocedure) into s;
  needle:='perform pg_advisory_xact_lock(hashtextextended(''stock-number:''||p_kind||'':''||p_scope::text||'':''||p_date::text,0));';
  if position(needle in s)=0 then raise exception '單號產生器版本不符。';end if;
  s:=replace(s,needle,'if p_kind=''receipt'' then perform pg_advisory_xact_lock(hashtextextended(''receipt-number-scope:''||p_scope::text,0));end if;'||chr(10)||needle);
  needle:='where kind=p_kind and numbering_scope_id=p_scope and numbering_date=p_date;';
  if position(needle in s)=0 then raise exception '單號流水版本不符。';end if;
  s:=replace(s,needle,needle||chr(10)||$patch$
    if p_kind='receipt' then
      while exists(select 1 from public.stock_transaction_documents where kind='receipt' and numbering_scope_id=p_scope
        and lower(document_no)=lower(to_char(p_date,'YYYYMMDD')||case when v_sequence>1 then '-'||v_sequence else '' end)) loop
        v_sequence:=v_sequence+1;
      end loop;
    end if;$patch$);
  execute s;
  select pg_get_functiondef('public.stamp_stock_document_v1()'::regprocedure) into s;
  needle:='new.receipt_document_id:=old.receipt_document_id;new.receipt_document_no:=old.receipt_document_no;return new;';
  if position(needle in s)=0 then raise exception '進貨單號戳記版本不符。';end if;
  s:=replace(s,needle,$patch$
      select * into strict d from public.stock_transaction_documents where kind='receipt' and id=old.receipt_document_id;
      if d.merged_into is not null then
        select * into strict d from public.stock_transaction_documents where kind='receipt' and id=d.merged_into and merged_into is null;
      end if;
      -- Ignore arbitrary incoming identity/number; only the private registry wins.
      new.receipt_document_id:=d.id;new.receipt_document_no:=d.document_no;return new;$patch$);
  needle:='new.receipt_document_id:=d.id;new.receipt_document_no:=d.document_no;'||chr(10)||'  else';
  if position(needle in s)=0 then raise exception '進貨新增戳記版本不符。';end if;
  s:=replace(s,needle,'if d.merged_into is not null then raise exception ''此進貨單已整併，請重新整理後修改合併後的單據。'';end if;'||chr(10)||needle);
  execute s;
end $$;

-- Existing v1 API and its stock/customer writers remain unchanged.
create function public.save_stock_receipt_document_v2(p_document_id uuid,p_create boolean,p_existing jsonb,
  p_receipt_date date,p_supplier_id uuid,p_rows jsonb,p_customer_ids uuid[],p_customer_departments jsonb,
  p_actor_user_id uuid,p_document_no text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_result jsonb;v_doc public.stock_transaction_documents;v_number text:=nullif(btrim(p_document_no),'');
begin
  if v_number is not null and (char_length(v_number)>64 or v_number ~ '[[:cntrl:]]') then raise exception '進貨單號最多 64 字，不能包含換行或控制字元。';end if;
  v_result:=public.save_stock_receipt_document_v1(p_document_id,p_create,p_existing,p_receipt_date,p_supplier_id,p_rows,p_customer_ids,p_customer_departments,p_actor_user_id);
  select * into strict v_doc from public.stock_transaction_documents where kind='receipt' and id=p_document_id;
  if v_number is not null and v_number is distinct from v_doc.document_no then
    perform pg_advisory_xact_lock(hashtextextended('receipt-number-scope:'||v_doc.numbering_scope_id::text,0));
    if exists(select 1 from public.stock_transaction_documents where kind='receipt' and numbering_scope_id=v_doc.numbering_scope_id
      and id<>p_document_id and lower(document_no)=lower(v_number)) then
      raise exception '進貨單號已使用，請輸入同一編號廠商下不重複的單號。';
    end if;
    update public.stock_transaction_documents set document_no=v_number where kind='receipt' and id=p_document_id;
    update public.stock_receipts set receipt_document_no=v_number where receipt_document_id=p_document_id;
  end if;
  return v_result||jsonb_build_object('document_no',coalesce(v_number,v_doc.document_no));
end $$;
revoke all on function public.save_stock_receipt_document_v2(uuid,boolean,jsonb,date,uuid,jsonb,uuid[],jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.save_stock_receipt_document_v2(uuid,boolean,jsonb,date,uuid,jsonb,uuid[],jsonb,uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
