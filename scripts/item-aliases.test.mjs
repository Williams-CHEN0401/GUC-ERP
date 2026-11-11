import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8'),aliases=fs.readFileSync(new URL('../item-aliases.js',import.meta.url),'utf8');
function setup(){
 const c=vm.createContext({state:{inventory:[{id:'one',categoryId:'c',name:'感應磁扣',code:'A001',unit:'個'},{id:'two',categoryId:'c',name:'無對照品項',code:'A002',unit:'個'}],categories:[{id:'c',active:true}],itemAliases:[{inventory_item_id:'one',supplier_id:'s1',supplier_name:'元盛電子',supplier_item_name:'Mifare Standard',supplier_sku:'MF-01',status:'confirmed',specification:'<script>'},{inventory_item_id:'one',supplier_id:'s2',supplier_name:'第二供應商',supplier_item_name:'Key Ring',status:'pending'},{inventory_item_id:'one',supplier_id:'s1',supplier_item_name:'停用別名',status:'inactive'}]}});
 vm.runInContext(aliases.slice(0,aliases.indexOf('(()=>{')),c);
 vm.runInContext(['esc','valueText','matches','sortRows','pickupSearchItems','inventoryItemOptions'].map(name=>app.split('\n').find(line=>line.startsWith('function '+name+'('))).join('\n'),c);return c;
}
test('ERP and supplier names, SKU and supplier name identify the same existing item without writes',()=>{
 const c=setup(),before=JSON.stringify(c.state);
 for(const term of ['感應磁扣','mifare standard','MF-01','元盛電子','Key Ring'])assert.deepEqual(Array.from(c.pickupSearchItems(term),i=>i.id),['one']);
 assert.deepEqual(Array.from(c.pickupSearchItems('無對照'),i=>i.id),['two']);assert.equal(JSON.stringify(c.state),before);
 assert(c.inventoryItemOptions('c','','Mifare').includes('value="one"'));
});
test('supplier display is scoped, pending stays explicit, inactive aliases cannot participate in search',()=>{
 const c=setup();assert.deepEqual(Array.from(c.itemAliasRows('one','s1'),a=>a.supplier_item_name),['Mifare Standard']);
 assert.equal(c.pickupSearchItems('停用別名').length,0);assert(c.itemAliasSummary('one','s2').includes('待確認'));
 assert(!c.itemAliasSummary('one','s1').includes('<script>'));assert(c.itemAliasSummary('one','s1').includes('&lt;script&gt;'));
});
