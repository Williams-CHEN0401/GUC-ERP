function receiptCustomerPicker(selected=[]){
 return `<fieldset class="receipt-customers span-2"><legend>訂貨客戶</legend><div class="permission-toolbar"><label>客戶分類<select id="receiptCustomerCategory"><option value="">請選擇分類</option>${CUSTOMER_CATEGORIES.map(([code,name])=>`<option value="${code}">${name}</option>`).join('')}</select></label><label>搜尋客戶<input type="search" id="receiptCustomerSearch" placeholder="編號或名稱"></label><button type="button" class="outline" data-receipt-customers-select>全選目前分類</button><button type="button" class="outline" data-receipt-customers-clear>清空選擇</button></div><output id="receiptCustomerCount">已選 ${selected.length} 位</output><div class="receipt-customer-list">${state.customers.map(c=>`<label hidden data-receipt-customer data-category="${esc(c.category)}" data-search="${esc((c.code+' '+c.name).toLowerCase())}"><input type="checkbox" name="receiptCustomerId" value="${c.id}" ${selected.includes(c.id)?'checked':''}>${esc(c.code)}｜${esc(c.name)}</label>`).join('')}</div><div id="receiptCustomerSelected">${selected.map(id=>esc(byId(state.customers,id)?.name||'')).join('、')}</div></fieldset>`;
}
function refreshReceiptCustomerPicker(){
 const category=document.querySelector('#receiptCustomerCategory')?.value||'',search=document.querySelector('#receiptCustomerSearch')?.value.trim().toLowerCase()||'';
 document.querySelectorAll('[data-receipt-customer]').forEach(row=>row.hidden=!category||row.dataset.category!==category||!row.dataset.search.includes(search));
 const selected=[...document.querySelectorAll('input[name=receiptCustomerId]:checked')];
 const count=document.querySelector('#receiptCustomerCount'),names=document.querySelector('#receiptCustomerSelected');if(count)count.textContent=`已選 ${selected.length} 位`;if(names)names.textContent=selected.map(input=>byId(state.customers,input.value)?.name||'').join('、');
}
document.addEventListener('change',event=>{if(event.target.id==='receiptCustomerCategory'||event.target.name==='receiptCustomerId')refreshReceiptCustomerPicker();});
document.addEventListener('input',event=>{if(event.target.id==='receiptCustomerSearch')refreshReceiptCustomerPicker();});
document.addEventListener('click',event=>{
 if(event.target.closest('[data-receipt-customers-select]'))document.querySelectorAll('[data-receipt-customer]:not([hidden]) input').forEach(input=>input.checked=true);
 else if(event.target.closest('[data-receipt-customers-clear]'))document.querySelectorAll('input[name=receiptCustomerId]').forEach(input=>input.checked=false);else return;
 refreshReceiptCustomerPicker();
});
