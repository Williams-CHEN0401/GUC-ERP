import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8').replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
const ui=readFileSync(new URL('../contract-service-catalog.js',import.meta.url),'utf8');
const id='10000000-0000-4000-8000-000000000001';
function harness(actions=[],module='customers',preview=false){
 let handler;const calls=[];
 const context=vm.createContext({AsyncLocalStorage,performance,URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,crypto,console,Deno:{env:{get:key=>key==='PREVIEW_MODE'&&preview?'true':''},serve:fn=>handler=fn}});
 vm.runInContext(source,context);
 context.currentUser=async()=>({id,username:'fixture',role:'custom',is_active:true,permissions:[{module,can_view:actions.includes('view'),can_create:actions.includes('create'),can_update:actions.includes('update'),can_delete:actions.includes('delete')}]});
 context.get=context.getAll=async path=>{calls.push(path);return [];};context.rpc=async(name,args)=>{calls.push({name,args});return {};};
 return {calls,context,read:scope=>handler(new Request('https://example.test/inventory-gateway?scope='+scope)),write:(op,payload)=>handler(new Request('https://example.test/inventory-gateway'+(preview?'-preview':''),{method:'POST',body:JSON.stringify({operation:op,payload})}))};
}
for(const action of ['create','update','delete'])test('contract catalog '+action+' uses existing customers permission and trusted actor',async()=>{
 const payload={id,row_version:2,name:'新承攬',sort_order:10,actor:'forged',code:'phone_system'};
 for(const h of [harness(['view']),harness(['view',action],'inventory')]){assert.equal((await h.write(action+'_contract_service_type',payload)).status,403);assert.equal(h.calls.length,0);}
 const h=harness(['view',action]);assert.equal((await h.write(action+'_contract_service_type',payload)).status,201);
 assert.equal(h.calls[0].name,'manage_contract_service_type_v1');assert.equal(h.calls[0].args.p_actor,'fixture');assert.equal(h.calls[0].args.p_action,action);assert.ok(!('p_code' in h.calls[0].args));
});
test('preview gateway rejects all catalog writes even with permissions',async()=>{
 for(const action of ['create','update','delete']){const h=harness(['view',action],'customers',true);assert.equal((await h.write(action+'_contract_service_type',{id,row_version:1,name:'新',sort_order:1})).status,403);assert.equal(h.calls.length,0);}
});
test('invalid and anonymous catalog changes never call SQL',async()=>{
 for(const [op,p] of [['create',{name:' ',sort_order:0}],['create',{name:'x'.repeat(81),sort_order:1}],['create',{name:'新',sort_order:0.5}],['create',{name:'新',sort_order:'1'}],['update',{id,row_version:0,name:'新',sort_order:1}],['delete',{id:'bad',row_version:1}]]){const h=harness(['create','update','delete']);assert.equal((await h.write(op+'_contract_service_type',p)).status,400);assert.equal(h.calls.length,0);}
 const h=harness();h.context.currentUser=async()=>null;assert.equal((await h.write('create_contract_service_type',{name:'新',sort_order:1})).status,401);assert.equal(h.calls.length,0);
});
test('shared catalog comes from the same paged dataset across CRM/worklogs/site navigation',async()=>{
 for(const [scope,module]of [['crm','customers'],['worklogs','worklogs'],['site_navigation','site']]){const h=harness(['view'],module);assert.equal((await h.read(scope)).status,200);assert.ok(h.calls.some(p=>typeof p==='string'&&p.startsWith('contract_service_types?')&&p.includes('row_version')));}
 const h=harness(['view'],'suppliers');await h.read('crm');assert.ok(!h.calls.some(p=>typeof p==='string'&&p.startsWith('contract_service_types?')));
});
test('empty snapshots clear stale choices; old schema/errors disable writes and new names keep IDs',()=>{
 const state={contractServiceTypes:[{id:'old'}]},context=vm.createContext({state,document:{addEventListener(){}}});vm.runInContext(ui,context);
 context.applyContractServiceCatalogSnapshot({contract_service_types:[]});assert.equal(state.contractServiceTypes.length,0);assert.equal(state.contractServicesReady,true);
 context.applyContractServiceCatalogSnapshot({contract_service_types:[{id:'same',code:'fixed',name:'新名稱',is_active:true,sort_order:1,row_version:2}]});assert.equal(state.contractServiceTypes[0].code,'fixed');assert.equal(state.contractServiceTypes[0].name,'新名稱');assert.equal(state.contractServicesReady,true);
 context.applyContractServiceCatalogSnapshot({errors:[{dataset:'contract_service_types'}]});assert.equal(state.contractServicesReady,false);
 context.applyContractServiceCatalogSnapshot({contract_service_types:[{id:'legacy',name:'舊名稱'}]});assert.equal(state.contractServicesReady,false);
});
test('nested catalog UI keeps existing customer tabs and RBAC mapping',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8'),permissions=readFileSync(new URL('../permissions-ui.js',import.meta.url),'utf8');
 for(const pane of ['list','categories','departments','services'])assert.ok(html.includes('data-customer-pane="'+pane+'"'));
 assert.match(permissions,/contractServiceModal:'customers'/);assert.ok(html.indexOf('contract-service-catalog.js')<html.indexOf('src="/app.js"'));
});
