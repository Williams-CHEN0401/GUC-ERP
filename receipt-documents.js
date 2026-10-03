// One UI document, existing stock rows as its lines. Legacy rows stay separate.
function receiptDocumentRows(id){return state.receipts.filter(row=>(row.documentId||row.id)===id).sort((a,b)=>(a.lineNo||0)-(b.lineNo||0)||String(a.id).localeCompare(String(b.id)));}
function receiptDocument(id){return receiptDocumentRows(id)[0];}
function renderReceiptDocuments(){
  const groups=new Map();for(const row of state.receipts){const id=row.documentId||row.id;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(row);}
  const config=tableState.receipt,rows=[...groups].map(([id,lines])=>{
    lines=receiptDocumentRows(id);const first=lines[0];
    const names=lines.map(line=>{const item=byId(state.inventory,line.itemId);return `${item?.code||''} ${item?.name||''} ${item?.brand||''} ${item?.model||''}`.trim();});
    return {id,date:first.date,supplier:byId(state.suppliers,first.supplierId)?.name||first.supplierName||'',
      documentNo:first.documentNo||'',item:names.join('、'),itemNames:names,itemCount:new Set(lines.map(line=>line.itemId)).size,quantity:lines.reduce((sum,line)=>sum+line.quantity,0),
      customers:[...new Set(lines.flatMap(line=>line.customerIds||[]))].map(key=>byId(state.customers,key)?.name||'').join('、'),
      note:lines.map(line=>line.note).filter(Boolean).join('；')};
  }).filter(row=>matches([row.documentNo,row.date,row.supplier,row.item,row.customers,row.note],config.search)&&transactionDocumentFilter('receipt',row));
  const page=tablePage('receipt',sortRows(rows,config.sortKey||'date',config.direction||'desc'));
  document.querySelector('#receiptTable').innerHTML=page.rows.map(row=>`<tr${editableRowAttributes('receiptModal',row.id,canModule('purchases','UPDATE'))}><td>${esc(row.documentNo)||'舊單（未編號）'}</td><td>${esc(row.date)}</td><td>${esc(row.supplier)}</td><td>${row.itemNames.slice(0,2).map(name=>`<small>${esc(name)}</small>`).join('')}${row.itemNames.length>2?`<small>另有 ${row.itemNames.length-2} 筆明細</small>`:''}</td><td>${row.itemCount} 種</td><td>${row.quantity}</td><td>${esc(row.customers)||'—'}</td><td>${esc(row.note)}</td><td class="actions">${canModule('purchases','DELETE')?`<button data-delete-receipt="${esc(row.id)}">刪除整單</button>`:''}</td></tr>`).join('')||emptyRow(9);
  renderPagination('receipt','receiptPagination',page.total);
}
function receiptDocumentFields(id){
  const row=receiptDocument(id)||{};
  return receiptDocumentNumberField(row.documentNo,id)+inputField('date','進貨日期','date',true,row.date||today())+selectField('supplierId','供應商',state.suppliers.map(s=>[s.id,s.name]),row.supplierId)+
    `<div class="batch-editor span-2"><div class="batch-editor-head"><div><b>進貨明細</b><small>整張進貨單一起儲存；每列可修改品項、數量及備註。</small></div>${canModule('purchases','CREATE')?'<button class="outline" type="button" data-add-transaction-row="receipt">＋ 新增一列</button>':''}</div><div id="transactionBatchRows" class="transaction-batch receipt-batch"></div></div>`+
    receiptCustomerPicker(row.customerIds||[])+submitField(id?'儲存整張進貨單':'建立進貨單');
}
function initializeReceiptDocument(id){
  const form=document.querySelector('#modalForm'),lines=receiptDocumentRows(id);
  // Pin all versions on open; reference refresh must not replace this snapshot.
  form._receiptDocument={id:id||uid(),existing:lines.map(row=>({id:row.id,row_version:row.rowVersion}))};
  for(const row of lines){addTransactionBatchRow('receipt',{...row,categoryId:byId(state.inventory,row.itemId)?.categoryId||''});
    const element=form.querySelector('#transactionBatchRows').lastElementChild;element.dataset.receiptId=row.id;
    element.querySelector('[data-remove-batch-row]').hidden=!canModule('purchases','DELETE');
  }
  if(!lines.length)addTransactionBatchRow('receipt');
}
async function saveReceiptDocument(form,id,data){
  const rows=collectTransactionBatchRows('receipt'),elements=[...form.querySelectorAll('[data-batch-row]')],snapshot=form._receiptDocument;
  await mutate(id?'update_stock_receipt_document':'create_stock_receipt_document',{
    document_id:snapshot.id,existing:snapshot.existing,document_no:data.documentNo?.trim()||null,receipt_date:data.date,supplier_id:data.supplierId,
    customer_ids:[...new FormData(form).getAll('receiptCustomerId')],customer_departments:collectReceiptCustomerDepartments(),
    rows:rows.map((row,index)=>({id:elements[index].dataset.receiptId||null,inventory_item_id:row.itemId,quantity:row.quantity,note:row.note}))
  },id?'整張進貨單已修改':'進貨單已建立');
}
function previewReceiptDocument(payload){
  const previous=receiptDocumentRows(payload.document_id),scope=previous[0]?.numberingSupplierId||previous[0]?.supplierId||payload.supplier_id;
  const number=payload.document_no?.trim()||previous[0]?.documentNo||previewDocumentNumber('receipt',scope,payload.receipt_date);
  if(state.receipts.some(row=>(row.documentId||row.id)!==payload.document_id&&(row.numberingSupplierId||row.supplierId)===scope&&row.documentNo?.toLocaleLowerCase()===number.toLocaleLowerCase()))throw new Error('進貨單號已使用，請輸入同一編號廠商下不重複的單號。');
  state.receipts=state.receipts.filter(row=>(row.documentId||row.id)!==payload.document_id||payload.rows.some(line=>line.id===row.id));
  payload.rows.forEach((row,index)=>{let existing=byId(state.receipts,row.id);if(!existing){existing={id:uid(),rowVersion:0};state.receipts.unshift(existing);}
    Object.assign(existing,{documentId:payload.document_id,documentNo:number,numberingSupplierId:scope,lineNo:index+1,date:payload.receipt_date,supplierId:payload.supplier_id,itemId:row.inventory_item_id,quantity:row.quantity,note:row.note||'',customerIds:payload.customer_ids,customerDepartments:payload.customer_departments,rowVersion:existing.rowVersion+1});});
}

