import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const receipts=readFileSync(new URL('../receipt-documents.js',import.meta.url),'utf8');
function harness(){
 const inventory=[{id:'a',categoryId:'one',name:'光纖測試器',brand:'ACME',model:'F1',code:'Z2'},{id:'b',categoryId:'two',name:'網路測試器',brand:'B',model:'LAN',code:'A1'},{id:'off',categoryId:'off',name:'停用品',code:'OFF'}];
 const rows=[],notices=[],status={textContent:''},input={value:''},results={innerHTML:''},events={},addedTypes=[];
 const makeRow=(item='',quantity='4')=>{const fields={'[data-batch-item]':{value:item},'[data-batch-category]':{value:''},'[name="batchNote"]':{value:'保留備註'},'[name="batchQuantity"]':{value:quantity,focus(){this.focused=true;}}};return {querySelector:s=>fields[s]};};
 rows.push(makeRow());
 const container={children:rows,querySelectorAll:()=>rows,get lastElementChild(){return rows.at(-1);}};
 const c=vm.createContext({state:{inventory,categories:[{id:'one',active:true},{id:'two',active:true},{id:'off',active:false}]},document:{querySelector:s=>s==='#transactionBatchRows'?container:s.endsWith('Results')?results:s.endsWith('Status')?status:input,addEventListener(name,fn){events[name]=fn;}},MAX_BATCH_ROWS:3,canModule:()=>true,showToast:s=>notices.push(s),syncBatchItemOptions(){},addTransactionBatchRow(type){addedTypes.push(type);rows.push(makeRow('','1'));}});
 for(const name of ['esc','byId','valueText','matches','sortRows'])vm.runInContext(app.split(/\r?\n/).find(line=>line.startsWith('function '+name+'(')),c);
 vm.runInContext(app.slice(app.indexOf('function transactionItemSearchFields('),app.indexOf('function itemBatchRow(')),c);
 return {c,rows,notices,status,input,results,events,addedTypes};
}
test('search is below pickup rows in both entry forms, never inside pickup item label',()=>{
 for(const type of ['pickupModal','workLogPickupModal']){
  const line=app.split(/\r?\n/).find(line=>line.includes('if(type==="'+type+'")'));
  assert.ok(line.indexOf('取貨明細')<line.indexOf('pickupItemSearchFields()'));
 }
 const rowSource=app.split(/\r?\n/).find(line=>line.startsWith('function transactionBatchRow('));
 assert.ok(!rowSource.includes('type="search"'));
 const receiptFields=receipts.slice(receipts.indexOf('function receiptDocumentFields('),receipts.indexOf('function initializeReceiptDocument('));
 assert.ok(receiptFields.indexOf('進貨明細')<receiptFields.indexOf("transactionItemSearchFields('receipt')"));
 assert.ok(receiptFields.indexOf("transactionItemSearchFields('receipt')")<receiptFields.indexOf('receiptCustomerPicker('));
 const {c}=harness();
 assert.equal(c.transactionItemSearchFields('receipt').replaceAll('receipt','pickup').replaceAll('進貨','取貨'),c.pickupItemSearchFields());
});

test('receipt search fills category and item, preserves quantity/notes, appends receipt rows and focuses duplicates',()=>{
 const {c,rows,notices,status,addedTypes}=harness();
 c.chooseTransactionSearchItem('receipt','a');
 assert.equal(rows[0].querySelector('[data-batch-item]').value,'a');
 assert.equal(rows[0].querySelector('[data-batch-category]').value,'one');
 assert.equal(rows[0].querySelector('[name="batchQuantity"]').value,'4');
 assert.equal(rows[0].querySelector('[name="batchNote"]').value,'保留備註');
 assert.match(status.textContent,/第 1 列/);
 c.chooseTransactionSearchItem('receipt','b');
 assert.deepEqual(addedTypes,['receipt']);assert.equal(rows.length,2);
 assert.equal(rows[1].querySelector('[data-batch-item]').value,'b');
 assert.equal(rows[1].querySelector('[data-batch-category]').value,'two');
 assert.equal(rows[1].querySelector('[name="batchQuantity"]').value,'1');
 c.chooseTransactionSearchItem('receipt','a');c.chooseTransactionSearchItem('receipt','off');c.chooseTransactionSearchItem('receipt','missing');
 assert.equal(rows.length,2);assert.match(notices[0],/已在進貨明細/);
 assert.equal(rows[0].querySelector('[name="batchQuantity"]').focused,true);
});

