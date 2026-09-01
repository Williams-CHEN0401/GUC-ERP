import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const edge = readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260831153450_phone_terminal_excel_import.sql", import.meta.url), "utf8");

test("terminal imports use dedicated phone-only tables with RLS", () => {
  for (const table of ["phone_terminal_import_batches", "phone_terminal_import_rows"]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`revoke all on public\\.${table} from public, anon, authenticated`));
  }
  assert.match(migration, /references public\.customer_contract_services\(customer_id, service_type_id\)/);
  assert.doesNotMatch(migration, /inventory_items|pickup_records|stock_receipts|projects|site_work_logs/);
  assert.doesNotMatch(migration, /drop table|truncate|delete from public\./i);
});

test("commit RPC is service-role only and resolves rows inside one transaction", () => {
  assert.match(migration, /create or replace function public\.commit_phone_terminal_import_v1/);
  assert.match(migration, /security definer\s+set search_path = ''/);
  assert.match(migration, /revoke all on function public\.commit_phone_terminal_import_v1[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.commit_phone_terminal_import_v1[\s\S]*to service_role/);
  assert.match(migration, /for v_row, v_ordinality in[\s\S]*begin[\s\S]*exception when others/);
  assert.match(migration, /extension_number = coalesce\(v_phone, extension_number\)/);
  assert.match(migration, /building_name = coalesce\(v_building, building_name\)/);
});

test("field rows require an exact system-side phone match and never create orphans", () => {
  assert.match(migration, /if p_import_type = 'system' then/);
  assert.match(migration, /if v_phone is null then raise exception '缺少電話／分機，無法對應既有系統端。'/);
  assert.match(migration, /extension_number = v_phone/);
  assert.match(migration, /endpoint_side = 'system'/);
  assert.match(migration, /為避免孤立資料不會新增/);
  assert.match(migration, /on conflict \(phone_extension_id, endpoint_side\) do update/);
});

test("gateway provides preview and commit with RBAC and validation", () => {
  assert.match(edge, /operation === "preview_phone_terminal_import"[\s\S]*requireRole\(user,\["admin","operator"\]\)/);
  assert.match(edge, /operation === "commit_phone_terminal_import"[\s\S]*requireRole\(user,\["admin","operator"\]\)/);
  assert.match(edge, /phoneTerminalImportRows\(payload\.rows\)/);
  assert.match(edge, /value\.length > 1000/);
  assert.match(edge, /同一匯入檔有重複的端子板＋槽位/);
  assert.match(edge, /同一匯入檔有重複的電話／分機/);
  assert.match(edge, /commit_phone_terminal_import_v1/);
});