function receiptDocumentNumberField(number,id){return `<label class="span-2">進貨單號<input name="documentNo" maxlength="64" value="${esc(number||'')}" placeholder="留白時自動產生"><small>${id?'可手動修改；留白則保留原單號。修改日期／廠商不會自動重編。':'留白時依進貨日期及廠商自動編號，也可自行輸入。'} 單號須在原編號廠商範圍內不重複。</small></label>`;}
function documentNumberField(number,id){return `<label class="span-2">單號<output>${esc(number)||(id?'舊單（未編號）':'儲存後依實際日期產生')}</output></label>`;}
function pickupDocumentRows(id){return state.pickups.filter(row=>(row.documentId||row.id)===id).sort((a,b)=>(a.requestRow||0)-(b.requestRow||0)||String(a.id).localeCompare(String(b.id)));}
function pickupDocument(id){return pickupDocumentRows(id)[0];}
function initializePickupDocument(id){
  const form=document.querySelector('#modalForm'),lines=pickupDocumentRows(id);form._pickupDocument={id,existing:lines.map(row=>({id:row.id,row_version:row.rowVersion}))};
  for(const row of lines){addTransactionBatchRow('pickup',{...row,categoryId:byId(state.inventory,row.itemId)?.categoryId||''});const element=form.querySelector('#transactionBatchRows').lastElementChild;element.dataset.pickupId=row.id;element.querySelector('[data-remove-batch-row]').hidden=!canModule('pickups','DELETE');}
  if(!lines.length)addTransactionBatchRow('pickup');
}
function pickupDocumentPayload(form,data){
  const rows=collectTransactionBatchRows('pickup'),elements=[...form.querySelectorAll('[data-batch-row]')];
  return {document_id:form._pickupDocument.id,existing:form._pickupDocument.existing,pickup_date:data.date,project_id:data.projectId,customer_id:data.customerId,
    rows:rows.map((row,index)=>({id:elements[index].dataset.pickupId||null,inventory_item_id:row.itemId,quantity:row.quantity,note:row.note}))};
}
function renderPickupDocuments(){
  const config=tableState.pickup,groups=new Map();for(const line of state.pickups){const id=line.documentId||line.id;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(line);}
  const rows=[...groups].map(([id,lines])=>{const first=lines[0],project=byId(state.projects,first.projectId),customer=byId(state.customers,first.customerId),names=lines.map(line=>{const item=byId(state.inventory,line.itemId);return `${item?.code||''} ${item?.name||''} ${item?.brand||''} ${item?.model||''}`.trim();});return {id,documentNo:first.documentNo||'',date:first.date,projectId:first.projectId,project:project?.name||first.projectName||'已刪除工作內容',projectCode:project?.code||first.projectCode||'—',customer:customer?.name||'',item:names.join('、'),itemNames:names,itemCount:new Set(lines.map(line=>line.itemId)).size,quantity:lines.reduce((sum,line)=>sum+line.quantity,0),account:[...new Set(lines.map(line=>line.account))].join('、'),note:lines.map(line=>line.note).filter(Boolean).join('；')};}).filter(row=>matches([row.documentNo,row.date,row.customer,row.project,row.projectCode,row.item,row.account,row.note],config.search)&&transactionDocumentFilter('pickup',row));
  const page=tablePage('pickup',sortRows(rows,config.sortKey||'date',config.direction||'desc'));
  document.querySelector('#pickupTable').innerHTML=page.rows.map(row=>`<tr${editableRowAttributes('pickupModal',row.id,canModule('pickups','UPDATE'))}><td>${esc(row.documentNo)||'舊單（未編號）'}</td><td>${esc(row.date)}</td><td>${esc(row.customer)}</td><td><strong>${esc(row.projectCode)}</strong><small>${esc(row.project)}</small></td><td>${row.itemCount} 種</td><td>${esc(row.account)}</td><td>${esc(row.note)}</td><td class="actions">${canModule('pickups','DELETE')?`<button data-delete-pickup="${esc(row.id)}">刪除整單</button>`:''}</td></tr>`).join('')||emptyRow(8);
  renderPagination('pickup','pickupPagination',page.total);
}
function transactionDocumentFilter(kind,row){
  const from=document.querySelector(`#${kind}DateFrom`)?.value||'',to=document.querySelector(`#${kind}DateTo`)?.value||'',scope=document.querySelector(`#${kind}ScopeFilter`)?.value||'';
  return (!from||row.date>=from)&&(!to||row.date<=to)&&(!scope||(kind==='receipt'?receiptDocument(row.id)?.supplierId:row.projectId)===scope);
}
function refreshTransactionFilters(){
  for(const [kind,options] of [['receipt',state.suppliers.map(row=>[row.id,row.name])],['pickup',state.projects.map(row=>[row.id,`${row.code}｜${row.name}`])]]){
    const select=document.querySelector(`#${kind}ScopeFilter`);if(!select)continue;const current=select.value;
    select.innerHTML='<option value="">全部</option>'+options.map(([id,label])=>`<option value="${esc(id)}">${esc(label)}</option>`).join('');select.value=current;
  }
}
document.addEventListener('change',event=>{const kind=event.target.dataset.transactionFilter;if(kind){tableState[kind].page=1;renderTransactions();}});
async function deleteTransactionDocument(kind,id){
  const rows=kind==='receipt'?receiptDocumentRows(id):pickupDocumentRows(id),label=kind==='receipt'?'進貨':'取貨';
  if(rows.length&&confirm(`確定刪除整張${label}單（${rows.length} 筆明細）？庫存也會重新計算。`))await mutate(kind==='receipt'?'delete_stock_receipt_document':'delete_pickup_document',{document_id:id,existing:rows.map(row=>({id:row.id,row_version:row.rowVersion}))},`${label}單已刪除`);
}
const previewDocumentCounters=new Map();
function previewDocumentNumber(kind,scope,date){
  const key=[kind,scope,date].join('|'),format=n=>date.replaceAll('-','')+(n>1?`-${n}`:'');let next=(previewDocumentCounters.get(key)||0)+1;
  if(kind==='receipt')while(state.receipts.some(row=>(row.numberingSupplierId||row.supplierId)===scope&&row.documentNo?.toLocaleLowerCase()===format(next).toLocaleLowerCase()))next++;
  previewDocumentCounters.set(key,next);return format(next);
}
function previewPickupDocument(payload){
  const previous=pickupDocumentRows(payload.document_id),first=previous[0];
  state.pickups=state.pickups.filter(row=>(row.documentId||row.id)!==payload.document_id||payload.rows.some(line=>line.id===row.id));
  payload.rows.forEach(row=>{let existing=byId(state.pickups,row.id);if(!existing){existing={...first,id:uid(),requestId:'',requestRow:null,workAssignmentId:'',rowVersion:0};state.pickups.push(existing);}
    Object.assign(existing,{workLogId:existing.projectId===payload.project_id?existing.workLogId:'',date:payload.pickup_date,projectId:payload.project_id,customerId:payload.customer_id,itemId:row.inventory_item_id,quantity:row.quantity,note:row.note||'',rowVersion:existing.rowVersion+1});});
}
