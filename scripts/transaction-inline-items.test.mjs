import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {buildErpExport} from '../supabase/functions/inventory-gateway/export-lists.ts';
test('inventory filtered export includes active aliases and respects category with partial columns',()=>{
 const data={categories:[{id:'c',name:'弱電線材'},{id:'d',name:'監控設備'}],items:[{id:'i',category_id:'c',item_name:'CAT-6',unit:'箱'},{id:'j',category_id:'d',item_name:'Camera'}],item_aliases:[{inventory_item_id:'i',supplier_item_name:'六類網路線',supplier_sku:'ABC-6',status:'confirmed'},{inventory_item_id:'j',supplier_item_name:'六類網路線',status:'inactive'}]};
 const run=filters=>buildErpExport({resource:'inventory',scope:'filtered',columns:['name'],filters},data,false);
 assert.deepEqual(run({q:'六類網路線',category_name:'弱電線材'}).rows,[['CAT-6']]);
 assert.equal(run({q:'六類網路線',category_name:'監控設備'}).row_count,0);
 assert.deepEqual(run({q:'abc-6'}).rows,[['CAT-6']]);
});
test('personnel export separates 4 person-times from 2 days and does not require all columns',()=>{
 const data={reports:[{project:{name:'工程'},workerStats:[{id:'subcontractor',name:'代工',constructionDays:2,personCount:4}]}]};
 assert.deepEqual(buildErpExport({resource:'report_personnel',scope:'filtered',columns:['name','person_count','days'],filters:{}},data,false).rows,[['代工',4,2]]);
});
test('inline item keeps existing rows untouched and requires existing inventory CREATE permission',()=>{
 let permit=true;const modal={dataset:{type:'pickupModal',id:''}},c=vm.createContext({canModule:()=>permit,searchValue:e=>e.value,document:{addEventListener(){},querySelector:()=>modal}});
 vm.runInContext(readFileSync(new URL('../transaction-inline-items.js',import.meta.url),'utf8'),c);
 const values={'[data-batch-item]':'__new__','[data-batch-category]':'c','[data-batch-item-search]':' 新品項 ','[name=newItemBrand]':'品牌','[name=newItemModel]':'','[name=newItemUnit]':'台'};
 const row={querySelector:s=>({value:values[s]})};assert.equal(c.collectTransactionNewItem(row).item_name,'新品項');
 permit=false;assert.throws(()=>c.collectTransactionNewItem(row),/權限/);values['[data-batch-item]']='existing';assert.equal(c.collectTransactionNewItem(row),null);
 permit=true;modal.dataset.id='edit';assert.equal(c.transactionInlineItemsAllowed(),true);
 for(const type of ['receiptModal','pickupModal']){modal.dataset.type=type;assert.equal(c.transactionInlineItemsAllowed(),true,type);}
 permit=false;assert.equal(c.transactionInlineItemsAllowed(),false);
});
test('edited pickup and receipt documents send the new item and keep existing line IDs',async()=>{
 const newItem={category_id:'c',item_name:'新品項',brand:'品牌',model:null,unit:'台'};
 const rows=[{itemId:'item-1',quantity:2,note:'原列',quantityUnit:'package'},{itemId:'__new__',newItem,quantity:3,note:'',quantityUnit:'package'}];
 const elements=[{dataset:{pickupId:'line-1',receiptId:'line-1'}},{dataset:{}}];
 const calls=[];
 const c=vm.createContext({document:{addEventListener(){}},esc:String,canModule:()=>true,collectTransactionBatchRows:()=>rows,uid:()=>'request',
  FormData:class{getAll(){return []}},receiptMutation:async(operation,payload)=>{calls.push([operation,payload]);return {};},mutate:async()=>({})});
 vm.runInContext(readFileSync(new URL('../receipt-documents.js',import.meta.url),'utf8'),c);
 // Unrelated receipt header/price helpers are covered by their own tests.
 Object.assign(c,{collectReceiptCustomerDepartments:()=>[],receiptMetadataPayload:()=>({}),receiptPricePayload:()=>({})});
 const form={querySelectorAll:()=>elements,_pickupDocument:{id:'doc-p',existing:[{id:'line-1',row_version:4}]},
  _receiptDocument:{kind:'receipt',id:'doc-r',existing:[{id:'line-1',row_version:2}]}};
 const pickup=c.pickupDocumentPayload(form,{date:'2026-11-26',projectId:'p',customerId:'cu'});
 assert.equal(pickup.rows[0].id,'line-1');assert.equal(pickup.rows[0].inventory_item_id,'item-1');assert.equal(Object.hasOwn(pickup.rows[0],'new_item'),false);
 assert.equal(pickup.rows[1].id,null);assert.equal(pickup.rows[1].inventory_item_id,null);assert.deepEqual(JSON.parse(JSON.stringify(pickup.rows[1].new_item)),newItem);
 await c.saveReceiptDocument(form,'doc-r',{date:'2026-11-26',supplierId:'s',documentNo:'A1'});
 const [operation,receipt]=calls[0];assert.equal(operation,'update_stock_receipt_document');
 assert.equal(receipt.rows[0].id,'line-1');assert.equal(receipt.rows[1].inventory_item_id,null);assert.equal(receipt.rows[1].new_item.item_name,'新品項');
});
test('work-log pickup dialog allows inline items although dataset.id holds the work log ID',()=>{
 let permit=true;const modal={dataset:{type:'workLogPickupModal',id:'log-1'}},c=vm.createContext({canModule:(module,action)=>permit&&module==='inventory'&&action==='CREATE',searchValue:e=>e.value,document:{addEventListener(){},querySelector:()=>modal}});
 vm.runInContext(readFileSync(new URL('../transaction-inline-items.js',import.meta.url),'utf8'),c);
 assert.equal(c.transactionInlineItemsAllowed(),true);
 assert.match(c.transactionNewItemButton(),/新增此品項/);
 permit=false;assert.equal(c.transactionInlineItemsAllowed(),false);assert.equal(c.transactionNewItemButton(),'');
 permit=true;for(const type of ['supplierReturnModal','workLogModal']){modal.dataset.type=type;modal.dataset.id='';assert.equal(c.transactionInlineItemsAllowed(),false,type);}
});
