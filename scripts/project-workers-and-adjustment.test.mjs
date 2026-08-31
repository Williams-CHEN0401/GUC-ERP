import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const js = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const edge = readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260831000100_project_workers_and_work_log_defaults.sql", import.meta.url), "utf8");

test("庫存校正保留表單引用，不在 await 後讀取失效的 currentTarget", () => {
  const start = js.indexOf('document.querySelector("#adjustForm")');
  const handler = js.slice(start, js.indexOf("initEnvironment()", start));
  assert.match(handler, /const form=event\.currentTarget/);
  assert.match(handler, /form\.reset\(\)/);
  assert.doesNotMatch(handler, /await mutate[\s\S]*event\.currentTarget/);
});

test("專案負責人使用與施工人員相同的系統使用者複選器", () => {
  assert.match(js, /projectOwnerPickerField/);
  assert.match(js, /name:"projectWorkerIds"/);
  assert.match(js, /getAll\("projectWorkerIds"\)/);
  const start = js.indexOf('if(type==="projectModal")');
  const projectModal = js.slice(start, js.indexOf('if(type==="supplierModal")', start));
  assert.ok(start >= 0);
  assert.doesNotMatch(projectModal, /inputField\("owner"/);
});

test("Preview 庫存校正同步更新瀏覽器暫存數量", () => {
  assert.match(js, /if\(operation==="create_stock_adjustment"\)/);
  assert.match(js, /item\.quantity=after/);
  assert.match(js, /difference_quantity:after-before/);
});

test("新增工作日誌選擇既有專案時帶入專案負責人", () => {
  assert.match(js, /function syncWorkLogWorkersFromProject/);
  assert.match(js, /ownerIds=new Set\(project\?\.ownerIds\|\|\[\]\)/);
  assert.match(js, /checkbox\.checked=ownerIds\.has\(checkbox\.value\)/);
  assert.match(js, /event\.target\.name==="projectName"/);
});

test("project_workers 關聯具備外鍵、RLS、service role 限制與原子 RPC", () => {
  for (const marker of [
    "create table if not exists public.project_workers",
    "references public.projects(id) on delete cascade",
    "references public.app_users(id) on delete restrict",
    "enable row level security",
    "revoke all on table public.project_workers from public, anon, authenticated",
    "upsert_erp_project_with_workers_v1",
    "for update",
    "專案資料已被其他使用者更新",
  ]) assert.ok(migration.includes(marker), marker);
});

test("Gateway 只接受 UUID 負責人並在 CRM 與工作日誌範圍回傳關聯", () => {
  assert.match(edge, /project_workers\?select=project_id,user_id,created_at/);
  assert.match(edge, /crm: \[[^\]]*"project_workers"[^\]]*"site_workers"/);
  assert.match(edge, /sites: \[[^\]]*"project_workers"/);
  assert.match(edge, /worker_user_ids\.some\(workerId=>!workerId\)/);
  assert.match(edge, /rpc\("upsert_erp_project_with_workers_v1"/);
});
