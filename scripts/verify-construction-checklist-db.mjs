// Explicit isolated Docker database only. Never accepts a production DB name.
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const database='guc_checklist_test_20261012',checks=[];
function sql(query){
 const r=spawnSync('docker',['exec','-i','supabase-db','psql','-U','supabase_admin','-d',database,'-X','-qAt','-v','ON_ERROR_STOP=1'],{input:query,encoding:'utf8',windowsHide:true});
 if(r.status!==0)throw Error(r.stderr.trim());return r.stdout.trim();
}
const quote=v=>v==null?'null':typeof v==='boolean'||typeof v==='number'?String(v):`'${String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")}'`;
const rpc=(name,...args)=>JSON.parse(sql(`set role service_role; select public.${name}(${args.map(quote).join(',')});`));
const id=()=>randomUUID(),admin=id(),owner=id(),worker=id(),outsider=id(),viewer=id(),customer=id(),project=id();
function check(name,fn){fn();checks.push({name,passed:true});console.log('PASS '+name);}
sql(`begin;
 insert into public.app_roles(code,name,project_scoped) values('checklist_owner','Checklist owner',true),('checklist_worker','Checklist worker',true),('checklist_viewer','Checklist viewer',true) on conflict do nothing;
 insert into public.role_permissions(role_code,module,can_view,can_create,can_update,can_delete) values
 ('checklist_owner','projects',true,true,true,true),('checklist_owner','worklogs',true,true,true,true),('checklist_owner','dashboard',true,false,false,false),
 ('checklist_worker','worklogs',true,true,true,true),('checklist_worker','dashboard',true,false,false,false),('checklist_viewer','worklogs',true,false,false,false) on conflict do nothing;
 ${[[admin,'admin'],[owner,'checklist_owner'],[worker,'checklist_worker'],[outsider,'checklist_worker'],[viewer,'checklist_viewer']].map(([user,role],i)=>`insert into auth.users(id,email) values('${user}','checklist-${user}@example.invalid'); insert into public.app_users(id,auth_user_id,username,display_name,role) values('${user}','${user}','checklist-${user.slice(0,12)}','Isolated checklist ${i}','${role}');`).join('\n')}
 insert into public.customers(id,name) values('${customer}','Isolated checklist customer');
 insert into public.projects(id,customer_id,name,project_type,construction_category,status) values('${project}','${customer}','Isolated checklist project','construction','small_purchase','in_progress');
 insert into public.project_workers(project_id,user_id,is_assignee,can_view) values('${project}','${owner}',true,true);
 commit;`);
