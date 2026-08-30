import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const edge = readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260830082440_create_secure_phone_data_module.sql", import.meta.url), "utf8");

test("phone schema stays linked to the customer contract and indexed", () => {
  for (const table of ["phone_systems", "phone_extensions", "phone_terminal_points", "phone_system_credentials", "phone_credential_access_logs"]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /foreign key \(customer_id, contract_service_type_id\)[\s\S]*customer_contract_services\(customer_id, service_type_id\)/);
  assert.match(migration, /phone_extensions_number_unique/);
  assert.match(migration, /phone_terminal_points_slot_idx/);
});

test("credentials are encrypted and inaccessible through the regular snapshot", () => {
  assert.match(migration, /vault\.create_secret/);
  assert.match(migration, /pgp_sym_encrypt/);
  assert.match(migration, /pgp_sym_decrypt/);
  assert.match(migration, /phone_credential_access_logs/);
  assert.match(migration, /revoke all on public\.phone_system_credentials from public, anon, authenticated/);
  assert.doesNotMatch(edge, /login_username_ciphertext|login_password_ciphertext/);
  assert.match(edge, /phone_systems\?select=id,customer_id,contract_service_type_id,system_name,ip_address/);
});

test("gateway enforces phone module RBAC", () => {
  assert.match(edge, /operation === "upsert_phone_system"[\s\S]*requireRole\(user,\["admin","operator"\]\)/);
  assert.match(edge, /operation === "upsert_phone_extension"[\s\S]*requireRole\(user,\["admin","operator"\]\)/);
  assert.match(edge, /operation === "delete_phone_system"[\s\S]*requireRole\(user,\["admin"\]\)/);
  assert.match(edge, /operation === "set_phone_system_credential"[\s\S]*requireRole\(user,\["admin"\]\)/);
  assert.match(edge, /operation === "reveal_phone_system_credential"[\s\S]*requireRole\(user,\["admin"\]\)/);
});
