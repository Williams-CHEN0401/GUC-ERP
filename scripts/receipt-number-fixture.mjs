import {transactionDocumentServer} from './transaction-document-fixture.mjs';
import {sql,ids} from './worklog-save-fixture.mjs';
import {callAsService,extraIds} from './department-cross-system-fixture.mjs';
import {receiptMergeSql} from './receipt-document-repair.mjs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
export const numberMigration='20261002102916_receipt_document_editable_numbers.sql';
export async function receiptNumberServer(){
 const f=await transactionDocumentServer();await f.db.exec(await sql(numberMigration));
 f.additionalRpcs.push('save_stock_receipt_document_v2');
 // Match the production RPC boundary, which creates Error in the Gateway realm.
 const rpc=f.gatewayContext.rpc,GatewayError=vm.runInContext('Error',f.gatewayContext);
 f.gatewayContext.rpc=async(...args)=>{try{return await rpc(...args);}catch(error){throw new GatewayError(error.code==='P0001'?error.message:'資料處理失敗，請確認輸入內容後重試。');}};
 return f;
}
export async function seedMergeGroup(f,date='2026-09-29'){
 const metadata=[];
 for(let i=0;i<3;i++){
  const doc=randomUUID();await callAsService(f.db,'save_stock_receipt_document_v1',[doc,true,'[]',date,extraIds.supplier,JSON.stringify([{inventory_item_id:f.items[i],quantity:i+1,note:'原進貨明細 '+(i+1)}]),[ids.customer],JSON.stringify([{customer_id:ids.customer,department_id:ids.department}]),ids.actor]);
  const r=(await f.db.query('select id,receipt_document_id document,receipt_document_no number,row_version version from stock_receipts where receipt_document_id=$1',[doc])).rows[0];metadata.push(r);
 }
 return {receipt_date:date,supplier_id:extraIds.supplier,metadata};
}
if(process.argv[1]?.endsWith('receipt-number-fixture.mjs')){
 const f=await receiptNumberServer(),group=await seedMergeGroup(f);await f.db.exec(receiptMergeSql([group]));
 const port=Number(process.env.DOCUMENT_TEST_PORT||4239);
 f.server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port+'/?page=transactions — 隔離資料庫：整併與手動單號'));
}
