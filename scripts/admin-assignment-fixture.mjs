// Isolated PostgreSQL, existing RPCs and the real Gateway. No production secrets.
import {constructionPlanServer,planUsers} from './construction-plan-fixture.mjs';
import {ids,sql} from './worklog-save-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';

export async function adminAssignmentFixture(){
 const f=await constructionPlanServer(),{db,gatewayContext:context}=f;
 // The historical isolated schema predates these already-deployed nullable fields.
 await db.exec('alter table work_assignments add column if not exists construction_plan_id uuid,add column if not exists construction_item_id uuid,add column if not exists construction_plan_title text,add column if not exists construction_item_title text');
 const exportMigration=await sql('20261017083454_customer_archive_and_admin_tools.sql');
 await db.exec(exportMigration.slice(exportMigration.indexOf('do $$ declare prior text;'),exportMigration.lastIndexOf('commit;')));
 const users={admin:planUsers.admin,A:planUsers.A,B:planUsers.B,viewer:planUsers.viewer,admin2:'10000000-0000-4000-8000-000000000090'};
 await db.query("insert into app_users(id,username,display_name,role,is_active) values($1,'second-admin','第二位管理員（隔離）','admin',true)",[users.admin2]);
 await db.query("update app_users set username='williams',display_name='一般唯讀人員（隔離）' where id=$1",[users.viewer]);
 await db.exec("insert into role_permissions(role_code,module,can_view,can_create,can_update,can_delete) values('plan_worker','data_export',true,false,false,false),('plan_worker','appointments',true,false,false,false),('plan_worker','pickups',true,false,false,false),('viewer','data_export',true,false,false,false) on conflict(role_code,module) do update set can_view=true");
 context.currentUser=async request=>{
  const key=(request.headers.get('authorization')||'').replace('Bearer isolated-admin-assignment-',''),id=users[key];
  if(!id)return null;
  const user=(await db.query('select * from app_users where id=$1',[id])).rows[0];
  if(!user?.is_active)return null;
  user.project_scoped=(await db.query('select project_scoped from app_roles where code=$1',[user.role])).rows[0]?.project_scoped||false;
  user.permissions=(await db.query('select * from role_permissions where role_code=$1',[user.role])).rows;
  await context.initializePrivateAccess(user);return user;
 };
 // Resolve only the dynamic module import for this VM. All export validation,
 // query, privacy filtering and spreadsheet projection remain application code.
 const exporterSource=readFileSync(new URL('../supabase/functions/inventory-gateway/export-lists.ts',import.meta.url),'utf8').replace(/^export /gm,'');
 context.__assignmentExporter=vm.runInContext(stripTypeScriptTypes(`(()=>{${exporterSource};return {ERP_EXPORT_SPECS,buildErpExport};})()`,{mode:'strip'}),context);
 const gatewaySource=readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8');
 const exportSource=gatewaySource.slice(gatewaySource.indexOf('async function exportErpData('),gatewaySource.indexOf('const queryDefinitions:'));
 vm.runInContext(stripTypeScriptTypes(exportSource.replace("await import('./export-lists.ts')",'globalThis.__assignmentExporter'),{mode:'strip'}),context);
 const create=(assignee,type,instructions,creator=users.admin)=>callAsService(db,'create_work_assignment_v1',[f.planProjects.repair,assignee,type,instructions,type==='pickup'?ids.item:null,type==='pickup'?1:null,creator,'隔離管理員']);
 const records={
  own:await create(users.admin,'general','管理員自己的查修工作'),
  other:await create(users.A,'general','指派給施工人員 A 的查修工作'),
  otherCreator:await create(users.B,'general','第二位管理員指派給施工人員 B',users.admin2),
  pickup:await create(users.B,'pickup','施工人員 B 取貨工作'),
  completed:await create(users.A,'general','已完成工作（僅完成通知）'),
  cancelled:await create(users.B,'general','已取消工作（不列入待辦）')
 };
 await callAsService(db,'complete_work_assignment_v1',[records.completed.id,records.completed.row_version,users.A,'施工人員 A']);
 await db.query("update work_assignments set status='cancelled' where id=$1",[records.cancelled.id]);
 records.appointment=await callAsService(db,'upsert_customer_appointment_v2',[null,null,ids.customer,null,'repair','2026-10-29','','','預約電話設備查修',users.A,'pending','隔離預約範例',3,users.admin,'隔離管理員']);
 records.plan=await callAsService(db,'save_construction_plan_v1',[users.admin,JSON.stringify({id:randomUUID(),project_id:f.planProjects.small,construction_date:'2026-10-29',content:'A、B 共同施工規劃',status:'pending',planned_days:7,notes:'隔離範例',assignee_user_ids:[users.A,users.B]}),false]);
 records.ownPlan=await callAsService(db,'save_construction_plan_v1',[users.admin,JSON.stringify({id:randomUUID(),project_id:f.planProjects.tender,construction_date:'2026-10-29',content:'管理員與 A 共同施工規劃',status:'in_progress',planned_days:3,notes:'隔離範例',assignee_user_ids:[users.admin,users.A]}),false]);
 return {...f,users,records};
}
