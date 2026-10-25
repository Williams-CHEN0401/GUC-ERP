// Explicit synthetic database only. No production connection argument is accepted.
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const database='guc_monitor_20261025',checks=[];
function sql(q){const r=spawnSync('docker',['exec','-i','supabase-db','psql','-U','supabase_admin','-d',database,'-X','-qAt','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',windowsHide:true,maxBuffer:8e6});if(r.status!==0)throw Error(r.stderr.trim());return r.stdout.trim();}
const literal=v=>v==null?'null':typeof v==='number'||typeof v==='boolean'?String(v):"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
const rpc=(name,...args)=>JSON.parse(sql(`set role service_role;select to_jsonb(public.${name}(${args.map(literal).join(',')}));`));
const id=()=>randomUUID(),admin='35033078-6d17-4f14-8608-048f700a78a9',owner=id(),worker=id(),outsider=id(),viewer=id(),customer=id(),project=id();
function check(name,fn){fn();checks.push({name,passed:true});console.log('PASS '+name);}
sql(`begin;
insert into public.app_roles(code,name,project_scoped) values('monitor_owner','Monitor owner',true),('monitor_worker','Monitor worker',true),('monitor_viewer','Monitor viewer',true) on conflict do nothing;
insert into public.role_permissions(role_code,module,can_view,can_create,can_update,can_delete) values
('monitor_owner','projects',true,true,true,true),('monitor_owner','worklogs',true,true,true,true),('monitor_owner','reports',true,true,true,true),('monitor_owner','accounting_reports',true,true,true,true),
('monitor_worker','worklogs',true,true,true,true),('monitor_worker','reports',true,false,false,false),('monitor_worker','projects',true,false,false,false),
('monitor_viewer','projects',true,false,false,false),('monitor_viewer','worklogs',true,false,false,false),('monitor_viewer','reports',true,false,false,false) on conflict do nothing;
${[[owner,'monitor_owner'],[worker,'monitor_worker'],[outsider,'monitor_owner'],[viewer,'monitor_viewer']].map(([user,role],i)=>`insert into auth.users(id,email) values('${user}','monitor-${user}@example.invalid');insert into public.app_users(id,auth_user_id,username,display_name,role) values('${user}','${user}','monitor-${user.slice(0,12)}','監控測試人員${i}','${role}');`).join('\n')}
insert into public.customers(id,name) values('${customer}','監控合成驗收客戶 ${customer.slice(0,8)}');
insert into public.projects(id,customer_id,name,project_type,construction_category,status,assigned_to) values('${project}','${customer}','履約監控合成驗收','construction','small_purchase','in_progress','監控測試人員0');
insert into public.project_workers(project_id,user_id,is_assignee,can_view) values('${project}','${owner}',true,true),('${project}','${worker}',false,true),('${project}','${viewer}',false,true);
commit;`);
const items=Array.from({length:7},(_,i)=>({id:id(),title:`施工項目${i+1}`,start_day:1,planned_days:i===0?4:1}));
const payload={id:id(),project_id:project,construction_date:'2026-10-01',content:'行政大樓讀卡機施工（合成驗收）',status:'pending',planned_days:7,assignee_user_ids:[worker,owner],items,warning_work_days:3,warning_min_progress:30};
let plan=rpc('save_construction_plan_v1',owner,payload,false);
const scope=(actor=owner)=>rpc('construction_scope_v1',actor,project).construction_plans.find(p=>p.id===plan.id);
const report=(actor=owner,accounting=false,from=null,to=null)=>rpc('work_content_report_v1',actor,project,from,to,null,accounting);
const save=(patch={},actor=owner)=>{const p=scope();return rpc('save_construction_plan_v1',actor,{...payload,row_version:p.row_version,status:p.status,...patch},false);};
const complete=(index,value,actor=owner)=>{const item=scope().items.find(i=>i.id===items[index].id);return rpc('set_construction_item_completed_v1',actor,item.id,item.row_version,value);};
function log(day,itemId=items[0].id,extras={}){return rpc('save_construction_work_log_v1',worker,plan.id,{id:null,request_id:id(),project_id:project,customer_id:customer,department_id:null,project_name:'履約監控合成驗收',construction_plan_id:plan.id,construction_item_id:itemId,log_date:day,time_period:'上午',work_type:'工程施工',status:'in_progress',summary:'完成當日施作\n待後續完成',completed_content:'完成當日施作',pending_content:'待後續完成',worker_user_ids:[worker],reporter_on_site:true,subcontractor_count:0,resolved_pending_items:[],maintenance_events:[],...extras});}
check('7 items count equally despite different planned durations; 1/7 = 14.3%',()=>{complete(0,true);assert.equal(scope().completion_percent,14.3);assert.equal(scope().completed_item_count,1);});
check('A: day 2 below configured 3-day threshold has no alert',()=>{log('2026-10-01');log('2026-10-02');assert.equal(scope().worked_days,2);assert.equal(scope().progress_alert,false);});
check('B: day 3 at 1/7 triggers 30% alert with 15.7 point gap',()=>{log('2026-10-03');const p=scope();assert.equal(p.worked_days,3);assert.equal(p.progress_alert,true);assert.equal(p.needs_attention,true);assert.equal(p.progress_gap,15.7);});
check('C/E: 3/7 = 42.9% clears the alert, and unchecking restores 1/7',()=>{complete(1,true);assert.equal(scope().completion_percent,28.6);complete(2,true);assert.equal(scope().completion_percent,42.9);assert.equal(scope().progress_alert,false);complete(1,false);complete(2,false);assert.equal(scope().progress_alert,true);});
check('D: additional actual day keeps alert; duplicate dates do not inflate days',()=>{log('2026-10-03',items[1].id);log('2026-10-04');assert.equal(scope().worked_days,4);assert.equal(scope().progress_alert,true);});
check('In-progress actual logs count, future and deleted dates do not',()=>{log('2099-01-01');const deleted=log('2026-10-05').work_log;sql(`update public.site_work_logs set deleted_at=now() where id='${deleted.id}';`);assert.equal(scope().worked_days,4);});
check('Unlinked logs do not affect a plan, and old no-item plans have unknown completion',()=>{
 const other=rpc('save_construction_plan_v1',owner,{...payload,id:id(),content:'獨立規劃',items:[],warning_work_days:3,warning_min_progress:30},false);
 rpc('save_construction_work_log_v1',worker,other.id,{request_id:id(),project_id:project,customer_id:customer,department_id:null,project_name:'履約監控合成驗收',log_date:'2026-10-06',work_type:'工程施工',status:'in_progress',summary:'獨立規劃施工',worker_user_ids:[worker],reporter_on_site:true,subcontractor_count:0,resolved_pending_items:[],maintenance_events:[]});
 const p=rpc('construction_scope_v1',owner,project).construction_plans.find(p=>p.id===other.id);assert.equal(p.completion_percent,null);assert.equal(p.progress_alert,false);assert.equal(scope().worked_days,4);
});
check('ERP/accounting share all-time plan count, progress, warning and actual day metrics despite date filtering',()=>{
 const a=report(),b=report(owner,true,'2026-10-03','2026-10-03');
 assert.deepEqual(a.report.constructionSummary,b.report.constructionSummary);assert.deepEqual(a.report.constructionPlans,b.report.constructionPlans);
 assert.equal(b.report.constructionPlans.find(p=>p.id===plan.id).worked_days,4);assert.equal(a.report.constructionSummary.progressPercent,14.3);
});
check('Appending/removing an unstarted item recalculates 1/8 then 1/7 and retains completed history',()=>{const added={id:id(),title:'新增項目',start_day:1,planned_days:1};save({items:[...items,added]});assert.equal(scope().completion_percent,12.5);save({items});assert.equal(scope().completion_percent,14.3);assert.throws(()=>save({items:items.slice(1)}),/不能移除/);});
check('No configured thresholds means no implicit 80% warning; clearing is immediate',()=>{save({warning_work_days:null,warning_min_progress:null});assert.equal(scope().needs_attention,false);assert.equal(scope().warning_after_days,null);save();assert.equal(scope().progress_alert,true);});
check('Threshold validation rejects partial, fractional, negative, too-large and invalid progress atomically',()=>{
 for(const invalid of [{warning_work_days:null},{warning_work_days:0},{warning_work_days:1.5},{warning_work_days:3651},{warning_min_progress:-1},{warning_min_progress:101},{warning_min_progress:'NaN'}])assert.throws(()=>save(invalid));
 assert.equal(scope().warning_work_days,3);assert.equal(scope().warning_min_progress,30);
 save({warning_min_progress:0});assert.equal(scope().progress_alert,false);save({warning_min_progress:100});assert.equal(scope().progress_alert,true);save();
});
check('Contract date source shared between project, scope and both reports; overdue independent of progress alert',()=>{
 const version=JSON.parse(sql(`select to_jsonb(p) from public.projects p where id='${project}';`)).row_version;
 save({contract_start_date:'2026-10-01',contract_end_date:'2026-10-02',project_row_version:version,warning_work_days:null,warning_min_progress:null});
 const p=scope(),r=report().report;assert.equal(p.contract_overdue,true);assert.equal(p.progress_alert,false);assert.equal(r.project.contractOverdue,true);assert.equal(r.project.contractEndDate,'2026-10-02');assert.ok(p.contract_remaining_days<0);
 assert.deepEqual(r.project,report(owner,true).report.project);
});
check('Stale project version and reversed contract dates roll back the entire plan update',()=>{
 const p=scope(),version=JSON.parse(sql(`select to_jsonb(p) from public.projects p where id='${project}';`)).row_version;
 assert.throws(()=>save({content:'不得保存',contract_end_date:'2026-12-31',project_row_version:version-1}),/重新讀取/);
 assert.throws(()=>save({contract_start_date:'2026-12-31',contract_end_date:'2026-10-01',project_row_version:version}),/晚於/);
 assert.equal(scope().row_version,p.row_version);assert.equal(scope().content,p.content);
});
check('Worker, viewer and unrelated manager cannot change planning, contract or item completion',()=>{
 for(const actor of [worker,viewer,outsider]){assert.throws(()=>save({},actor));assert.throws(()=>complete(1,true,actor));const p=JSON.parse(sql(`select to_jsonb(p) from public.projects p where id='${project}';`));assert.throws(()=>rpc('set_project_contract_dates_v1',actor,project,p.row_version,'2026-01-01','2026-12-31'));}
 assert.equal(scope(worker).can_complete_items,false);assert.equal(scope(viewer).can_complete_items,false);
});
check('Performance uses allowed owner membership, authentic completion dates only, no invented rate',()=>{
 const r=report();assert.equal(r.managerPerformanceVisible,true);const m=r.managerPerformance.find(m=>m.managerId===owner);assert.equal(m.projectCount,1);assert.equal(m.completedProjectCount,0);assert.equal(m.overdueProjectCount,1);assert.equal(m.onTimeCompletionRate,null);assert.deepEqual(m.projectIds,[project]);
 const denied=report(viewer);assert.equal(denied.managerPerformanceVisible,false);assert.deepEqual(denied.managerPerformance,[]);assert.throws(()=>report(outsider),/查看權限/);
});
check('Existing project form saves contract dates atomically and preserves unspecified dates',()=>{
 const p=JSON.parse(sql(`select to_jsonb(p) from public.projects p where id='${project}';`));
 // The legacy project form writer itself is limited to admin/operator roles;
 // keep that existing gate rather than widening it for this feature.
 const result=rpc('upsert_erp_project_contract_v1',admin,{id:project,row_version:p.row_version,name:p.name,customer_id:customer,project_type:'construction',construction_category:'small_purchase',status:'in_progress',project_date:'2026-10-01',worker_user_ids:[owner],estimated_cost:null,department_id:null,contract_end_date:'2026-12-31'});
 assert.equal(result.project.contract_end_date,'2026-12-31');assert.equal(result.project.contract_start_date,'2026-10-01');assert.equal(scope().contract_overdue,false);
});
check('Project completion uses genuine recorded completed_on for rate; cancelled plans excluded',()=>{
 const v=JSON.parse(sql(`select to_jsonb(p) from public.projects p where id='${project}';`));
 sql(`update public.projects set status='completed' where id='${project}';`);
 // A completed work log/workflow status does not complete unchecked items.
 assert.equal(report().managerPerformance.find(m=>m.managerId===owner).completedProjectCount,0);
 for(let i=1;i<items.length;i++)complete(i,true);
 const m=report().managerPerformance.find(m=>m.managerId===owner);assert.equal(m.completedProjectCount,1);assert.equal(m.onTimeEligibleCount,1);assert.equal(m.onTimeCompletionRate,100);assert.equal(report().report.project.contractOverdue,false);
 sql(`update public.projects set status='in_progress' where id='${project}';`);
 save({status:'cancelled'});assert.equal(report().report.constructionSummary.totalItemCount,0);assert.equal(report().report.constructionSummary.progressPercent,null);assert.equal(scope().progress_alert,false);
});
check('All new RPCs are service-only invokers; existing RLS remains enabled',()=>{
 const signatures=['set_project_contract_dates_v1(uuid,uuid,integer,date,date)','upsert_erp_project_contract_v1(uuid,jsonb)','construction_manager_performance_v1(uuid,uuid[])','construction_progress_alert_v1(integer,integer,integer,integer,numeric,text)'];
 for(const signature of signatures){assert.equal(sql(`select prosecdef from pg_proc where oid='public.${signature}'::regprocedure;`),'f');for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege('${role}','public.${signature}','execute');`),'f');}
 for(const table of ['construction_plans','construction_plan_items','projects'])assert.equal(sql(`select relrowsecurity from pg_class where oid='public.${table}'::regclass;`),'t');
});
writeFileSync('F:/GUC-Docker/previews/20261025-construction-monitor/evidence/backend-verification.json',JSON.stringify({at:new Date().toISOString(),database,checks,fixture:{project,owner,worker,viewer,outsider,plan:plan.id}},null,2));
console.log(`${checks.length} isolated monitoring database checks passed.`);
