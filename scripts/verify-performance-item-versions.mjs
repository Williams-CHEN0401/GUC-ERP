// Real isolated Auth -> Gateway -> PostgreSQL version changes, never production data.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
if(process.env.PERFORMANCE_TEST_INTERNAL!=='true'||process.env.SUPABASE_FUNCTIONS_URL!=='http://guc-supabase-functions:9000')throw Error('Isolated ERP container required');
const fixture=JSON.parse(await readFile('/test-output/runtime.json','utf8')),settings=JSON.parse(await readFile('/test-output/test-credentials.json','utf8'));
const config=JSON.parse(await readFile(new URL('../assets/performance-weights-v1.json',import.meta.url),'utf8'));
const db=new pg.Client({host:'db',user:'supabase_admin',password:settings.password,database:'postgres'});await db.connect();
const endpoint='http://127.0.0.1:3000/api/inventory',checks=[];
async function command(actor,op,payload,expected=201){const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+fixture.users[actor].token},body:JSON.stringify({operation:'performance.'+op,payload:{request_id:randomUUID(),...payload}})});const body=await response.json();assert.equal(response.status,expected,JSON.stringify(body));return body.result||body;}
async function detail(id,actor='admin'){const r=await fetch(endpoint+'?'+new URLSearchParams({scope:'performance',mode:'detail',id}),{headers:{Authorization:'Bearer '+fixture.users[actor].token}});assert.equal(r.status,200);return (await r.json()).performance;}
async function action(actor,op,id,payload={},status=201){const r=await detail(id);return command(actor,op,{id,row_version:r.row_version,...payload},status);}
const scalar=async(q,p=[])=>(await db.query(q,p)).rows[0];
const pass=message=>{checks.push(message);console.log('PASS '+message);};
const allocations=[{job_role:'construction',percent:50},{job_role:'maintenance',percent:50}];
const ratings=()=>allocations.flatMap(a=>config.criteria.map(c=>({job_role:a.job_role,criterion:c.code,rating_state:'RATED',rating:c.code==='QUALITY'?5:4,reason:'隔離實作與驗收符合要求',na_kind:null,assigned:true})));
try{
 const year=Number((await scalar('select max(extract(year from month))+1 y from performance_periods')).y);
 const period=await command('admin','period_create',{month:year+'-01-01',template_id:fixture.template});
 const create=employee=>command('admin','review_create',{period_id:period.id,employee_id:fixture.users[employee].id,reviewer_id:fixture.users.scorer.id,approver_id:fixture.users.admin.id,allocations});
 const first=await create('employee'),other=await create('employee2');await action('scorer','review_score',first.id,{items:ratings()});await action('scorer','goal_add',first.id,{description:'保留既有改善行動',due_date:year+'-01-31'});
 const before=await detail(first.id),otherBefore=await detail(other.id);assert.equal(before.score,85.5);
 const next=structuredClone(config);next.criteria[0].label='成果品質與驗收';next.criteria[0].evidence_guide='設備逐點測試、驗收文件與交接成果';next.job_roles[0].weights.QUALITY=30;next.job_roles[0].weights.SCHEDULE=15;next.job_roles[1].weights.QUALITY=35;next.job_roles[1].weights.SCHEDULE=10;
 const lead=next.job_roles.find(r=>r.code==='lead');lead.additional_criteria=[{code:'LEAD_COACHING',label:'人員指導與資源安排',evidence_guide:'每月安排、追蹤與指導成果'}];lead.weights.QUALITY=10;lead.weights.LEAD_COACHING=10;
 const payload={name:'項目改版 '+randomUUID().slice(0,8),config:next,reason:'調整驗收重點與各職務權重',confirm_reset:true};
 await action('scorer','review_template',first.id,payload,403);await action('outsider','review_template',first.id,payload,401);await action('admin','review_template',first.id,{...payload,confirm_reset:false},400);
 const count=(await scalar('select count(*)::int n from performance_templates')).n;
 await command('admin','review_template',{id:first.id,row_version:before.row_version-1,...payload},409);
 const invalid=structuredClone(next);invalid.job_roles[0].weights.QUALITY=31;await action('admin','review_template',first.id,{...payload,config:invalid},400);
 for(const bad of ['', ' '.repeat(3),'x'.repeat(121)]){const c=structuredClone(next);c.criteria[0].label=bad;await action('admin','review_template',first.id,{...payload,config:c},400);}
 const tooLong=structuredClone(next);tooLong.criteria[0].evidence_guide='x'.repeat(2001);await action('admin','review_template',first.id,{...payload,config:tooLong},400);
 const missing=structuredClone(next);missing.criteria.pop();await action('admin','review_template',first.id,{...payload,config:missing},400);
 const otherExtra=structuredClone(next);otherExtra.job_roles[0].additional_criteria=lead.additional_criteria;await action('admin','review_template',first.id,{...payload,config:otherExtra},400);
 const duplicate=structuredClone(next);duplicate.job_roles[2].additional_criteria.push({...lead.additional_criteria[0]});await action('admin','review_template',first.id,{...payload,config:duplicate},400);
 assert.equal((await scalar('select count(*)::int n from performance_templates')).n,count);assert.deepEqual(await detail(first.id),before);pass('Permissions, reset confirmation, stale row, fixed seven criteria and invalid metadata/weights reject atomically');
 const request_id=randomUUID(),submitted={id:first.id,row_version:before.row_version,request_id,...payload};const saved=await command('admin','review_template',submitted);assert.deepEqual(await command('admin','review_template',submitted),saved);
 const changed=await detail(first.id);assert.notEqual(changed.template.id,before.template.id);assert.deepEqual(changed.template.config,next);assert.equal(changed.score,null);assert(changed.items.every(i=>i.rating_state==='UNRATED'&&i.reason===''&&!i.assigned));assert.deepEqual(changed.allocations,before.allocations);assert.deepEqual(changed.goals,before.goals);assert.deepEqual(await detail(other.id),otherBefore);
 const audit=await scalar("select count(*)::int n,min(before_data->>'score') before_score,min(after_data->>'previous_template_id') previous_id from audit_logs where after_data->>'request_id'=$1 and after_data->>'performance_operation'='review_template'",[request_id]);assert.equal(audit.n,1);assert.equal(Number(audit.before_score),85.5);assert.equal(audit.previous_id,before.template.id);assert.equal((await scalar('select count(*)::int n from performance_templates')).n,count+1);pass('New version and draft apply are atomic/idempotent; old ratings audited, goals/allocations and sibling review preserved');
 await action('scorer','review_score',first.id,{items:ratings()});assert.equal((await detail(first.id)).score,86.5);pass('Backend uses the selected review version for multi-role weighted score');
 await action('admin','review_template',other.id,{template_id:changed.template.id,reason:'同職務改採新版項目',confirm_reset:true});assert.equal((await detail(other.id)).template.id,changed.template.id);
 await action('admin','review_template',other.id,{template_id:changed.template.id,reason:'重複版本應拒絕',confirm_reset:true},400);
 const future=await command('admin','period_create',{month:year+'-02-01',template_id:changed.template.id});const fresh=await command('admin','review_create',{period_id:future.id,employee_id:fixture.users.employee.id,reviewer_id:fixture.users.scorer.id,approver_id:fixture.users.admin.id,allocations});assert.equal((await detail(fresh.id)).template.id,changed.template.id);pass('Existing version can apply to a specified draft and be selected by a new month');
 const allRoles=config.job_roles.map(r=>({job_role:r.code,percent:25}));const leadReview=await command('admin','review_create',{period_id:future.id,employee_id:fixture.users.multi.id,reviewer_id:fixture.users.scorer.id,approver_id:fixture.users.admin.id,allocations:allRoles});
 const leadDetail=await detail(leadReview.id);for(const role of config.job_roles)assert.equal(leadDetail.items.filter(i=>i.job_role===role.code).length,role.code==='lead'?8:7);
 await action('scorer','review_score',leadReview.id,{items:leadDetail.items.map(i=>({job_role:i.job_role,criterion:i.criterion,rating_state:'RATED',rating:i.criterion==='LEAD_COACHING'?5:4,reason:'各職務工作與指導成果均已確認',na_kind:null,assigned:true}))});assert.equal((await detail(leadReview.id)).score,80.5);pass('Only supervisor role gains an eighth item; other three keep seven and backend weighted result is 80.50');
 await action('scorer','review_submit',first.id);await action('admin','review_template',first.id,payload,400);
 await action('employee','review_respond',first.id,{response_type:'acknowledged',message:'知悉新版評核'});await action('admin','review_approve',first.id);await action('admin','review_template',first.id,payload,400);await action('admin','review_publish',first.id);
 const published=await detail(first.id);await action('admin','review_template',first.id,payload,400);assert.deepEqual(await detail(first.id),published);
 const revised=await action('admin','review_revise',first.id,{reason:'保留版本的評核修訂'});const revision=await detail(revised.id);assert.equal(revision.template.id,changed.template.id);assert.equal(revision.score,86.5);assert.equal((await detail(first.id)).template.id,changed.template.id);pass('Submitted/approved/published reviews reject changes; new revisions inherit the correct version');
 for(const role of ['anon','authenticated'])assert.equal((await scalar("select has_function_privilege($1,'public.performance_command_v1(uuid,text,jsonb)','EXECUTE') allowed",[role])).allowed,false);
 assert.equal((await scalar("select relrowsecurity enabled from pg_class where oid='performance_reviews'::regclass")).enabled,true);pass('Existing RPC grants and review RLS remain restricted');
 await writeFile('/test-output/item-version-fixture.json',JSON.stringify({draft:other.id,leadDraft:leadReview.id,newMonthDraft:fresh.id,published:first.id,revision:revised.id,template:changed.template.id,originalTemplate:fixture.template,year},null,2));
 await writeFile('/test-output/item-version-results.json',JSON.stringify({checkedAt:new Date().toISOString(),status:'PASS',checks},null,2));
}finally{await db.end();}
