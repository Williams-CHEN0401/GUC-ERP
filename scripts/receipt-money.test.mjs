import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const c=vm.createContext({});vm.runInContext(readFileSync(new URL('../receipt-money.js',import.meta.url),'utf8'),c);
const money=(lines,mode,rate)=>JSON.parse(JSON.stringify(c.GUCReceiptMoney.calculate(lines,mode,rate)));
test('exclusive and inclusive modes do not compound tax when switching',()=>{
 const lines=[{quantity:2,unit_price:3000},{quantity:1,unit_price:4000}];
 const exclusive=money(lines,'exclusive',500);assert.equal(exclusive.net_amount,10000);assert.equal(exclusive.tax_amount,500);assert.equal(exclusive.total_amount,10500);
 const inclusive=money([{quantity:2,unit_price:3150},{quantity:1,unit_price:4200}],'inclusive',500);assert.deepEqual(inclusive,{...exclusive,mode:'inclusive',input_amount:10500});
 assert.equal(money(lines,'inclusive',500).total_amount,10000);assert.deepEqual(money(lines,'exclusive',500),exclusive);
});
test('receipt rounding matches TWD line rounding and positive half-away tax',()=>{
 assert.equal(money([{quantity:3,unit_price:'0.50'}],'exclusive',0).net_amount,2);
 assert.equal(money([{quantity:1,unit_price:10}],'exclusive',500).tax_amount,1);
 const r=money([{quantity:1,unit_price:100}],'exclusive',725);assert.equal(r.tax_amount,7);assert.equal(r.total_amount,107);
 assert.equal(c.GUCReceiptMoney.rateBasisPoints('7.25'),725);
});
test('unknown legacy mode and missing prices remain unknown, zero is a price',()=>{
 assert.equal(money([{quantity:2,unit_price:100}],null,null).total_amount,null);
 const missing=money([{quantity:2,unit_price:null}],'exclusive',500);assert.equal(missing.missing_price_count,1);assert.equal(missing.total_amount,null);
 assert.equal(money([{quantity:2,unit_price:0}],'inclusive',500).total_amount,0);
});
test('invalid monetary input is rejected without float rounding',()=>{
 for(const unit_price of [-1,'1.001','NaN','1e3',1e12])assert.throws(()=>money([{quantity:1,unit_price}],'exclusive',500));
 for(const quantity of [0,-1,1.1,NaN])assert.throws(()=>money([{quantity,unit_price:1}],'exclusive',500));
 for(const rate of [-1,10001,1.5,null])assert.throws(()=>money([{quantity:1,unit_price:1}],'exclusive',rate));
});
