import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const gateway = readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260902110557_sync_project_type_status_with_work_logs.sql", import.meta.url), "utf8");

test("project and work-log types share the same three exact values", () => {
  assert.match(app, /PROJECT_WORK_TYPES\s*=\s*\[\["construction", "工程施工"\], \["repair", "維修紀錄"\], \["maintenance", "維護保養"\]\]/);
  assert.ok(app.includes('selectField("type","專案類型",PROJECT_WORK_TYPES'));
  assert.ok(app.includes('PROJECT_WORK_TYPES.map(([value,label])=>[label,label])'));
  assert.match(gateway, /\["construction","repair","maintenance"\]/);
});

test("work-log project selection preloads shared type and status", () => {
  assert.ok(app.includes("form.elements.workType.value=workTypeFromProjectType(project.rawType)"));
  assert.ok(app.includes("form.elements.status.value=project.status"));
  assert.ok(app.includes("工作類型與狀態會同步到專案管理，以及同一專案的其他工作日誌"));
});

test("preview mutations mirror type and status in both directions", () => {
  assert.ok(app.includes("project.rawType=projectType;project.status=payload.status"));
  assert.ok(app.includes("log.work_type=payload.work_type;log.status=payload.status"));
  assert.ok(app.includes("log.work_type=workType;log.status=payload.status"));
});

test("new work log offers the existing pickup workflow", () => {
  assert.ok(app.includes("result?.work_log?.id||result?.result?.work_log?.id"));
  assert.ok(app.includes('confirm("工作日誌已建立。是否要立即進入「操作 → 登錄取貨」？")'));
  assert.ok(app.includes('openModal("workLogPickupModal",pickupLogId)'));
});

test("migration enforces bidirectional project-level synchronization", () => {
  for (const marker of [
    "check (project_type in ('construction', 'repair', 'maintenance'))",
    "order by logs.project_id, logs.log_date desc, logs.updated_at desc, logs.id desc",
    "sync_project_fields_to_work_logs_v1",
    "sync_work_log_fields_to_project_v1",
    "projects_sync_work_logs_v1",
    "work_logs_sync_project_v1",
    "security invoker",
    "set search_path = ''",
    "from public, anon, authenticated",
    "work_type = v_work_type",
    "status = p_status",
  ]) assert.ok(migration.includes(marker), marker);
  assert.doesNotMatch(migration, /\bdrop\s+table\b|\btruncate\b/i);
});

