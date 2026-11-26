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
 permit=true;modal.dataset.id='edit';assert.equal(c.transactionInlineItemsAllowed(),false);
});
test('work-log pickup dialog allows inline items although dataset.id holds the work log ID',()=>{
 let permit=true;const modal={dataset:{type:'workLogPickupModal',id:'log-1'}},c=vm.createContext({canModule:(module,action)=>permit&&module==='inventory'&&action==='CREATE',searchValue:e=>e.value,document:{addEventListener(){},querySelector:()=>modal}});
 vm.runInContext(readFileSync(new URL('../transaction-inline-items.js',import.meta.url),'utf8'),c);
 assert.equal(c.transactionInlineItemsAllowed(),true);
 assert.match(c.transactionNewItemButton(),/新增此品項/);
 permit=false;assert.equal(c.transactionInlineItemsAllowed(),false);assert.equal(c.transactionNewItemButton(),'');
 permit=true;for(const type of ['supplierReturnModal','workLogModal']){modal.dataset.type=type;modal.dataset.id='';assert.equal(c.transactionInlineItemsAllowed(),false,type);}
});
