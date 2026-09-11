function receiptCustomerPicker(selected=[]){
 const initialCategory=byId(state.customers,selected[0])?.category||'';
 return `<fieldset class="receipt-customers span-2"><legend>訂貨客戶</legend><div class="permission-toolbar"><label>客戶分類<select id="receiptCustomerCategory"><option value="">請選擇分類</option>${CUSTOMER_CATEGORIES.map(([code,name])=>`<option value="${code}" ${code===initialCategory?'selected':''}>${name}</option>`).join('')}</select></label><label>搜尋客戶<input type="search" id="receiptCustomerSearch" placeholder="編號或名稱"></label><button type="button" class="outline" data-receipt-customers-select>全選目前分類</button><button type="button" class="outline" data-receipt-customers-clear>清空選擇</button></div><output id="receiptCustomerCount">已選 ${selected.length} 位</output><div class="receipt-customer-list">${state.customers.map(c=>`<label hidden data-receipt-customer data-category="${esc(c.category)}" data-search="${esc((c.code+' '+c.name).toLocaleLowerCase('zh-Hant'))}"><input type="checkbox" name="receiptCustomerId" value="${esc(c.id)}" ${selected.includes(c.id)?'checked':''}><span>${esc(c.code)}｜${esc(c.name)}</span></label>`).join('')}</div><p id="receiptCustomerEmpty" class="form-sync-hint" hidden></p><div id="receiptCustomerSelected">${selected.map(id=>esc(byId(state.customers,id)?.name||'')).filter(Boolean).join('、')}</div></fieldset>`;
}
function refreshReceiptCustomerPicker(){
 const form=document.querySelector('#modalForm');if(!form)return;
 const category=form.querySelector('#receiptCustomerCategory')?.value||'',search=form.querySelector('#receiptCustomerSearch')?.value.trim().toLocaleLowerCase('zh-Hant')||'',rows=[...form.querySelectorAll('[data-receipt-customer]')];
 rows.forEach(row=>row.hidden=!category||row.dataset.category!==category||!row.dataset.search.includes(search));
 const visibleCount=rows.filter(row=>!row.hidden).length,empty=form.querySelector('#receiptCustomerEmpty');if(empty){empty.hidden=visibleCount>0;empty.textContent=!category?'請先選擇客戶分類。':search?'沒有符合搜尋條件的客戶。':'此分類目前沒有客戶。';}
 const selected=[...form.querySelectorAll('input[name=receiptCustomerId]:checked')];
 const count=form.querySelector('#receiptCustomerCount'),names=form.querySelector('#receiptCustomerSelected');if(count)count.textContent=`已選 ${selected.length} 位`;if(names)names.textContent=selected.map(input=>byId(state.customers,input.value)?.name||'').filter(Boolean).join('、');
}
document.addEventListener('change',event=>{if(event.target.id==='receiptCustomerCategory')document.querySelectorAll('input[name=receiptCustomerId]:checked').forEach(input=>{if(byId(state.customers,input.value)?.category!==event.target.value)input.checked=false;});if(event.target.id==='receiptCustomerCategory'||event.target.name==='receiptCustomerId')refreshReceiptCustomerPicker();});
document.addEventListener('input',event=>{if(event.target.id==='receiptCustomerSearch')refreshReceiptCustomerPicker();});
document.addEventListener('click',event=>{
 if(event.target.closest('[data-receipt-customers-select]'))document.querySelectorAll('[data-receipt-customer]:not([hidden]) input').forEach(input=>input.checked=true);
 else if(event.target.closest('[data-receipt-customers-clear]'))document.querySelectorAll('input[name=receiptCustomerId]').forEach(input=>input.checked=false);else return;
 refreshReceiptCustomerPicker();
});
