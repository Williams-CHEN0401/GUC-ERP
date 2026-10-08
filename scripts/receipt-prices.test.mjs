import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../receipt-documents.js',import.meta.url),'utf8');
function fixture(permissions){
 const context=vm.createContext({document:{addEventListener:()=>{}},esc:value=>String(value),canModule:(_,action)=>permissions.includes(action)});
 vm.runInContext(source,context);return context;
}
test('receipt price UI denies hidden/readonly writes and keeps unrelated fields untouched',()=>{
 const noView=fixture([]),view=fixture(['VIEW']),edit=fixture(['VIEW','CREATE','UPDATE','DELETE']);
 assert.equal(noView.receiptPriceField({unitPrice:12}),'');
 assert.match(view.receiptPriceField({unitPrice:12}),/readonly/);
 assert.doesNotMatch(view.receiptPriceField({unitPrice:12}),/data-clear-receipt-price/);
 assert.match(edit.receiptPriceField({unitPrice:12}),/data-clear-receipt-price/);
 const row=(value,originalPrice)=>({querySelector:()=>({value,dataset:{originalPrice}})});
 assert.equal(Object.keys(noView.receiptPricePayload({querySelector:()=>null})).length,0);
 assert.equal(Object.keys(view.receiptPricePayload(row('12','12'))).length,0);
 assert.throws(()=>view.receiptPricePayload(row('13','12')),/權限/);
 assert.equal(edit.receiptPricePayload(row('12.25','')).unit_price,12.25);
 assert.equal(edit.receiptPricePayload(row('','12')).unit_price,null);
 for(const value of ['-1','0.123','NaN','1000000000000'])assert.throws(()=>edit.receiptPricePayload(row(value,'')),/單價/);
});
