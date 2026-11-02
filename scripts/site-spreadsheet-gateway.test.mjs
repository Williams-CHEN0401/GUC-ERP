import assert from 'node:assert/strict';import test from 'node:test';import {readFileSync} from 'node:fs';import {stripTypeScriptTypes} from 'node:module';import {AsyncLocalStorage} from 'node:async_hooks';import vm from 'node:vm';
const root=new URL('../supabase/functions/inventory-gateway/',import.meta.url);
const raw=readFileSync(new URL('index.ts',root),'utf8').replace(/^import .*node:async_hooks.*;\r?\n/m,'').replaceAll("import('./site-spreadsheet.ts')",'Promise.resolve(spreadsheetHelpers)');
const helper=readFileSync(new URL('site-spreadsheet.ts',root),'utf8').replace(/export /g,'');
const code=stripTypeScriptTypes(raw,{mode:'strip'}),helperCode=stripTypeScriptTypes('(()=>{'+helper+';return {siteSpreadsheetRow,spreadsheetColumns,spreadsheetText};})()',{mode:'strip'});
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0'),customer=id(1),service=id(2),device=id(3),site=id(4);
const permission=(module,actions=[])=>({module,can_view:true,can_create:actions.includes('CREATE'),can_update:actions.includes('UPDATE'),can_delete:false});
function harness({role='admin',permissions=[],serviceCode='surveillance',website=true,linked=true,validDevice=true,privateCustomer=false,anonymous=false}={}){
 let handler;const calls=[],c=vm.createContext({AsyncLocalStorage,Request,Response,Headers,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,console,crypto,performance,TextEncoder,TextDecoder,Error,Deno:{env:{get:()=>''},serve:fn=>handler=fn}});
 c.spreadsheetHelpers=vm.runInContext(helperCode,c);vm.runInContext(code,c);
 c.currentUser=async()=>{if(anonymous)return null;if(privateCustomer)Object.assign(vm.runInContext('privateContext.getStore()',c),{configured:true,direct:false,blocked_ids:[customer]});return{id:id(10),username:'fixture',display_name:'合成帳號',role,is_active:true,permissions,website_access:{erp:{login:true},site:{login:website}}};};
 c.get=async path=>path.startsWith('contract_service_types?')?[{id:service,code:serviceCode}]:path.startsWith('customer_contract_services?')?linked?[{customer_id:customer}]:[]:path.startsWith('customers?')?[{id:customer}]:path.startsWith('site_devices?')?validDevice?[{id:device,site_id:site}]:[]:path.startsWith('sites?')?[{id:site}]:path.startsWith('site_spreadsheet_templates?')?[]:[];
 c.insert=async()=>[];c.rpc=async(name,args)=>{calls.push({name,args});return {saved:true};};
 const request=async({operation='import_site_spreadsheet',kind='devices',system='site',query='',preview=false}={})=>{
  const payload={customer_id:customer,service_id:service,kind,...kind==='history'?{source_id:device}:{},file_name:'fixture.xlsx',sheet_name:'Sheet',file_hash:'a'.repeat(64),request_id:id(12),rows:[{source_row:2,...kind==='devices'?{device_name:'合成設備'}:{description:'合成維修'}}],name:'合成範本',columns:[{key:kind==='devices'?'device_name':'description',label:'內容'}]};
  const r=await handler(new Request('https://fixture.invalid/inventory-gateway'+(preview?'-preview':'')+query,{method:'POST',headers:{'content-type':'application/json',...system?{'x-guc-system':system}:{}},body:JSON.stringify({operation,payload})}));return {status:r.status,body:await r.json()};
 };
 return {request,calls,c,handler:()=>handler};
}
test('admin imports devices and history, and saves both templates, through the real site Gateway handler',async()=>{
 for(const serviceCode of ['surveillance','access_control','office_cabling','custom_service'])for(const kind of ['devices','history'])for(const operation of ['import_site_spreadsheet','save_site_spreadsheet_template']){
  const h=harness({serviceCode}),r=await h.request({kind,operation});assert.equal(r.status,201,JSON.stringify({serviceCode,kind,operation,body:r.body}));assert.equal(h.calls.at(-1).name,operation==='import_site_spreadsheet'?'import_site_spreadsheet_v1':'save_site_spreadsheet_template_v1');
 }
});
test('custom roles use the existing service-specific create and template update grants',async()=>{
 for(const [serviceCode,module]of [['surveillance','monitoring'],['access_control','equipment']]){
  const base=[permission('site'),permission(module,['UPDATE'])],importModule=module==='monitoring'?'monitoring_import':'equipment';
  for(const kind of ['devices','history']){
   const granted=[...base,permission(kind==='history'?'history':importModule,['CREATE','UPDATE'])];
   const ok=harness({role:'custom',serviceCode,permissions:granted});assert.equal((await ok.request({kind})).status,201);
   const denied=harness({role:'custom',serviceCode,permissions:base});assert.equal((await denied.request({kind})).status,403);assert.equal(denied.calls.length,0);
  }
  assert.equal((await harness({role:'custom',serviceCode,permissions:base}).request({operation:'save_site_spreadsheet_template'})).status,201);
 }
});
test('website revocation, missing site grant, anonymous, readonly preview and private customer remain denied',async()=>{
 for(const settings of [{website:false},{anonymous:true},{privateCustomer:true},{role:'custom',permissions:[permission('equipment',['CREATE'])]}]){
  const h=harness(settings),r=await h.request();assert.equal(r.status,settings.anonymous?401:403,JSON.stringify(r.body));assert.equal(h.calls.length,0);
 }
 const h=harness();assert.equal((await h.request({preview:true})).status,403);assert.equal(h.calls.length,0);
});
test('wrong contract/customer/device and phone service never reach an import RPC',async()=>{
 for(const settings of [{linked:false},{validDevice:false},{serviceCode:'phone_system'}]){
  const h=harness(settings),r=await h.request({kind:settings.validDevice===false?'history':'devices'});assert([400,404].includes(r.status),JSON.stringify(r.body));assert.equal(h.calls.length,0);
 }
});
test('history template read supports service scope; history data read still requires an authorized device',async()=>{
 const h=harness(),query=new URLSearchParams({scope:'site_spreadsheet',customer_id:customer,service_id:service,kind:'history',template_only:'1'}),request=q=>h.handler()(new Request('https://fixture.invalid/inventory-gateway?'+q,{headers:{'x-guc-system':'site'}}));
 assert.equal((await request(query)).status,200);query.delete('template_only');assert.equal((await request(query)).status,400);
 query.set('source_id',device);query.set('template_only','1');const denied=harness({validDevice:false});assert.equal((await denied.handler()(new Request('https://fixture.invalid/inventory-gateway?'+query,{headers:{'x-guc-system':'site'}}))).status,404);
});
