import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260904120000_equipment_maintenance_history.sql", import.meta.url), "utf8");

function functionSource(name, nextName) {
  const start = app.indexOf(`function ${name}`);
  const end = app.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `${name} is missing`);
  assert.notEqual(end, -1, `${nextName} is missing`);
  return app.slice(start, end);
}

test("native sidebar new tabs securely request the existing same-origin session", () => {
  assert.match(app, /new BroadcastChannel\(SESSION_CHANNEL_NAME\)/);
  assert.match(app, /SESSION_REQUEST_MESSAGE/);
  assert.match(app, /SESSION_RESPONSE_MESSAGE/);
  assert.match(app, /requestId: message\.requestId, accessToken/);
  assert.match(app, /storeAccessToken\(await requestSessionFromOtherTab\(\)\)/);
  assert.doesNotMatch(app, /localStorage\.(?:getItem|setItem)\(SESSION_KEY/);
  assert.doesNotMatch(html, /access_token|GUC_ERP_ACCESS_TOKEN/);
});

test("repair work type uses the new label without rewriting stored work-log values", () => {
  assert.match(app, /\["repair", "維修\/查修", "維修紀錄"\]/);
  assert.match(html, /<option value="維修紀錄">維修\/查修<\/option>/);
  assert.match(app, /function workTypeLabel/);
  assert.match(app, /workTypeLabel:workTypeLabel\(log\.work_type\)/);
});

test("equipment maintenance details omit result and per-event worker controls", () => {
  const card = functionSource("maintenanceEventCard", "maintenanceEditorFields");
  assert.doesNotMatch(card, /eventResult|data-event-worker|<legend>處理人員<\/legend>/);
  assert.match(card, /data-event-result/);
  assert.match(card, /data-worker-ids/);

  const collect = functionSource("collectMaintenanceEvents", "projectOwnerPickerField");
  assert.match(collect, /card\.dataset\.eventResult\|\|sharedDescription/);
  assert.match(collect, /if\(card\.dataset\.eventId\)/);
  assert.match(migration, /cardinality\(v_worker_ids\) = 0 then v_worker_ids := coalesce\(p_worker_user_ids/);
});
