import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

test("新增工作日誌會在開啟前確認並補載施工人員清單", () => {
  const start = app.indexOf("async function ensureWorkLogWorkers");
  const end = app.indexOf("function syncAttachmentOptions", start);
  const handler = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(handler, /state\.siteWorkers\.some\(\(worker\)=>worker\.active\)/);
  assert.match(handler, /for\(const scope of \["worklogs","crm"\]\)/);
  assert.match(handler, /loadScope\(scope,\{force:true,silent:true\}\)/);
  assert.match(handler, /error\.dataset==="site_workers"/);
  assert.match(handler, /openModal\("workLogModal",id\)/);
  assert.match(app, /dataset\.open==="workLogModal"\)await openWorkLogModal\(\)/);
});

test("施工人員選項保留原生複選、選取計數與手機觸控區域", () => {
  const start = app.indexOf("function workerPickerField");
  const end = app.indexOf("function customerMaintenanceServices", start);
  const picker = app.slice(start, end);

  assert.match(picker, /type="checkbox" name="\$\{esc\(name\)\}"/);
  assert.match(picker, /data-worker-count="\$\{esc\(name\)\}"/);
  assert.match(app, /new FormData\(form\)\.getAll\("workerIds"\)/);
  assert.match(app, /worker_user_ids:workerIds/);
  assert.match(styles, /\.worker-picker label\{[^}]*min-height:46px[^}]*touch-action:manipulation/);
  assert.match(styles, /\.worker-picker input\{[^}]*width:21px!important[^}]*height:21px!important/);
});
