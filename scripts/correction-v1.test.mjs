import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260828000200_standalone_work_logs_contracts_accounts_nas.sql", import.meta.url), "utf8");

test("工作日誌先依客戶類型篩選，再選擇客戶", () => {
  const category = html.indexOf('id="worklogCustomerCategoryFilter"');
  const customer = html.indexOf('id="worklogCustomerFilter"');
  assert.ok(category >= 0 && customer > category);
  assert.match(js, /syncModalCustomerOptions/);
});

test("工作日誌雙擊整列開啟內容，操作選單不再包含內容入口", () => {
  const start = js.indexOf("function workLogActionMenu");
  const end = js.indexOf("function renderWorkLogs", start);
  const menu = js.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(menu, /worklog-content-action/);
  assert.doesNotMatch(menu, /data-edit-work-log/);
  assert.match(js, /data-work-log-row/);
  assert.match(js, /addEventListener\("dblclick"/);
  assert.match(js, /openModal\("workLogModal",row\.dataset\.workLogRow\)/);
  assert.doesNotMatch(menu, /log\.summary/);
  assert.match(js, /<td><strong>\$\{esc\(log\.project\)\}<\/strong><\/td>/);
});

test("Preview NAS 檢查不讀取正式帳密或呼叫 NAS API", () => {
  const start = js.indexOf("async function checkNasConnection");
  const end = js.indexOf("async function", start + 30);
  const check = js.slice(start, end);
  const previewGuard = check.indexOf("if(PREVIEW_MODE)");
  const networkCall = check.indexOf("fetch(NAS_API_ENDPOINT");
  assert.ok(previewGuard >= 0 && networkCall > previewGuard);
  assert.ok(check.indexOf("return true;", previewGuard) < networkCall);
});

test("正式附件送出會重試 NAS 健康檢查並保留真正錯誤原因", () => {
  const submitStart = js.indexOf("async function handleModalSubmit");
  const attachmentStart = js.indexOf('if(type==="attachmentModal"){', submitStart);
  const attachmentEnd = js.indexOf('if(type==="siteEntryModal")', attachmentStart);
  const attachmentSubmit = js.slice(attachmentStart, attachmentEnd);
  assert.ok(submitStart >= 0 && attachmentStart > submitStart && attachmentEnd > attachmentStart);
  assert.match(attachmentSubmit, /const nasAvailable=await checkNasConnection\(\)/);
  assert.match(attachmentSubmit, /if\(!nasAvailable\)throw new Error\(nasConnectionState\.message\|\|"NAS 尚未通過連線檢查。"\)/);

  const checkStart = js.indexOf("async function checkNasConnection");
  const checkEnd = js.indexOf("async function", checkStart + 30);
  const connectionCheck = js.slice(checkStart, checkEnd);
  assert.match(connectionCheck, /return true;/);
  assert.match(connectionCheck, /return false;/);
});

test("承攬關聯 migration 具備外鍵索引與發布前資料防護", () => {
  for (const marker of [
    "customer_contract_services_service_type_id_idx",
    "customer_contract_services_created_by_idx",
    "仍有專案未關聯客戶",
    "同一客戶內仍有重複專案名稱",
  ]) assert.ok(migration.includes(marker), marker);
});
