// Actual Gateway and migrated SQL; synthetic users and loopback only.
import {constructionPlanServer,planUsers} from './construction-plan-fixture.mjs';
import {sql,ids} from './worklog-save-fixture.mjs';
export {planUsers};
export const managementMigration='20261031074859_work_assignment_management.sql';
export async function assignmentManagementServer(){
 const f=await constructionPlanServer(),{db}=f;
 await db.exec('alter table customers add column if not exists deleted_at timestamptz');
 await db.exec('alter table app_users add column if not exists can_work_on_site boolean default true');
 await db.exec(`alter table contract_service_types add column if not exists equipment_import_template jsonb;
 alter table projects add column if not exists contract_start_date date,add column if not exists contract_end_date date;
 alter table inventory_items add column if not exists meters_per_unit numeric;
 alter table pickup_records add column if not exists quantity_unit text default 'package',add column if not exists source_receipt_line_id uuid;
 alter table stock_adjustments add column if not exists quantity_unit text default 'package';`);
 const checklist=await sql('20261012093253_construction_checklist_gantt.sql');
 await db.exec(checklist.slice(checklist.indexOf('create table public.construction_plan_items'),checklist.indexOf('alter table public.site_work_logs add column')));
 // Earlier fixtures predate the complete multi-person migration.
 await db.exec('alter table work_assignments drop column if exists assignment_request_id');
 await db.exec(await sql('20261025051340_multi_person_work_assignments.sql'));
 await db.exec(await sql(managementMigration));
 await db.exec("insert into role_permissions(role_code,module,can_view,can_create,can_update,can_delete) values('plan_owner','appointments',true,false,false,false),('plan_owner','inventory',true,false,false,false),('plan_worker','appointments',true,false,false,false),('plan_worker','projects',true,false,false,false),('viewer','appointments',true,false,false,false),('viewer','projects',true,false,false,false) on conflict(role_code,module) do update set can_view=true");
 f.additionalRpcs.push('create_work_assignments_v1','work_assignment_management_v1','update_work_assignment_v1','cancel_work_assignment_v1');
 // Financial document summaries are unrelated to assignment editing. The
 // assignment writers, permissions, projections and private checks stay real.
 const rpc=f.gatewayContext.rpc;f.gatewayContext.rpc=(name,args)=>name==='receipt_document_context_v1'?{documents:[],settings:{}}:rpc(name,args);
 const audit=await sql('20261029084350_system_audit_coverage.sql');await db.exec(audit.slice(0,audit.indexOf('create or replace function audit_internal.enrich()'))+'commit;');
 const rest=f.gatewayContext.db;f.gatewayContext.db=async(path,init={})=>{
  if(init.method==='POST'&&path.split('?')[0]==='audit_logs'){
   const record=JSON.parse(init.body),keys=Object.keys(record);if(keys.some(key=>!['entity_type','entity_id','action','event_kind','outcome','source','actor','after_data'].includes(key)))throw Error('Unexpected fixture audit field');
   const rows=(await db.query('insert into audit_logs('+keys.join(',')+') values('+keys.map((_,i)=>'$'+(i+1)).join(',')+') returning *',keys.map(key=>record[key]&&typeof record[key]==='object'?JSON.stringify(record[key]):record[key]))).rows;
   return Response.json(rows,{status:201});
  }
  return rest(path,init);
 };
 const fallback=f.server.listeners('request')[0];f.server.removeAllListeners('request');
 f.server.on('request',(req,res)=>{
  if(req.url.split('?')[0]==='/api/public-config'){
   res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store'});
   res.end('globalThis.GUC_PUBLIC_CONFIG={localProduction:true,productionOrigin:location.origin};sessionStorage.setItem("GUC_ERP_ACCESS_TOKEN","isolated-plan-"+(new URLSearchParams(location.search).get("test_user")||"admin"));');return;
  }
  return fallback(req,res);
 });
 return f;
}
if(process.argv[1]?.endsWith('assignment-management-fixture.mjs')){
 const f=await assignmentManagementServer();const port=Number(process.env.ASSIGNMENT_MANAGEMENT_PORT||4396);
 f.server.listen(port,'127.0.0.1',()=>console.log('http://localhost:'+port+'/?page=appointments&test_user=admin — isolated assignment management'));
}
