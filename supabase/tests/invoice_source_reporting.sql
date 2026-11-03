-- Integration regression. Run only in an isolated fixture database, with
-- guc.test_actor and guc.test_denied_actor set to the fixture users. All changes
-- roll back. Requires a unique active unconfirmed invoice without child events.
begin;
set local statement_timeout='30s';
create temp table invoice_source_checks(name text);
create temp table invoice_source_case as
select i.*,extract(year from i.invoice_date)::integer yr,q.row_version
from quotation_invoices i join quotations q on q.id=i.quotation_id
where i.tax_basis='unconfirmed' and i.status='active' and q.archived_at is null
 and q.quote_status<>'voided' and i.invoice_date is not null and i.amount_twd>0
 and i.canonical_invoice_id is null and q.invoice_number=i.invoice_number
 and not exists(select 1 from quotation_financial_events where invoice_id=i.id)
 and not exists(select 1 from quotation_invoices x where x.id<>i.id and x.status='active'
 and accounting_invoice_identity_v1(x.invoice_number,x.invoice_date)=accounting_invoice_identity_v1(i.invoice_number,i.invoice_date))
order by i.invoice_date limit 1;
do $$ declare f record; ledger jsonb; report jsonb; row jsonb; actor uuid:=current_setting('guc.test_actor')::uuid; begin
 select * into strict f from invoice_source_case;
 ledger:=accounting_ledger_read_v1(actor,jsonb_build_object('scope','sales','year',f.yr));
 select x into strict row from jsonb_array_elements(ledger->'invoices')x where x->>'id'=f.id::text;
 if (row->>'received_amount')::numeric<>f.amount_twd or (row->>'net_amount')::numeric+(row->>'vat_amount')::numeric<>f.amount_twd
 or (row->>'vat_amount')::numeric<>round(f.amount_twd::numeric*5/105,0) or (row->>'unpaid_amount')::numeric<>0
 then raise exception 'Unconfirmed invoice must report automatic tax and full gross as received';end if;
 if exists(select 1 from jsonb_array_elements(ledger->'invoices')x join quotations q on q.id=(x->>'quotation_id')::uuid where q.archived_at is not null or q.quote_status='voided' or x->>'status'<>'active') then raise exception 'Removed records leaked into ledger';end if;
 report:=quotation_revenue_report_v1(actor,f.yr,'month',null,null,1,200);
 select x into strict row from jsonb_array_elements(report->'invoices')x where x->>'id'=f.id::text;
 if (row->>'amount_twd')::numeric<>f.amount_twd or not (row->>'confirmed')::boolean then raise exception 'Invoice must immediately contribute without manual confirmation';end if;
 if (report#>>'{summary,received_amount}')::numeric<>(select coalesce(sum((x->>'amount_twd')::numeric),0) from jsonb_array_elements(report->'invoices')x where (x->>'confirmed')::boolean) then raise exception 'Receipt vouchers double counted';end if;
 if (select tax_basis from quotation_invoices where id=f.id)<>'unconfirmed' then raise exception 'Read mutated original tax evidence';end if;
 insert into invoice_source_checks values('Automatic 5% / gross=received / zero unpaid'),('Unconfirmed legacy invoice immediately in month report'),('Removed rows excluded from ledger'),('No fake confirmation or duplicate receipt');
end $$;
savepoint before_delete;
do $$ declare f record; actor uuid:=current_setting('guc.test_actor')::uuid; out jsonb; before_amount numeric; after_amount numeric; begin
 select * into strict f from invoice_source_case;
 before_amount:=(quotation_revenue_report_v1(actor,f.yr)#>>'{summary,received_amount}')::numeric;
 out:=delete_quotation_confirmed_v1(actor,f.quotation_id,f.row_version,'隔離測試：刪除請款來源',true);
 if not coalesce((out->>'archived')::boolean,false) then raise exception 'Expected financial history archive';end if;
 if exists(select 1 from jsonb_array_elements(accounting_ledger_read_v1(actor,jsonb_build_object('scope','sales','year',f.yr))->'invoices')x where x->>'id'=f.id::text) then raise exception 'Deleted billing still in ledger';end if;
 if exists(select 1 from jsonb_array_elements(quotation_revenue_report_v1(actor,f.yr,'month',null,null,1,200)->'invoices')x where x->>'id'=f.id::text) then raise exception 'Deleted billing still in details/export';end if;
 after_amount:=(quotation_revenue_report_v1(actor,f.yr)#>>'{summary,received_amount}')::numeric;
 if before_amount-after_amount<>f.amount_twd then raise exception 'Deleted amount not removed from summary';end if;
 if not exists(select 1 from quotation_invoices where id=f.id) or not exists(select 1 from quotation_billing_history where quotation_id=f.quotation_id) then raise exception 'History was lost';end if;
 raise notice 'PASS real delete RPC removes ledger/detail/summary, preserves source history';
end $$;
rollback to before_delete;
insert into invoice_source_checks values('Real billing delete RPC: ledger/details/totals excluded; history retained');
savepoint before_void;
do $$ declare f record; actor uuid:=current_setting('guc.test_actor')::uuid; n text; begin
 select * into strict f from invoice_source_case;
 perform void_quotation_invoice_v1(actor,f.quotation_id,f.row_version,f.id,'隔離測試：作廢發票');
 if exists(select 1 from jsonb_array_elements(accounting_ledger_read_v1(actor,jsonb_build_object('scope','sales','year',f.yr))->'invoices')x where x->>'id'=f.id::text) then raise exception 'Voided invoice still in ledger';end if;
 select row_version into f.row_version from quotations where id=f.quotation_id;
 n:='SOURCE-REISSUE-'||left(f.id::text,8);
 perform update_quotation_invoice_v1(actor,f.quotation_id,f.row_version,f.invoice_date,n,'隔離測試：重開發票');
 if not exists(select 1 from jsonb_array_elements(quotation_revenue_report_v1(actor,f.yr,'month',null,null,1,200)->'invoices')x where x->>'invoice_number'=n and (x->>'amount_twd')::numeric>=0) then raise exception 'Replacement invoice requires manual confirmation';end if;
 if (select count(*) from quotation_invoices where quotation_id=f.quotation_id and status='voided')<1 then raise exception 'Void history lost';end if;
 raise notice 'PASS void/reissue RPCs immediately update reports';
end $$;
rollback to before_void;
insert into invoice_source_checks values('Real void/reissue RPCs: old invoice excluded; new invoice automatic');
do $$ declare actor uuid:=current_setting('guc.test_denied_actor')::uuid; begin
 begin perform accounting_ledger_read_v1(actor,'{"scope":"sales","year":2026}');raise exception 'EXPECTED_DENIAL';
 exception when insufficient_privilege then null;end;
 begin perform quotation_revenue_report_v1(actor,2026);raise exception 'EXPECTED_DENIAL';
 exception when insufficient_privilege then null;end;
 if has_table_privilege('anon','accounting_invoice_source_v1','SELECT') or has_table_privilege('authenticated','accounting_invoice_source_v1','SELECT') or has_table_privilege('service_role','accounting_invoice_source_v1','SELECT') then raise exception 'Internal projection exposed directly';end if;
 if has_function_privilege('authenticated','accounting_ledger_read_v1(uuid,jsonb)','EXECUTE') or has_function_privilege('service_role','accounting_ledger_before_credits_read_v1(uuid,jsonb)','EXECUTE') then raise exception 'Private RPC ACL changed';end if;
 insert into invoice_source_checks values('Permission denial and internal view/RPC ACLs');
end $$;
savepoint before_edges;
do $$ declare f record; actor uuid:=current_setting('guc.test_actor')::uuid; owner_id uuid; value bigint; r record; begin
 select * into strict f from invoice_source_case;
 foreach value in array array[0,10,11,10000,9000000000000000]::bigint[] loop
  update quotation_invoices set amount_twd=value where id=f.id;
  select * into strict r from accounting_invoice_source_v1 where id=f.id;
  if r.net_amount+r.vat_amount<>value or r.vat_amount<>round(value::numeric*5/105,0) then raise exception 'Rounding/precision failure for %',value;end if;
 end loop;
 update quotation_invoices set amount_twd=f.amount_twd where id=f.id;
 update quotations set invoice_number=null where id=f.quotation_id;
 if exists(select 1 from accounting_invoice_source_v1 where id=f.id) then raise exception 'Cleared source still visible';end if;
 update quotations set invoice_number=f.invoice_number,invoice_date=null where id=f.quotation_id;
 update quotation_invoices set invoice_date=null where id=f.id;
 if not exists(select 1 from jsonb_array_elements(accounting_ledger_read_v1(actor,jsonb_build_object('scope','sales','year',f.yr))->'invoices')x where x->>'id'=f.id::text) then raise exception 'Missing-date invoice should be visible for correction';end if;
 if exists(select 1 from jsonb_array_elements(quotation_revenue_report_v1(actor,f.yr,'month',null,null,1,200)->'invoices')x where x->>'id'=f.id::text) then raise exception 'Missing-date invoice included in monthly total';end if;
 update quotations set invoice_date=f.invoice_date where id=f.quotation_id;
 update quotation_invoices set invoice_date=f.invoice_date where id=f.id;
 -- Restricted customer remains hidden even when the actor can read accounting.
 update customers set is_private=true where id=f.customer_id;
 select id into strict owner_id from app_users where id<>actor and is_active order by id limit 1;
 update erp_private_access set owner_user_id=owner_id,viewer_user_ids='{}';
 -- Each API request has a fresh transaction. Clear the cached request scope
 -- after changing the fixture's private-access configuration in this test.
 perform set_config('app.private_scope','',true);
 if exists(select 1 from jsonb_array_elements(accounting_ledger_read_v1(actor,jsonb_build_object('scope','sales','year',f.yr))->'invoices')x where x->>'id'=f.id::text)
 or exists(select 1 from jsonb_array_elements(quotation_revenue_report_v1(actor,f.yr,'month',null,null,1,200)->'invoices')x where x->>'id'=f.id::text)
 then raise exception 'Private customer invoice leaked to non-viewer';end if;
 raise notice 'PASS rounding, precision, source clearing, missing date and private customer filtering';
end $$;
rollback to before_edges;
insert into invoice_source_checks values('0/10/11/10000/9000000000000000 exact rounding'),('Cleared source hidden; missing date excluded only from period totals'),('Private customer access remains enforced');
select jsonb_agg(name) from invoice_source_checks;
rollback;
