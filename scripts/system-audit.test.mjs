import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';import {AsyncLocalStorage} from 'node:async_hooks';
const source=fs.readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8'),compiled=stripTypeScriptTypes(source.replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
const id='10000000-0000-4000-8000-000000000001',user={id,username:'admin',display_name:'測試管理員',role:'admin',is_active:true,permissions:[]};
function harness(){let handler;const context=vm.createContext({Error,AsyncLocalStorage,performance,crypto,URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,console:{error:()=>{}},Deno:{env:{get:()=>''},serve:fn=>handler=fn}});vm.runInContext(compiled,context);context.currentUser=async()=>user;context.get=async()=>[];return {context,handler};}
test('form outcome metadata keeps only identifiers, never submitted credentials or financial values',()=>{
 const {context:c}=harness(),result=c.auditOperation('update_account',{id,password:'private-pw',notes:'user-private-text',salary:98765,rows:[{customer_id:id,token:'bad'}]});
 assert.equal(result.entityType,'app_users');assert.equal(result.action,'update');assert.equal(result.target.id,id);assert(!/private-pw|user-private-text|98765|bad/.test(JSON.stringify(result)));
});
test('legacy audit projection keeps missing actor unknown and does not fabricate identity or snapshots',()=>{
 const {context:c}=harness(),row=c.auditProjection({id:1,actor:null,before_data:null,after_data:{name:'舊資料'}});assert.equal(row.actor_evidence,'unknown');assert.equal(row.event_kind,'legacy');assert.equal(row.outcome,'recorded');assert.equal(row.before_data,null);
 assert.equal(c.auditProjection({actor:'歷史文字'}).actor_evidence,'text');assert.equal(c.auditProjection({actor:'姓名',actor_user_id:id}).actor_evidence,'account');
});
test('metadata and history use the same permission gate and database read path',async()=>{
 const {context:c}=harness(),paths=[];c.db=async path=>{paths.push(path);return Response.json([],{headers:{'content-range':'*/0'}});};
 await c.auditRecords(new URLSearchParams({include_history:'1',event_kind:'request',outcome:'failed',request_id:id}),user);assert.equal(paths.length,2);assert(paths.every(p=>p.startsWith('audit_logs?')));const q=new URLSearchParams(paths[0].split('?')[1]);assert.equal(q.get('event_kind'),'eq.request');assert.equal(q.get('request_id'),'eq.'+id);assert.equal(q.get('outcome'),'eq.failed');
 paths.length=0;await assert.rejects(c.auditRecords(new URLSearchParams({include_history:'1'}),{...user,role:'viewer',permissions:[]}));assert.equal(paths.length,0);
 for(const params of [{event_kind:'bad'},{outcome:'bad'},{request_id:'x'},{entity_id:'x'},{actor_user_id:'x'}])await assert.rejects(c.auditRecords(new URLSearchParams(params),user));
});
test('same-request identifiers survive row writes and outcome recording; forged context is ignored',async()=>{
 const h=harness(),events=[];h.context.change=async()=>{events.push(vm.runInContext('({...auditContext.getStore()})',h.context));return{id};};h.context.insert=async(_table,row)=>{events.push({...row,context:vm.runInContext('({...auditContext.getStore()})',h.context)});return[row];};
 const response=await h.handler(new Request('https://test.invalid/inventory-gateway',{method:'POST',headers:{'x-guc-audit-context':'forged'},body:JSON.stringify({operation:'update_supplier',payload:{id}})}));assert.equal(response.status,201);assert.equal(events.length,2);assert.equal(events[1].event_kind,'request');assert.equal(events[1].outcome,'completed');assert.equal(events[1].context.actorId,user.id);assert.equal(events[0].requestId,events[1].context.requestId);assert.equal(events[1].context.operation,'update_supplier');
});
test('audit result write failure preserves completed business response and exposes warning without retry',async()=>{
 const h=harness();let writes=0;h.context.change=async()=>{writes++;return{id};};h.context.insert=async()=>{throw Error('unavailable');};
 const response=await h.handler(new Request('https://test.invalid/inventory-gateway',{method:'POST',body:JSON.stringify({operation:'update_supplier',payload:{id}})}));assert.equal(response.status,201);const result=await response.json();assert.equal(result.result.id,id);assert(result.audit_warning);assert.equal(writes,1);
});
test('actual mutation rejection produces failed outcome without retaining error details or payload',async()=>{
 const h=harness(),entries=[];h.context.change=async()=>{throw Error('沒有此私人資料的操作權限。');};h.context.insert=async(_table,row)=>{entries.push(row);return[row];};
 const response=await h.handler(new Request('https://test.invalid/inventory-gateway',{method:'POST',body:JSON.stringify({operation:'delete_supplier',payload:{id,password:'sensitive'}})}));assert.equal(response.status,403);assert.equal(entries[0].outcome,'failed');assert.equal(entries[0].after_data.http_status,403);assert(!JSON.stringify(entries).includes('sensitive'));assert(!JSON.stringify(entries).includes('私人資料'));
});
test('audit presentation distinguishes account/text/unknown actors and labels current ERP forms',()=>{
 const c=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../audit-ui.js',import.meta.url),'utf8'),c);const a=c.GUCAudit;
 assert.equal(a.auditEntityLabel('supplier_return_documents'),'供應商退貨單');assert.equal(a.auditEntityLabel('role_permissions'),'角色權限');assert.equal(a.auditEvidence({actor:'舊姓名'}),'僅原始操作者文字');assert.equal(a.auditEvidence({}),'操作者未記錄');assert.equal(a.auditOutcome({outcome:'failed'}),'送出失敗');assert.equal(a.auditModuleLabel({entity_type:'site_return_documents'}),'進貨、取貨與退貨');assert.equal(a.auditChanges({after_data:{password:'bad'}})[0].after,'[已遮蔽]');
 assert.equal(a.auditChanges({after_data:{name:'有效內容',notes:null,floor:''}}).length,1);
});