const items=['A 棟配管施工','B 棟配管施工','C 棟配管施工'].map((title,i)=>({id:id(),title,start_day:i*4+1,planned_days:i===2?6:4}));
const payload={id:id(),project_id:project,construction_date:'2026-09-01',content:'配管施工',status:'pending',planned_days:14,assignee_user_ids:[worker,viewer],items};
const plan=rpc('save_construction_plan_v1',owner,payload,false);
const scope=(actor=owner)=>rpc('construction_scope_v1',actor,project).construction_plans.find(p=>p.id===plan.id);
function log(day,itemId=items[0].id,extras={}){
 const body={id:null,request_id:id(),project_id:project,customer_id:customer,department_id:null,project_name:'Isolated checklist project',construction_plan_id:plan.id,construction_item_id:itemId,
 log_date:day,time_period:'上午',work_type:'工程施工',status:'in_progress',summary:'已配管\n後續穿線',completed_content:'已配管',pending_content:'後續穿線',worker_user_ids:[worker],maintenance_events:[],...extras};
 return rpc('save_construction_work_log_v1',worker,plan.id,body);
}
check('new plan saves three independently scheduled items',()=>{assert.equal(scope().items.length,3);assert.equal(scope().completion_percent,0);});
check('8 unique dates count 8 days including in-progress logs; same-day duplicates count once',()=>{
 for(let d=1;d<=8;d++)log(`2026-09-${String(d).padStart(2,'0')}`);
 log('2026-09-01',items[1].id);log('2026-09-01',items[1].id);
 const p=scope();assert.equal(p.worked_days,8);assert.equal(p.remaining_days,6);assert.equal(p.completion_percent,0);assert.equal(p.needs_attention,false);assert.equal(p.items[1].worked_days,1);
});
check('14-day plan warns at day 12, not day 11, for item C with no log',()=>{
 for(let d=9;d<=11;d++)log(`2026-09-${d}`);
 assert.equal(scope().needs_attention,false);log('2026-09-12');
 const p=scope();assert.equal(p.worked_days,12);assert.equal(p.warning_after_days,12);assert.equal(p.needs_attention,true);assert.deepEqual(p.unstarted_items.map(i=>i.title),['C 棟配管施工']);
});
check('future work-log dates do not count as executed days',()=>{log('2099-01-01',items[2].id);assert.equal(scope().worked_days,12);assert.equal(scope().needs_attention,true);});
check('assigned worker can complete an item; stale versions and outsiders are rejected',()=>{
 const before=scope().items[0];rpc('set_construction_item_completed_v1',worker,before.id,before.row_version,true);
 assert.equal(scope().completion_percent,33.3);assert.equal(scope().worked_days,12);
 assert.throws(()=>rpc('set_construction_item_completed_v1',worker,before.id,before.row_version,false),/其他使用者更新/);
 const next=scope().items[1];assert.throws(()=>rpc('set_construction_item_completed_v1',outsider,next.id,next.row_version,true),/只有專案負責人/);
 assert.throws(()=>rpc('set_construction_item_completed_v1',viewer,next.id,next.row_version,true),/只有專案負責人/);
});
check('all checked items complete the plan; reopening restores warning',()=>{
 for(const i of scope().items.filter(i=>!i.is_completed))rpc('set_construction_item_completed_v1',owner,i.id,i.row_version,true);
 let p=scope();assert.equal(p.completion_percent,100);assert.equal(p.status,'completed');assert.equal(p.needs_attention,false);
 const c=p.items[2];rpc('set_construction_item_completed_v1',worker,c.id,c.row_version,false);
 p=scope();assert.equal(p.status,'in_progress');assert.equal(p.completion_percent,66.7);assert.equal(p.needs_attention,true);
});
check('unlinked new logs, cross-plan items and changing an existing association are rejected',()=>{
 assert.throws(()=>log('2026-09-13',null),/請選擇.*子項目/);
 assert.throws(()=>log('2026-09-13',id()),/不屬於/);
 const saved=log('2026-09-12').work_log;
 assert.throws(()=>log('2026-09-12',items[1].id,{id:saved.id,row_version:saved.row_version}),/不能變更/);
});
check('idempotency key cannot be replayed against another checklist item',()=>{
 const request=id();log('2026-09-12',items[0].id,{request_id:request});
 assert.throws(()=>log('2026-09-12',items[1].id,{request_id:request}),/其他子項目|送出識別碼/);
});
check('removal of logged items, invalid schedules, forged completion and stale plans are rejected',()=>{
 const p=scope();
 assert.throws(()=>rpc('save_construction_plan_v1',owner,{...payload,row_version:p.row_version,status:p.status,items:[]},false),/不能移除/);
 assert.throws(()=>rpc('save_construction_plan_v1',owner,{...payload,row_version:p.row_version,status:p.status,items:items.map(i=>({...i,planned_days:99}))},false),/總工期/);
 assert.throws(()=>rpc('save_construction_plan_v1',owner,{...payload,row_version:p.row_version,status:'completed'},false),/勾選完成/);
 assert.throws(()=>rpc('save_construction_plan_v1',owner,{...payload,row_version:1,status:p.status},false),/其他使用者更新/);
});
check('a log for C clears warning; archiving it restores warning and preserves day deduplication',()=>{
 const saved=log('2026-09-12',items[2].id).work_log;assert.equal(scope().needs_attention,false);
 sql(`update public.site_work_logs set deleted_at=now() where id='${saved.id}';`);assert.equal(scope().needs_attention,true);assert.equal(scope().worked_days,12);
});
check('legacy plan-level logs remain readable and editable without forced reassignment',()=>{
 const legacy=rpc('save_construction_plan_v1',owner,{...payload,id:id(),items:[]},false);
 const body={id:null,request_id:id(),project_id:project,customer_id:customer,project_name:'Isolated checklist project',department_id:null,log_date:'2026-09-01',work_type:'工程施工',status:'in_progress',summary:'Legacy work',worker_user_ids:[worker],maintenance_events:[]};
 const saved=rpc('save_construction_work_log_v1',worker,legacy.id,body).work_log;
 const current=rpc('construction_scope_v1',owner,project).construction_plans.find(p=>p.id===legacy.id);
 rpc('save_construction_plan_v1',owner,{...payload,id:legacy.id,row_version:current.row_version,items:[{...items[0],id:id()}]},false);
 const edited=rpc('save_construction_work_log_v1',worker,legacy.id,{...body,id:saved.id,row_version:saved.row_version,summary:'Legacy edited',request_id:id()}).work_log;
 assert.equal(edited.construction_item_id,null);
});
check('RLS enabled; browser roles cannot access checklist tables or privileged RPCs',()=>{
 assert.equal(sql("select relrowsecurity from pg_class where oid='public.construction_plan_items'::regclass;"),'t');
 for(const role of ['anon','authenticated']){
  assert.equal(sql(`select has_table_privilege('${role}','public.construction_plan_items','select,insert,update,delete');`),'f');
  for(const signature of ['set_construction_item_completed_v1(uuid,uuid,integer,boolean)','save_construction_plan_v1(uuid,jsonb,boolean)','save_construction_work_log_v1(uuid,uuid,jsonb)','construction_scope_v1(uuid,uuid)'])assert.equal(sql(`select has_function_privilege('${role}','public.${signature}','execute');`),'f');
 }
});
writeFileSync('F:/GUC-Docker/backups/construction-checklist-2026-10-12/database-tests.json',JSON.stringify({database,checks},null,2));
console.log(`${checks.length} isolated database checks passed.`);
