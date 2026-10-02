// Loopback + synthetic PostgreSQL only; no production credentials or network writes.
import {receiptDocumentServer} from './receipt-document-fixture.mjs';
import {sql,ids} from './worklog-save-fixture.mjs';
import {extraIds,callAsService} from './department-cross-system-fixture.mjs';
import {randomUUID} from 'node:crypto';
export const documentMigration='20261002011333_transaction_document_numbers.sql';
export async function transactionDocumentServer({migrate=true}={}){
 const fixture=await receiptDocumentServer(),{db}=fixture;
 await db.exec(`alter table stock_receipts add column if not exists created_at timestamptz default now();
   alter table pickup_records add column if not exists created_at timestamptz default now();
   update stock_receipts set receipt_date='2026-09-01' where receipt_date is null;
   update pickup_records set pickup_date='2026-09-01' where pickup_date is null;
   alter table stock_receipt_customers drop constraint stock_receipt_customers_stock_receipt_id_fkey;
   alter table stock_receipt_customers add constraint stock_receipt_customers_stock_receipt_id_fkey foreign key(stock_receipt_id) references stock_receipts(id) on delete cascade;`);
 // Existing deletion contracts, isolated baseline. Row/audit triggers still execute.
 for(const [name,table] of [['delete_stock_receipt_records','stock_receipts'],['delete_pickup_records','pickup_records']]){
   await db.exec(`create or replace function public.${name}(p_ids uuid[],p_actor text default 'system') returns integer
     language plpgsql security definer set search_path='' as $$
     declare v_ids uuid[];v_locked integer;v_deleted integer;
     begin
       if p_ids is null or cardinality(p_ids)=0 or array_position(p_ids,null) is not null then raise exception '請選擇有效的紀錄。';end if;
       select array_agg(distinct id order by id) into v_ids from unnest(p_ids) id;
       perform 1 from public.${table} where id=any(v_ids) order by id for update;get diagnostics v_locked=row_count;
       if v_locked<>cardinality(v_ids) then raise exception '部分紀錄不存在，請重新載入。';end if;
       perform 1 from public.inventory_items where id in(select inventory_item_id from public.${table} where id=any(v_ids)) order by id for update;
       perform set_config('app.actor',p_actor,true);delete from public.${table} where id=any(v_ids);get diagnostics v_deleted=row_count;return v_deleted;
     end $$;
     revoke all on function public.${name}(uuid[],text) from public,anon,authenticated;grant execute on function public.${name}(uuid[],text) to service_role;`);
 }
 const supplierB=randomUUID(),items=[ids.item,randomUUID(),randomUUID(),randomUUID()];
 await db.query('insert into suppliers(id,name) values($1,$2)',[supplierB,'隔離廠商 B']);
 for(let i=1;i<items.length;i++)await db.query('insert into inventory_items(id,category_id,item_name,item_type,inventory_code,brand,model,unit,opening_quantity) values($1,$2,$3,$4,$5,$6,$7,$8,100)',[items[i],ids.category,['','網路交換器','網路接頭','網路線'][i],'電腦設備','DOC-'+i,'隔離品牌','型號-'+i,'個']);
 const projects=(await db.query('select id from projects where deleted_at is null order by id limit 2')).rows.map(row=>row.id);
 const legacy={receipt:randomUUID(),pickup:randomUUID()};
 await db.query("insert into stock_receipts(id,receipt_date,supplier_id,inventory_item_id,quantity,note) values($1,'2026-09-24',$2,$3,1,'無批次舊進貨')",[legacy.receipt,extraIds.supplier,ids.item]);
 await db.query("insert into pickup_records(id,pickup_date,project_id,inventory_item_id,quantity,note) values($1,'2026-09-24',$2,$3,1,'無批次舊取貨')",[legacy.pickup,projects[0],ids.item]);
 const before={receipts:(await db.query('select id,receipt_date,supplier_id,inventory_item_id,quantity,note from stock_receipts order by id')).rows,pickups:(await db.query('select id,pickup_date,project_id,inventory_item_id,quantity,note,work_log_id,work_assignment_id from pickup_records order by id')).rows};
 if(migrate)await db.exec(await sql(documentMigration));
 fixture.additionalRpcs.push('save_pickup_document_v1','delete_stock_document_v1');
 return {...fixture,supplierB,items,projects,legacy,before};
}
if(process.argv[1]?.endsWith('transaction-document-fixture.mjs')){
 const f=await transactionDocumentServer(),{server,db}=f;const port=Number(process.env.DOCUMENT_TEST_PORT||4238);
 if(process.env.DOCUMENT_SAMPLE_DOCUMENTS==='1')for(let i=0;i<12;i++){
  const rows=f.items.slice(0,3).map((item,j)=>({inventory_item_id:item,quantity:j+1,note:'隔離範例 '+(i+1)}));
  await callAsService(db,'save_stock_receipt_document_v1',[randomUUID(),true,'[]','2026-10-02',extraIds.supplier,JSON.stringify(rows),[],'[]',ids.actor]);
  await callAsService(db,'create_pickup_records_batch_v2',[JSON.stringify(rows.map(r=>({...r,pickup_date:'2026-10-02',project_id:f.projects[0]}))),ids.actor,'fixture-admin',null,randomUUID(),'fixture-admin']);
 }
 server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port+'/?page=transactions — 整單隔離 DB，不連線正式資料庫/NAS'));
}
