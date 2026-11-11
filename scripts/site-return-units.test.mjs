import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import {withWebsiteAccess} from './website-access-test-helper.mjs';

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const returns=readFileSync(new URL('../site-returns.js',import.meta.url),'utf8');
function lineFixture({originalMode='package',originalItem='cable',snapshot='',readonly=false}={}){
 const items=[{id:'cable',category_id:'weak',category:'弱電線材',unit:'捲',legacy_unit:'箱',active:true},{id:'camera',category_id:'camera',category:'監控設備',unit:'台',active:true}];
 const c=vm.createContext({state:{categories:[]},data:{items},editor:{readonly},item:id=>items.find(i=>i.id===id),options:()=>''});
 for(const name of ['byId','inventoryUnitIsMeter','looseMeterCategory','inventoryAllowsLooseMeters'])vm.runInContext(app.split(/\r?\n/).find(line=>line.startsWith('function '+name+'(')),c);
 vm.runInContext(returns.slice(returns.indexOf(' function lineChoices('),returns.indexOf(' function addLine(')),c);
 const category={value:''},selected={value:'cable'},mode={value:originalMode,options:[{},{}]},quantity={value:'123.75',readOnly:false},lengths={value:''},unit={},lengthField={},legacy={};
 const row={dataset:{originalMode,originalItem,originalPackageUnit:snapshot},querySelector:s=>({'[data-return-item-category]':category,'[data-return-item]':selected,'[data-return-mode]':mode,'[data-return-quantity]':quantity,'[data-return-label]':{closest:()=>lengthField},'[data-return-legacy]':legacy})[s]};
 return {c,row,selected,mode,quantity,lengths,unit,lengthField};
}
test('existing site-return package lines can switch to loose meters without a length or quantity reset',()=>{
 const f=lineFixture();f.c.lineChoices(f.row);assert.equal(f.mode.disabled,false);assert.equal(f.mode.options[0].textContent,'箱');
 f.mode.value='meter';f.c.lineChoices(f.row);assert.equal(f.mode.value,'meter');assert.equal(f.quantity.value,'123.75');assert.equal(f.quantity.readOnly,false);assert.equal(f.lengthField.hidden,false);
 f.mode.value='package';f.c.lineChoices(f.row);assert.equal(f.quantity.value,'123.75');assert.equal(f.mode.options[0].textContent,'箱');
});
test('site-return package snapshots stay on the original item and cannot grant another item historical meter access',()=>{
 const f=lineFixture({originalMode:'meter',snapshot:'舊單位'});f.c.lineChoices(f.row);assert.equal(f.mode.options[0].textContent,'捲');
 f.selected.value='camera';f.c.lineChoices(f.row);assert.equal(f.mode.options[1].hidden,true);assert.equal(f.mode.value,'package');assert.equal(f.mode.options[0].textContent,'台');assert.equal(f.quantity.value,'123.75');
 const old=lineFixture({snapshot:'包'});old.c.lineChoices(old.row);assert.equal(old.mode.options[0].textContent,'包');
 const fresh=lineFixture({originalMode:'',originalItem:''});fresh.c.lineChoices(fresh.row);assert.equal(fresh.mode.options[0].textContent,'捲');
});
test('each return row keeps its individual meters and read-only documents keep their unit selector disabled',()=>{
 const f=lineFixture({readonly:true});f.c.lineChoices(f.row);assert.equal(f.mode.disabled,true);
 f.mode.value='meter';f.lengths.value='10.25、5';f.c.lineChoices(f.row);assert.equal(f.quantity.value,'123.75');assert.equal(f.quantity.readOnly,false);assert.equal(f.quantity.step,'0.01');
});

const edge=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8').replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
const id='20000000-0000-4000-8000-000000000001';
function gateway({write=true}={}){
 let handler;const calls=[];
 const c=vm.createContext({AsyncLocalStorage,performance,URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,crypto,console,Deno:{env:{get:()=>''},serve:fn=>handler=fn}});vm.runInContext(edge,c);
 c.currentUser=withWebsiteAccess(async()=>({id,username:'fixture',role:'custom',is_active:true,permissions:['purchases','inventory','pickups'].map(module=>({module,can_view:true,can_create:write,can_update:write,can_delete:write}))}));
 c.get=c.getAll=async()=>[];c.rpc=async(name,args)=>{calls.push({name,args:JSON.parse(JSON.stringify(args))});return {document_id:id};};c.db=async()=>Response.json([],{status:201});
 return {calls,async send(operation='create_site_return',payload={}){const response=await handler(new Request('https://fixture.invalid/inventory-gateway',{method:'POST',body:JSON.stringify({operation,payload:{document_id:id,request_id:id,row_version:1,return_date:'2026-11-04',customer_id:id,project_id:id,rows:[{inventory_item_id:id,quantity:999999,quantity_unit:'meter',lengths:[],package_unit_snapshot:'偽造'}],...payload}})}));return {status:response.status,body:await response.json()};}};
}
test('site-return create and unit edits use the atomic RPC without requiring pickups or accepting client snapshots',async()=>{
 for(const operation of ['create_site_return','update_site_return']){const f=gateway(),result=await f.send(operation);assert.equal(result.status,201,result.body.error);assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'save_site_return_v1');assert.deepEqual(f.calls[0].args.p_rows,[{inventory_item_id:id,quantity:999999,quantity_unit:'meter',lengths:[]}]);}
});
test('site-return unit edits retain server permission and decimal-integrity validation',async()=>{
 const denied=gateway({write:false});assert.equal((await denied.send('update_site_return')).status,403);assert.equal(denied.calls.length,0);
 for(const row of [{quantity:1.001},{quantity_unit:'invalid'},{lengths:[1.001]},{quantity:1e12}]){const f=gateway(),result=await f.send('create_site_return',{rows:[{inventory_item_id:id,quantity:1,quantity_unit:'meter',...row}]});assert.equal(result.status,400);assert.equal(f.calls.length,0);}
});
test('physical count uses the separate meter RPC and retains the existing package adjustment RPC',async()=>{
 for(const [quantity_unit,after_quantity,name] of [['meter',12.25,'apply_stock_adjustment_meter_v1'],['meter',0,'apply_stock_adjustment_meter_v1'],['package',12,'apply_stock_adjustment_verified_v1']]){const f=gateway(),result=await f.send('create_stock_adjustment',{inventory_item_id:id,idempotency_key:id,quantity_unit,after_quantity});assert.equal(result.status,201,result.body.error);assert.equal(f.calls[0].name,name);assert.equal(f.calls[0].args.p_after_quantity,after_quantity);}
 const denied=gateway({write:false});assert.equal((await denied.send('create_stock_adjustment',{inventory_item_id:id,idempotency_key:id,quantity_unit:'meter',after_quantity:1})).status,403);assert.equal(denied.calls.length,0);
});
test('pickup API rejects unknown unit modes before calling the existing stock RPC',async()=>{
 const f=gateway(),result=await f.send('create_pickup_batch',{rows:[{inventory_item_id:id,customer_id:id,project_id:id,pickup_date:'2026-11-04',quantity:1,quantity_unit:'other'}]});assert.equal(result.status,400);assert.equal(f.calls.length,0);
});
