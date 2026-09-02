import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const edge = readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260830082440_create_secure_phone_data_module.sql", import.meta.url), "utf8");
const hardening = readFileSync(new URL("../supabase/migrations/20260830083755_harden_phone_module_service_role_grants.sql", import.meta.url), "utf8");
const phoneLocation = readFileSync(new URL("../supabase/migrations/20260831000200_phone_building_and_optional_extension.sql", import.meta.url), "utf8");
const phoneImport = readFileSync(new URL("../supabase/migrations/20260831043000_phone_terminal_excel_import.sql", import.meta.url), "utf8");
const phoneSourceFields = readFileSync(new URL("../supabase/migrations/20260901090000_phone_terminal_source_fields.sql", import.meta.url), "utf8");

test("phone schema stays linked to the customer contract and indexed", () => {
  for (const table of ["phone_systems", "phone_extensions", "phone_terminal_points", "phone_system_credentials", "phone_credential_access_logs"]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /foreign key \(customer_id, contract_service_type_id\)[\s\S]*customer_contract_services\(customer_id, service_type_id\)/);
  assert.match(migration, /phone_extensions_number_unique/);
  assert.match(migration, /phone_terminal_points_slot_idx/);
});

test("phone location migration is additive and keeps legacy rows compatible", () => {
  assert.match(phoneLocation, /add column if not exists building_name text/);
  assert.match(phoneLocation, /alter column extension_number drop not null/);
  assert.match(phoneLocation, /extension_number is null/);
  assert.match(phoneLocation, /phone_extensions_building_floor_idx/);
  assert.match(phoneLocation, /upsert_phone_extension_v2/);
  assert.doesNotMatch(phoneLocation, /delete from public\.phone_extensions|truncate|drop table/);
});

