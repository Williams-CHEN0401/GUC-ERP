import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=f=>readFileSync(new URL('../'+f,import.meta.url),'utf8'),source=read('form-reference-sync.js'),app=read('app.js');
function runtime(){
 const calls=[],applied=[],modal={dataset:{type:'pickupModal',id:'row',editVersion:'2'}};
 const document={hidden:false,querySelector:s=>s==='#simpleModal.open'?modal:null,addEventListener(){}};
 const context=vm.createContext({document,window:{addEventListener(){}},setInterval(){},Date,accessToken:'user-B',PREVIEW_MODE:false,loadedScopes:new Set(['transactions']),state:{currentUser:{id:'B'}},currentPage:()=> 'transactions',PAGE_SCOPES:{transactions:'transactions'},apiRequest:async args=>{calls.push(args);return {scope:'transactions',categories:[{id:'new'}]};},hydrateSnapshot:(data,options)=>applied.push({data,options}),logout:()=>{context.accessToken='';}});
 vm.runInContext(source,context);return {context,calls,applied,modal,document};
}
test('customer search precedes category/customer/department in the shared selector and receipt picker',()=>{
 for(const [file,search,category] of [['customer-departments.js','搜尋客戶','${customerCategoryOptions(category)}'],['receipt-customers.js','搜尋客戶','客戶分類']]){const text=read(file);assert.ok(text.indexOf(search)<text.indexOf(category));}
 for(const modal of ['projectModal','pickupModal','repairModal','workLogModal','attachmentModal'])assert.match(app,new RegExp('type==="'+modal+'"[\\s\\S]*?customerSelectorFields'));
});
test('reference refresh uses authorized scope, is deduplicated and keeps form rendering separate',async()=>{
 const h=runtime();let finish;h.context.apiRequest=args=>{h.calls.push(args);return new Promise(resolve=>finish=resolve);};
 const pending=h.context.refreshVisibleFormReferences();const second=h.context.refreshVisibleFormReferences();assert.equal(h.calls.length,1);
 finish({scope:'transactions',categories:[{id:'new'}]});await Promise.all([pending,second]);
 assert.equal(h.calls[0].optionsOnly,true);assert.equal(h.applied[0].options.referencesOnly,true);
 assert.doesNotMatch(source,/form\.innerHTML\s*=|\.reset\(/);
 await h.context.refreshVisibleFormReferences();assert.equal(h.calls.length,1,'focus throttling');
});
test('late responses after logout, account change or a save do not replace current data',async()=>{
 for(const change of [c=>c.accessToken='',c=>c.accessToken='other-user',c=>c.invalidateFormReferences()]){
  const h=runtime();let finish;h.context.apiRequest=()=>new Promise(resolve=>finish=resolve);const pending=h.context.refreshVisibleFormReferences();change(h.context);finish({categories:[{id:'stale'}]});await pending;assert.equal(h.applied.length,0);
 }
});
test('hidden page, login chooser, no selected system and preview never poll production',async()=>{
 const h=runtime();h.document.hidden=true;await h.context.refreshVisibleFormReferences();assert.equal(h.calls.length,0);
 h.document.hidden=false;h.context.loadedScopes.clear();await h.context.refreshVisibleFormReferences();assert.equal(h.calls.length,0);
 h.context.loadedScopes.add('transactions');h.context.PREVIEW_MODE=true;h.context.refreshFormReferenceChoices=()=>{};await h.context.refreshVisibleFormReferences();assert.equal(h.calls.length,0);
});
test('unchanged responses do not rebuild option nodes; unauthorized session logs out',async()=>{
 const h=runtime();await h.context.refreshVisibleFormReferences({force:true});await h.context.refreshVisibleFormReferences({force:true});assert.equal(h.applied.length,1);
 h.context.apiRequest=async()=>{throw Object.assign(new Error('Expired'),{status:401});};await h.context.refreshVisibleFormReferences({force:true});assert.equal(h.context.accessToken,'');
});
test('editing version remains pinned while reference records refresh',()=>{
 const h=runtime();assert.equal(h.context.pinOpenFormVersion({id:'row',row_version:9,name:'draft'}).row_version,2);assert.equal(h.context.pinOpenFormVersion({id:'other',row_version:9}).row_version,9);
 assert.match(app,/payload=pinOpenFormVersion\(payload\)/);
});
test('all ERP entry forms resolve the existing authorized scope, including both assignment datasets',()=>{
 const h=runtime();
 for(const [type,scopes] of Object.entries({customerModal:['crm'],customerCategoryModal:['crm'],customerDepartmentModal:['crm'],contractServiceModal:['crm'],projectModal:['crm'],supplierModal:['crm'],categoryModal:['inventory'],itemModal:['inventory'],pickupModal:['transactions'],receiptModal:['transactions'],repairModal:['repairs'],workLogModal:['worklogs'],workLogPickupModal:['transactions'],workAssignmentModal:['crm','inventory'],accountModal:['settings'],attachmentModal:['worklogs']})){
  h.modal.dataset.type=type;assert.deepEqual(Array.from(h.context.formReferenceScopes()),scopes,type);
 }
 h.modal.dataset.type='unknown';assert.deepEqual(Array.from(h.context.formReferenceScopes()),[]);
});
test('save-in-progress and changed page ignore an in-flight reference response',async()=>{
 for(const busy of [true,false]){
  const h=runtime();let finish;h.context.apiRequest=()=>new Promise(resolve=>finish=resolve);
  const pending=h.context.refreshVisibleFormReferences();
  if(busy)h.context.formReferencesBusy=()=>true;else h.modal.dataset.type='categoryModal';
  finish({categories:[{id:'new'}]});await pending;assert.equal(h.applied.length,0);
 }
});
test('option replacement preserves selected/removed IDs, blank selection and disabled state',()=>{
 const h=runtime();h.context.esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 const selected={value:'old',selectedOptions:[{textContent:'草稿選項'}],innerHTML:'',disabled:false};
 h.context.replaceReferenceOptions(selected,[['new','新選項']]);
 assert.equal(selected.value,'old');assert.match(selected.innerHTML,/value="old">草稿選項/);assert.match(selected.innerHTML,/value="new">新選項/);
 const blank={value:'',selectedOptions:[],innerHTML:'',disabled:true};
 h.context.replaceReferenceOptions(blank,[['new','新選項']],{disabled:false});
 assert.equal(blank.value,'');assert.equal(blank.disabled,false);
 h.context.replaceReferenceOptions(blank,[['new','<script>']],{disabled:true});
 assert.ok(!blank.innerHTML.includes('<script>'));assert.equal(blank.disabled,true);
});
test('role/project-grant forms keep their original versions while reference data changes',()=>{
 const permissions=read('permissions-ui.js');
 assert.match(permissions,/permissionRoleEditVersion=chosen\?\.row_version\?\?null/);
 assert.match(permissions,/row_version:permissionRoleEditVersion/);
 assert.match(permissions,/row_version:projectAccessEditVersion/);
 assert.doesNotMatch(permissions,/row_version:user\.rowVersion/);
 assert.match(permissions,/form\.setAttribute\('aria-busy','true'\)/);
});
test('BFF forwards the option-only query and never caches authenticated reference data',()=>{
 const proxy=read('api/inventory.js');
 assert.ok(proxy.includes('const target = `${UPSTREAM}${incomingUrl.search}`'));
 assert.ok(proxy.includes("response.setHeader('Cache-Control', 'no-store')"));
 assert.ok(proxy.includes('headers.Authorization = request.headers.authorization'));
});
test('inventory search combines case-insensitive name/brand/model/code and Chinese name-first order',()=>{
 const extract=name=>app.split('\n').find(line=>line.startsWith('function '+name+'('));
 const context=vm.createContext({state:{inventory:[{id:'z',categoryId:'c',name:'電源',code:'A001',brand:'ACME',model:'X200'},{id:'a',categoryId:'c',name:'中文設備',code:'Z999',brand:'Other',model:'M'},{id:'b',categoryId:'other',name:'中文設備',code:'B001'}]}});
 vm.runInContext(['esc','valueText','matches','sortRows','inventoryItemOptions'].map(extract).join('\n'),context);
 const all=context.inventoryItemOptions('c');assert.ok(all.indexOf('value="a"')<all.indexOf('value="z"'));
 const filtered=context.inventoryItemOptions('c','',' ACME ');assert.ok(filtered.includes('value="z"'));assert.ok(!filtered.includes('value="a"'));assert.ok(!filtered.includes('value="b"'));
 assert.ok(context.inventoryItemOptions('c','a','X200').includes('value="a"'),'selected item retained while searching');
 assert.match(app,/data-batch-item-search/);
});
