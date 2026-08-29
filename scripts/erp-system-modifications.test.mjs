import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const nas = readFileSync(new URL("../api/nas.mjs", import.meta.url), "utf8");
const edge = readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260829000100_contract_attachment_project_path.sql", import.meta.url), "utf8");

test("附件承攬內容只由所選客戶關聯動態產生", () => {
  assert.match(js, /function syncAttachmentOptions/);
  assert.match(js, /customerContractServiceTypes\(customerRow\)/);
  assert.match(js, /row\.customerId===customer\.value/);
  assert.match(js, /name="contractServiceTypeId"|selectField\("contractServiceTypeId"/);
});

test("附件缺少承攬內容或專案時前後端都拒絕", () => {
  assert.match(js, /缺少專案時禁止上傳/);
  assert.match(nas, /UPLOAD_CONTEXT_REQUIRED/);
  assert.match(nas, /PROJECT_REQUIRED/);
  assert.match(edge, /!project_id/);
});

test("NAS 新附件使用客戶、承攬內容、專案、日期完整路徑", () => {
  assert.match(js, /safePathPart\(project\?\.name/);
  assert.match(nas, /\$\{contractServiceName\}\/\$\{projectName\}\/\$\{logDate\}/);
  assert.match(edge, /safePathPart\(services\[0\]\.name\).*safePathPart\(projects\[0\]\.name\).*\$\{log_date\}/);
  assert.match(migration, /project_id = p_project_id/);
});

test("上傳案場附件不再顯示或建立關聯工作日誌", () => {
  const attachmentModal = js.slice(js.indexOf('if(type==="attachmentModal")'), js.indexOf('if(type==="workLogModal")'));
  const contractAttachmentGateway = edge.slice(edge.indexOf('operation === "create_contract_site_attachment_batch"'), edge.indexOf('operation === "create_site_attachment_batch"'));
  assert.doesNotMatch(attachmentModal, /selectField\("workLogId"|關聯工作日誌/);
  assert.doesNotMatch(nas, /form\.get\("work_log_id"\)/);
  assert.match(contractAttachmentGateway, /work_log_id:null/);
  assert.match(migration, /work_log_id = null/);
});

test("登入成功後先顯示系統選擇且案場網址未設定時不跳轉", () => {
  assert.match(html, /id="systemChooser"/);
  assert.match(html, /data-system-choice="erp"/);
  assert.match(html, /data-system-choice="sites"/);
  assert.match(js, /const SITE_SYSTEM_TARGET_URL = ""/);
  assert.match(js, /showSystemChooser\(\)/);
  assert.match(js, /if\(!SITE_SYSTEM_TARGET_URL\)/);
});
