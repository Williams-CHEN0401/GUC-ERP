/* Existing receipt and pickup ledgers, confirmed by one atomic server RPC. */
async function receiptMutation(operation,payload,message){
 if(PREVIEW_MODE)throw Error('進貨送達與庫存需由伺服器驗證，請使用隔離測試網站或正式系統。');
 if(typeof pinOpenFormVersion==='function')payload=pinOpenFormVersion(payload);
 if(typeof invalidateFormReferences==='function')invalidateFormReferences();
 const result=await apiRequest({operation,payload});loadedScopes.clear();
 try{await loadScope('transactions',{force:true});}catch(error){showToast(`資料已儲存，但清單更新失敗：${error.message}。請重新整理。`,'儲存成功，清單待更新');}
 if(message)showToast(message);
 return result;
}
function receiptSupplierSearchFields(){return '<label>品項範圍<select id="receiptItemSearchScope"><option value="supplier">供應商歷史品項</option><option value="all">所有有效貨品</option></select></label>';}
async function loadReceiptSupplierItems(){
 const form=document.querySelector('#modalForm');if(!form||receiptEditorKind()!=='receipt')return;
 const supplier=form.elements.supplierId?.value||'',generation=(form._supplierGeneration||0)+1;form._supplierGeneration=generation;
 form._supplierHistory={supplier,items:[],loading:!!supplier,error:''};renderTransactionItemSearch('receipt');if(!supplier)return;
 try{
  const result=await apiRequest({method:'GET',scope:'receipt_supplier_items',supplierId:supplier});
  if(form._supplierGeneration!==generation||form.elements.supplierId?.value!==supplier||document.querySelector('#simpleModal').dataset.type!=='receiptModal')return;
  form._supplierHistory={supplier,items:result.items||[],loading:false,error:''};
 }catch(error){if(form._supplierGeneration!==generation)return;form._supplierHistory={supplier,items:[],loading:false,error:error.message};}
 renderTransactionItemSearch('receipt');
}
function receiptSearchItems(query){
 const form=document.querySelector('#modalForm'),history=form?._supplierHistory;
 const active=state.inventory.filter(item=>state.categories.some(category=>category.id===item.categoryId&&category.active)&&matches([item.name,item.brand,item.model,item.code],query));
 if(document.querySelector('#receiptItemSearchScope')?.value==='all'){
  const rank=new Map((history?.items||[]).map((r,index)=>[r.inventory_item_id,index]));
  return active.sort((a,b)=>(rank.get(a.id)??Infinity)-(rank.get(b.id)??Infinity)||a.name.localeCompare(b.name,'zh-Hant'));
 }
 const byItem=new Map(active.map(item=>[item.id,item]));return (history?.items||[]).map(r=>byItem.get(r.inventory_item_id)).filter(Boolean);
}
function receiptSearchStatus(count,shown){
 const history=document.querySelector('#modalForm')?._supplierHistory,all=document.querySelector('#receiptItemSearchScope')?.value==='all';
 if(!all&&history?.loading)return '正在讀取供應商歷史品項…';
 if(!all&&history?.error)return `歷史品項載入失敗：${history.error}。可重新選擇供應商重試，或切換所有有效貨品。`;
 if(!all&&!history?.supplier)return '請先選擇供應商，或切換所有有效貨品。';
 return count?`${all?'所有有效貨品（供應商歷史優先）':'供應商歷史品項'}：${count} 筆${count>shown?'，先顯示 50 筆，請縮小關鍵字':''}。`:all?'沒有符合的有效貨品。':'沒有符合的歷史品項，可切換「所有有效貨品」選擇新採購品項。';
}
document.addEventListener('change',event=>{
 if(document.querySelector('#simpleModal')?.dataset.type!=='receiptModal')return;
 if(event.target.matches('#modalForm [name="supplierId"]')){const input=document.querySelector('#receiptItemSearch');if(input)input.value='';void loadReceiptSupplierItems();}
 if(event.target.id==='receiptItemSearchScope')renderTransactionItemSearch('receipt');
});
document.addEventListener('click',event=>{const button=event.target.closest('[data-receipt-delivery]');if(button){event.preventDefault();event.stopPropagation();void openReceiptDelivery(button.dataset.receiptDelivery);}});