test('receipt search respects row cap and CREATE permission, without overwriting an existing line',()=>{
 const {c,rows,notices}=harness();c.chooseTransactionSearchItem('receipt','a');
 c.MAX_BATCH_ROWS=1;c.chooseTransactionSearchItem('receipt','b');
 assert.equal(rows.length,1);assert.match(notices.pop(),/最多/);
 c.MAX_BATCH_ROWS=3;c.canModule=()=>false;c.chooseTransactionSearchItem('receipt','b');
 assert.equal(rows.length,1);assert.match(notices.pop(),/沒有新增進貨/);
 assert.equal(rows[0].querySelector('[data-batch-item]').value,'a');
 // UPDATE-only users can replace an existing row after clearing its selection.
 rows[0].querySelector('[data-batch-item]').value='';c.chooseTransactionSearchItem('receipt','b');
 assert.equal(rows[0].querySelector('[data-batch-item]').value,'b');
});

for(const type of ['pickup','receipt']){
 test(`${type}: input/Enter and reference refresh render results without submitting; empty, no match and result cap`,()=>{
  const {c,input,results,status,events}=harness();let prevented=0;
  const target={id:type+'ItemSearch'};
  events.input({target});assert.equal(results.innerHTML,'');assert.match(status.textContent,/輸入關鍵字/);
  input.value='LAN';events.input({target});assert.match(results.innerHTML,new RegExp('data-'+type+'-search-item="b"'));assert.match(status.textContent,/找到 1 筆/);
  events.keydown({target,key:'Enter',isComposing:false,preventDefault(){prevented++;}});assert.equal(prevented,1);
  events.keydown({target,key:'Enter',isComposing:true,preventDefault(){prevented++;}});assert.equal(prevented,1);
  input.value='not-present';events.input({target});assert.equal(results.innerHTML,'');assert.match(status.textContent,/沒有符合/);
  input.value='大量';c.state.inventory=Array.from({length:51},(_,i)=>({id:String(i),categoryId:'one',name:'大量'+i}));
  c.renderTransactionItemSearch(type);assert.equal((results.innerHTML.match(/<button /g)||[]).length,50);assert.match(status.textContent,/共 51 筆/);
  c.state.inventory=[];events['guc:form-references-updated']();assert.equal(results.innerHTML,'');
 });
 test(`${type}: click event uses its own result identifier`,()=>{
  const {events,rows}=harness();events.click({target:{closest:selector=>selector===`[data-${type}-search-item]`?{dataset:{[type+'SearchItem']:'b'}}:null}});
  assert.equal(rows[0].querySelector('[data-batch-item]').value,'b');
 });
}
test('search matches across active categories by name/brand/model/code; empty query stays empty',()=>{
 const {c}=harness();
 assert.deepEqual(Array.from(c.pickupSearchItems('測試器'),item=>item.id),['a','b']);
 assert.equal(c.pickupSearchItems(' acme ')[0].id,'a');
 assert.equal(c.pickupSearchItems('LAN')[0].id,'b');
 assert.equal(c.pickupSearchItems('A1')[0].id,'b');
 assert.equal(c.pickupSearchItems('OFF').length,0);
 assert.equal(c.pickupSearchItems(' ').length,0);
});
test('click fills first blank preserving quantity; subsequent item appends; duplicate and inactive IDs do not overwrite',()=>{
 const {c,rows,notices}=harness();
 c.choosePickupSearchItem('a');
 assert.equal(rows[0].querySelector('[data-batch-item]').value,'a');
 assert.equal(rows[0].querySelector('[data-batch-category]').value,'one');
 assert.equal(rows[0].querySelector('[name="batchQuantity"]').value,'4');
 c.choosePickupSearchItem('b');assert.equal(rows.length,2);
 assert.equal(rows[1].querySelector('[data-batch-category]').value,'two');
 assert.equal(rows[1].querySelector('[data-batch-item]').value,'b');
 c.choosePickupSearchItem('a');c.choosePickupSearchItem('off');c.choosePickupSearchItem('missing');
 assert.equal(rows.length,2);assert.match(notices[0],/已在取貨明細/);
});
test('maximum rows is enforced without replacing completed selections',()=>{
 const {c,rows,notices}=harness();
 c.MAX_BATCH_ROWS=1;c.choosePickupSearchItem('a');c.choosePickupSearchItem('b');
 assert.equal(rows.length,1);assert.equal(rows[0].querySelector('[data-batch-item]').value,'a');assert.match(notices[0],/最多/);
});
