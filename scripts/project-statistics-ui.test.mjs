import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const edge = readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts", import.meta.url), "utf8");

test("project statistics keeps the existing route and exposes the requested tabs", () => {
  assert.match(html, /data-page="materials"[\s\S]*專案統計報表/);
  for (const [key, label] of [["overview", "總覽"], ["materials", "用料統計"], ["workers", "施工人員"]]) {
    assert.match(html, new RegExp(`data-report-tab="${key}"[^>]*>${label}<`));
  }
  assert.match(html, /id="materialDateFrom" type="date"/);
  assert.match(html, /id="materialDateTo" type="date"/);
  assert.match(app, /data-edit-work-log/);
  assert.match(app, /function exportProjectMaterials/);
});

test("materials scope includes work-log worker data and paginates growing datasets", () => {
  assert.match(edge, /materials: \["customers", "projects", "items", "pickups", "site_work_logs", "site_work_log_workers", "site_workers"\]/);
  for (const dataset of ["customers", "projects", "items", "pickups", "receipts", "adjustments", "site_work_logs", "site_work_log_workers", "site_workers"]) {
    assert.match(edge, new RegExp(`${dataset}: \\{[^\\n]+paged: true`));
  }
  assert.match(edge, /definition\.paged \? getAll\(definition\.path\) : get\(definition\.path\)/);
});

test("report blocks incomplete scope, compares material quantities per unit, and avoids account enumeration", () => {
  assert.match(app, /required=new Set\(\["customers","projects","items","pickups","site_work_logs","site_work_log_workers","site_workers"\]\)/);
  assert.match(app, /function reportMaterialQuantityBars/);
  assert.match(app, /reportBars\([^\n]+"quantity"/);
  assert.match(edge, /site_workers: \{ path: "app_users\?select=id,display_name,is_active/);
  assert.doesNotMatch(edge, /site_workers: \{ path: "app_users\?select=id,username/);
});

test("large snapshot hydration uses lookup maps instead of nested full scans", () => {
  assert.match(app, /function sumInventoryTransactions/);
  assert.match(app, /const projectById=new Map/);
  assert.doesNotMatch(app, /receipts\.filter\(\(x\)=>x\.inventory_item_id===r\.id\)/);
});
