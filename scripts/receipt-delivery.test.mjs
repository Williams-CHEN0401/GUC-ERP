import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function setup() {
  const form={elements:{supplierId:{value:'supplier-a'}},draft:[{item:'existing',quantity:7,price:12.5}]};
  const modal={dataset:{type:'receiptModal'}},scope={value:'supplier'},requests=[];
  const context=vm.createContext({document:{addEventListener(){},querySelector(selector){return selector==='#modalForm'?form:selector==='#simpleModal'?modal:selector==='#receiptItemSearchScope'?scope:null;}},state:{inventory:[],categories:[]},receiptEditorKind:()=> 'receipt',renderTransactionItemSearch(){},apiRequest:()=>new Promise(resolve=>requests.push(resolve)),matches:(parts,q)=>parts.some(p=>String(p||'').includes(q))});
  vm.runInContext(fs.readFileSync(new URL('../receipt-delivery.js',import.meta.url),'utf8'),context);
  return {context,form,scope,requests};
}
test('a slow previous supplier response cannot replace the current supplier or entered lines',async()=>{
  const {context,form,requests}=setup();
  const draft=JSON.stringify(form.draft),first=context.loadReceiptSupplierItems();
  form.elements.supplierId.value='supplier-b';const second=context.loadReceiptSupplierItems();
  requests[1]({items:[{inventory_item_id:'b'}]});await second;
  requests[0]({items:[{inventory_item_id:'a'}]});await first;
  assert.equal(form._supplierHistory.supplier,'supplier-b');
  assert.deepEqual(form._supplierHistory.items,[{inventory_item_id:'b'}]);
  assert.equal(JSON.stringify(form.draft),draft);
});
test('all-items fallback retains supplier priority and excludes inactive categories',()=>{
  const {context,form,scope}=setup();
  context.state.categories=[{id:'active',active:true},{id:'old',active:false}];
  context.state.inventory=[{id:'new',name:'新貨品',categoryId:'active'},{id:'history',name:'歷史貨品',categoryId:'active'},{id:'inactive',name:'停用貨品',categoryId:'old'}];
  form._supplierHistory={items:[{inventory_item_id:'history'},{inventory_item_id:'inactive'}]};
  assert.deepEqual(Array.from(context.receiptSearchItems(''),r=>r.id),['history']);
  scope.value='all';assert.deepEqual(Array.from(context.receiptSearchItems(''),r=>r.id),['history','new']);
  assert.deepEqual(Array.from(context.receiptSearchItems('新'),r=>r.id),['new']);
});
