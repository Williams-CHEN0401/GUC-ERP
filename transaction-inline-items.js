/* New masters and their document are saved atomically by the existing gateway. */
function transactionInlineItemsAllowed(){
 const modal=document.querySelector('#simpleModal');
 return !modal?.dataset.id&&['receiptModal','pickupModal','workLogPickupModal'].includes(modal?.dataset.type)&&canModule('inventory','CREATE');
}
function transactionNewItemFields(){
 if(!transactionInlineItemsAllowed())return '';
 return '<div class="span-2" data-new-item-fields hidden><div class="form-grid"><label>新貨品品牌<input name="newItemBrand" maxlength="120" disabled></label><label>新貨品型號（選填）<input name="newItemModel" maxlength="120" disabled></label><label>新貨品單位<input name="newItemUnit" maxlength="30" value="台" disabled></label></div><small>儲存單據時一併建立品項；取貨可先登錄，再人工校正庫存。</small></div>';
}
function syncTransactionNewItem(row,current=row.querySelector('[data-batch-item]').value){
 const select=row.querySelector('[data-batch-item]'),fields=row.querySelector('[data-new-item-fields]'),name=searchValue(row.querySelector('[data-batch-item-search]')).trim();
 if(!fields)return;
 const category=row.querySelector('[data-batch-category]').value;
 if(name&&category&&transactionInlineItemsAllowed()&&!select.querySelector('option[value="__new__"]')){
  const option=document.createElement('option');option.value='__new__';option.textContent='＋ 新增品項：'+name;select.append(option);
 }
 if(current==='__new__'&&name&&category)select.value='__new__';
 const active=select.value==='__new__';fields.hidden=!active;
 fields.querySelectorAll('input').forEach(input=>{input.disabled=!active;input.required=active&&input.name!=='newItemModel';});
 if(active){const unit=row.querySelector('[name=batchQuantityUnit]');unit.value='package';unit.options[0].textContent=fields.querySelector('[name=newItemUnit]').value||'原單位';unit.options[1].disabled=true;unit.options[1].hidden=true;}
}
function collectTransactionNewItem(row){
 if(row.querySelector('[data-batch-item]').value!=='__new__')return null;
 if(!transactionInlineItemsAllowed())throw Error('沒有新增品項權限，請選擇既有品項。');
 const item={category_id:row.querySelector('[data-batch-category]').value,item_name:searchValue(row.querySelector('[data-batch-item-search]')).trim(),brand:row.querySelector('[name=newItemBrand]').value.trim(),model:row.querySelector('[name=newItemModel]').value.trim(),unit:row.querySelector('[name=newItemUnit]').value.trim()};
 if(!item.item_name||!item.brand||!item.unit)throw Error('請填寫新貨品名稱、品牌及單位。');
 return item;
}
document.addEventListener('change',event=>{const row=event.target.closest('[data-batch-row]');if(row&&event.target.matches('[data-batch-item],[name=newItemUnit]'))syncTransactionNewItem(row);});
document.addEventListener('input',event=>{const row=event.target.closest('[data-batch-row]');if(!row)return;if(event.target.matches('[data-batch-item-search]')){const choice=row.querySelector('[data-batch-item]');if(choice.value!=='__new__')choice.value='';syncBatchItemOptions(row);syncCablePickupUnit(row);}if(event.target.matches('[name=newItemUnit]'))syncTransactionNewItem(row);});
