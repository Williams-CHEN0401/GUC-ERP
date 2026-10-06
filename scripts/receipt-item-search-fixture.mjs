// Loopback and disposable in-memory SQL only; no production credentials or NAS.
import {accessAppointmentsServer} from './erp-access-fixture.mjs';
import {randomUUID} from 'node:crypto';
const f=await accessAppointmentsServer();
// PGlite returns DATE as a JS Date; PostgREST returns YYYY-MM-DD. Match that wire format.
const read=f.gatewayContext.db;
f.gatewayContext.db=async(path,init={})=>{
 const response=await read(path,init);
 if((!init.method||init.method==='GET')&&path.startsWith('stock_receipts?')){
  const rows=await response.json();
  return Response.json(rows.map(row=>({...row,...(typeof row.receipt_date==='string'?{receipt_date:row.receipt_date.slice(0,10)}:{})})),{status:response.status});
 }
 return response;
};
const category=randomUUID(),inactive=randomUUID();
await f.db.query('insert into product_categories(id,name,code_prefix,is_active) values($1,$2,$3,true),($4,$5,$6,false)',[category,'監控設備（隔離）','SEARCH',inactive,'停用品（隔離）','OFF']);
await f.db.query('insert into inventory_items(id,category_id,item_name,item_type,inventory_code,brand,model,unit,opening_quantity) values($1,$2,$3,$4,$5,$6,$7,$8,100),($9,$10,$11,$12,$13,$14,$15,$16,100)',[randomUUID(),category,'網路攝影機（隔離搜尋）','監控設備（隔離）','SEARCH-01','搜尋品牌','CAM-100','台',randomUUID(),inactive,'停用品（隔離搜尋）','停用品（隔離）','OFF-01','停用品牌','OFF-100','台']);
const port=Number(process.env.RECEIPT_SEARCH_TEST_PORT||4245);
f.server.listen(port,'127.0.0.1',()=>console.log(`http://127.0.0.1:${port}/?page=transactions — 進貨搜尋：隔離 SQL、合成資料，不寫入正式資料庫／NAS`));
