// Isolated PostgreSQL only; reuses real ERP RPCs and synthetic master rows.
import {titlePickerDatabase} from './worklog-title-fixture.mjs';
import {sql} from './worklog-save-fixture.mjs';
export const dailyTypeMigration='20260922103001_preserve_daily_work_log_type.sql';
export async function dailyTypeDatabase({fixed=true}={}){
 const db=await titlePickerDatabase();
 if(fixed)await db.exec(await sql(dailyTypeMigration));
 return db;
}
