import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function fixture(metersPerUnit=100,originalUnit='package'){
 const c=vm.createContext({state:{inventory:[{id:'cable',unit:'捲',metersPerUnit,quantity:3,looseMeters:10}]}});
 for(const name of ['byId','syncCablePickupUnit'])vm.runInContext(app.split(/\r?\n/).find(line=>line.startsWith('function '+name+'(')),c);
 const unit={value:originalUnit,disabled:true,options:[{},{}],dataset:{originalUnit}},quantity={},stock={};
 const row={querySelector:selector=>({'[name="batchQuantityUnit"]':unit,'[data-batch-item]':{value:'cable'},'[name="batchQuantity"]':quantity,'[data-cable-stock]':stock})[selector]};
 return {c,row,unit,quantity,stock};
}
test('existing package pickup can select meters and retain the entered quantity',()=>{
 const f=fixture();f.c.syncCablePickupUnit(f.row);assert.equal(f.unit.disabled,false);assert.equal(f.unit.options[1].disabled,false);
 f.unit.value='meter';f.quantity.value='12';f.c.syncCablePickupUnit(f.row);assert.equal(f.unit.value,'meter');assert.equal(f.quantity.value,'12');assert.equal(f.quantity.step,'0.01');
});
test('items without a package length still cannot request an invented meter conversion',()=>{
 const f=fixture(null);f.c.syncCablePickupUnit(f.row);assert.equal(f.unit.options[1].disabled,true);assert.equal(f.unit.value,'package');assert.equal(f.quantity.step,'1');assert.match(f.stock.textContent,/尚未設定每捲米數/);
});
