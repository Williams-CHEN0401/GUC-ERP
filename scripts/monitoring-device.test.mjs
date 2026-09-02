import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const edge=readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts",import.meta.url),"utf8");
const migration=readFileSync(new URL("../supabase/migrations/20260902010234_monitoring_device_management.sql",import.meta.url),"utf8");

test("monitoring credentials use AES-256-GCM in the Edge Function and never decrypt",()=>{
  for(const marker of ["GUC_DEVICE_CREDENTIAL_KEY_V1","keyBytes.length !== 32","AES-GCM","new Uint8Array(12)","tagLength: 128","plaintext.fill(0)"])assert.ok(edge.includes(marker),`missing ${marker}`);
  assert.doesNotMatch(edge,/crypto\.subtle\.decrypt|operation === "reveal_monitoring/);
  assert.ok(edge.includes("site_device_credentials?device_id=in.(${deviceIds.join(\",\")})&select=device_id,masked_username"));
});

test("monitoring credential key is generated in Vault and exposed only to the service role",()=>{
  for(const marker of ["guc_monitoring_device_credentials_v1","extensions.gen_random_bytes(32)","get_monitoring_device_key_v1","from public, anon, authenticated","to service_role"])assert.ok(migration.includes(marker),`missing ${marker}`);
  assert.match(edge,/monitoringDeviceCredentialKey/);
  assert.match(edge,/rpc\("get_monitoring_device_key_v1", \{\}\)/);
});

test("preview gateway blocks every non-login POST at the Edge boundary",()=>{
  assert.match(edge,/endsWith\("\/inventory-gateway-preview"\)/);
  assert.match(edge,/if \(isPreviewGateway\) return json\([^;]*PREVIEW_READ_ONLY/s);
  assert.ok(edge.indexOf("if (isPreviewGateway)")<edge.indexOf("const user = await currentUser(request)",edge.indexOf("if (isPreviewGateway)")));
});

test("gateway enforces monitoring roles and does not expose credential material",()=>{
  for(const marker of ['operation === "upsert_monitoring_device"','operation === "delete_monitoring_device"','operation === "import_monitoring_devices"','requireRole(user,["admin","operator"])','requireRole(user,["admin"])'])assert.ok(edge.includes(marker),`missing ${marker}`);
  const select=edge.match(/const MONITORING_DEVICE_SELECT = ([^;]+);/)?.[1]||"";
  assert.doesNotMatch(select,/password|username|ciphertext|authentication_tag|iv/);
});

test("migration extends site_devices, enables RLS, and keeps import atomic",()=>{
  for(const marker of ["alter table public.site_devices","site_device_credentials","username_ciphertext bytea","password_ciphertext bytea","enable row level security","revoke all","grant execute","import_monitoring_devices_v1","jsonb_array_elements","site_devices_active_ip_unique","deleted_at is null","monitoring_device_import_rows"])assert.ok(migration.includes(marker),`missing ${marker}`);
  assert.match(migration,/begin;[\s\S]*create or replace function public\.import_monitoring_devices_v1[\s\S]*commit;/);
  assert.doesNotMatch(migration,/login_password\s+text|login_username\s+text/);
});

test("import history stores only sanitized credential indicators",()=>{
  const sanitized=migration.slice(migration.indexOf("jsonb_build_object(\n        'device_name'"),migration.indexOf("v_count :=",migration.indexOf("jsonb_build_object(\n        'device_name'")));
  assert.match(sanitized,/masked_username/);
  assert.match(sanitized,/password_provided/);
  assert.doesNotMatch(sanitized,/ciphertext|authentication_tag|login_password|password_ciphertext/);
});

