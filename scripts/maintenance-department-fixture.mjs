import {editContextDatabase} from './worklog-edit-context-fixture.mjs';
import {sql,ids,sample,saveLog} from './worklog-save-fixture.mjs';
import {extraIds} from './department-cross-system-fixture.mjs';
export const maintenanceDepartmentMigration='20260923151258_maintenance_worklog_departments.sql';
export const thirdRoom='30000000-0000-4000-8000-000000000093';
export async function applyMaintenanceDepartment(db){await db.exec(await sql(maintenanceDepartmentMigration));}
export const independentStatusMigration='20260923151304_independent_work_log_status.sql';
export async function applyIndependentStatus(db){await db.exec(await sql(independentStatusMigration));}
export async function maintenanceDepartmentDatabase(){const db=await editContextDatabase();await applyMaintenanceDepartment(db);return db;}
export async function seedMeetingRooms(db){
 await db.query('update customer_departments set name=$2 where id=$1',[ids.department,'第一會議室']);
 await db.query('update customer_departments set name=$2 where id=$1',[extraIds.secondDepartment,'第二會議室']);
 await db.query('insert into customer_departments(id,customer_id,name) values($1,$2,$3)',[thirdRoom,ids.customer,'第三會議室']);
 return saveLog(db,{...sample(),project_name:'第三季會議系統維護',department_id:thirdRoom,work_type:'維護保養',maintenance_events:[],summary:'第三會議室定期維護'});
}