test("phone Excel import is row-rollback safe, logged, service-role only, and prevents orphan field endpoints", () => {
  for (const marker of ["phone_terminal_import_logs", "import_phone_terminal_rows_v1", "phone_terminal_points_location_uidx", "source_rows", "failure_reasons", "preview_status", "frame_name", "source_column", "exception", "when others", "現場端資料不得建立為沒有系統端的孤立資料"]) assert.ok(phoneImport.includes(marker), `missing phone import marker: ${marker}`);
  assert.match(phoneImport, /security definer/);
  assert.match(phoneImport, /revoke all on function public\.import_phone_terminal_rows_v1[\s\S]*from public, anon, authenticated/);
  assert.match(phoneImport, /grant execute on function public\.import_phone_terminal_rows_v1[\s\S]*to service_role/);
  assert.match(edge, /operation === "import_phone_terminal_rows"[\s\S]*requireRole\(user,\["admin","operator"\]\)/);
  assert.match(edge, /preview_status/);
  assert.match(edge, /eligibleRows/);
  for (const marker of ["phone_type_match_status", "normalizeMatch", "typesBySource", "phone_type_matched", "failure_reasons", 'operation === "import_phone_terminal_rows"']) assert.ok(edge.includes(marker), `missing exact type matching/result marker: ${marker}`);
  assert.match(edge, /return json\(\{ ok: true, result,/);
  assert.match(edge, /const logId=uuid\(result\?\.log_id\)/);
  assert.doesNotMatch(edge, /Number\(result\?\.log_id\)/);
  assert.match(edge, /getAll\(`phone_extensions[\s\S]*getAll\(`phone_terminal_points/);
  assert.match(edge, /\.find\(value=>\/\^Excel\\s\*型態[\s\S]*\?\.trim\(\)\.replace/);
  assert.match(edge, /targetType!=="unknown"&&targetType!==computedPhoneType/);
  assert.match(edge, /確認匯入時已依最新系統端資料重新驗證/);
  assert.doesNotMatch(edge, /話機類型匹配狀態與系統端資料不一致|電話類型與系統端精確匹配結果不一致/);
  assert.doesNotMatch(phoneImport, /delete from public\.phone_extensions|truncate|drop table/);
});

test("source terminal fields reuse frame columns through an additive v3 RPC", () => {
  for (const marker of ["upsert_phone_extension_v3", "p_source_terminal_group", "p_source_terminal_board", "frame_name", "frame_block", "frame_position", "phone_terminal_points_location_uidx"]) assert.ok(phoneSourceFields.includes(marker), `missing source terminal marker: ${marker}`);
  assert.match(phoneSourceFields, /revoke all on function public\.upsert_phone_extension_v3[\s\S]*from public, anon, authenticated/);
  assert.match(phoneSourceFields, /grant execute on function public\.upsert_phone_extension_v3[\s\S]*to service_role/);
  assert.doesNotMatch(phoneSourceFields, /add column|drop table|truncate|delete from public\.phone_extensions/);
  assert.match(edge, /sourceFieldsProvided=Object\.prototype\.hasOwnProperty/);
  assert.match(edge, /source_terminal_group=nullable/);
  assert.match(edge, /source_terminal_board=nullable/);
  assert.match(edge, /p_source_fields_provided:sourceFieldsProvided/);
  assert.match(edge, /rpc\("upsert_phone_extension_v3"/);
  assert.match(phoneSourceFields, /phone_terminal_points\.frame_name/);
  assert.match(phoneSourceFields, /phone_terminal_points\.frame_block/);
  assert.match(phoneSourceFields, /數字系統端槽位必須介於 1 到 10000/);
  assert.match(phoneSourceFields, /coalesce\(nullif\(btrim\(coalesce\(p_source_terminal_board, ''\)\), ''\), ''\)/);
  assert.match(phoneSourceFields, /when coalesce\(p_source_fields_provided, false\) then excluded\.frame_block/);
});

test("credentials are encrypted and inaccessible through the regular snapshot", () => {
  assert.match(migration, /vault\.create_secret/);
  assert.match(migration, /pgp_sym_encrypt/);
  assert.match(migration, /pgp_sym_decrypt/);
  assert.match(migration, /phone_credential_access_logs/);
  assert.match(migration, /revoke all on public\.phone_system_credentials from public, anon, authenticated/);
  assert.match(hardening, /revoke all on public\.phone_system_credentials from service_role/);
  assert.match(hardening, /grant select on public\.phone_credential_access_logs to service_role/);
  assert.doesNotMatch(hardening, /grant .*phone_system_credentials to service_role/);
  assert.doesNotMatch(edge, /login_username_ciphertext|login_password_ciphertext/);
  assert.match(edge, /phone_systems\?select=id,customer_id,contract_service_type_id,system_name,ip_address/);
});

test("gateway enforces phone module RBAC", () => {
  assert.match(edge, /operation === "upsert_phone_system"[\s\S]*requireRole\(user,\["admin","operator"\]\)/);
  assert.match(edge, /operation === "upsert_phone_extension"[\s\S]*requireRole\(user,\["admin","operator"\]\)/);
  assert.match(edge, /operation === "delete_phone_system"[\s\S]*requireRole\(user,\["admin"\]\)/);
  assert.match(edge, /operation === "set_phone_system_credential"[\s\S]*requireRole\(user,\["admin"\]\)/);
  assert.match(edge, /operation === "reveal_phone_system_credential"[\s\S]*requireRole\(user,\["admin"\]\)/);
  assert.match(edge, /upsert_phone_extension_v3/);
  assert.match(edge, /p_building_name/);
  assert.match(edge, /extension_number=nullable/);
  assert.match(edge, /building_name,floor,installation_location/);
});

test("void RPC success responses do not become false failures", () => {
  assert.match(edge, /async function rpc[\s\S]*const raw = await response\.text\(\)/);
  assert.match(edge, /if \(raw\)[\s\S]*JSON\.parse\(raw\)/);
  assert.match(edge, /if \(!response\.ok\)[\s\S]*return body/);
  assert.doesNotMatch(edge, /async function rpc[^\n]*return response\.json\(\)/);
  for (const operation of ["delete_phone_system", "delete_phone_extension", "set_phone_system_credential"]) {
    assert.ok(edge.includes(`operation === "${operation}"`), `missing void RPC caller: ${operation}`);
  }
});

test("phone system updates preserve useful database errors", () => {
  assert.match(edge, /async function updatePhoneSystem[\s\S]*failure\.code === "23505"/);
  assert.match(edge, /同一客戶的總機名稱已存在/);
  assert.match(edge, /failure\.code === "23503" && name === "delete_phone_system_v1"/);
  assert.match(edge, /此總機仍有關聯的分機或端子資料/);
  assert.doesNotMatch(edge, /throw new Error\(failure\.message \|\| "總機資料更新失敗/);
});
