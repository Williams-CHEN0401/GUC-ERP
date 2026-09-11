import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
const source=readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8');
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
test('ERP Gateway sends manual business date through the existing permission boundary and one RPC',async()=>{
 let handler;const calls=[],user={id:randomUUID(),username:'test',display_name:'測試',role:'admin',is_active:true};
 const context=vm.createContext({Error,AsyncLocalStorage,performance,Deno:{env:{get:()=>''},serve:callback=>handler=callback},URL,Request,Response,Headers,AbortController,setTimeout,clearTimeout,console,crypto});
 vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'}),context);
 context.currentUser=async()=>user;context.rpc=async(name,args)=>{calls.push({name,args});return {project:{id:randomUUID(),project_date:args.p_project_date}};};
 const payload={name:'補登工作',customer_id:randomUUID(),project_type:'construction',status:'in_progress',project_date:'2025-12-01',worker_user_ids:[],estimated_cost:''};
 const response=await handler(new Request('https://fixture.test/functions/v1/inventory-gateway',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'create_erp_project',payload})}));
 assert.equal(response.status,201);assert.equal(calls.length,1);assert.equal(calls[0].name,'upsert_erp_project_with_workers_v3');assert.equal(calls[0].args.p_project_date,'2025-12-01');
});
test('business date is editable and precise report link uses shared customer selectors',()=>{
 assert.match(app,/inputField\("projectDate","工作日期","date",true,r\.projectDate\|\|today\(\)\)/);
 assert.match(app,/project_date:data\.projectDate/);
 assert.match(app,/get\("work_content_id"\)/);
 assert.match(app,/if\(name==="materials"\)applyWorkContentReportLink\(\)/);
 assert.match(app,/customerCategoryOptions\(customer\?\.category\|\|""\)/);
 assert.doesNotMatch(app,/selectField\("customerId","客戶",\[\["","請選擇客戶"\],\.\.\.sortRows\(state\.customers,/);
});
