// Actual Gateway and SQL, synthetic identities, in-memory PostgreSQL only.
import {constructionPlanServer,planUsers} from './construction-plan-fixture.mjs';
import {sql,definition,ids} from './worklog-save-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
export const permissionMigration='20261104002756_construction_role_permissions.sql';
export async function constructionPermissionsServer(){
 const f=await constructionPlanServer(),{db}=f;
 const currentUser=f.gatewayContext.currentUser;
 f.gatewayContext.currentUser=request=>Object.hasOwn(planUsers,(request.headers.get('authorization')||'').replace('Bearer isolated-plan-',''))?currentUser(request):null;
 const fallback=f.server.listeners('request')[0];f.server.removeAllListeners('request');
 f.server.on('request',(req,res)=>{
  if(req.url==='/__construction_test'){
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({isolated:true,failures:f.failures.slice(-3)}));return;
  }
  if(req.url.split('?')[0]==='/api/public-config'){
   res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store'});
   res.end('globalThis.GUC_PUBLIC_CONFIG={localProduction:true,productionOrigin:location.origin};sessionStorage.setItem("GUC_ERP_ACCESS_TOKEN","isolated-plan-"+(new URLSearchParams(location.search).get("test_user")||"A"));');return;
  }
  return fallback(req,res);
 });
 // Older fixture already populates project_id with its own link trigger.
 await db.exec((await sql('20261012093253_construction_checklist_gantt.sql')).replace('alter trigger site_work_logs_project_link_v1 on public.site_work_logs rename to a_site_work_logs_project_link_v1;',''));
 await db.exec(`alter table projects add column contract_start_date date,add column contract_end_date date;
 alter table construction_plans add column warning_work_days integer,add column warning_min_progress numeric,add column subcontractor_count integer default 0;
 alter table app_users add column can_work_on_site boolean default true;`);
 const monitor=await sql('20261025062408_construction_contract_monitoring.sql');
 for(const name of ['construction_completion_totals_v1','construction_progress_alert_v1'])await db.exec(definition(monitor,name));
 await db.exec(await sql(permissionMigration));
 // Released request-audit fields and REST insertion adapter are absent from
 // the historical fixture; keep audit outcomes in the same in-memory table.
 await db.exec("alter table audit_logs alter column entity_id drop not null;alter table audit_logs add column event_kind text default 'legacy',add column outcome text default 'recorded'");
 const api=f.gatewayContext.api;
 f.gatewayContext.api=async(path,init={})=>{
  if(path.split('?')[0]==='audit_logs'&&init.method==='POST'){
   const row=JSON.parse(init.body),columns=['entity_type','entity_id','action','event_kind','outcome','source','actor','after_data'];
   if(Object.keys(row).some(k=>!columns.includes(k)))throw Error('Unexpected isolated audit field');
   const result=await db.query('insert into audit_logs('+columns.join(',')+') values('+columns.map((_,i)=>'$'+(i+1)).join(',')+') returning *',columns.map(k=>row[k]??null));
   return Response.json(result.rows,{status:201});
  }
  return api(path,init);
 };
 // This old fixture predates accounting/website modules rendered by today's
 // settings form. Mirror the current Gateway whitelist, retaining the same PK.
 const gateway=await readFile(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8');
 const modules=JSON.parse(gateway.match(/const PERMISSION_MODULES = (\[[^;]+\]);/)[1]);
 await db.exec('alter table role_permissions drop constraint role_permissions_module_check;alter table role_permissions add constraint role_permissions_module_check check(module in ('+modules.map(m=>"'"+m+"'").join(',')+'))');
 f.additionalRpcs.push('set_construction_item_completed_v1');
 const rpc=(name,args)=>callAsService(db,name,args);
 const plan=await rpc('save_construction_plan_v1',[planUsers.owner,JSON.stringify({id:randomUUID(),project_id:f.planProjects.small,construction_date:'2026-10-16',content:'隔離施工規劃',status:'pending',planned_days:7,notes:'合成資料，可自由測試',assignee_user_ids:[planUsers.A,planUsers.B],items:[{id:randomUUID(),title:'配管施工',start_day:1,planned_days:2},{id:randomUUID(),title:'端子板與線路接通',start_day:3,planned_days:5}]}),false]);
 plan.items=(await db.query('select * from construction_plan_items where construction_plan_id=$1 order by sort_order',[plan.id])).rows;
 const project=(await db.query('select * from projects where id=$1',[plan.project_id])).rows[0];
 const logPayload=(key,date,log=null)=>({request_id:randomUUID(),id:log?.id||null,row_version:log?.row_version||null,construction_plan_id:plan.id,construction_item_id:plan.items[0].id,project_id:project.id,customer_id:ids.customer,department_id:project.department_id,project_name:project.name,log_date:date,work_type:'工程施工',time_period:'上午',status:'in_progress',summary:'施工紀錄 '+key+'\n後續作業',completed_content:'施工紀錄 '+key,pending_content:'後續作業',worker_user_ids:[planUsers[key]],maintenance_events:[]});
 const logs=[];
 for(const [key,date]of [['owner','2026-10-16'],['B','2026-10-27'],['A','2026-11-03']])logs.push((await rpc('save_construction_work_log_v1',[planUsers[key],plan.id,JSON.stringify(logPayload(key,date))])).work_log);
 const grant=async(overrides={})=>{
  const permissions=[
   {module:'construction_plans',can_view:true},
   {module:'construction_items',can_view:true,can_update:true},
   {module:'construction_logs',can_view:true,can_create:true,can_update:true,can_delete:true},
   {module:'construction_logs_all',can_view:true}
  ].map(p=>({can_create:false,can_update:false,can_delete:false,...p,...overrides[p.module]}));
  for(const p of permissions)await db.query('insert into role_permissions values($1,$2,$3,$4,$5,$6) on conflict(role_code,module) do update set can_view=excluded.can_view,can_create=excluded.can_create,can_update=excluded.can_update,can_delete=excluded.can_delete',['plan_worker',p.module,p.can_view,p.can_create,p.can_update,p.can_delete]);
 };
 if(process.argv.includes('--demo'))await grant();
 return {...f,plan,logs,grant,logPayload};
}
if(process.argv[1]?.endsWith('construction-permissions-fixture.mjs')){
 const f=await constructionPermissionsServer(),port=Number(process.env.CONSTRUCTION_PERMISSION_PORT||4512);
 f.server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port+'/?page=projects&test_user=A — 隔離 SQL 合成資料；test_user=admin/owner/A/B/C/viewer'));
}
