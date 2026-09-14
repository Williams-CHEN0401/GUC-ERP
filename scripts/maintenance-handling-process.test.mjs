import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const gateway=readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8');
const migration=readFileSync(new URL('../supabase/migrations/20260914130833_add_maintenance_handling_process.sql',import.meta.url),'utf8');

test('維修明細處理流程使用獨立欄位並完整通過表單、快照與閘道',()=>{
  assert.match(app,/eventHandlingProcess","處理流程（選填）"/);
  assert.match(app,/handling_process:handlingProcess/);
  assert.match(app,/handlingProcess:r\.handling_process\|\|""/);
  assert.match(gateway,/description,cause,handling_process,result,notes/);
  assert.match(gateway,/const handlingProcess = nullable\(row\.handling_process,2000\)/);
  assert.match(gateway,/hasOwnProperty\.call\(row,"handling_process"\) \? \{handling_process:handlingProcess \|\| null\} : \{\}/);
});

test('資料庫只擴充既有維修事件，保留原 RPC 權限與原子儲存流程',()=>{
  assert.match(migration,/alter table public\.maintenance_events\s+add column if not exists handling_process text/i);
  assert.match(migration,/maintenance_events_handling_process_check/);
  assert.match(migration,/v_handling_process := nullif\(btrim\(coalesce\(v_event_json->>'handling_process',''\)\),''\)/);
  assert.match(migration,/cause,handling_process,result,notes/);
  assert.match(migration,/handling_process = v_handling_process/);
  assert.match(migration,/not \(v_event_json \? 'handling_process'\)[\s\S]*v_handling_process := v_before\.handling_process/);
  assert.match(migration,/security definer\s+set search_path = ''/i);
  assert.match(migration,/revoke all on function public\.upsert_customer_project_work_log_with_maintenance_v1[\s\S]*from public, anon, authenticated/i);
  assert.match(migration,/grant execute on function public\.upsert_customer_project_work_log_with_maintenance_v1[\s\S]*to service_role/i);
  assert.doesNotMatch(migration,/\b(?:drop table|delete from public\.maintenance_events|truncate)\b/i);
});

test('設備履歷回傳處理流程，供案場承攬系統後續與故障原因對照',()=>{
  assert.match(migration,/events\.cause,\s+events\.handling_process,\s+events\.result/);
});
