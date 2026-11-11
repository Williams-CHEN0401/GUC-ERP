import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8'),c=vm.createContext({state:{categories:[]}});
for(const name of ['byId','inventoryUnitIsMeter','looseMeterCategory','inventoryAllowsLooseMeters','inventoryTransactionUnit'])vm.runInContext(app.split(/\r?\n/).find(line=>line.startsWith('function '+name+'(')),c);
test('all warehouse forms use cable category eligibility independently of length or opening stock',()=>{
for(const category of ['弱電線材','電線&電纜類','電線＆電纜類'])assert(c.inventoryAllowsLooseMeters({category,unit:'箱',metersPerUnit:null,openingMeters:0}));
assert(!c.inventoryAllowsLooseMeters({category:'監控設備',unit:'台',metersPerUnit:305}));
assert(!c.inventoryAllowsLooseMeters({category:'弱電線材',unit:'米'}));
assert(c.inventoryAllowsLooseMeters({category:'弱電線材',unit:'米',canUseMeter:true}));
});
test('old document units use their own snapshot or original item unit after a rename',()=>{
const item={unit:'捲',legacyUnit:'箱'};assert.equal(c.inventoryTransactionUnit({quantityUnit:'package',packageUnitSnapshot:'包'},item),'包');assert.equal(c.inventoryTransactionUnit({quantityUnit:'package'},item),'箱');assert.equal(c.inventoryTransactionUnit({quantityUnit:'meter'},item),'米');
});
test('physical count offers decimal meters for eligible categories independently of length, and resets equipment to its own stock',()=>{
 const select={value:'meter',options:[{},{}]},quantity={},hint={},chosen={value:'cable'},inventory=[{id:'cable',code:'C',name:'線材',category:'弱電線材',unit:'箱',quantity:3,looseMeters:0},{id:'camera',code:'E',name:'設備',category:'監控設備',unit:'台',quantity:2,looseMeters:0}];
 c.state.inventory=inventory;c.document={querySelector:s=>({'#adjustQuantityUnit':select,'#adjustForm':{elements:{quantity}},'#adjustItem':chosen,'#adjustStockHint':hint})[s]};vm.runInContext(app.split(/\r?\n/).find(line=>line.startsWith('function syncAdjustmentUnit(')),c);
 c.syncAdjustmentUnit();assert.equal(select.options[1].disabled,false);assert.equal(quantity.step,'0.01');assert.match(hint.textContent,/0 米$/);
 chosen.value='camera';c.syncAdjustmentUnit();assert.equal(select.value,'package');assert.equal(select.options[1].hidden,true);assert.equal(quantity.step,'1');assert.match(hint.textContent,/2 台$/);
});
