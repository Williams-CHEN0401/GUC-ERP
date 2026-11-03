import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

const source=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8').replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
function harness(){
 const c=vm.createContext({AsyncLocalStorage,URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,console,crypto,performance,Error,Deno:{env:{get:()=>''},serve:()=>{}}});
 vm.runInContext(source,c);return c;
}
const siteOperations=['import_site_spreadsheet','save_site_spreadsheet_template','import_access_devices','upsert_contract_site_entry','delete_contract_site_entry','upsert_monitoring_device','delete_monitoring_device','batch_update_monitoring_devices','import_monitoring_devices','check_monitoring_ip_conflicts','save_equipment_history','void_maintenance_event','create_phone_terminal_version','upsert_phone_system','delete_phone_system','upsert_phone_extension','delete_phone_extension','batch_update_phone_extensions','batch_delete_phone_extensions','import_phone_terminal_rows','set_phone_system_credential','reveal_phone_system_credential'];
test('every site page command, including spreadsheet commits and template saves, routes to the site website',()=>{
 const c=harness(),request=new Request('https://fixture.invalid',{headers:{'x-guc-system':'site'}});
 for(const op of siteOperations)assert.equal(c.requestWebsite(request,new URLSearchParams(),op,{}),'site',op);
});
test('spreadsheet commands require site website access even without the BFF header',()=>{
 const c=harness(),request=new Request('https://fixture.invalid');
 for(const op of ['import_site_spreadsheet','save_site_spreadsheet_template']){
  const site=c.requestWebsite(request,new URLSearchParams(),op,{});assert.equal(site,'site');
  assert.equal(c.requestWebsite(request,new URLSearchParams('scope=finance'),op,{}),'site','query scope cannot reclassify a spreadsheet command');
  assert.throws(()=>c.requireWebsite({website_access:{erp:{login:true},site:{login:false}}},site),/權限/);
  assert.doesNotThrow(()=>c.requireWebsite({website_access:{erp:{login:false},site:{login:true}}},site));
 }
});
test('all site page reads include shared audit, equipment, spreadsheet and phone subpages',()=>{
 const c=harness(),request=new Request('https://fixture.invalid',{headers:{'x-guc-system':'site'}});
 for(const query of ['scope=session','scope=site_navigation','scope=site_customer','scope=sites','scope=site_spreadsheet','scope=access_device_import','entity=audit_logs','entity=monitoring_devices','entity=monitoring_device_detail','entity=monitoring_device_options','entity=monitoring_device_imports','entity=equipment_history','entity=maintenance_workers','entity=phone_extensions','entity=phone_systems','entity=phone_terminal_points','entity=phone_terminal_versions','entity=phone_security_audit'])assert.equal(c.requestWebsite(request,new URLSearchParams(query)),'site',query);
});
test('site website routing still rejects unrelated ERP commands and reads, including for admin',()=>{
 const c=harness(),request=new Request('https://fixture.invalid',{headers:{'x-guc-system':'site'}});
 for(const op of ['create_account','save_app_role','restore_database_backup','create_stock_receipt_document','unknown_import'])assert.throws(()=>c.requestWebsite(request,new URLSearchParams(),op,{}),/權限/,op);
 for(const query of ['scope=settings','scope=backup','entity=inventory'])assert.throws(()=>c.requestWebsite(request,new URLSearchParams(query)),/權限/,query);
});
test('accounting BFF cannot use spreadsheet writes; shared audit still needs audit permission',()=>{
 const c=harness(),request=new Request('https://fixture.invalid',{headers:{'x-guc-system':'quotation'}});
 for(const op of ['import_site_spreadsheet','save_site_spreadsheet_template'])assert.throws(()=>c.requestWebsite(request,new URLSearchParams(),op,{}),/權限/);
 const query=new URLSearchParams('entity=audit_logs');
 assert.throws(()=>c.authorizeRead({role:'custom',permissions:[{module:'site',can_view:true}]},query,true),/權限/);
 assert.doesNotThrow(()=>c.authorizeRead({role:'admin'},query,true));
});
