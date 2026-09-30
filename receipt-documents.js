// One UI document, existing stock rows as its lines. Legacy rows stay separate.
function receiptDocumentRows(id){return state.receipts.filter(row=>(row.documentId||row.id)===id).sort((a,b)=>(a.lineNo||0)-(b.lineNo||0)||String(a.id).localeCompare(String(b.id)));}
function receiptDocument(id){return receiptDocumentRows(id)[0];}
function renderReceiptDocuments(){
  const groups=new Map();for(const row of state.receipts){const id=row.documentId||row.id;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(row);}
  const config=tableState.receipt,rows=[...groups].map(([id,lines])=>{
    lines=receiptDocumentRows(id);const first=lines[0];
    const names=lines.map(line=>{const item=byId(state.inventory,line.itemId);return `${item?.code||''} ${item?.name||''} ${item?.brand||''} ${item?.model||''}`.trim();});
    return {id,date:first.date,supplier:byId(state.suppliers,first.supplierId)?.name||first.supplierName||'',
      item:names.join('、'),itemNames:names,quantity:lines.length,
      customers:[...new Set(lines.flatMap(line=>line.customerIds||[]))].map(key=>byId(state.customers,key)?.name||'').join('、'),
      note:lines.map(line=>line.note).filter(Boolean).join('；')};
  }).filter(row=>matches([row.date,row.supplier,row.item,row.customers,row.note],config.search));
  const page=tablePage('receipt',sortRows(rows,config.sortKey||'date',config.direction||'desc'));
  document.querySelector('#receiptTable').innerHTML=page.rows.map(row=>`<tr${editableRowAttributes('receiptModal',row.id,canModule('purchases','UPDATE'))}><td>${esc(row.date)}</td><td>${esc(row.supplier)}</td><td>${row.itemNames.slice(0,3).map(name=>`<small>${esc(name)}</small>`).join('')}${row.itemNames.length>3?`<small>另有 ${row.itemNames.length-3} 筆明細</small>`:''}</td><td>${row.quantity} 筆</td><td>${esc(row.customers)||'—'}</td><td>${esc(row.note)}</td><td class="actions">${canModule('purchases','DELETE')?`<button data-delete-receipt="${esc(row.id)}">刪除整單</button>`:''}</td></tr>`).join('')||emptyRow(7);
  renderPagination('receipt','receiptPagination',page.total);
}
function receiptDocumentFields(id){
  const row=receiptDocument(id)||{};
  return inputField('date','進貨日期','date',true,row.date||today())+selectField('supplierId','供應商',state.suppliers.map(s=>[s.id,s.name]),row.supplierId)+
    `<div class="batch-editor span-2"><div class="batch-editor-head"><div><b>進貨明細</b><small>整張進貨單一起儲存；每列可修改品項、數量及備註。</small></div>${canModule('purchases','CREATE')?'<button class="outline" type="button" data-add-transaction-row="receipt">＋ 新增一列</button>':''}</div><div id="transactionBatchRows" class="transaction-batch receipt-batch"></div></div>`+
    receiptCustomerPicker(row.customerIds||[])+submitField(id?'儲存整張進貨單':'建立進貨單');
}
function initializeReceiptDocument(id){
  const form=document.querySelector('#modalForm'),lines=receiptDocumentRows(id);
  // Pin all versions on open; reference refresh must not replace this snapshot.
  form._receiptDocument={id:id||uid(),existing:lines.map(row=>({id:row.id,row_version:row.rowVersion}))};
  for(const row of lines){addTransactionBatchRow('receipt',{...row,categoryId:byId(state.inventory,row.itemId)?.categoryId||''});
    const element=form.querySelector('#transactionBatchRows').lastElementChild;element.dataset.receiptId=row.id;
    // Existing line deletion remains an explicit whole-document action, never an implicit save side effect.
    element.querySelector('[data-remove-batch-row]').hidden=true;
  }
  if(!lines.length)addTransactionBatchRow('receipt');
}
async function saveReceiptDocument(form,id,data){
  const rows=collectTransactionBatchRows('receipt'),elements=[...form.querySelectorAll('[data-batch-row]')],snapshot=form._receiptDocument;
  await mutate(id?'update_stock_receipt_document':'create_stock_receipt_document',{
    document_id:snapshot.id,existing:snapshot.existing,receipt_date:data.date,supplier_id:data.supplierId,
    customer_ids:[...new FormData(form).getAll('receiptCustomerId')],customer_departments:collectReceiptCustomerDepartments(),
    rows:rows.map((row,index)=>({id:elements[index].dataset.receiptId||null,inventory_item_id:row.itemId,quantity:row.quantity,note:row.note}))
  },id?'整張進貨單已修改':'進貨單已建立');
}
function previewReceiptDocument(payload){
  payload.rows.forEach((row,index)=>{let existing=byId(state.receipts,row.id);if(!existing){existing={id:uid(),rowVersion:0};state.receipts.unshift(existing);}
    Object.assign(existing,{documentId:payload.document_id,lineNo:index+1,date:payload.receipt_date,supplierId:payload.supplier_id,itemId:row.inventory_item_id,quantity:row.quantity,note:row.note||'',customerIds:payload.customer_ids,customerDepartments:payload.customer_departments,rowVersion:existing.rowVersion+1});});
}
