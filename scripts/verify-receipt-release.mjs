// Production deletion definition inspected read-only on 2026-09-30; executed ONLY in PGlite.
import assert from 'node:assert/strict';
import {worklogAttachmentsServer} from './worklog-attachments-fixture.mjs';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
const fixture=await worklogAttachmentsServer(),{db,server,additionalRpcs}=fixture;
try{
 // Match the existing production FK (read-only verified); the minimal fixture omitted CASCADE.
 await db.exec(`alter table public.stock_receipt_customers drop constraint stock_receipt_customers_stock_receipt_id_fkey;
   alter table public.stock_receipt_customers add constraint stock_receipt_customers_stock_receipt_id_fkey foreign key(stock_receipt_id) references public.stock_receipts(id) on delete cascade;`);
 await db.exec(`CREATE OR REPLACE FUNCTION public.delete_stock_receipt_records(p_ids uuid[], p_actor text DEFAULT 'system'::text)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
 declare v_ids uuid[]; v_expected integer; v_locked integer; v_deleted integer;
 begin
 if p_ids is null or cardinality(p_ids) = 0 or exists (select 1 from unnest(p_ids) as value where value is null) then raise exception '請選擇要刪除的進貨紀錄。'; end if;
 select array_agg(distinct value order by value) into v_ids from unnest(p_ids) as value;
 v_expected := cardinality(v_ids);
 perform 1 from public.stock_receipts where id = any(v_ids) order by id for update;
 get diagnostics v_locked = row_count;
 if v_locked <> v_expected then raise exception '部分進貨紀錄不存在，請重新載入。'; end if;
 perform 1 from public.inventory_items where id in (select distinct inventory_item_id from public.stock_receipts where id = any(v_ids)) order by id for update;
 perform set_config('app.actor', coalesce(nullif(btrim(p_actor), ''), 'system'), true);
 delete from public.stock_receipts where id = any(v_ids);
 get diagnostics v_deleted = row_count;
 return v_deleted;
 end; $function$;
 revoke all on function public.delete_stock_receipt_records(uuid[],text) from public,anon,authenticated;
 grant execute on function public.delete_stock_receipt_records(uuid[],text) to service_role;`);
 additionalRpcs.push('delete_stock_receipt_records');
 console.log('BASELINE',JSON.stringify((await db.query("select proname,md5(pg_get_functiondef(oid)) as hash from pg_proc where pronamespace='public'::regnamespace and proname in ('create_stock_receipts_department_v1','update_stock_receipt_department_v1','complete_work_assignment_v1','register_contract_site_attachments_v2')")).rows));
 const before=(await db.query('select count(*)::integer as n from stock_receipts')).rows[0].n;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const {stdout}=await promisify(execFile)(process.execPath,['scripts/verify-receipt-documents-browser.mjs'],{env:{...process.env,TEST_ORIGIN:'http://127.0.0.1:'+server.address().port,TEST_RECEIPT_DELETE:'1'},windowsHide:true,timeout:120000});console.log(stdout);
 assert.equal((await db.query('select count(*)::integer as n from stock_receipts')).rows[0].n,before);console.log('PASS isolated whole-document delete: exact original row count restored.');
}finally{if(fixture.failures.length)console.error('ISOLATED SQL FAILURES',fixture.failures);fixture.restore();if(server.listening)await new Promise(resolve=>server.close(resolve));await db.close();}
