import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const gateway=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8').replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const id='10000000-0000-4000-8000-000000000001',customer='30000000-0000-4000-8000-000000000001';
const payload={project_mode:'manual',project_name:' 新工作 ',customer_id:customer,department_id:null,project_type:'repair',project_date:'2026-09-17',assignee_user_id:id,assignment_type:'general',instructions:'工作說明'};
function harness({role='admin',preview=false,anonymous=false}={}){
 let handler;const calls=[];
 const context=vm.createContext({AsyncLocalStorage,performance,URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,crypto,console,Deno:{env:{get:key=>key==='PREVIEW_MODE'&&preview?'true':''},serve:fn=>handler=fn}});
 vm.runInContext(gateway,context);
 context.currentUser=async()=>anonymous?null:{id,username:'fixture-admin',role,is_active:true};
 context.rpc=async(name,args)=>{calls.push({name,args});return{id};};
 return{calls,write:p=>handler(new Request('https://example.test/inventory-gateway'+(preview?'-preview':''),{method:'POST',body:JSON.stringify({operation:'create_work_assignment',payload:p})}))};
}
test('manual assignment calls one atomic RPC with trusted actor and original project metadata',async()=>{
 const h=harness();assert.equal((await h.write({...payload,created_by_user_id:customer,actor:'forged'})).status,201);
 assert.equal(h.calls.length,1);const {name,args}=h.calls[0];assert.equal(name,'create_work_assignment_with_project_v1');
 assert.equal(args.p_project_name,'新工作');assert.equal(args.p_customer_id,customer);assert.equal(args.p_department_id,null);assert.equal(args.p_project_date,'2026-09-17');assert.equal(args.p_created_by_user_id,id);assert.equal(args.p_actor,'fixture-admin');
});
test('legacy existing-project assignment keeps its original RPC contract',async()=>{
 const h=harness();assert.equal((await h.write({project_id:id,assignee_user_id:id,assignment_type:'general',instructions:'選既有工作'})).status,201);
 assert.equal(h.calls[0].name,'create_work_assignment_v1');assert.equal(h.calls[0].args.p_project_id,id);assert.ok(!('p_project_name' in h.calls[0].args));
});
test('invalid manual inputs are rejected before SQL',async()=>{
 for(const extra of [{project_mode:'other'},{project_name:' '},{project_name:'x'.repeat(121)},{customer_id:'invalid'},{department_id:'invalid'},{project_type:'unknown'},{project_date:'not-a-date'},{project_id:id},{assignee_user_id:'invalid'},{assignment_type:'pickup'}]){
  const h=harness();assert.equal((await h.write({...payload,...extra})).status,400);assert.equal(h.calls.length,0);
 }
});
test('manual assignment does not bypass admin, anonymous or preview boundaries',async()=>{
 for(const options of [{role:'viewer'},{role:'operator'},{anonymous:true},{preview:true}]){const h=harness(options);assert.ok([401,403].includes((await h.write(payload)).status));assert.equal(h.calls.length,0);}
});
test('switching project mode disables hidden required fields and preserves existing/pickup selections',()=>{
 const label={},newGroup={},pickupGroup={},existing={value:'existing-id',closest:()=>label};
 const fields={assignmentProjectMode:{value:'existing'},assignmentProjectId:existing,assignmentType:{value:'general'},pickupCategoryId:{value:'category'},inventoryItemId:{value:'item'},pickupQuantity:{value:'2'}};
 const form={elements:fields,querySelector:s=>s==='#workAssignmentNewProjectFields'?newGroup:pickupGroup};let syncs=0;
 const context=vm.createContext({document:{querySelector:s=>s==='#simpleModal'?{dataset:{type:'workAssignmentModal'}}:form},state:{inventory:[{id:'item',categoryId:'category',code:'I001',name:'測試品項',quantity:5,unit:'台'}]},esc:x=>x,syncModalCustomerOptions:()=>syncs++});
 vm.runInContext(app.slice(app.indexOf('function syncWorkAssignmentFields('),app.indexOf('async function openWorkAssignmentModal(')),context);
 context.syncWorkAssignmentFields();assert.equal(newGroup.disabled,true);assert.equal(newGroup.hidden,true);assert.equal(existing.required,true);assert.equal(pickupGroup.hidden,true);
 fields.assignmentProjectMode.value='manual';context.syncWorkAssignmentFields();assert.equal(newGroup.disabled,false);assert.equal(existing.disabled,true);assert.equal(existing.required,false);assert.equal(label.hidden,true);assert.equal(syncs,1);
 fields.assignmentType.value='pickup';context.syncWorkAssignmentFields();assert.equal(pickupGroup.hidden,false);assert.equal(fields.pickupQuantity.required,true);
 fields.assignmentProjectMode.value='existing';context.syncWorkAssignmentFields();assert.equal(newGroup.disabled,true);assert.equal(existing.disabled,false);assert.equal(existing.value,'existing-id');assert.equal(fields.inventoryItemId.value,'item');
});
