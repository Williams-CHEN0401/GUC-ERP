// Isolated DB only. Reuses production receipt writers; no real business data.
import {appointmentsServer} from './appointments-fixture.mjs';
import {sql} from './worklog-save-fixture.mjs';
export const receiptDocumentMigration='20260930110326_stock_receipt_documents.sql';
export async function receiptDocumentServer(){
  const fixture=await appointmentsServer();
  await fixture.db.exec(await sql(receiptDocumentMigration));
  fixture.additionalRpcs.push('save_stock_receipt_document_v1');
  return fixture;
}
if(process.argv[1]?.endsWith('receipt-document-fixture.mjs')){
  const {server}=await receiptDocumentServer();server.listen(4234,'127.0.0.1',()=>console.log('http://127.0.0.1:4234/?page=transactions — 隔離 DB，無正式寫入'));
}
