import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function fixture(){
 const c=vm.createContext({state:{categories:[{id:'weak',name:'弱電線材'},{id:'wire',name:'電線&電纜類'},{id:'camera',name:'監控設備'}]},inputField:(name,label,type,required,value)=>`<label>${label}<input name="${name}" value="${value}"></label>`,submitField:label=>`<button>${label}</button>`});
 for(const name of ['byId','esc','looseMeterCategory','inventoryAllowsLooseMeters','inventoryUnitIsMeter','cableLengthEnabled','inventoryUnitSettingsFields','inventoryUnitSettingsPayload','cablePickupUnitField'])vm.runInContext(app.split(/\r?\n/).find(line=>line.startsWith('function '+name+'(')),c);
 const item={id:'item-1',rowVersion:4,categoryId:'weak',name:'網路線',brand:'既有品牌',model:'原型號',unit:'箱',metersPerUnit:null,openingQuantity:7};return{c,item};
}
test('unit settings update one item using its pinned version, retaining all non-unit fields and original opening stock',()=>{
 const {c,item}=fixture(),p=c.inventoryUnitSettingsPayload(item,{unit:' 捲 ',metersPerUnit:'200'});
 assert.deepEqual(JSON.parse(JSON.stringify(p)),{id:item.id,row_version:4,units_only:true,unit:'捲',meters_per_unit:200});
 assert.equal(item.unit,'箱');assert.equal(item.metersPerUnit,null);
});
test('equipment receives only its own base unit and cable categories receive a per-item optional length',()=>{
 const {c,item}=fixture();assert.match(c.inventoryUnitSettingsFields(item),/name="metersPerUnit"/);
 const camera={...item,categoryId:'camera',name:'攝影機',unit:'台'};assert.doesNotMatch(c.inventoryUnitSettingsFields(camera),/metersPerUnit/);
 const p=c.inventoryUnitSettingsPayload(camera,{unit:'台',metersPerUnit:'200'});assert.equal(p.meters_per_unit,null);
 assert.equal(c.inventoryUnitSettingsPayload({...item,categoryId:'wire'},{unit:'捲',metersPerUnit:'100'}).meters_per_unit,100);
});
test('per-item unit validation rejects missing names and invalid lengths and avoids double converting base meters',()=>{
 const {c,item}=fixture();for(const unit of ['', '  ', '單'.repeat(31)])assert.throws(()=>c.inventoryUnitSettingsPayload(item,{unit}),/貨品單位/);
 for(const length of ['no',0,-2,1.234,1e12])assert.throws(()=>c.inventoryUnitSettingsPayload(item,{unit:'箱',metersPerUnit:String(length)}),/米數/);
 assert.equal(c.inventoryUnitSettingsPayload(item,{unit:'米',metersPerUnit:'200'}).meters_per_unit,null);
 assert.equal(c.inventoryUnitSettingsPayload(item,{unit:'捲',metersPerUnit:''}).meters_per_unit,null);
});
test('pickup unit field contains only unit choices, without the former conversion/stock annotation',()=>{
 const {c}=fixture(),html=c.cablePickupUnitField({});assert.match(html,/散料\(米\)/);assert.doesNotMatch(html,/<small|data-cable-stock|尚未設定每|自動拆包/);
});
