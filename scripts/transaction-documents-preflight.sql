-- Read-only production readiness inventory. Do NOT apply the migration here.
begin read only;
select 'receipts' kind,count(*) rows,count(distinct coalesce(receipt_document_id,id)) documents,
 count(*) filter(where receipt_document_id is null) ungrouped_rows,
 count(*) filter(where receipt_date is null or supplier_id is null) missing_numbering_context from public.stock_receipts
union all
select 'pickups',count(*),count(distinct (coalesce(request_id,id),project_id,pickup_date)),
 count(*) filter(where request_id is null),count(*) filter(where pickup_date is null or project_id is null) from public.pickup_records;
select receipt_document_id,count(*) lines,count(distinct (receipt_date,supplier_id)) header_variants
from public.stock_receipts where receipt_document_id is not null group by receipt_document_id having count(distinct (receipt_date,supplier_id))>1;
select request_id,count(*) lines,count(distinct (project_id,pickup_date)) context_variants
from public.pickup_records where request_id is not null group by request_id having count(distinct (project_id,pickup_date))>1;
select proname,oid::regprocedure,prosecdef,pg_get_functiondef(oid) definition from pg_proc
where pronamespace='public'::regnamespace and proname in('create_pickup_records_batch_v2','create_stock_receipts_with_customers_v1','delete_pickup_records','delete_stock_receipt_records');
select table_name,privilege_type from information_schema.role_table_grants where grantee='service_role' and table_schema='public'
and table_name in('stock_receipts','pickup_records','inventory_items','stock_receipt_customers');
-- Save fingerprints before and after migration; only metadata may differ.
select 'receipt_business_fields' dataset,md5(coalesce(string_agg((to_jsonb(s)-'receipt_document_id'-'receipt_document_no'-'row_version'-'updated_at')::text,'' order by id),'')) fingerprint from public.stock_receipts s
union all
select 'pickup_business_fields',md5(coalesce(string_agg((to_jsonb(p)-'pickup_document_id'-'pickup_document_no'-'row_version'-'updated_at')::text,'' order by id),'')) from public.pickup_records p;
rollback;
