import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const gateway = readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260904232000_verified_stock_adjustment.sql", import.meta.url), "utf8");

test("商品與庫存可由管理員新增貨品種類", () => {
  assert.match(html, /data-open="categoryModal"/);
  assert.match(app, /type==="categoryModal"/);
  assert.match(app, /mutate\("create_product_category"/);
  assert.match(app, /data-open="categoryModal"[\s\S]*role!=="admin"/);
  assert.match(gateway, /operation === "create_product_category"[\s\S]*requireRole\(user,\["admin"\]\)/);
  assert.equal([...gateway.matchAll(/operation === "create_product_category"/g)].length, 1);
  assert.match(gateway, /rpc\("create_product_category_v1",\{p_name:name,p_code_prefix:code_prefix,p_actor:actor\}\)/);
  assert.equal([...app.matchAll(/type==="categoryModal"/g)].length, 2);
});

test("盤點校正必須先選貨品種類再選品項", () => {
  assert.match(html, /id="adjustCategory"[\s\S]*id="adjustItem"/);
  assert.match(app, /function syncAdjustmentItems/);
  assert.match(app, /row\.categoryId===category\.value/);
  assert.match(app, /selectedItem\.categoryId!==d\.category/);
});

test("盤點校正在資料庫交易內鎖定、執行並驗證即時庫存", () => {
  assert.match(gateway, /rpc\("apply_stock_adjustment_verified_v1"/);
  for (const marker of [
    "security invoker",
    "set search_path = ''",
    "for update",
    "perform public.apply_stock_adjustment",
    "sum(receipt.quantity)",
    "sum(pickup.quantity)",
    "sum(adjustment.difference_quantity)",
    "is distinct from p_after_quantity",
    "revoke all",
    "grant execute",
  ]) assert.ok(migration.includes(marker), marker);
  assert.match(app, /verified_quantity/);
  assert.match(app, /actualQuantity!==afterQuantity/);
});
