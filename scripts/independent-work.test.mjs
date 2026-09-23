import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {definition} from './worklog-save-fixture.mjs';
const sql=readFileSync(new URL('../supabase/migrations/20260923003902_independent_work_log_pickup_project.sql',import.meta.url),'utf8');
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
test('pickup writers lock request/log before pickup/inventory; reassignment keeps history and versions',()=>{
 const update=definition(sql,'update_pickup_record'),batch=definition(sql,'create_pickup_records_batch_v2'),log=definition(sql,'upsert_customer_project_work_log_v3');
 assert.ok(update.indexOf('for share')<update.indexOf('select * into v_existing'));
 assert.ok(update.indexOf('for key share')<update.indexOf('for share'));
 assert.match(update,/v_existing.work_log_id is distinct from v_locked_log_id/);
 assert.match(update,/work_log_id = case/);
 assert.doesNotMatch(update,/此取貨已關聯工作日誌/);
 assert.ok(batch.indexOf('pg_advisory_xact_lock')<batch.indexOf('for share of logs'));
 assert.ok(batch.indexOf('for key share')<batch.indexOf('for share of logs'));
 assert.ok(batch.indexOf('for share of logs')<batch.indexOf('from public.inventory_items'));
 assert.match(log,/order by id for update/);
 assert.match(log,/set work_log_id=null,source='web',updated_by=p_actor/);
 assert.match(log,/site_assets where work_log_id=p_id/);
 assert.match(log,/work_type=p_work_type/);
 assert.doesNotMatch(sql,/\b(?:grant|revoke|alter table|delete from|drop)\b/i);
});
test('soft-delete fix changes only the invalid audit action, not security or history behavior',()=>{
 const legacy=readFileSync(new URL('../supabase/migrations/20260916232954_work_assignments_dashboard.sql',import.meta.url),'utf8');
 const fixed=readFileSync(new URL('../supabase/migrations/20260923004454_fix_project_soft_delete_audit.sql',import.meta.url),'utf8');
 assert.equal(definition(fixed,'delete_project_record').replace(/\r\n/g,'\n'),
 definition(legacy,'delete_project_record').replace("'project', p_id, 'soft_delete'","'project', p_id, 'update'").replace(/\r\n/g,'\n'));
 assert.doesNotMatch(fixed,/\b(?:alter table|delete from|drop|grant|revoke)\b/i);
});
test('preview detaches only changed pickup ownership and log links without relying on unloaded logs',()=>{
 assert.match(source,/workLogId:r.projectId===payload.project_id\?r.workLogId:""/);
 assert.match(source,/row.workLogId===payload.id&&row.projectId!==project.id/);
 assert.doesNotMatch(source,/work_type:moving\?workTypeFromProjectType/);
});
