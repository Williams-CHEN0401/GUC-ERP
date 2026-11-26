/* New masters and their document are saved atomically by the existing gateway. */
function transactionInlineItemsAllowed(){
 const modal=document.querySelector('#simpleModal'),type=modal?.dataset.type;
 // Creating and editing receipt/pickup documents, plus work-log pickups, may add a missing item.
 // The gateway saves the item and the document in one transaction.
 return ['receiptModal','pickupModal','workLogPickupModal'].includes(type)&&canModule('inventory','CREATE');
}

function transactionNewItemButton(){
 if(!transactionInlineItemsAllowed())return '';
 return '<button class="outline" type="button" data-toggle-transaction-new-item aria-expanded="false">＋ 新增此品項</button>';
}

function transactionNewItemFields(){
 if(!transactionInlineItemsAllowed())return '';
 return '<div class="span-2" data-new-item-fields hidden><div class="form-grid"><label>新貨品品牌<input name="newItemBrand" maxlength="120" disabled></label><label>新貨品型號（選填）<input name="newItemModel" maxlength="120" disabled></label><label>新貨品單位<input name="newItemUnit" maxlength="30" value="台" disabled></label></div><small>儲存單據時一併建立品項；取貨可先登錄，再人工校正庫存。</small></div>';
}

function syncTransactionNewItem(row,current=row.querySelector('[data-batch-item]').value){
 const fields=row.querySelector('[data-new-item-fields]');
 if(!fields)return;

 const select=row.querySelector('[data-batch-item]');
 const name=row.querySelector('[data-batch-item-search]').value.trim();
 const category=row.querySelector('[data-batch-category]').value;
 const active=current==='__new__'&&Boolean(name&&category)&&transactionInlineItemsAllowed();
 let option=select.querySelector('option[value="__new__"]');
 if(active){
  if(!option){
   option=document.createElement('option');
   option.value='__new__';
   select.append(option);
  }
  option.textContent='新增品項：'+name;
  select.value=option.value;
 }else{
  option?.remove();
 }

 const button=row.querySelector('[data-toggle-transaction-new-item]');
 const buttonText=active?'取消新增品項':'＋ 新增此品項';
 if(button.textContent!==buttonText)button.textContent=buttonText;
 button.setAttribute('aria-expanded',String(active));
 fields.hidden=!active;
 for(const input of fields.querySelectorAll('input')){
  input.disabled=!active;
  input.required=active&&input.name!=='newItemModel';
 }

 if(active){
  const unit=row.querySelector('[name=batchQuantityUnit]');
  unit.value='package';
  unit.options[0].textContent=fields.querySelector('[name=newItemUnit]').value||'原單位';
  unit.options[1].disabled=true;
  unit.options[1].hidden=true;
  const quantity=row.querySelector('[name=batchQuantity]');
  quantity.min='1';
  quantity.step='1';
  syncRemnantPickup(row,null,'package');
 }
}

function collectTransactionNewItem(row){
 if(row.querySelector('[data-batch-item]').value!=='__new__')return null;
 if(!transactionInlineItemsAllowed())throw Error('沒有新增品項權限，請選擇既有品項。');
 const item={
  category_id:row.querySelector('[data-batch-category]').value,
  item_name:row.querySelector('[data-batch-item-search]').value.trim(),
  brand:row.querySelector('[name=newItemBrand]').value.trim(),
  model:row.querySelector('[name=newItemModel]').value.trim(),
  unit:row.querySelector('[name=newItemUnit]').value.trim(),
 };
 if(!item.item_name||!item.brand||!item.unit)throw Error('請填寫新貨品名稱、品牌及單位。');
 return item;
}

document.addEventListener('click',event=>{
 const button=event.target.closest('[data-toggle-transaction-new-item]');
 if(!button||!transactionInlineItemsAllowed())return;
 const row=button.closest('[data-batch-row]');
 if(row.querySelector('[data-batch-item]').value==='__new__'){
  syncTransactionNewItem(row,'');
  syncCablePickupUnit(row);
  return;
 }

 const category=row.querySelector('[data-batch-category]');
 if(!category.value){
  category.focus();
  showToast('請先選擇貨品種類。');
  return;
 }

 const name=row.querySelector('[data-batch-item-search]');
 // Read the field directly so tapping does not depend on the last IME input event.
 if(!name.value.trim()){
  name.focus();
  showToast('請輸入品項名稱。');
  return;
 }
 syncTransactionNewItem(row,'__new__');
});

document.addEventListener('change',event=>{
 const row=event.target.closest('[data-batch-row]');
 if(row&&event.target.matches('[data-batch-item]'))syncTransactionNewItem(row);
});

document.addEventListener('input',event=>{
 const row=event.target.closest('[data-batch-row]');
 if(!row)return;
 if(event.target.matches('[data-batch-item-search]')){
  const choice=row.querySelector('[data-batch-item]');
  if(choice.value!=='__new__')choice.value='';
  syncBatchItemOptions(row);
  syncCablePickupUnit(row);
 }
 if(event.target.matches('[name=newItemUnit]')&&row.querySelector('[data-batch-item]').value==='__new__'){
  const unitOption=row.querySelector('[name=batchQuantityUnit]').options[0];
  unitOption.textContent=event.target.value||'原單位';
 }
});
