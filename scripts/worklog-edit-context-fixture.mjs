import {formSyncDatabase} from './form-sync-fixture.mjs';
import {sql} from './worklog-save-fixture.mjs';
export const editContextMigration='20260923151251_worklog_edit_customer_context.sql';
export async function applyEditContext(db){
 await db.exec('alter table project_workers add column if not exists granted_by uuid,add column if not exists granted_at timestamptz');
 await db.exec(await sql('20260923060629_repair_visit_quotation_rows.sql'));
 await db.exec(await sql(editContextMigration));
}
export async function editContextDatabase(){const db=await formSyncDatabase();await applyEditContext(db);return db;}
