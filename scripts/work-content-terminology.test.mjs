import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const permissions = readFileSync(new URL("../permissions-ui.js", import.meta.url), "utf8");
const audit = readFileSync(new URL("../audit-ui.js", import.meta.url), "utf8");

test("ERP visible project terminology is renamed to work content", () => {
  for (const source of [html, app, permissions, audit]) assert.doesNotMatch(source, /專案/);
  for (const marker of ["工作內容管理", "工作內容統計報表", "工作內容名稱", "角色／工作內容權限"]) {
    assert.ok(html.includes(marker) || app.includes(marker), marker);
  }
  assert.match(permissions, /使用者可存取工作內容/);
  assert.match(audit, /PROJECT_UPDATE: "修改工作內容"/);
});

test("internal project identifiers and existing relations remain unchanged", () => {
  assert.match(app, /state\.projects/);
  assert.match(app, /project_id/);
  assert.match(app, /project_name/);
  assert.match(permissions, /project_scoped/);
  assert.match(permissions, /projectAccess/);
});

test("work-log operation annotations are removed while confirmations remain", () => {
  const start = html.indexOf('<section class="page" id="worklogs"');
  const end = html.indexOf('<section class="page" id="materials"', start);
  const worklogSection = html.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(worklogSection, /list-row-hint|獨立管理所有客戶/);
  for (const annotation of [
    "可填實際施工時段",
    "本次施工人員請獨立選擇",
    "工作類型與狀態會同步到工作內容管理",
    "若本次有設備維修",
    "選擇「是」後可建立多筆事件",
    "維修內容沿用上方",
    "內容沿用上方工作內容",
    "選擇設備才會同步",
    "依客戶與承攬內容篩選",
    "儲存後會寫入既有取貨資料表",
    "使用與進出貨管理相同的品項",
  ]) assert.ok(!app.includes(annotation), annotation);
  assert.match(app, /是否要登錄維修設備/);
  assert.match(app, /工作日誌已建立。是否要立即進入/);
  assert.match(app, /已選 \$\{selectedCount\} 位/);
});
