import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const gateway = readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260904120000_equipment_maintenance_history.sql", import.meta.url), "utf8");

test("shared registry preserves source UUIDs and all maintenance tables use restrictive foreign keys", () => {
  for (const marker of ["create table if not exists public.equipment_registry", "unique (source_table, source_id)", "create table if not exists public.maintenance_events", "create table if not exists public.maintenance_event_equipment", "create table if not exists public.maintenance_event_workers", "on delete restrict"]) assert.ok(migration.toLowerCase().includes(marker), marker);
  for (const source of ["site_devices", "phone_systems", "phone_extensions", "phone_terminal_points"]) assert.match(migration, new RegExp(source));
  assert.match(migration, /Legacy maintenance_details is project-level and has no reliable equipment mapping/);
});

test("tables are private to the service role and history cannot be physically deleted", () => {
  for (const table of ["equipment_registry", "maintenance_events", "maintenance_event_equipment", "maintenance_event_workers"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"));
  }
  assert.match(migration, /maintenance_events_no_delete/);
  assert.match(migration, /設備維修履歷不可實體刪除/);
  assert.match(migration, /soft_delete_site_work_log_v1/);
});

test("work log and equipment events save through one atomic database function", () => {
  assert.match(migration, /upsert_customer_project_work_log_with_maintenance_v1/);
  assert.match(migration, /upsert_customer_project_work_log_v3/);
  assert.match(migration, /jsonb_array_length\(p_maintenance_events\) > 20/);
  assert.match(migration, /registry\.customer_id = p_customer_id/);
  assert.match(gateway, /maintenanceEventsInput/);
  assert.match(gateway, /p_maintenance_events:maintenance_events/);
  assert.match(gateway, /requireRole\(user,\["admin"\]\).*void_maintenance_event/s);
  assert.match(migration, /'maintenance_event_equipment'[\s\S]*'equipment_ids'/);
  assert.match(migration, /'maintenance_event_workers'[\s\S]*'user_ids'/);
  assert.match(migration, /'maintenance_event_result'/);
});

test("ERP form supports multiple events, multi-device drawer and preview-only simulation", () => {
  for (const marker of ["登錄維修事項", "data-add-maintenance-event", "data-open-equipment-picker", "equipment-drawer", "collectMaintenanceEvents", "maintenance_event_count", "內容沿用上方工作內容；可同時連結多台設備"]) assert.ok(`${app}\n${styles}`.includes(marker), marker);
  assert.doesNotMatch(app, /confirm\("本次工作日誌/);
  assert.match(app, /if\(PREVIEW_MODE\)\{const result=applyPreviewMutation/);
  assert.match(app, /customer_category\|\|"government"/);
  assert.match(app, /永久履歷｜錯誤時由管理員作廢/);
  assert.match(app, /設備未建檔/);
});

test("work log content is shared with maintenance event descriptions", () => {
  assert.match(app, /工作內容／維修設定內容/);
  assert.match(app, /sharedDescription=form\.elements\.summary/);
  assert.match(app, /description=sharedDescription/);
  assert.doesNotMatch(app, /inputField\("eventDescription"/);
});

test("confirmed empty categories migrate to government without introducing a category foreign key", () => {
  assert.match(migration, /update public\.customers[\s\S]*customer_category = 'government'[\s\S]*customer_category is null or btrim\(customer_category\) = ''/);
  assert.doesNotMatch(migration, /customer_category_id|customer_categories/);
});
