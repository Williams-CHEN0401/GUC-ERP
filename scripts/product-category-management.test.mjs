import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const edge = readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260904090000_product_category_management.sql", import.meta.url), "utf8");

test("new-item tab exposes an admin-only product-category flow", () => {
  assert.match(html, /data-open="categoryModal">＋ 新增貨品種類/);
  assert.match(js, /data-open="categoryModal"/);
  assert.match(js, /type==="categoryModal"/);
  assert.match(js, /operation==="create_product_category"/);
  assert.match(js, /refreshItemBatchCategories\(\)/);
  assert.match(js, /\^\[A-Z\]\{1,3\}\$/);
});

test("gateway and database restrict category creation to the trusted admin path", () => {
  assert.match(edge, /operation === "create_product_category"/);
  assert.match(edge, /create_product_category[\s\S]*?requireRole\(user,\["admin"\]\)/);
  assert.match(edge, /rpc\("create_product_category_v1"/);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /set search_path = ''/i);
  assert.match(migration, /product_categories_name_ci_unique|lower\(btrim\(name\)\)/i);
  assert.match(migration, /CREATE_PRODUCT_CATEGORY/);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/i);
  assert.doesNotMatch(migration, /\bdrop\s+table\b|\btruncate\b/i);
});
