import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const html = read("../index.html");
const app = read("../app.js");
const gateway = read("../supabase/functions/inventory-gateway/index.ts");
const migration = read("../supabase/migrations/20260916232954_work_assignments_dashboard.sql");
const indexMigration = read("../supabase/migrations/20260916233046_index_work_assignments_inventory_item.sql");

test("dashboard exposes admin assignment creation and current-user completion controls", () => {
  for (const marker of ["workAssignmentModal", "pendingAssignmentList", "completedAssignmentList", "data-complete-assignment", "data-acknowledge-assignment"]) {
    assert.ok((html + app).includes(marker), marker);
  }
  assert.match(app, /role!=="admin"/);
  assert.match(app, /create_work_assignment/);
  assert.match(app, /complete_work_assignment/);
  assert.match(app, /acknowledge_work_assignment/);
  assert.match(app, /assignmentType==="pickup"/);
});

test("assignment SQL is private, transactional and idempotently links pickup records", () => {
  assert.match(migration, /create table if not exists public\.work_assignments/);
  assert.match(migration, /alter table public\.work_assignments enable row level security/);
  assert.match(migration, /revoke all on table public\.work_assignments from public, anon, authenticated/);
  assert.match(migration, /create unique index if not exists pickup_records_work_assignment_uidx/);
  assert.match(migration, /create or replace function public\.complete_work_assignment_v1/);
  assert.match(migration, /on conflict \(work_assignment_id\) where work_assignment_id is not null/);
  assert.match(migration, /for update/);
  assert.match(migration, /role = 'admin' and is_active/);
  assert.match(indexMigration, /work_assignments_inventory_item_idx/);
});

test("deleted work content is hidden from active reads while historical logs and pickup labels survive", () => {
  assert.match(migration, /add column if not exists deleted_at timestamptz/);
  assert.match(migration, /delete_project_record[\s\S]*set deleted_at = statement_timestamp\(\)/);
  assert.match(migration, /v_log_projects[\s\S]*site_work_logs where project_id = any\(v_log_projects\)/);
  assert.match(gateway, /projects\?deleted_at=is\.null/);
  assert.match(gateway, /project:projects!pickup_records_project_id_fkey/);
  assert.match(app, /historical\.name\|\|"已刪除工作內容"/);
});

test("dashboard keeps every previous Taipei-day log and excludes completed work from to-do", () => {
  assert.match(gateway, /timeZone:"Asia\/Taipei"/);
  assert.match(gateway, /site_work_logs\?select=[^`]+log_date=eq\.\$\{previousBusinessDate\}[^`]+order=created_at\.asc,id\.asc/);
  assert.doesNotMatch(gateway.match(/site_work_logs\?select=[^`]+log_date=eq\.\$\{previousBusinessDate\}[^`]+/s)?.[0] || "", /limit=/);
  assert.match(gateway, /status=neq\.completed/);
  assert.match(app, /dashboardWorklogDate/);
});

test("removed backup and role-permission entries are absent without removing RBAC enforcement", () => {
  assert.doesNotMatch(html, /data-page="backup"|permissionSettings|角色／工作內容權限/);
  assert.doesNotMatch(app, /exportBackup/);
  assert.match(app, /applyPermissionUI\(\)/);
  assert.match(gateway, /requireOperation\(/);
});
