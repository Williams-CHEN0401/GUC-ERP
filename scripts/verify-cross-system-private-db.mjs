// Cross-repository integration: real current quotation and ERP migrations/RPCs.
// All identities, records and Postgres storage are synthetic in-memory PGlite.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {sql,definition} from './worklog-save-fixture.mjs';
const quotationRoot=process.env.QUOTATION_REPO_PATH||resolve('../GUC-Quotation-search-sort-0926');
const qImport=path=>import(pathToFileURL(resolve(quotationRoot,path)).href);
const {multiWorkDatabase}=await qImport('tests/multi-work-fixture.mjs');
const {actor,outsider,customer,project,createQuote}=await qImport('tests/database-fixture.mjs');
const {quotationGateway,rpcCall}=await qImport('tests/gateway-fixture.mjs');
const db=await multiWorkDatabase();
const rpc=(name,parameters)=>rpcCall(db,name,parameters);
const results=[],pass=label=>{results.push(label);console.log('PASS '+label);};
try{
 await db.exec(`
 alter table customers add row_version integer default 1,add updated_at timestamptz default now();
 alter table site_work_logs add reporter_user_id uuid references app_users;
 alter table project_workers add can_create_work_log boolean default false,add can_update_work_log boolean default false,add can_delete_work_log boolean default false;
 create table stock_receipts(id uuid primary key,inventory_item_id uuid,quantity numeric);
 create table stock_receipt_customers(stock_receipt_id uuid references stock_receipts,customer_id uuid references customers);
 create table sites(id uuid primary key,customer_id uuid references customers,project_id uuid references projects,contract_service_type_id uuid,status text);
 create table site_devices(id uuid primary key,site_id uuid references sites,device_type text,device_brand text,device_model text,cabinet text,network_cable_no text,deleted_at timestamptz);
 create table equipment_registry(id uuid primary key,customer_id uuid references customers,service_id uuid,site_id uuid references sites,source_table text,source_id uuid,status text,equipment_type text,search_key text,display_name text);
 create table maintenance_event_equipment(event_id uuid references maintenance_events,equipment_id uuid references equipment_registry);
 create table maintenance_event_workers(event_id uuid references maintenance_events,user_id uuid references app_users);
 create table phone_terminal_versions(id uuid primary key,customer_id uuid references customers,version_no integer);
 alter table maintenance_events add service_id uuid,add event_type text,add cause text,add notes text,add phone_terminal_version_id uuid references phone_terminal_versions,add row_version integer default 1,add created_at timestamptz default now(),add updated_at timestamptz default now();
 create table contract_service_types(id uuid primary key,code text,is_active boolean);
 create table customer_contract_services(customer_id uuid references customers,service_type_id uuid references contract_service_types,is_active boolean);
 `);
 // Existing ERP project-RBAC implementation, not a permissive test stub.
 await db.exec(definition(await sql('20260908060047_role_permissions_project_scope.sql'),'has_project_permission_v1'));
 await db.exec(await sql('20261004152032_erp_private_data_access.sql'));
 for(const [file,name] of [
  ['20260914130833_add_maintenance_handling_process.sql','get_equipment_history_v1'],
  ['20260907155544_customer_services_and_shared_history.sql','search_equipment_history_v1'],
  ['20260908064210_customer_filters_phone_versions_purchase_customers.sql','monitoring_customer_filters_v1']])await db.exec(definition(await sql(file),name));
 await db.exec(`revoke all on function get_equipment_history_v1(text,uuid),search_equipment_history_v1(uuid,uuid,text,text,integer),monitoring_customer_filters_v1(uuid) from public,anon,authenticated;grant execute on function get_equipment_history_v1(text,uuid),search_equipment_history_v1(uuid,uuid,text,text,integer),monitoring_customer_filters_v1(uuid) to service_role;`);
 await db.exec(await sql('20261005005222_cross_system_private_access.sql'));
 await db.exec(await readFile(resolve(quotationRoot,'supabase/migrations/20261005005228_quotation_private_access.sql'),'utf8'));
 // Existing quote access is still required, independently of private allowlist.
 await db.query('insert into quotation_access_users(app_user_id) values($1)',[outsider]);
 const qGateway=quotationGateway(db);
 let identity=actor;
 qGateway.context.currentUser=async()=>({id:identity,username:'synthetic',role:'admin',is_active:true});
 const get=async entity=>{const response=await qGateway.handler(new Request('https://fixture.supabase.co/functions/v1/quotation-gateway?'+entity));return{status:response.status,body:await response.json()};};
 const post=async(operation,payload)=>{const response=await qGateway.handler(new Request('https://fixture.supabase.co/functions/v1/quotation-gateway',{method:'POST',body:JSON.stringify({operation,payload})}));return{status:response.status,body:await response.json()};};
 const publicCustomer=randomUUID(),publicProject=randomUUID(),mixedProject=randomUUID(),privateWork=randomUUID(),publicLog=randomUUID(),privateLog=randomUUID(),ownLog=randomUUID();
 await db.query("insert into customers(id,name) values($1,'PUBLIC_CUSTOMER')",[publicCustomer]);
 for(const [id,name] of [[publicProject,'PUBLIC_WORK'],[mixedProject,'MIXED_WORK'],[privateWork,'PRIVATE_WORK']])await db.query("insert into projects(id,customer_id,name,status,project_type,project_date) values($1,$2,$3,'in_progress','construction','2026-10-05')",[id,publicCustomer,name]);
 const original=await createQuote(db);
 const input={customer_id:publicCustomer,project_id:publicProject,owner_user_id:actor,quote_date:'2026-10-05',valid_until:'2026-11-05',discount_twd:0,tax_rate_basis_points:0,items:[{description:'PUBLIC_ITEM',quantity_milli:1000,unit:'式',unit_price_twd:1000}]};
 let created=await post('create_quotation',{...input,request_id:randomUUID()});assert.equal(created.status,201,JSON.stringify(created));
 const allowedQuote=created.body.result;
 await rpc('configure_erp_private_access_v1',{p_actor_user_id:actor,p_owner_user_id:actor,p_viewer_user_ids:[],p_row_version:null});
 await rpc('set_customer_private_v1',{p_actor_user_id:actor,p_customer_id:customer,p_row_version:1,p_is_private:true});
 for(const [id,pid,reporter,title] of [[publicLog,mixedProject,outsider,'PUBLIC_LOG'],[privateLog,mixedProject,actor,'PRIVATE_LOG'],[ownLog,privateWork,actor,'PRIVATE_ONLY_LOG']])
  await db.query("insert into site_work_logs(id,project_id,reporter_user_id,title,log_date,work_type) values($1,$2,$3,$4,'2026-10-05','repair')",[id,pid,reporter,title]);
 identity=outsider;
 const options=await get('entity=options');assert.equal(options.status,200,JSON.stringify(options));
 assert.ok(!options.body.customers.some(r=>r.id===customer));assert.ok(!options.body.projects.some(r=>r.id===privateWork));
 const list=await get('entity=work_list&page_size=10');assert.equal(list.status,200,JSON.stringify(list));
 assert.equal(list.body.total,2);assert.ok(!JSON.stringify(list).includes('PRIVATE'));
 const empty=await get('entity=work_list&search=PRIVATE');assert.equal(empty.body.total,0);
 const dashboard=await get('entity=dashboard');assert.equal(dashboard.status,200,JSON.stringify(dashboard));assert.equal(dashboard.body.summary.total,1);
 pass('Quotation options, work list/search/pagination and dashboard filter before aggregation');
 for(const query of ['entity=detail&id='+original.quotation.id,'entity=version_detail&id='+original.quotation.id+'&version_id='+original.current_version.id,'entity=work_detail&project_id='+privateWork])assert.equal((await get(query)).status,403,query);
 for(const operation of ['update_quotation_status','update_quotation_invoice','update_quotation_billing_status','create_quotation_version','void_quotation','delete_quotation','record_excel_export']){
  const denied=await post(operation,{id:original.quotation.id,quotation_id:original.quotation.id,row_version:original.quotation.row_version,status:'confirmed',reason:'test',version_id:original.current_version.id,filename:'test.xlsx'});
  assert.equal(denied.status,403,operation+':'+JSON.stringify(denied));
 }
 pass('Direct quote/version/export/status/invoice/delete API denial; no admin bypass');
 const {handleExcelExport}=await qImport('lib/quotation-excel-server.ts');
 let templateReads=0;
 const exportResponse=await handleExcelExport(new Request('https://fixture.test/api/quotation-excel/export',{method:'POST',headers:{Authorization:'Bearer synthetic-test-token','Content-Type':'application/json'},body:JSON.stringify({quotation_id:original.quotation.id,version_id:original.current_version.id})}),{
  // Transport adapter routes only to this in-memory handler, never the real URL.
  production:true,fetch:(url,init)=>{const isolated=new URL(url);isolated.pathname='/functions/v1/quotation-gateway';return qGateway.handler(new Request(isolated,init));},loadTemplate:async()=>{templateReads++;throw Error('Private template must not be read for a denied quotation');}
 });
 assert.equal(exportResponse.status,403,await exportResponse.clone().text());assert.equal(templateReads,0);
 pass('Actual Excel export route denies private quote before template access or file generation');
 const detail=await get('entity=work_detail&project_id='+mixedProject);assert.equal(detail.status,200,JSON.stringify(detail));
 assert.equal(detail.body.total,1);assert.ok(!JSON.stringify(detail.body).includes('PRIVATE_LOG'));assert.ok(JSON.stringify(detail.body).includes('PUBLIC_LOG'));
 pass('Mixed public work keeps public logs, excludes private logs before count/limit');
 const forbiddenInput=await post('create_quotation',{...input,request_id:randomUUID(),project_id:privateWork,work_content_ids:[]});assert.equal(forbiddenInput.status,403,JSON.stringify(forbiddenInput));
 // Only the secondary work is private; the primary customer's/work's IDs remain public.
 identity=actor;
 const updateInput={...input,id:allowedQuote.quotation.id,row_version:allowedQuote.quotation.row_version,version_row_version:allowedQuote.current_version.row_version,work_content_ids:[privateWork]};
 const combined=await post('update_quotation',updateInput);assert.equal(combined.status,201,JSON.stringify(combined));
 identity=outsider;
 assert.equal((await get('entity=detail&id='+allowedQuote.quotation.id)).status,403);
 assert.ok(!(await get('entity=list')).body.records.some(r=>r.id===allowedQuote.quotation.id));
 pass('Secondary private work protects entire combined quotation and versions');
 identity=actor;assert.equal((await get('entity=detail&id='+allowedQuote.quotation.id)).status,200);
 identity=outsider;
 // Non-authorized raw roles cannot enter wrappers, views, helpers or originals.
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);
  await assert.rejects(rpc('quotation_work_list_v1',{p_actor_user_id:actor,p_filters:{}}),/permission denied/);
  await assert.rejects(db.query('select * from erp_private_customers'),/permission denied/);
  await assert.rejects(rpc('erp_private_prepare_v1',{p_actor_user_id:actor}),/permission denied/);
  await assert.rejects(rpc('get_equipment_history_v1',{p_source_table:'site_devices',p_source_id:randomUUID()}),/permission denied/);
  await assert.rejects(rpc('private_get_equipment_history_v1',{p_private_actor:actor,p_source_table:'site_devices',p_source_id:randomUUID()}),/permission denied/);
  await db.exec('reset role');
 }
 await db.exec('set role service_role');await assert.rejects(rpc('private_base_quotation_work_list_v1',{p_actor_user_id:actor,p_filters:{}}),/permission denied/);await db.exec('reset role');
 pass('Existing allowed identity works; client roles/internal-original ACL deny bypass');
 const service=randomUUID(),equipment=randomUUID(),source=randomUUID(),eventPublic=randomUUID(),eventPrivate=randomUUID();
 await db.query("insert into equipment_registry(id,customer_id,service_id,source_table,source_id,status,equipment_type,display_name,search_key) values($1,$2,$3,'site_devices',$4,'active','camera','PUBLIC_DEVICE','public')",[equipment,publicCustomer,service,source]);
 for(const [id,lid,label,date] of [[eventPublic,publicLog,'PUBLIC_EVENT','2026-10-01'],[eventPrivate,privateLog,'PRIVATE_EVENT','2026-10-05']]){
  await db.query('insert into maintenance_events(id,work_log_id,description,occurred_at) values($1,$2,$3,$4)',[id,lid,label,date]);
  await db.query('insert into maintenance_event_equipment values($1,$2)',[id,equipment]);
 }
 const history=await rpc('private_get_equipment_history_v1',{p_private_actor:outsider,p_source_table:'site_devices',p_source_id:source});
 assert.equal(history.summary.total,1);assert.equal(history.events.length,1);assert.equal(history.events[0].description,'PUBLIC_EVENT');
 const search=await rpc('private_search_equipment_history_v1',{p_private_actor:outsider,p_customer_id:publicCustomer,p_service_id:service});
 assert.equal(search.total,1);assert.equal(search.records[0].total,1);assert.ok(!JSON.stringify(search).includes('2026-10-05'));
 assert.equal((await rpc('private_get_equipment_history_v1',{p_private_actor:actor,p_source_table:'site_devices',p_source_id:source})).summary.total,2);
 await assert.rejects(rpc('private_search_equipment_history_v1',{p_private_actor:outsider,p_customer_id:customer,p_service_id:service}),/權限/);
 pass('Site history/search hide private event, total and latest date, allowed viewer retains both');
 // A private project under a public customer must not leak through device facets.
 const publicSite=randomUUID(),privateSite=randomUUID(),privateSource=randomUUID();
 await db.query("insert into contract_service_types values($1,'surveillance',true)",[service]);
 await db.query('insert into customer_contract_services values($1,$2,true)',[publicCustomer,service]);
 for(const [id,pid] of [[publicSite,mixedProject],[privateSite,privateWork]])await db.query("insert into sites values($1,$2,$3,$4,'active')",[id,publicCustomer,pid,service]);
 for(const [id,site,brand] of [[source,publicSite,'PUBLIC_BRAND'],[privateSource,privateSite,'PRIVATE_BRAND']])await db.query("insert into site_devices(id,site_id,device_type,device_brand) values($1,$2,'camera',$3)",[id,site,brand]);
 await db.query("insert into equipment_registry(id,customer_id,service_id,source_table,source_id,status,equipment_type,display_name) values($1,$2,$3,'site_devices',$4,'active','private_type','PRIVATE_DEVICE')",[randomUUID(),publicCustomer,service,privateSource]);
 const filters=await rpc('private_monitoring_customer_filters_v1',{p_private_actor:outsider,p_customer_id:publicCustomer});assert.deepEqual(filters.brands,['PUBLIC_BRAND']);
 assert.equal((await rpc('private_search_equipment_history_v1',{p_private_actor:outsider,p_customer_id:publicCustomer,p_service_id:service})).total,1);
 let siteHandler;
 const context=vm.createContext({AsyncLocalStorage,performance,URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,crypto,console,Deno:{env:{get:()=>''},serve:fn=>siteHandler=fn}});
 const sourceCode=(await readFile(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8')).replace(/^import .*node:async_hooks.*;\r?\n/m,'');
 vm.runInContext(stripTypeScriptTypes(sourceCode,{mode:'strip'}),context);
 context.rpc=(name,args)=>rpc(name,args);
 context.currentUser=async()=>{const user={id:identity,role:'admin',username:'synthetic',is_active:true};await context.initializePrivateAccess(user);return user;};
 const siteGet=async query=>siteHandler(new Request('https://fixture.test/inventory-gateway?'+query,{headers:{'x-guc-system':'site'}}));
 let siteResponse=await siteGet('entity=equipment_history&source_table=site_devices&source_id='+source);
 assert.equal(siteResponse.status,200,await siteResponse.clone().text());assert.equal((await siteResponse.json()).summary.total,1);
 siteResponse=await siteGet('entity=equipment_history_search&customer_id='+publicCustomer+'&service_id='+service);assert.equal(siteResponse.status,200,await siteResponse.clone().text());assert.equal((await siteResponse.json()).total,1);
 for(const query of ['entity=equipment_history&source_table=site_devices&source_id='+privateSource,'scope=site_customer&customer_id='+customer.toUpperCase(),'entity=monitoring_device_detail&id='+privateSource])assert.equal((await siteGet(query)).status,403,query);
 const writesBefore=(await db.query('select count(*)::int n from maintenance_events')).rows[0].n;
 for(const operation of ['save_equipment_history','reveal_phone_system_credential','import_monitoring_devices','batch_update_phone_extensions','create_phone_terminal_version']){
  const response=await siteHandler(new Request('https://fixture.test/inventory-gateway',{method:'POST',body:JSON.stringify({operation,payload:{customer_id:customer.toUpperCase()}})}));
  assert.equal(response.status,403,operation+':'+await response.text());
 }
 const restore=await siteHandler(new Request('https://fixture.test/inventory-gateway',{method:'POST',body:JSON.stringify({operation:'restore_database_backup',payload:{backup:{}}})}));assert.equal(restore.status,403);
 assert.equal((await db.query('select count(*)::int n from maintenance_events')).rows[0].n,writesBefore);
 pass('Actual Site Gateway protects history/direct URLs/imports/batch/credential writes, including uppercase IDs');
 // Deployed Preview aliases share the privacy guard and retain their write ban.
 const quotePreview='https://fixture.supabase.co/functions/v1/quotation-gateway-preview';
 assert.equal((await qGateway.handler(new Request(quotePreview+'?entity=detail&id='+original.quotation.id))).status,404); // Preview never serves production quotation detail.
 assert.equal((await qGateway.handler(new Request(quotePreview+'?entity=work_detail&project_id='+privateWork))).status,403);
 assert.equal((await qGateway.handler(new Request(quotePreview,{method:'POST',body:JSON.stringify({operation:'create_quotation',payload:input})}))).status,403);
 const sitePreview='https://fixture.test/functions/v1/inventory-gateway-preview-optimization';
 assert.equal((await siteHandler(new Request(sitePreview+'?entity=equipment_history&source_table=site_devices&source_id='+privateSource))).status,403);
 assert.equal((await siteHandler(new Request(sitePreview,{method:'POST',body:JSON.stringify({operation:'save_equipment_history',payload:{}})}))).status,403);
 assert.match(await readFile(new URL('../supabase/functions/inventory-gateway-preview-optimization/index.ts',import.meta.url),'utf8'),/import "\.\.\/inventory-gateway\/index\.ts"/);
 pass('Production and Preview share private read denial; Preview remains read-only');
 // Single-log approval never becomes quotation/site/customer access.
 const request=await rpc('request_work_log_access_v1',{p_actor_user_id:outsider,p_work_log_id:ownLog});
 await rpc('review_work_log_access_v1',{p_actor_user_id:actor,p_request_id:request.id,p_row_version:request.row_version,p_approved:true});
 assert.equal((await rpc('read_shared_work_log_v1',{p_actor_user_id:outsider,p_work_log_id:ownLog})).id,ownLog);
 assert.equal((await get('entity=detail&id='+allowedQuote.quotation.id)).status,403);
 assert.equal((await siteGet('entity=equipment_history&source_table=site_devices&source_id='+privateSource)).status,403);
 pass('Single-log approval does not grant quotation, linked work or Site access');
 await db.query('update site_work_logs set deleted_at=now() where id=$1',[ownLog]);
 assert.equal((await get('entity=detail&id='+allowedQuote.quotation.id)).status,403,'archiving a private log cannot publish its linked quotation/history');
 pass('Archived private logs retain privacy for related historical quotation data');
 // Public lifecycle remains available: create, update, reread, status, billing, delete.
 const lifecycleProject=randomUUID();await db.query("insert into projects(id,customer_id,name,status,project_type,project_date) values($1,$2,'LIFECYCLE','in_progress','construction','2026-10-05')",[lifecycleProject,publicCustomer]);
 const publicInput={...input,project_id:lifecycleProject,work_content_ids:[],request_id:randomUUID()};
 let lifecycle=await post('create_quotation',publicInput);assert.equal(lifecycle.status,201,JSON.stringify(lifecycle));let q=lifecycle.body.result;
 lifecycle=await post('update_quotation',{...publicInput,id:q.quotation.id,row_version:q.quotation.row_version,version_row_version:q.current_version.row_version,note:'PUBLIC_UPDATE'});assert.equal(lifecycle.status,201,JSON.stringify(lifecycle));q=lifecycle.body.result;
 assert.equal((await get('entity=detail&id='+q.quotation.id)).body.current_version.note,'PUBLIC_UPDATE');
 lifecycle=await post('update_quotation_status',{id:q.quotation.id,row_version:q.quotation.row_version,status:'confirmed'});assert.equal(lifecycle.status,201,JSON.stringify(lifecycle));q=lifecycle.body.result;
 lifecycle=await post('update_quotation_invoice',{id:q.quotation.id,row_version:q.quotation.row_version,invoice_number:'ZZ00000001',invoice_date:'2026-10-05'});assert.equal(lifecycle.status,201,JSON.stringify(lifecycle));assert.equal(lifecycle.body.result.quotation.billing_status,'in_progress');
 const deletionProject=randomUUID();await db.query("insert into projects(id,customer_id,name,status,project_type,project_date) values($1,$2,'DELETE_PUBLIC','in_progress','construction','2026-10-05')",[deletionProject,publicCustomer]);
 const deletion=await post('create_quotation',{...publicInput,project_id:deletionProject,request_id:randomUUID()});q=deletion.body.result;
 assert.equal((await post('delete_quotation',{id:q.quotation.id,row_version:q.quotation.row_version,reason:'synthetic delete'})).status,201);
 assert.ok((await db.query('select id from projects where id=$1',[deletionProject])).rows.length);
 pass('Public quote create/edit/reread/confirm/invoice/delete lifecycle keeps original ERP records');
 // Scopes are refreshed across statements, never inherited from the previous user.
 await assert.rejects(db.query("select erp_private_json_visible_v1('{}')"),/尚未完成/);
 identity=actor;assert.equal((await get('entity=detail&id='+original.quotation.id)).status,200);
 identity=outsider;assert.equal((await get('entity=detail&id='+original.quotation.id)).status,403);
 await db.query('update app_users set is_active=false where id=$1',[outsider]);assert.equal((await get('entity=work_list')).status,403);
 await db.query('update app_users set is_active=true where id=$1',[outsider]);
 pass('No transaction scope leakage; account deactivation immediately denies SQL access');
 console.log(JSON.stringify({passed:results.length,productionWrites:0}));
}catch(error){console.error(error.message,error.where||'',error.stack?.split('\n').filter(line=>line.includes('verify-cross-system')).join('\n'));process.exitCode=1;}finally{await db.close();}
