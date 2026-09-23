import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function harness(){
 const inventory=[{id:'a',categoryId:'one',name:'光纖測試器',brand:'ACME',model:'F1',code:'Z2'},{id:'b',categoryId:'two',name:'網路測試器',brand:'B',model:'LAN',code:'A1'},{id:'off',categoryId:'off',name:'停用品',code:'OFF'}];
 const rows=[],notices=[],status={textContent:''};
 const makeRow=(item='',quantity='4')=>{const fields={'[data-batch-item]':{value:item},'[data-batch-category]':{value:''},'[name="batchQuantity"]':{value:quantity,focus(){}}};return {querySelector:s=>fields[s]};};
 rows.push(makeRow());
 const container={children:rows,querySelectorAll:()=>rows,get lastElementChild(){return rows.at(-1);}};
 const c=vm.createContext({state:{inventory,categories:[{id:'one',active:true},{id:'two',active:true},{id:'off',active:false}]},document:{querySelector:s=>s==='#transactionBatchRows'?container:status,addEventListener(){}},MAX_BATCH_ROWS:3,showToast:s=>notices.push(s),syncBatchItemOptions(){},addTransactionBatchRow(){rows.push(makeRow('','1'));}});
 for(const name of ['byId','valueText','matches','sortRows','pickupSearchItems'])vm.runInContext(app.split(/\r?\n/).find(line=>line.startsWith('function '+name+'(')),c);
 vm.runInContext(app.slice(app.indexOf('function choosePickupSearchItem('),app.indexOf('document.addEventListener("input",event=>{if(event.target.id==="pickupItemSearch")')),c);
 return {c,rows,notices,status};
}
test('search is below pickup rows in both entry forms, never inside pickup item label',()=>{
 for(const type of ['pickupModal','workLogPickupModal']){
  const line=app.split(/\r?\n/).find(line=>line.includes('if(type==="'+type+'")'));
  assert.ok(line.indexOf('取貨明細')<line.indexOf('pickupItemSearchFields()'));
 }
 assert.ok(app.includes('品項${type==="receipt"?'));
});
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
