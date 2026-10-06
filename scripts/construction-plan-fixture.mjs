// Loopback-only synthetic users + actual Gateway/RPC; never loads production secrets.
import {accessAppointmentsServer} from './erp-access-fixture.mjs';
import {ids} from './worklog-save-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';
import {randomUUID} from 'node:crypto';
export const planMigration='20261006102619_construction_planning_worklogs.sql';
export const planUsers={admin:ids.actor,owner:'10000000-0000-4000-8000-000000000041',A:'10000000-0000-4000-8000-000000000042',B:'10000000-0000-4000-8000-000000000043',C:'10000000-0000-4000-8000-000000000044',viewer:ids.viewer};
export async function constructionPlanServer(){
 const f=await accessAppointmentsServer(),{db}=f;
 const rpc=(name,args)=>callAsService(db,name,args);
 const perms=(modules,actions)=>modules.map(module=>({module,can_view:true,can_create:actions,can_update:actions,can_delete:actions}));
 await rpc('save_app_role_v1',[ids.actor,'plan_owner','施工負責人（隔離）',false,null,JSON.stringify(perms(['projects','worklogs','dashboard'],true))]);
 await rpc('save_app_role_v1',[ids.actor,'plan_worker','施工人員（隔離）',true,null,JSON.stringify(perms(['worklogs','dashboard'],true))]);
 await db.exec("insert into role_permissions values('viewer','worklogs',true,false,false,false),('viewer','dashboard',true,false,false,false) on conflict(role_code,module) do update set can_view=true");
 for(const key of ['owner','A','B','C'])await db.query('insert into app_users(id,username,display_name,role,is_active) values($1,$2,$3,$4,true)',[planUsers[key],'plan-'+key,key==='owner'?'施工負責人（隔離）':'施工人員 '+key+'（隔離）',key==='owner'?'plan_owner':'plan_worker']);
 const projects={small:randomUUID(),tender:randomUUID(),repair:randomUUID()};
 for(const [kind,id] of Object.entries(projects)){
  await db.query("insert into projects(id,project_code,customer_id,department_id,name,project_type,construction_category,status,assigned_to,project_date) values($1,$2,$3,$4,$5,$6,$7,'in_progress','施工負責人（隔離）','2026-10-06')",[id,'PLAN-'+kind,ids.customer,ids.department,kind==='small'?'一號大樓監控工程（小額採購）':kind==='tender'?'二號大樓網路工程（標案）':'一般維修（不啟用規劃）',kind==='repair'?'repair':'construction',kind==='small'?'small_purchase':kind==='tender'?'tender':null]);
  await db.query('insert into project_workers(project_id,user_id,is_assignee) values($1,$2,true)',[id,planUsers.owner]);
 }
 f.gatewayContext.currentUser=async request=>{
  const key=(request.headers.get('authorization')||'').replace('Bearer isolated-plan-','');
  const id=planUsers[key]||planUsers.owner;
  const user=(await db.query('select * from app_users where id=$1',[id])).rows[0];
  if(!user?.is_active)return null;
  user.project_scoped=(await db.query('select project_scoped from app_roles where code=$1',[user.role])).rows[0]?.project_scoped||false;
  user.permissions=(await db.query('select * from role_permissions where role_code=$1',[user.role])).rows;
  await f.gatewayContext.initializePrivateAccess(user);return user;
 };
 const fallback=f.server.listeners('request')[0];f.server.removeAllListeners('request');
 f.server.on('request',(req,res)=>{
  if(req.url.split('?')[0]==='/api/public-config'){
   res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store'});
   res.end('globalThis.GUC_PUBLIC_CONFIG={};sessionStorage.setItem("GUC_ERP_ACCESS_TOKEN","isolated-plan-"+(new URLSearchParams(location.search).get("test_user")||"owner"));');return;
  }
  return fallback(req,res);
 });
 return {...f,planProjects:projects};
}
if(process.argv[1]?.endsWith('construction-plan-fixture.mjs')){
 const f=await constructionPlanServer();
 if(process.argv.includes('--demo')){
  const plan=await callAsService(f.db,'save_construction_plan_v1',[planUsers.owner,JSON.stringify({id:randomUUID(),project_id:f.planProjects.small,construction_date:'2026-10-10',content:'一樓配管與標示',status:'pending',notes:'隔離測試範例，可自由修改；不寫入正式資料',assignee_user_ids:[planUsers.A,planUsers.B]}),false]);
  const project=(await f.db.query('select * from projects where id=$1',[plan.project_id])).rows[0];
  await callAsService(f.db,'save_construction_work_log_v1',[planUsers.A,plan.id,JSON.stringify({request_id:randomUUID(),id:null,row_version:null,project_id:project.id,customer_id:project.customer_id,department_id:project.department_id,project_name:project.name,log_date:'2026-10-10',work_type:'工程施工',time_period:'08:30–12:00',status:'in_progress',summary:'完成一樓配管與標示\n待第二階段穿線',completed_content:'完成一樓配管與標示',pending_content:'待第二階段穿線',worker_user_ids:[planUsers.A],maintenance_events:[]})]);
 }
 const port=Number(process.env.CONSTRUCTION_TEST_PORT||4244);
 f.server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port+'/?page=projects — 施工規劃：隔離 SQL 測試，test_user=owner/A/B/C/viewer/admin'));
}
