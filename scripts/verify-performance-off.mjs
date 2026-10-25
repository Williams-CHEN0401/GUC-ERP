// Execute inside the isolated ERP container while both feature flags are disabled.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
if(process.env.PERFORMANCE_TEST_INTERNAL!=='true'||process.env.GUC_PERFORMANCE_ENABLED!=='false')throw Error('Requires isolated stack with feature disabled.');
const runtime=JSON.parse(await readFile('/test-output/runtime.json','utf8')),settings=JSON.parse(await readFile('/test-output/test-credentials.json','utf8'));
const db=new pg.Client({host:'db',user:'supabase_admin',database:'postgres',password:settings.password});await db.connect();
const base='http://127.0.0.1:3000/api/inventory',actor=runtime.users.admin;
const query=(s,p=[])=>db.query(s,p);
async function post(operation,payload,user=actor){const r=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+user.token},body:JSON.stringify({operation,payload})});const body=await r.json();assert.equal(r.status,201,operation+': '+JSON.stringify(body));return body.result;}
const results=[];
try{
 const config=await(await fetch('http://127.0.0.1:3000/api/public-config')).text();assert.ok(config.includes('"performanceEnabled":false'));
 const read=await fetch(base+'?scope=performance',{headers:{Authorization:'Bearer '+actor.token}});assert.equal(read.status,404);
 const denied=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+actor.token},body:JSON.stringify({operation:'performance.task_create',payload:{}})});assert.equal(denied.status,404);
 const customer=randomUUID(),projectId=randomUUID();
 await query('insert into customers(id,name) values($1,$2)',[customer,'功能關閉回歸客戶 '+customer.slice(0,8)]);
 const project=(await query("insert into projects(id,customer_id,name,project_type) values($1,$2,$3,'construction') returning *",[projectId,customer,'功能關閉回歸工程 '+projectId.slice(0,8)])).rows[0];
 const log=await post('upsert_customer_project_work_log',{id:null,row_version:null,request_id:randomUUID(),project_id:project.id,customer_id:project.customer_id,department_id:null,project_name:project.name,log_date:'2026-10-25',work_type:'工程施工',summary:'功能關閉後日誌回歸',time_period:'08:30–12:00',status:'in_progress',worker_user_ids:[actor.id],maintenance_events:[],completed_content:'功能關閉後日誌回歸',pending_content:'',reporter_on_site:true,subcontractor_count:0,resolved_pending_items:[]});
 const logId=log.work_log.id;assert.equal((await query('select summary from site_work_logs where id=$1',[logId])).rows[0].summary,'功能關閉後日誌回歸');results.push('Existing worklog Gateway write and database reread');
 const assignment=await post('create_work_assignment',{request_id:randomUUID(),project_mode:'existing',project_id:project.id,assignee_user_ids:[actor.id],assignment_type:'general',instructions:'功能關閉後多人指派回歸'});
 const assignmentId=assignment.assignments[0].id;await post('complete_work_assignment',{id:assignmentId,row_version:assignment.assignments[0].row_version});
 assert.equal((await query('select status from work_assignments where id=$1',[assignmentId])).rows[0].status,'completed');results.push('Existing assignment creation/completion through Gateway');
 const category=await post('create_product_category',{code_prefix:'PF',name:'隔離績效回歸品項 '+randomUUID().slice(0,6)});
 const categoryId=Array.isArray(category)?category[0].id:category.id;
 const item=await post('create_inventory_item',{category_id:categoryId,brand:'隔離',item_name:'驗收取貨品項',unit:'個',model:'TEST',opening_quantity:10});const itemId=Array.isArray(item)?item[0].id:item.id;
 await post('create_pickup_batch',{work_log_id:logId,request_id:randomUUID(),rows:[{customer_id:project.customer_id,project_id:project.id,pickup_date:'2026-10-25',inventory_item_id:itemId,quantity:2,note:'功能關閉後取貨回歸'}]});
 const pickup=(await query('select quantity,note from pickup_records where work_log_id=$1',[logId])).rows;assert.equal(pickup.length,1);assert.equal(Number(pickup[0].quantity),2);results.push('Existing worklog-linked pickup and quantity persisted');
 const dashboard=await fetch(base+'?scope=dashboard',{headers:{Authorization:'Bearer '+actor.token}});assert.equal(dashboard.status,200,await dashboard.clone().text());results.push('Existing dashboard remains available');
 console.log('PASS AT-22: feature-off UI/API guards plus existing worklog, assignment, pickup and dashboard use real Gateway/SQL.');
 await writeFile('/test-output/feature-off-results.json',JSON.stringify({checkedAt:new Date().toISOString(),case:'AT-22',status:'PASS',results},null,2));
}catch(error){console.error(error.stack);process.exitCode=1;await writeFile('/test-output/feature-off-results.json',JSON.stringify({case:'AT-22',status:'FAIL',results,error:error.message},null,2));}finally{await db.end();}