async function openReceiptDelivery(id){
 const first=document.querySelector('#receiptDeliveryDialog'),site=document.querySelector('#receiptDeliverySiteDialog');
 const header=receiptHeader(id,'receipt');if(header&&header.delivery_state!=='pending'){showToast('這張進貨單已確認送達位置。');return;}
 first.dataset.documentId=id;first.querySelector('[data-delivery-error]').textContent='';
 first.querySelector('[data-delivery-number]').textContent=`進貨單：${receiptDocument(id)?.documentNo||id}`;
 first.querySelector('[name="deliveryDate"]').value=today();
 first.querySelector('[data-delivery-site]').disabled=!['customers','projects'].every(m=>canModule(m,'VIEW'))||!canModule('pickups','CREATE')||!canModule('pickups','VIEW');
 if(site.open)site.close();if(!first.open)first.showModal();
}
(()=>{
 const first=document.querySelector('#receiptDeliveryDialog'),site=document.querySelector('#receiptDeliverySiteDialog');if(!first||!site)return;
 let busy=false,options=null;
 const error=(d,message)=>d.querySelector('[data-delivery-error]').textContent=message;
 const setBusy=value=>{busy=value;for(const d of [first,site]){d.querySelector('fieldset').disabled=value;d.querySelectorAll('[data-delivery-back]').forEach(b=>b.disabled=value);}};
 const optionRows=(rows,value,label,placeholder)=>'<option value="">'+esc(placeholder)+'</option>'+rows.map(r=>`<option value="${esc(r.id)}" ${r.id===value?'selected':''}>${esc(label(r))}</option>`).join('');
 const fields=site.querySelector('form').elements;
 function choices(resetCustomer=false){
  const cid=resetCustomer?'':fields.customer.value,pid=fields.project.value;
  fields.customer.innerHTML=optionRows(options.customers.filter(c=>!fields.category.value||c.category===fields.category.value),cid,c=>c.name,'請選擇客戶');
  fields.project.innerHTML=optionRows(options.projects.filter(p=>p.customer_id===fields.customer.value),pid,p=>[p.code,p.name].filter(Boolean).join('｜'),'請選擇工作內容');
  fields.project.disabled=!fields.customer.value;
 }
 async function confirm(d,destination){
  if(busy||!d.querySelector('form').reportValidity())return;
  const form=d.querySelector('form');error(d,'');setBusy(true);
  try{
   const response=await receiptMutation('confirm_receipt_delivery',{document_id:d.dataset.documentId,destination,delivery_date:form.elements.deliveryDate.value,customer_id:destination==='site'?fields.customer.value:null,project_id:destination==='site'?fields.project.value:null},'');
   const result=response.result||response;d.close();showToast(destination==='site'?`已直送施工現場，取貨單 ${result.pickup_document_no} 已建立。`:'已確認公司入庫。');
  }catch(e){error(d,`未能確認送達同步結果：${e.message} 原進貨單已保留，請核對後重試；重試不會重複建立取貨。`);}
  finally{setBusy(false);}
 }
 for(const d of [first,site]){
  d.addEventListener('cancel',e=>e.preventDefault());
  d.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();}});
 }
 site.querySelector('[data-delivery-back]').addEventListener('click',()=>{if(busy)return;first.querySelector('[name="deliveryDate"]').value=fields.deliveryDate.value;site.close();first.showModal();});
 first.querySelector('form').addEventListener('submit',e=>{e.preventDefault();void confirm(first,'company');});
 site.querySelector('form').addEventListener('submit',e=>{e.preventDefault();void confirm(site,'site');});
 fields.category.addEventListener('change',()=>choices(true));fields.customer.addEventListener('change',()=>choices());
 first.querySelector('[data-delivery-site]').addEventListener('click',async()=>{
  if(busy||!first.querySelector('form').reportValidity())return;setBusy(true);error(first,'');
  try{
   options=await apiRequest({method:'GET',scope:'receipt_delivery_options'});
   site.dataset.documentId=first.dataset.documentId;error(site,'');
   fields.deliveryDate.value=first.querySelector('[name="deliveryDate"]').value;
   const header=receiptHeader(site.dataset.documentId,'receipt'),selected=options.projects.find(p=>p.id===header?.receipt_project_id),customer=options.customers.find(c=>c.id===selected?.customer_id);
   fields.category.innerHTML=optionRows([...new Set(options.customers.map(c=>c.category))].map(id=>({id})),customer?.category||'',r=>customerCategoryLabel(r.id),'全部客戶分類');
   choices(true);fields.customer.value=customer?.id||'';choices();fields.project.value=selected?.id||'';
   first.close();site.showModal();
  }catch(e){error(first,e.message);}
  finally{setBusy(false);}
 });
})();
