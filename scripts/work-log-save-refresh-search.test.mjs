import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const gateway = readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts", import.meta.url), "utf8");

test("工作日誌頁使用獨立資料範圍，避免其他案場資料拖慢儲存後刷新", () => {
  assert.match(app, /worklogs:"worklogs"/);
  assert.match(gateway, /worklogs: \["customers", "contract_service_types", "customer_contract_services", "projects", "project_workers", "items", "categories", "pickups", "sites", "site_work_logs", "site_work_log_workers", "site_workers", "site_assets", "equipment_registry", "maintenance_events", "maintenance_event_equipment", "maintenance_event_workers"\]/);
});

test("工作日誌儲存後依資料庫回傳 ID 與欄位重新讀取核對", () => {
  assert.match(app, /function savedWorkLogId/);
  assert.match(app, /function workLogMatchesSave/);
  assert.match(app, /async function verifySavedWorkLog/);
  assert.match(app, /reloadScope:"worklogs"/);
  assert.match(app, /await verifySavedWorkLog\(result,payload\)/);
  assert.match(app, /工作日誌已寫入，但重新讀取核對不一致/);
});

test("工作日誌搜尋涵蓋中文狀態、客戶分類、日期格式與取貨摘要", () => {
  assert.match(app, /function workLogStatusText/);
  assert.match(app, /customerCategoryLabel:customerCategoryLabel/);
  assert.match(app, /statusText:workLogStatusText/);
  assert.match(app, /formatDate\(log\.log_date\)/);
  assert.match(app, /log\.pickupSummary,log\.summary/);
});
