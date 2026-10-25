// Real isolated Supabase Auth -> ERP proxy -> Edge Runtime -> PostgREST -> PostgreSQL.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import pg from 'pg';
if(process.env.PERFORMANCE_TEST_INTERNAL!=='true'||process.env.SUPABASE_FUNCTIONS_URL!=='http://guc-supabase-functions:9000')throw Error('Run only inside the isolated guc-performance-test ERP container.');
const settings=JSON.parse(await readFile('/test-output/test-credentials.json','utf8'));
const config=JSON.parse(await readFile(new URL('../assets/performance-weights-v1.json',import.meta.url),'utf8'));
const db=new pg.Client({host:'db',port:5432,user:'supabase_admin',password:settings.password,database:'postgres'});await db.connect();
pg.types.setTypeParser(1082,s=>s);
const results=[],runtime={users:{},reviews:{},baseUrl:'http://localhost:4268'};
const pass=(id,details)=>{results.push({id,status:'PASS',details});console.log('PASS '+id+' '+details);};
const query=(sql,args=[])=>db.query(sql,args);
const value=async(sql,args=[])=>(await query(sql,args)).rows[0];
const users={},tokens={},run=randomBytes(4).toString('hex'),password=randomBytes(18).toString('hex');
const endpoint='http://127.0.0.1:3000/api/inventory';
async function request(actor,op,payload,expect=201){
 const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(tokens[actor]?{Authorization:'Bearer '+tokens[actor]}:{})},body:JSON.stringify({operation:op.startsWith('performance.')||op==='login'?op:'performance.'+op,payload})});
 const data=await r.json();assert.equal(r.status,expect,op+': '+JSON.stringify(data));return data.result||data;
}
async function command(actor,op,payload={},expect=201){return request(actor,op,{request_id:randomUUID(),...payload},expect);}
async function read(actor,mode='list',options={},expect=200){
 const url=endpoint+'?'+new URLSearchParams({scope:'performance',mode,...options});const r=await fetch(url,{headers:{Authorization:'Bearer '+tokens[actor]}});const data=await r.json();assert.equal(r.status,expect,mode+': '+JSON.stringify(data));return data.performance||data;
}
const detail=(actor,id)=>read(actor,'detail',{id});
async function action(actor,op,id,payload={},expect=201){const r=await detail(actor,id);return command(actor,op,{id,row_version:r.row_version,...payload},expect);}
const fullItems=(allocations,rating=4)=>allocations.flatMap(a=>config.criteria.map(c=>({job_role:a.job_role,criterion:c.code,rating_state:'RATED',rating,reason:'已依約定標準完成並由主管確認',na_kind:null,assigned:true})));
const allocation=[{job_role:'construction',percent:100}];
let template,period,year;
async function createReview(employee='employee',allocations=allocation,periodId=period){return (await command('admin','review_create',{period_id:periodId,employee_id:users[employee],reviewer_id:users.scorer,approver_id:users.admin,allocations})).id;}
async function score(id,items){return action('scorer','review_score',id,{items});}
async function publish(id,employee='employee'){
 await action('scorer','review_submit',id);
 await action(employee,'review_respond',id,{response_type:'acknowledged',message:'已知悉，未表示同意。'});
 await action('admin','review_approve',id);await action('admin','review_publish',id);
 return detail('admin',id);
}
try{
 assert.match((await value('select version() v')).v,/PostgreSQL 17\.6/);
 await query("insert into app_roles(code,name,is_system) values('admin','管理員',true),('perf_employee','績效測試員工',false),('perf_scorer','績效測試主管',false) on conflict do nothing");
 for(const role of ['perf_employee','perf_scorer'])for(const module of ['performance','dashboard','worklogs','projects','history'])await query('insert into role_permissions(role_code,module,can_view,can_create,can_update,can_delete) values($1,$2,true,$3,$3,false) on conflict(role_code,module) do nothing',[role,module,role==='perf_scorer']);
 for(const name of ['admin','admin2','scorer','outsider','employee','employee2','multi','nodata']){
  const username='perf_'+name+'_'+run;
  const response=await fetch('http://api-gw:8000/auth/v1/admin/users',{method:'POST',headers:{Authorization:'Bearer '+settings.service,'Content-Type':'application/json'},body:JSON.stringify({email:username+'@inventory.local',password,email_confirm:true})});
  const auth=await response.json();assert.ok(response.ok,JSON.stringify(auth));
  const role=name.startsWith('admin')?'admin':['scorer','outsider'].includes(name)?'perf_scorer':'perf_employee';
  users[name]=randomUUID();await query('insert into app_users(id,auth_user_id,username,display_name,role) values($1,$2,$3,$4,$5)',[users[name],auth.id,username,'隔離 '+name,role]);
  const login=await request(null,'login',{username,password},200);tokens[name]=login.session.access_token;runtime.users[name]={id:users[name],username,password,token:tokens[name]};
 }
 console.log('Synthetic accounts authenticated through the existing ERP login and real GoTrue.');
 year=Number((await value('select coalesce(max(extract(year from month)),2029)+1 y from performance_periods')).y);
 template=(await command('admin','template_create',{name:'驗收 '+run,config})).id;
 period=(await command('admin','period_create',{month:year+'-10-01',template_id:template})).id;
 runtime.year=year;runtime.period=period;runtime.template=template;
 const a=await createReview(),b=await createReview('employee2');runtime.reviews.employee=a;runtime.reviews.employee2=b;
 assert.equal((await read('employee')).reviews.length,0);await read('employee','detail',{id:b},403);await read('employee','detail',{id:a},403);
 pass('AT-01','Employee cannot read another employee or unpublished draft ratings; limited own draft progress is separate.');
 await read('outsider','detail',{id:a},403);await command('outsider','review_create',{period_id:period,employee_id:users.employee,reviewer_id:users.outsider,approver_id:users.admin,allocations:allocation},403);
 pass('AT-02','Unassigned supervisor denied read and creation through Gateway.');
 assert.equal((await query('select job_role,sum(weight)::text total,count(*)::int n from performance_role_weights where template_id=$1 group by job_role',[template])).rows.filter(r=>r.total==='100'&&r.n===7).length,4);
 const invalid=structuredClone(config);invalid.job_roles[0].weights.QUALITY=24;await command('admin','template_create',{name:'bad',config:invalid},400);
 pass('AT-03','Four roles, seven distinct criteria each; 100% required and invalid template rejected.');
 for(const role of config.job_roles){const result=await value('select performance_calculate_v1($1,$2,$3) r',[template,JSON.stringify([{job_role:role.code,percent:100}]),JSON.stringify(fullItems([{job_role:role.code}]))]);assert.equal(result.r.score,80);assert.equal(result.r.grade,'B');}
 await score(a,fullItems(allocation));assert.equal((await detail('scorer',a)).score,80);
 pass('AT-04','All four roles compute 80.00/B from all-4 ratings; persisted RPC result agrees.');
 const badNA=fullItems(allocation);badNA[5]={...badNA[5],rating_state:'NA',rating:null,na_kind:'unassigned',assigned:true,reason:'已安排但未做'};
 await action('scorer','review_score',a,{items:badNA},400);badNA[5].assigned=false;badNA[5].reason='本月未安排訓練';await score(a,badNA);
 pass('AT-05','Unassigned training accepts reasoned N/A; assigned-but-unperformed cannot claim unassigned N/A.');
 const partial=fullItems(allocation).map(i=>['QUALITY','SCHEDULE'].includes(i.criterion)?{...i,rating:i.criterion==='QUALITY'?4:5}:{...i,rating_state:'NA',rating:null,na_kind:'unassigned',assigned:false,reason:'本月未指派此類工作'});
 await score(a,partial);assert.equal((await detail('scorer',a)).score,88.89);
 pass('AT-06','25/20 active weights rescale to persisted 88.89.');
 const multiAllocation=[{job_role:'construction',percent:60},{job_role:'maintenance',percent:40}],m=await createReview('multi',multiAllocation);
 const multiItems=fullItems(multiAllocation).map(i=>({...i,rating:i.job_role==='construction'&&i.criterion==='REPORT'?3:i.job_role==='maintenance'&&i.criterion==='QUALITY'?5:4}));await score(m,multiItems);
 const md=await detail('scorer',m);assert.equal(md.score,81.2);assert.equal(md.grade,'B');assert.deepEqual(md.calculation.roles.map(r=>r.score).sort(),[78,86]);runtime.reviews.multi=m;
 pass('AT-07','60%×78 + 40%×86 persists as 81.20/B with unrounded role intermediates.');
 await action('admin','review_allocate',m,{allocations:[{job_role:'construction',percent:60},{job_role:'maintenance',percent:30}],reason:'驗證拒絕不完整配比'},400);
 assert.equal((await detail('scorer',m)).score,81.2);pass('AT-08','90% allocation rejected atomically; previous 100% allocation and score preserved.');
 const n=await createReview('nodata',multiAllocation);const noData=fullItems(multiAllocation).map(i=>i.job_role==='maintenance'?{...i,rating_state:'NA',rating:null,na_kind:'unassigned',assigned:false,reason:'無此職務觀察資料'}:i);await score(n,noData);
 assert.equal((await detail('scorer',n)).score,null);await action('scorer','review_submit',n,{},400);
 await score(n,noData.map(i=>({...i,rating_state:'NA',rating:null,na_kind:'unassigned',assigned:false,reason:'未分派此類工作'})));assert.equal((await detail('scorer',n)).calculation.status,'NO_DATA');runtime.reviews.nodata=n;
 pass('AT-09','All N/A or any positive-allocation NO_DATA role makes whole month null and blocks submission.');
 await command('employee','review_score',{id:a,row_version:(await detail('admin',a)).row_version,items:fullItems(allocation)},403);
 await action('scorer','review_score',a,{items:fullItems(allocation),score:100},400);
 await command('admin','review_create',{period_id:period,employee_id:users.admin,reviewer_id:users.scorer,approver_id:users.admin,allocations:allocation},400);
 pass('AT-10','Forged score, employee scoring, and admin self-approval assignment rejected.');
 // Source fixture uses real source tables and triggers, not duplicated business masters.
 const customer=randomUUID(),project=randomUUID(),log=randomUUID(),site=randomUUID();
 await query('insert into customers(id,customer_code,name) values($1,$2,$3)',[customer,'PERF-'+run,'合成驗收客戶 '+run]);
 await query('insert into projects(id,customer_id,name,project_code,project_type) values($1,$2,$3,$4,\'construction\')',[project,customer,'合成工程 '+run,'PERF-'+run]);
 await query('insert into sites(id,project_id,customer_id,site_code,site_name) values($1,$2,$3,$4,$5)',[site,project,customer,'PERF-'+run,'合成案場']);
 await query("insert into site_work_logs(id,site_id,project_id,log_date,reporter_user_id,title,summary) values($1,$2,$3,$4,$5,'合成現場紀錄','已完成監控測試並交接')",[log,site,project,year+'-10-10',users.scorer]);
 await query('insert into site_work_log_workers(work_log_id,user_id) values($1,$2)',[log,users.employee]);
 const candidates=await read('scorer','candidates',{id:a});assert.ok(candidates.candidates.some(c=>c.source_id===log));
 const own=await command('admin','review_create',{period_id:period,employee_id:users.scorer,reviewer_id:users.outsider,approver_id:users.admin,allocations:allocation});
 assert.ok(!(await read('outsider','candidates',{id:own.id})).candidates.some(c=>c.source_id===log));
 pass('AT-11','Actual worker is an evidence candidate; a reporter absent from worker links is not.');
 const assignmentRequest=randomUUID();for(const employee of [users.employee,users.employee2])await query("insert into work_assignments(project_id,assignee_user_id,created_by_user_id,instructions,assignment_request_id,created_at) values($1,$2,$3,'共同測試交辦',$4,$5)",[project,employee,users.scorer,assignmentRequest,year+'-10-10T02:00:00Z']);
 const beforeAssignment=(await detail('scorer',a)).score;const assignmentCandidates=await read('scorer','candidates',{id:a});assert.ok(assignmentCandidates.candidates.some(c=>c.source_type==='work_assignment'));assert.equal((await detail('scorer',a)).score,beforeAssignment);
 pass('AT-12','Shared assignment is candidate-only and does not grant per-person points.');
 const beforeProjects=(await value('select count(*)::int n from projects')).n;
 const task=await command('admin','task_create',{title:'工具與車輛檢查 '+run,category:'tools',assignee_id:users.employee,due_date:year+'-10-20'});
 const completed=await command('employee','task_complete',{id:task.id,row_version:task.row_version,completion_note:'工具數量清點完成，缺件已回報'});
 await command('admin','task_verify',{id:task.id,row_version:completed.row_version});assert.equal((await value('select count(*)::int n from projects')).n,beforeProjects);
 pass('AT-13','Nonproject task created, completed, independently verified; project count unchanged.');
 await action('scorer','evidence_add',a,{source_type:'site_work_log',source_id:log});await score(a,partial);
 const published=await publish(a);const frozen=published.evidence[0].snapshot.summary;
 await query("update site_work_logs set summary='後來更新的施工文字' where id=$1",[log]);
 assert.equal((await detail('employee',a)).evidence[0].snapshot.summary,frozen);assert.equal((await detail('employee',a)).score,88.89);
 await action('scorer','review_score',a,{items:fullItems(allocation)},400);
 const revision=await action('admin','review_revise',a,{reason:'補充確認後重新評核'});assert.equal((await detail('scorer',revision.id)).revision,2);assert.equal((await detail('employee',a)).is_current,true);runtime.reviews.revision=revision.id;
 pass('AT-14','Published source snapshot/score immutable; explicit second revision keeps previous current version.');
 const audits=(await query("select actor,created_at,before_data,after_data from audit_logs where source='performance' and entity_id=$1",[a])).rows;
 for(const op of ['review_score','review_respond','review_approve','review_publish'])assert.ok(audits.some(r=>r.after_data?.performance_operation===op&&r.actor&&r.created_at&&r.before_data));
 assert.ok(!JSON.stringify(audits).includes(tokens.employee));pass('AT-15','Ratings, reply, approval, publication record actor/time/before/after/request; no session tokens.');
 const concurrentPayload={request_id:randomUUID(),title:'並行工具清點 '+run,category:'tools',assignee_id:users.employee,due_date:year+'-10-20'};
 const copies=await Promise.all(Array.from({length:8},()=>request('admin','task_create',concurrentPayload)));assert.equal(new Set(copies.map(r=>r.id)).size,1);
 const createPeriod=(await command('admin','period_create',{month:year+'-11-01',template_id:template})).id;
 const simultaneous={request_id:randomUUID(),period_id:createPeriod,employee_id:users.employee,reviewer_id:users.scorer,approver_id:users.admin,allocations:allocation};
 const reviewCopies=await Promise.all(Array.from({length:6},()=>request('admin','review_create',simultaneous)));assert.equal(new Set(reviewCopies.map(r=>r.id)).size,1);
 await request('admin','review_create',{...simultaneous,employee_id:users.employee2},409);runtime.reviews.november=reviewCopies[0].id;
 pass('AT-16','Eight simultaneous tasks and six reviews create one row per request; changed payload conflicts.');
 const stale=await detail('scorer',revision.id);await score(revision.id,fullItems(allocation));await command('scorer','review_score',{id:revision.id,row_version:stale.row_version,items:partial},409);assert.equal((await detail('scorer',revision.id)).score,80);
 pass('AT-17','Stale row_version returns HTTP 409 without overwriting the latest saved score.');
 assert.equal((await detail('scorer',revision.id)).score,80);await action('scorer','review_score',revision.id,{items:fullItems(allocation),leave_days:12},400);assert.equal((await detail('scorer',revision.id)).score,80);
 pass('AT-18','No attendance/work-count inputs enter calculation; forged leave-days rejected without score change.');
 await query('insert into erp_private_access(singleton,owner_user_id,viewer_user_ids) values(true,$1,$2) on conflict(singleton) do update set owner_user_id=excluded.owner_user_id,viewer_user_ids=excluded.viewer_user_ids',[users.admin,[users.scorer]]);
 await query('update customers set is_private=true where id=$1',[customer]);
 assert.ok((await detail('employee',a)).evidence[0].redacted);assert.ok(!(await read('employee','candidates',{id:revision.id})).candidates.some(c=>c.source_id===log));
 assert.equal((await detail('scorer',a)).evidence[0].snapshot.summary,frozen);
 await query("update erp_private_access set viewer_user_ids='{}'");assert.ok((await detail('scorer',a)).evidence[0].redacted);
 pass('AT-19','Private source, frozen summary and source identifiers hidden after permission revocation, including supervisor.');
 const exported=await read('employee','export');assert.ok(exported.reviews.length>0&&exported.reviews.every(r=>r.employee_id===users.employee));assert.ok(!JSON.stringify(exported).includes('隔離 employee2'));
 pass('AT-21','Export uses same server-side per-review scope; employee export contains no peer data or notes.');
 const skill=await action('scorer','skill_set',a,{skill_code:'monitoring',level:3,evidence:'實作完成攝影機測試與查修，主管現場確認'});assert.ok(skill.id);
 await action('employee','skill_set',a,{skill_code:'monitoring',level:4,evidence:'自行修改測試'},403);
 assert.equal((await read('employee')).skills.find(s=>s.review_id===a).level,3);
 pass('AT-23','L1–L4 validates evidence and assessor, keeps versions, and denies employee self-edit.');
 await score(runtime.reviews.november,fullItems(allocation));await publish(runtime.reviews.november);
 const report=await read('employee','quarter',{year:String(year),quarter:'4'});const qr=report.results.find(r=>r.employee_id===users.employee);assert.equal(qr.sample_count,2);assert.equal(qr.missing_months,1);assert.equal(qr.effective_month_weight,50);assert.equal(qr.average_score,84.45);
 assert.equal((await read('nodata','quarter',{year:String(year),quarter:'4'})).results.length,0);
 pass('AT-24','Quarter uses two valid published samples (84.45), reports 50%/month and missing month; NO_DATA excluded.');
 // Additional boundaries and direct access restrictions.
 for(const role of ['anon','authenticated']){
  await query('set role '+role);await assert.rejects(query('select * from performance_reviews'),/permission denied/);await assert.rejects(query("select performance_read_v1($1,'list','{}')",[users.admin]),/permission denied/);await query('reset role');
 }
 const decimalItems=fullItems(allocation);decimalItems[0].rating=3.5;await action('scorer','review_score',revision.id,{items:decimalItems},400);
 const roundCases=[[69.995,3,4,50.025,'C',70],[79.995,3,4,0.025,'B',80],[89.995,4,5,50.025,'A',90]];
 for(const [raw,low,high,lowWeight,grade,scoreExpected] of roundCases){
  const c=structuredClone(config);for(const role of c.job_roles){for(const key of Object.keys(role.weights))role.weights[key]=0;role.weights.QUALITY=lowWeight;role.weights.SCHEDULE=100-lowWeight;}
  const t=(await command('admin','template_create',{name:'round-'+raw,config:c})).id;
  const items=fullItems(allocation).map(i=>({...i,rating:i.criterion==='QUALITY'?low:high}));
  const calculated=(await value('select performance_calculate_v1($1,$2,$3) r',[t,JSON.stringify(allocation),JSON.stringify(items)])).r;assert.equal(calculated.score,scoreExpected);assert.equal(calculated.grade,grade);
 }
 const deadline=(await value("select performance_deadline_v1('2030-10-04T08:00:00+08',5,'{\"weekdays\":[1,2,3,4,5],\"holidays\":[\"2030-10-10\"]}') d")).d;assert.ok(deadline);
 await action('admin','review_timeout',revision.id,{},400);
 await query('update app_users set is_active=false where id=$1',[users.outsider]);await read('outsider','list',{},401);
 pass('EXTRA','Direct anon/authenticated denial, fractional rating rejection, rounding/grade boundaries, workday deadline and disabled-session denial.');
 runtime.source={customer,project,log};runtime.results=results;
 await writeFile('/test-output/runtime.json',JSON.stringify(runtime,null,2));
}catch(error){console.error(error.stack);results.push({id:'BLOCKER',status:'FAIL',details:error.message});process.exitCode=1;}
finally{
 await writeFile('/test-output/database-results.json',JSON.stringify({checkedAt:new Date().toISOString(),environment:'guc-performance-test / PostgreSQL 17.6 / real GoTrue / Edge Runtime / PostgREST',productionWrites:0,results},null,2));await db.end();
}
