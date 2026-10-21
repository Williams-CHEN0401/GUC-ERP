import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {sql,literal as q,database} from '../../preview-db.mjs';
if(database!=='guc_dashboard_preview_20261012')throw Error('Only synthetic isolated database allowed');
const file=new URL('../../fixture-ids.json',import.meta.url),ids=JSON.parse(readFileSync(file,'utf8'));
for(const key of ['exporter','privateowner','exportPrivateCustomer','exportArchiveCustomer','exportArchiveProject','searchRepair','searchAppointment'])ids[key]||=randomUUID();
sql(`begin;
insert into public.app_roles(code,name,project_scoped) values('export_test','隔離匯出測試',false) on conflict do nothing;
${['data_export','customers','purchases','projects','inventory','repairs','appointments','worklogs','reports','dashboard'].map(module=>`insert into public.role_permissions(role_code,module,can_view,can_create,can_update,can_delete) values('export_test',${q(module)},true,false,false,false) on conflict(role_code,module) do nothing;`).join('\n')}
${['exporter','privateowner'].map(key=>`insert into auth.users(id,email) values(${q(ids[key])},${q(key+'1017@preview.invalid')}) on conflict do nothing;insert into public.app_users(id,auth_user_id,username,display_name,role) values(${q(ids[key])},${q(ids[key])},${q(key+'1017')},${q(key==='exporter'?'匯出測試員':'隔離私人資料擁有者')},'export_test') on conflict do nothing;`).join('\n')}
insert into public.erp_private_access(singleton,owner_user_id,viewer_user_ids) values(true,${q(ids.privateowner)},array[${q(ids.admin)}]::uuid[]) on conflict do nothing;
insert into public.customers(id,name,customer_code,customer_category,is_private) values(${q(ids.exportPrivateCustomer)},'私人匯出防護測試1017','EX-PRIVATE','school',true),(${q(ids.exportArchiveCustomer)},'封存瀏覽器測試1017','EX-ARCHIVE','school',false) on conflict do nothing;
insert into public.projects(id,customer_id,name,project_code,project_type,status) values(${q(ids.exportArchiveProject)},${q(ids.exportArchiveCustomer)},'封存客戶歷史工作1017','EX-ARCHIVE-P','repair','pending') on conflict do nothing;
insert into public.repair_items(id,customer_id,department_id,inventory_item_id,supplier_id,serial_number,issue_description,updated_by,repair_no) values(${q(ids.searchRepair)},${q(ids.customer)},${q(ids.department)},${q(ids.items[0])},${q(ids.supplier)},'IME-1017','繁體中文監視器維修測試1017','williams','SEARCH-REPAIR-1017') on conflict do nothing;
insert into public.work_assignments(id,assignment_type,assignee_user_id,created_by_user_id,customer_id,department_id,appointment_type,appointment_date,instructions,contact_name,contact_phone,notes) values(${q(ids.searchAppointment)},'appointment',${q(ids.worker)},${q(ids.admin)},${q(ids.customer)},${q(ids.department)},'repair','2026-10-17','繁體中文預約測試1017','測試聯絡人','070-1017','保留搜尋備註') on conflict do nothing;
commit;`);
writeFileSync(file,JSON.stringify(ids,null,2));console.log('Isolated search/export fixtures ready. Shared viewer/outsider roles untouched.');
