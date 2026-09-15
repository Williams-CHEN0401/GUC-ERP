import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sql=readFileSync(new URL('../supabase/migrations/20260914223754_fix_department_cross_system_boundaries.sql',import.meta.url),'utf8');
test('department/quotation guard reuses existing protected tracking boundary and keeps linked-quote refusal',()=>{
 assert.match(sql,/create or replace trigger quotation_project_department_guard[\s\S]*?execute function public\.audit_work_content_tracking_v1\(\)/);
 assert.match(sql,/tg_when='BEFORE'[\s\S]*?exists\(select 1 from public\.quotations where project_id=old\.id\)[\s\S]*?已有報價/);
 assert.doesNotMatch(sql,/\bgrant\b[^;]*\bon\s+(?:table\s+)?public\./i);assert.doesNotMatch(sql,/disable row level security|alter function[^;]*security definer/i);
});
test('repair department wrapper has no protected-table write and always restores transaction context',()=>{
 const wrapper=sql.slice(sql.indexOf('create or replace function public.upsert_repair_item_department_v1'));
 assert.match(wrapper,/security invoker/);assert.doesNotMatch(wrapper,/update public\.repair_items|from public\.repair_items[^;]*for update/);
 assert.equal((wrapper.match(/set_config\('app.repair_department_selection',v_previous,true\)/g)||[]).length,2);
 assert.match(sql,/perform public\.assert_customer_department_v1\(p_customer_id,v_department_id,v_before\.department_id/);
 assert.match(sql,/received_on, customer_id, department_id, inventory_item_id/);assert.match(sql,/department_id = v_department_id/);
});
