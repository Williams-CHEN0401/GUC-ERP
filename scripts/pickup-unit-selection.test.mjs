import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function fixture(metersPerUnit=100,originalUnit='package',category='弱電線材'){
 const c=vm.createContext({state:{categories:[{id:'category',name:category}],inventory:[{id:'cable',categoryId:'category',unit:'捲',metersPerUnit,quantity:3,looseMeters:10}]}});
 for(const name of ['byId','looseMeterCategory','inventoryAllowsLooseMeters','inventoryUnitIsMeter','cableLengthEnabled','syncCablePickupUnit'])vm.runInContext(app.split(/\r?\n/).find(line=>line.startsWith('function '+name+'(')),c);
 const unit={value:originalUnit,disabled:true,options:[{},{}],dataset:{originalUnit,originalItem:'cable'}},quantity={},stock={};
 const row={querySelector:selector=>({'[name="batchQuantityUnit"]':unit,'[data-batch-item]':{value:'cable'},'[name="batchQuantity"]':quantity,'[data-cable-stock]':stock})[selector]};
 return {c,row,unit,quantity,stock};
}
test('existing package pickup can select meters and retain the entered quantity',()=>{
 const f=fixture();f.c.syncCablePickupUnit(f.row);assert.equal(f.unit.disabled,false);assert.equal(f.unit.options[1].disabled,false);
 f.unit.value='meter';f.quantity.value='12';f.c.syncCablePickupUnit(f.row);assert.equal(f.unit.value,'meter');assert.equal(f.quantity.value,'12');assert.equal(f.quantity.step,'0.01');
});
test('cable items without a package length can select meters without changing quantity',()=>{
 const f=fixture(null);f.c.syncCablePickupUnit(f.row);assert.equal(f.unit.options[1].disabled,false);assert.equal(f.unit.options[1].hidden,false);assert.equal(f.unit.value,'package');assert.equal(f.quantity.step,'1');assert.equal(f.stock.textContent,undefined);
});
test('meter option is shown for both cable categories and hidden for equipment even with an unrelated length profile',()=>{
 for(const category of ['弱電線材','電線&電纜類','電線＆電纜類']){const f=fixture(200,'package',category);f.c.syncCablePickupUnit(f.row);assert.equal(f.unit.options[1].hidden,false);assert.equal(f.unit.options[1].disabled,false);}
 const camera=fixture(200,'package','監控設備');camera.c.state.inventory[0].unit='台';camera.c.syncCablePickupUnit(camera.row);assert.equal(camera.unit.options[1].hidden,true);assert.equal(camera.unit.options[0].textContent,'台');
});
test('historical meter selection is retained only for the original item; changing to other equipment resets the unit without changing quantity',()=>{
 const f=fixture(200,'meter','舊分類');f.quantity.value='12';f.c.syncCablePickupUnit(f.row);assert.equal(f.unit.value,'meter');
 f.unit.dataset.originalItem='different-item';f.c.syncCablePickupUnit(f.row);assert.equal(f.unit.options[1].hidden,true);assert.equal(f.unit.value,'package');assert.equal(f.quantity.value,'12');
});
test('all shared transaction editors retain legacy package labels while new or converted meter rows use the current unit',()=>{
 const old=fixture();old.c.state.inventory[0].legacyUnit='箱';old.c.syncCablePickupUnit(old.row);assert.equal(old.unit.options[0].textContent,'箱');
 old.unit.dataset.originalPackageUnit='包';old.c.syncCablePickupUnit(old.row);assert.equal(old.unit.options[0].textContent,'包');
 const meter=fixture(null,'meter');meter.unit.dataset.originalPackageUnit='米';meter.c.syncCablePickupUnit(meter.row);assert.equal(meter.unit.options[0].textContent,'捲');
 old.unit.dataset.originalItem='';old.c.syncCablePickupUnit(old.row);assert.equal(old.unit.options[0].textContent,'捲');
});
