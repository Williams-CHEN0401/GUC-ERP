import {departmentDatabase} from './department-cross-system-fixture.mjs';
import {sql} from './worklog-save-fixture.mjs';
export async function titlePickerDatabase(){
 const db=await departmentDatabase();
 await db.exec(`create table pickup_records(id uuid primary key default gen_random_uuid(),project_id uuid references projects,work_log_id uuid references site_work_logs);
 create table site_assets(id uuid primary key default gen_random_uuid(),project_id uuid references projects,work_log_id uuid references site_work_logs);
 grant select on pickup_records,site_assets to service_role;
 drop trigger project_sync on projects;`);
 for(const name of ['20260915150407_shared_work_types_and_worklog_rename.sql','20260916001938_worklog_title_selection.sql','20260916002422_worklog_repair_received_date.sql'])await db.exec(await sql(name));
 return db;
}
