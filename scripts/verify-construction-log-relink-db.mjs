// Synthetic identities and actual Gateway/RPC in PostgreSQL-WASM only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {constructionPermissionsServer} from './construction-permissions-fixture.mjs';
import {planUsers} from './construction-plan-fixture.mjs';
import {sql,definition,ids} from './worklog-save-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';
import {readdir} from 'node:fs/promises';
const f=await constructionPermissionsServer(),{db}=f,rpc=(n,a)=>callAsService(db,n,a);
const oldAssignment=await sql('20261016102818_worklog_plan_assignment.sql');
for(const name of ['save_construction_work_log_v1','preserve_construction_log_v1','preserve_construction_item_v1'])await db.exec(definition(oldAssignment,name));
const migration='20261113054605_construction_log_relink_existing.sql',checks=[];
const post=async(key,payload)=>{const r=await f.gatewayHandler(new Request('http://isolated.invalid/inventory-gateway',{method:'POST',headers:{authorization:'Bearer isolated-plan-'+key,'Content-Type':'application/json'},body:JSON.stringify({operation:'upsert_customer_project_work_log',payload})}));return{status:r.status,data:await r.json()};};
const good=r=>{assert.equal(r.status,201,JSON.stringify(r));return r.data.result.work_log;},bad=(r,re)=>{assert(r.status>=400,JSON.stringify(r));assert.match(r.data.error,re);};
const pass=s=>{checks.push(s);console.log('PASS '+checks.length+': '+s);};
try{
 await f.grant();
 const second=await rpc('save_construction_plan_v1',[planUsers.owner,JSON.stringify({...f.plan,id:randomUUID(),row_version:null,content:'另一棟大樓施工',items:[{id:randomUUID(),title:'配線',start_day:1,planned_days:2}]}),false]);
 second.items=(await db.query('select * from construction_plan_items where construction_plan_id=$1',[second.id])).rows;
 const regularPayload=f.logPayload('admin','2026-11-10');delete regularPayload.construction_plan_id;delete regularPayload.construction_item_id;regularPayload.summary='舊日誌施工紀錄\n待後續作業';regularPayload.completed_content='舊日誌施工紀錄';regularPayload.pending_content='待後續作業';
 const regular=good(await post('admin',regularPayload));
 const attach={...regularPayload,id:regular.id,row_version:regular.row_version,request_id:randomUUID(),construction_plan_id:f.plan.id,construction_item_id:f.plan.items[0].id};
 bad(await post('admin',attach),/日誌與施工規劃不相符/);
 const move={...f.logPayload('A','2026-11-03',f.logs[2]),construction_plan_id:second.id,construction_item_id:second.items[0].id};
 bad(await post('A',move),/日誌與施工規劃不相符/);pass('Latest RBAC reproduces both ordinary-log assignment and existing-plan reassignment failure');
 const identity=(await db.query("select oid,proowner,proacl,prosecdef,proconfig from pg_proc where oid='assert_construction_log_access_v1(uuid,uuid,uuid,text)'::regprocedure")).rows[0];
 // Exercise the last definition in migration order, as production will use it.
 // A later RBAC migration must not silently restore the old rejection again.
 const candidates=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort();
 let latest;
 for(const name of candidates){const text=await sql(name);if(/create\s+(?:or\s+replace\s+)?function\s+public\.assert_construction_log_access_v1\b/i.test(text))latest={name,text};}
 assert(latest&&latest.name>=migration,'Construction relink migration missing from latest chain');
 await db.exec(definition(latest.text,'assert_construction_log_access_v1'));
 assert.deepEqual((await db.query("select oid,proowner,proacl,prosecdef,proconfig from pg_proc where oid='assert_construction_log_access_v1(uuid,uuid,uuid,text)'::regprocedure")).rows[0],identity);
 const attached=good(await post('admin',{...attach,request_id:randomUUID()}));assert.equal(attached.construction_plan_id,f.plan.id);assert.equal(attached.construction_item_id,f.plan.items[0].id);assert.equal(attached.access_creator_user_id,regular.access_creator_user_id);assert.equal(attached.summary,regular.summary);assert.equal(attached.project_id,regular.project_id);assert.equal(attached.log_date,regular.log_date);pass('Admin assigns an ordinary historical log without changing content, date, project or immutable author');
 const samePlan=good(await post('admin',{...attach,row_version:attached.row_version,request_id:randomUUID(),construction_item_id:f.plan.items[1].id}));assert.equal(samePlan.construction_item_id,f.plan.items[1].id);pass('Already-linked logs can change subitems within the same plan');
 const ordinary=good(await post('admin',{...regularPayload,request_id:randomUUID()}));
 const ordinaryEdit=good(await post('admin',{...regularPayload,id:ordinary.id,row_version:ordinary.row_version,request_id:randomUUID(),summary:'一般日誌修改\n待後續作業',completed_content:'一般日誌修改'}));assert.equal(ordinaryEdit.construction_plan_id,null);assert.equal(ordinaryEdit.completed_content,'一般日誌修改');pass('Regular work-log edits remain available without a construction plan');
 const moved=good(await post('A',{...move,request_id:randomUUID()}));assert.equal(moved.construction_plan_id,second.id);assert.equal(moved.construction_item_id,second.items[0].id);assert.equal(moved.access_creator_user_id,planUsers.A);pass('Assigned author can move their log between plans of the same project');
 bad(await post('A',{...f.logPayload('A','2026-10-27',f.logs[1]),construction_plan_id:second.id,construction_item_id:second.items[0].id}),/權限/);
 await f.grant({construction_logs_all:{can_update:true}});
 const other=good(await post('A',{...f.logPayload('A','2026-10-27',f.logs[1]),construction_plan_id:second.id,construction_item_id:second.items[0].id}));assert.equal(other.access_creator_user_id,planUsers.B);pass('Other-author updates require the existing independent permission; author remains unchanged');
 bad(await post('A',{...move,request_id:randomUUID()}),/修改|版本|載入|變更/);
 bad(await post('admin',{...attach,row_version:attached.row_version,request_id:randomUUID(),construction_item_id:second.items[0].id}),/子項目不屬於/);pass('Stale versions and mismatched plan-item IDs remain rejected');
 await db.query("update construction_plans set status='cancelled' where id=$1",[second.id]);
 bad(await post('admin',{...attach,row_version:attached.row_version,request_id:randomUUID(),construction_plan_id:second.id,construction_item_id:second.items[0].id}),/權限/);
 bad(await post('viewer',{...attach,request_id:randomUUID()}),/權限|允許/);pass('Cancelled destinations and read-only users remain blocked');
 await rpc('configure_erp_private_access_v1',[ids.actor,ids.actor,[planUsers.owner],null]);
 await rpc('set_customer_private_v1',[ids.actor,ids.customer,(await db.query('select row_version from customers where id=$1',[ids.customer])).rows[0].row_version,true]);
 bad(await post('A',{...move,id:moved.id,row_version:moved.row_version,request_id:randomUUID()}),/權限|允許/);
 pass('Private customer access still overrides assignment and other-author update permissions');
 console.log('RESULT '+checks.length+' synthetic Gateway/PostgreSQL groups passed; production writes 0');
}finally{await db.close();}
