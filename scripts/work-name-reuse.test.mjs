import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const migration=readFileSync(new URL('../supabase/migrations/20260930151330_reuse_deleted_work_names.sql',import.meta.url),'utf8');
test('work name uniqueness is retained only for non-deleted projects, with atomic index replacement',()=>{
 assert.match(migration,/create unique index projects_customer_active_name_uidx\s+on public\.projects\(customer_id, lower\(btrim\(name\)\)\) where deleted_at is null;/);
 assert.ok(migration.indexOf('create unique index')<migration.indexOf('drop index public.projects_customer_normalized_name_uidx;'));
 assert.match(migration,/^begin;/);assert.match(migration,/commit;\s*$/);assert.match(migration,/lock_timeout = '5s'/);
 assert.doesNotMatch(migration,/\b(?:delete from|update public\.|truncate|drop table|disable trigger)\b/i);
});
test('repair suffix checks both base and dated names among non-deleted work, without changing grants',()=>{
 assert.equal((migration.match(/where customer_id=p_customer_id and deleted_at is null and lower\(btrim\(name\)\)=lower\(v_name\)/g)||[]).length,2);
 assert.match(migration,/v_suffix integer:=2/);assert.match(migration,/to_char\(p_date,'YYMMDD'\)/);assert.match(migration,/char_length\(v_name\)>120/);
 assert.match(migration,/security invoker set search_path=''/);
 assert.match(migration,/revoke all on function public\.repair_visit_name_v1\(uuid,text,date\) from public,anon,authenticated/);
 assert.match(migration,/grant execute on function public\.repair_visit_name_v1\(uuid,text,date\) to service_role/);
});
test('all shared name-resolution entrypoints are patched with an exact-baseline guard',()=>{
 for(const name of ['upsert_customer_project_work_log_v2','upsert_customer_project_work_log_v3','upsert_customer_project_work_log_department_v1','upsert_erp_project_department_v1','create_work_assignment_with_project_v1'])assert.ok(migration.includes("('"+name+"',"));
 assert.match(migration,/select oid into strict v_oid/);assert.match(migration,/<> 1 then/);assert.match(migration,/Unexpected work-name lookup baseline/);
});
