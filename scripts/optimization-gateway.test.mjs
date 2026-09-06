import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8');
const compiled=stripTypeScriptTypes(source.replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const user={id:id(1),username:'tester',display_name:'測試員',role:'admin',is_active:true};
function harness(){let handler;const calls=[];const context=vm.createContext({AsyncLocalStorage,performance,Deno:{env:{get:()=>''},serve:fn=>handler=fn},URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,console,crypto});vm.runInContext(compiled,context);context.currentUser=async()=>user;context.get=async path=>{calls.push(path);return[];};return{context,calls,handler};}
test('dashboard queries limit business rows on the server, with deterministic business dates and batched relations',async()=>{
 const h=harness();h.context.get=async path=>{h.calls.push(path);if(path.startsWith('site_work_logs?'))return[{id:id(2),project_id:id(3),log_date:'2026-09-06'}];if(path.startsWith('projects?select=id,name'))return[{id:id(3),customer_id:id(4),name:'專案'}];if(path.startsWith('customers?'))return[{id:id(4),name:'測試客戶'}];if(path.startsWith('site_work_log_workers?'))return[{work_log_id:id(2),user_id:id(1)}];if(path.startsWith('app_users?'))return[{id:id(1),display_name:'施工人員'}];return[];};
 const result=await h.context.dashboardSnapshot(user);assert.equal(result.dashboard.worklogs[0].customer,'測試客戶');assert.equal(result.dashboard.worklogs[0].workers,'施工人員');
 for(const path of h.calls.slice(0,3))assert.equal(new URLSearchParams(path.split('?')[1]).get('limit'),'15');
 const logQuery=new URLSearchParams(h.calls.find(p=>p.startsWith('site_work_logs?')).split('?')[1]);assert.equal(logQuery.get('order'),'log_date.desc,created_at.desc,id.desc');assert.ok(!logQuery.get('select').split(',').includes('customer_id'));
 assert.ok(h.calls.every(p=>!p.startsWith('pickup_records')));assert.equal(h.calls.length,7);
});
test('audit endpoint is admin-only, server-paginated, ordered, bounded, filtered, and redacts nested credentials',async()=>{
 const h=harness();let path;h.context.db=async p=>{path=p;return Response.json([{id:1,action:'UPDATE',before_data:{password:'bad',nested:[{access_token:'bad'}]},after_data:{notes:'Bearer sensitive-token',name:'名稱'}}],{headers:{'content-range':'25-49/80'}});};
 const params=new URLSearchParams({page:'2',page_size:'25',from:'2026-09-01',to:'2026-09-06',actor:'測試員',module:'phone',action:'update',q:'UPDATE'});
 const result=await h.context.auditRecords(params,user),query=new URLSearchParams(path.split('?')[1]);
 assert.equal(result.pagination.total,80);assert.equal(query.get('offset'),'25');assert.equal(query.get('order'),'created_at.desc,id.desc');assert.deepEqual(query.getAll('created_at'),['gte.2026-09-01T00:00:00+08:00','lt.2026-09-07T00:00:00+08:00']);assert.match(query.get('entity_type'),/phone_extensions/);assert.ok(!JSON.stringify(result).includes('sensitive-token'));assert.ok(!JSON.stringify(result).includes('bad'));assert.equal(result.records[0].after_data.name,'名稱');
 await assert.rejects(h.context.auditRecords(params,{...user,role:'viewer'}));
 await assert.rejects(h.context.auditRecords(new URLSearchParams({page:'1.5'}),user));
 await assert.rejects(h.context.auditRecords(new URLSearchParams({from:'2026-09-08',to:'2026-09-01'}),user));
});
test('each concurrent write forwards only its verified actor context',async()=>{
 const h=harness(),contexts=[];h.context.currentUser=async r=>({...user,username:r.headers.get('x-test-user'),display_name:r.headers.get('x-test-user')});
 h.context.change=async()=>{await new Promise(resolve=>setTimeout(resolve,5));contexts.push(vm.runInContext('auditContext.getStore()',h.context));return{};};
 const req=name=>new Request('https://example.test/functions/v1/inventory-gateway',{method:'POST',headers:{'Content-Type':'application/json','x-test-user':name,'x-guc-audit-context':'forged'},body:JSON.stringify({operation:'test'})});
 const responses=await Promise.all([h.handler(req('Alice')),h.handler(req('Bob'))]);assert.ok(responses.every(r=>r.ok));assert.deepEqual(contexts.map(c=>c.actor).sort(),['Alice','Bob']);assert.notEqual(contexts[0].requestId,contexts[1].requestId);
});
test('preview allows authenticated conflict lookups but blocks all mutations before the write handler',async()=>{
 const h=harness();let writes=0;h.context.change=async()=>writes++;h.context.monitoringIpConflicts=async()=>({ips:['10.0.0.1']});
 const req=operation=>new Request('https://example.test/functions/v1/inventory-gateway-preview-optimization',{method:'POST',body:JSON.stringify({operation,payload:{}})});
 assert.equal((await h.handler(req('check_monitoring_ip_conflicts'))).status,200);
 for(const operation of ['upsert_monitoring_device','update_account','logout','request_excel_sync','restore_database_backup'])assert.equal((await h.handler(req(operation))).status,403);
 assert.equal(writes,0);h.context.currentUser=async()=>null;assert.equal((await h.handler(req('check_monitoring_ip_conflicts'))).status,401);
});
test('spreadsheet export is absent while JSON recovery and import routes remain',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.doesNotMatch(app+html,/exportProjectMaterials|exportMaterials|exportInventory|text\/csv/);assert.doesNotMatch(source,/request_excel_sync/);assert.match(app,/exportBackup/);assert.match(source,/import_monitoring_devices/);assert.doesNotMatch(app,/activities\.unshift/);
});
test('every ERP list starts with its business date descending and resolves equal dates consistently',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');const context=vm.createContext({});
 vm.runInContext(app.match(/^const tableState = .+$/m)[0]+app.match(/^function sortRows.+$/m)[0]+';globalThis.tables=tableState;',context);
 for(const [name,key] of Object.entries({pickup:'date',receipt:'date',repair:'receivedOn',inventory:'createdAt',customer:'updatedRaw',project:'updatedRaw',supplier:'createdAt',user:'updatedRaw',log:'createdAt',worklog:'log_date'})){
  const config=context.tables[name];assert.equal(config.sortKey,key);assert.equal(config.direction,'desc');
  const rows=[{id:'1',[key]:'2026-01-01',created_at:'2026-01-01'},{id:'2',[key]:'2026-09-06',created_at:'2026-09-05'},{id:'3',[key]:'2026-09-06',created_at:'2026-09-06'}];assert.deepEqual(Array.from(context.sortRows(rows,key,config.direction),r=>r.id),['3','2','1']);
 }
});
test('audit detail resolves worker and contract IDs to names without losing original identifiers',async()=>{
 const h=harness();h.context.get=async path=>path.startsWith('app_users')?[{id:id(1),display_name:'施工人員'}]:[{id:id(2),name:'門禁系統'}];
 const rows=[{before_data:{user_id:id(1),service_type_id:id(2)},after_data:{worker_user_ids:[id(1)]}}];await h.context.auditDisplayNames(rows);assert.equal(rows[0].display_before.user_id,'施工人員');assert.equal(rows[0].display_before.service_type_id,'門禁系統');assert.equal(rows[0].before_data.user_id,id(1));assert.equal(rows[0].display_after.worker_user_ids[0],'施工人員');
});
