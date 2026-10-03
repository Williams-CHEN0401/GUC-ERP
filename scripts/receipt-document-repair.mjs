// Generates a bounded, one-time repair; never merges future receipts automatically.
// The reviewed manifest contains only receipt identity/version metadata, no line content.
export function receiptMergeSql(groups){
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(!Array.isArray(groups)||!groups.length)throw new Error('Empty merge manifest');
 const rows=groups.flatMap(g=>{
  if(!uuid.test(g.supplier_id)||!/^\d{4}-\d{2}-\d{2}$/.test(g.receipt_date)||!Array.isArray(g.metadata)||g.metadata.length<2||g.metadata.length>20)throw new Error('Invalid merge group');
  const target=g.metadata[0].document;
  return g.metadata.map((r,i)=>{
   if(![r.id,r.document,target].every(x=>uuid.test(x))||!Number.isInteger(r.version)||r.version<1)throw new Error('Invalid receipt identity/version');
   return `('${r.id}'::uuid,'${r.document}'::uuid,${r.version},'${target}'::uuid,'${g.receipt_date}'::date,'${g.supplier_id}'::uuid,${i+1})`;
  });
 });
 return `begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Lock only affected data domains; keep all audit/sync/version triggers enabled.
lock table public.stock_receipts,public.stock_transaction_documents in share row exclusive mode;
lock table public.stock_receipt_customers,public.inventory_items,public.pickup_records in share mode;
create temporary table receipt_merge_manifest(id uuid primary key,old_document uuid,old_version integer,target uuid,receipt_date date,supplier_id uuid,line_no integer) on commit drop;
insert into receipt_merge_manifest values ${rows.join(',\n')};
do $$
declare before_receipts text;before_customers text;before_inventory text;before_pickups text;before_count integer;after_count integer;
begin
 if (select count(*) from receipt_merge_manifest)<>${rows.length}
   or exists(select 1 from receipt_merge_manifest m left join public.stock_receipts r on r.id=m.id
     where r.id is null or r.row_version<>m.old_version or r.receipt_document_id<>m.old_document or r.receipt_date<>m.receipt_date or r.supplier_id<>m.supplier_id)
   or exists(select 1 from public.stock_receipts r where exists(select 1 from receipt_merge_manifest m where (m.receipt_date=r.receipt_date and m.supplier_id=r.supplier_id) or m.old_document=r.receipt_document_id) and not exists(select 1 from receipt_merge_manifest m where m.id=r.id))
   then raise exception '進貨資料已異動，停止整併；請重新盤點。';end if;
 if exists(select 1 from receipt_merge_manifest m left join public.stock_transaction_documents d on d.kind='receipt' and d.id=m.old_document
   where d.id is null or d.merged_into is not null or d.numbering_scope_id is distinct from m.supplier_id or d.numbering_date<>m.receipt_date)
   or exists(select 1 from receipt_merge_manifest m where not exists(select 1 from receipt_merge_manifest t where t.old_document=m.target and t.target=m.target and t.supplier_id=m.supplier_id and t.receipt_date=m.receipt_date))
   then raise exception '單據登錄與整併目標不符，停止整併。';end if;
 if exists(select 1 from receipt_merge_manifest m join public.stock_receipts r on r.id=m.id group by m.target
   having count(*)>20 or count(*)<>count(distinct (r.inventory_item_id,lower(btrim(coalesce(r.note,'')))))
     or count(distinct coalesce((select jsonb_agg(jsonb_build_array(c.customer_id,c.department_id) order by c.customer_id,c.department_id) from public.stock_receipt_customers c where c.stock_receipt_id=r.id),'[]'))>1)
   then raise exception '客戶科室或明細衝突，停止整併。';end if;
 select count(distinct receipt_document_id),md5(string_agg((to_jsonb(r)-array['receipt_document_id','receipt_document_no','receipt_line_no','row_version','updated_at'])::text,'' order by id)) into before_count,before_receipts from public.stock_receipts r;
 select md5(coalesce(string_agg(to_jsonb(c)::text,'' order by stock_receipt_id,customer_id),'')) into before_customers from public.stock_receipt_customers c;
 select md5(string_agg(to_jsonb(i)::text,'' order by id)) into before_inventory from public.inventory_items i;
 select md5(string_agg(to_jsonb(p)::text,'' order by id)) into before_pickups from public.pickup_records p;
 update public.stock_transaction_documents d set merged_into=m.target from (select distinct old_document,target from receipt_merge_manifest where old_document<>target) m where d.kind='receipt' and d.id=m.old_document;
 update public.stock_receipts r set receipt_line_no=m.line_no from receipt_merge_manifest m where r.id=m.id;
 -- The existing stamp trigger resolves registry targets; row IDs and business data stay put.
 if exists(select 1 from receipt_merge_manifest m join public.stock_receipts r on r.id=m.id join public.stock_transaction_documents d on d.kind='receipt' and d.id=m.target
   where r.receipt_document_id<>m.target or r.receipt_document_no is distinct from d.document_no or r.receipt_line_no<>m.line_no)
   then raise exception '整併後單据不一致，交易已回復。';end if;
 select count(distinct receipt_document_id) into after_count from public.stock_receipts;
 if after_count<>before_count-(select count(distinct old_document)-count(distinct target) from receipt_merge_manifest)
   or before_receipts is distinct from (select md5(string_agg((to_jsonb(r)-array['receipt_document_id','receipt_document_no','receipt_line_no','row_version','updated_at'])::text,'' order by id)) from public.stock_receipts r)
   or before_customers is distinct from (select md5(coalesce(string_agg(to_jsonb(c)::text,'' order by stock_receipt_id,customer_id),'')) from public.stock_receipt_customers c)
   or before_inventory is distinct from (select md5(string_agg(to_jsonb(i)::text,'' order by id)) from public.inventory_items i)
   or before_pickups is distinct from (select md5(string_agg(to_jsonb(p)::text,'' order by id)) from public.pickup_records p)
   then raise exception '資料保留檢查失敗，整筆交易已回復。';end if;
end $$;
select count(*) as preserved_receipt_lines,count(distinct receipt_document_id) as receipt_documents,
 (select count(*) from public.stock_transaction_documents where kind='receipt' and merged_into is not null) as archived_merged_numbers
 from public.stock_receipts;
commit;`;
}
