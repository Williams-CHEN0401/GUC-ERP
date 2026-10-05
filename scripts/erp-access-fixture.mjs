// Synthetic identities, actual Gateway and SQL; never loads production secrets.
import {receiptNumberServer} from './receipt-number-fixture.mjs';
import {sql,ids,definition} from './worklog-save-fixture.mjs';
import {restRead} from './work-assignment-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';
export const accessMigration='20261004151329_erp_roles_privacy_appointments.sql';
export const privateMigration='20261004152032_erp_private_data_access.sql';
export async function accessAppointmentsServer(){
 const fixture=await receiptNumberServer(),{db,additionalRpcs}=fixture;
 await db.exec(`
 alter table audit_logs add column if not exists created_at timestamptz default now();
 create table contract_service_types(id uuid primary key,code text,name text,sort_order integer default 1,is_active boolean default true,row_version integer default 1,created_at timestamptz default now(),updated_at timestamptz default now());
 insert into contract_service_types(id,code,name) select service_type_id,'computer','電腦設備（隔離）' from customer_contract_services limit 1;
 alter table customer_contract_services add created_at timestamptz default now(),add is_active boolean default true;
 alter table stock_receipts add column if not exists updated_at timestamptz default now();
 alter table pickup_records add column if not exists updated_at timestamptz default now();
 alter table sites add site_code text,add site_name text,add customer_id uuid references customers,add contract_service_type_id uuid references contract_service_types,add contact_id uuid,add address text,add phone text,add status text,add notes text,add row_version integer default 1,add created_at timestamptz default now(),add updated_at timestamptz default now();
 alter table site_work_log_workers add created_at timestamptz default now();
 alter table site_assets add created_at timestamptz default now();
 alter table equipment_registry add equipment_type text,add site_id uuid references sites,add display_name text,add search_key text,add installation_date date,add installation_precision text,add metadata jsonb,add created_at timestamptz default now(),add updated_at timestamptz default now();
 alter table maintenance_event_equipment add created_at timestamptz default now();
 alter table maintenance_event_workers add created_at timestamptz default now();
 alter table repair_items add constraint fixture_repair_event_fk foreign key(source_maintenance_event_id) references maintenance_events;
 alter table repair_items add column if not exists updated_at timestamptz default now();
 alter table site_work_log_workers add constraint fixture_log_worker_fk foreign key(work_log_id) references site_work_logs;
 alter table maintenance_event_equipment add constraint fixture_equipment_event_fk foreign key(event_id) references maintenance_events;
 alter table maintenance_event_workers add constraint fixture_worker_event_fk foreign key(event_id) references maintenance_events;
 grant select on contract_service_types to service_role;
 alter table app_users add column if not exists auth_user_id uuid,add column if not exists created_at timestamptz default now(),add column if not exists updated_at timestamptz default now(),add column if not exists row_version integer default 1;
 alter table project_workers add column if not exists created_at timestamptz default now();
 alter table projects add column if not exists actual_cost numeric,add column if not exists started_on date,add column if not exists completed_on date;
 alter table inventory_items add column if not exists cost_price numeric,add column if not exists sale_price numeric,add column if not exists inventory_status text default 'active',add column if not exists default_supplier_id uuid,add column if not exists note text;
 alter table suppliers add column if not exists contact_name text,add column if not exists phone text,add column if not exists email text,add column if not exists address text,add column if not exists note text,add column if not exists row_version integer default 1,add column if not exists created_at timestamptz default now(),add column if not exists updated_at timestamptz default now();
 create table if not exists stock_adjustments(id uuid primary key,inventory_item_id uuid references inventory_items,before_quantity numeric,after_quantity numeric,difference_quantity numeric,adjusted_at timestamptz,reason text,idempotency_key uuid,source text,updated_by text,created_at timestamptz default now());
 grant select on stock_adjustments to service_role;
 alter table app_roles add name text,add is_system boolean not null default false,
 add row_version integer not null default 1,add created_by uuid references app_users,
 add created_at timestamptz default now(),add updated_at timestamptz default now();
 insert into app_roles(code,name) values('operator','操作員') on conflict do nothing;
 update app_roles set name=coalesce(name,code),is_system=code in ('admin','operator','viewer');
 alter table app_users add constraint fixture_user_role foreign key(role) references app_roles(code);
 alter table role_permissions add constraint fixture_role_permission_pk primary key(role_code,module);
 alter table role_permissions add constraint fixture_role_permission_fk foreign key(role_code) references app_roles on delete cascade;
 alter table role_permissions add constraint role_permissions_module_check check(module<>'appointments');
 insert into role_permissions values('viewer','projects',true,false,false,false),('operator','projects',true,true,true,false);
 `);
 await db.exec(await sql(accessMigration));
 await db.exec(await sql(privateMigration));
 await db.exec(await sql('20261005005222_cross_system_private_access.sql'));
 additionalRpcs.push('upsert_customer_appointment_v2','save_app_role_v1','delete_app_role_v1');
 additionalRpcs.push('erp_private_scope_v1','configure_erp_private_access_v1','set_customer_private_v1','request_work_log_access_v1','review_work_log_access_v1','read_shared_work_log_v1','acknowledge_work_log_access_v1');
 additionalRpcs.push('erp_stock_totals_v1','erp_work_content_types_v1');
 additionalRpcs.push('private_work_log_scope_v1');
 const context=fixture.gatewayContext;
 const originalUser=context.currentUser;
 context.currentUser=async request=>{const identity=await originalUser(request),user=(await db.query('select * from app_users where id=$1',[identity.id])).rows[0];if(!user?.is_active)return null;user.project_scoped=(await db.query('select project_scoped from app_roles where code=$1',[user.role])).rows[0]?.project_scoped||false;user.permissions=(await db.query('select * from role_permissions where role_code=$1',[user.role])).rows;await context.initializePrivateAccess(user);return user;};
 const originalRpc=context.rpc;
 context.rpc=(name,args)=>originalRpc(name,Object.fromEntries(Object.entries(args).map(([key,value])=>[key,['p_permissions','p_grants'].includes(key)&&Array.isArray(value)?JSON.stringify(value):value])));
 context.db=async(path,init={})=>{
  if(init.method==='POST'&&path==='audit_logs'){
   const record=JSON.parse(init.body),keys=Object.keys(record);if(keys.some(key=>!/^[a-z_]+$/.test(key)))throw Error('Invalid audit field');
   const rows=(await db.query('insert into audit_logs('+keys.join(',')+') values('+keys.map((_,i)=>'$'+(i+1)).join(',')+') returning *',keys.map(key=>record[key]&&typeof record[key]==='object'?JSON.stringify(record[key]):record[key]))).rows;
   return Response.json(rows,{status:201});
  }
  if(init.method==='PATCH'&&path.startsWith('app_users?')){
   const params=new URLSearchParams(path.split('?')[1]),id=params.get('id')?.slice(3),version=Number(params.get('row_version')?.slice(3));
   const data=JSON.parse(init.body);if(!id||!Number.isInteger(version)||Object.keys(data).some(key=>!['username','display_name','role','is_active'].includes(key)))throw Error('Invalid isolated account patch');
   const rows=(await db.query('update app_users set username=$1,display_name=$2,role=$3,is_active=$4,row_version=row_version+1,updated_at=now() where id=$5 and row_version=$6 returning *',[data.username,data.display_name,data.role,data.is_active,id,version])).rows;
   return Response.json(rows);
  }
  if(init.method&&init.method!=='GET')throw Error('Fixture denies REST writes');
  const url=new URL(context.privateReadPath(path),'http://isolated.invalid');
  const select=url.searchParams.get('select')||'*',receiptJoin=select.includes('stock_receipt_customers('),projectJoin=select.includes('project:projects!');
  if(receiptJoin||projectJoin)url.searchParams.set('select',select.replace(/stock_receipt_customers\([^)]*\),?/, '').replace(/,?project:projects![^(]+\([^)]*\)/,''));
  let rows;try{rows=await restRead(db,url.pathname.slice(1)+url.search);}catch(error){console.error('Isolated REST',url.pathname,error.message);throw error;}
  if(receiptJoin)for(const row of rows)row.stock_receipt_customers=(await db.query('select customer_id,department_id from stock_receipt_customers where stock_receipt_id=$1',[row.id])).rows;
  if(projectJoin)for(const row of rows)row.project=(await db.query('select name,project_code,customer_id,department_id from projects where id=$1',[row.project_id])).rows[0];
  return Response.json(rows.map(row=>({...row,...(row.appointment_date instanceof Date?{appointment_date:row.appointment_date.toISOString().slice(0,10)}:{})})));
 };
 const fallback=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');
 fixture.server.on('request',async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname!=='/api/inventory')return fallback(req,res);
  try{
   let body='';if(req.method==='POST')for await(const chunk of req)body+=chunk;
   const response=await fixture.gatewayHandler(new Request('http://127.0.0.1/inventory-gateway'+url.search,{method:req.method,headers:req.headers,...(body?{body}:{})}));
   res.writeHead(response.status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(await response.text());
  }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
 });
 return fixture;
}
if(process.argv[1]?.endsWith('erp-access-fixture.mjs')){
 const {server,db}=await accessAppointmentsServer();
 if(process.argv.includes('--demo')){
  // Disposable demo records in this process's in-memory database only.
  const permissions=[{module:'dashboard',can_view:true},{module:'worklogs',can_view:true,can_create:true},{module:'appointments',can_view:true}].map(p=>({can_create:false,can_update:false,can_delete:false,...p}));
  await callAsService(db,'save_app_role_v1',[ids.actor,'qa_role','流程測試角色',false,null,JSON.stringify(permissions)]);
  await db.query("update app_users set role='qa_role' where username='fixture-operator'");
  await callAsService(db,'configure_erp_private_access_v1',[ids.actor,ids.actor,[ids.viewer,ids.scoped],null]);
  for(const [date,status,notes] of [['2026-10-20','pending','預約施工－未到期'],['2026-10-05','pending','預約施工－當日'],['2026-09-30','pending','預約施工－未完成提醒']])
   await callAsService(db,'upsert_customer_appointment_v2',[null,null,ids.customer,null,'construction',date,'','','隔離施工測試',ids.actor,status,notes,3,ids.actor,'fixture-admin']);
 }
 const port=Number(process.env.ERP_ACCESS_TEST_PORT||4241);
 server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port+'/?page=appointments — isolated SQL only'));
}
