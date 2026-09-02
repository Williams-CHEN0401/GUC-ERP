import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const edge = readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260831081216_work_log_period_project_status_sync.sql", import.meta.url), "utf8");

test("工作日誌清單隱藏時段與狀態、日期下拉選單，但保留狀態欄位", () => {
  assert.doesNotMatch(html, /id="worklogStatusFilter"/);
  assert.doesNotMatch(html, /id="worklogSort"/);
  assert.doesNotMatch(html, /<th>時段<\/th>/);
  assert.match(html, /data-key="status">狀態/);
  assert.match(js, /log\.time_period/);
  assert.match(js, /statusLabel\(log\.status\)/);
});

test("工作日誌表單可填時段與選擇進行中或已完成", () => {
  assert.match(js, /function workLogTimePeriodField/);
  assert.match(js, /name="timePeriod"/);
  assert.match(js, /maxlength="80"/);
  assert.match(js, /\[\["in_progress","進行中"\],\["completed","已完成"\]\]/);
  assert.match(js, /time_period:timePeriod/);
  assert.match(js, /status:data\.status/);
});

test("Preview 中從工作日誌或專案修改狀態都同步同專案日誌", () => {
  assert.match(js, /state\.siteData\.logs\.filter\(\(log\)=>log\.projectId===r\.id\)/);
  assert.match(js, /project\.status=payload\.status/);
  assert.match(js, /state\.siteData\.logs\.filter\(\(log\)=>log\.projectId===project\.id\)/);
  assert.match(js, /log\.status=payload\.status/);
});

test("Gateway 新版請求使用狀態同步 RPC，舊版前端仍可在切換期間寫入", () => {
  assert.match(edge, /time_period=nullable\(payload\.time_period,80\)/);
  assert.match(edge, /\["in_progress","completed"\]\.includes\(status\)/);
  assert.match(edge, /legacyRequest=!Object\.prototype\.hasOwnProperty\.call\(payload,"time_period"\)/);
  assert.match(edge, /if\(legacyRequest\)return rpc\("upsert_customer_project_work_log_v2"/);
  assert.match(edge, /rpc\("upsert_customer_project_work_log_v3"/);
  assert.match(edge, /rpc\("upsert_erp_project_with_workers_v2"/);
});

test("Migration 新增欄位、同步既有狀態並限制 RPC 權限", () => {
  for (const marker of [
    "add column if not exists time_period text",
    "alter column status set default 'in_progress'",
    "set status = projects.status",
    "upsert_project_site_work_log_v2",
    "upsert_customer_project_work_log_v3",
    "upsert_erp_project_with_workers_v2",
    "and id <> v_log.id",
    "from public, anon, authenticated",
    "to service_role",
  ]) assert.ok(migration.includes(marker), marker);
  assert.doesNotMatch(migration, /drop\s+table|truncate\s+table/i);
});
