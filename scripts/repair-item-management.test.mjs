import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html=readFileSync(new URL("../index.html",import.meta.url),"utf8");
const app=readFileSync(new URL("../app.js",import.meta.url),"utf8");
const gateway=readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts",import.meta.url),"utf8");
const migration=readFileSync(new URL("../supabase/migrations/20260903090000_repair_item_management.sql",import.meta.url),"utf8");

test("ERP navigation exposes repair management and renames transaction management",()=>{
  assert.match(html,/data-page="repairs"/);
  assert.match(html,/<span>維修品管理<\/span>/);
  assert.match(html,/<span>進出貨管理<\/span>/);
  assert.doesNotMatch(html,/<span>交易管理<\/span>/);
  assert.match(app,/transactions: \["進出貨管理"/);
});

test("repair UI links customer and product categories to canonical records",()=>{
  for(const marker of ["repairStatusFilter","repairTable","repairModal","customerCategoryOptions(category)","repairInventoryFields(r.itemId)","syncRepairItemOptions","upsert_repair_item","delete_repair_item"])assert.ok(app.includes(marker)||html.includes(marker),`missing ${marker}`);
  for(const marker of ["送修客戶","商品種類","送修供應商","供應商返件日期","返還客戶日期"])assert.ok(app.includes(marker)||html.includes(marker),`missing ${marker}`);
});

test("gateway loads and validates the repair workflow with least-privilege roles",()=>{
  for(const marker of ['repair_items: { path: "repair_items?select=','repairs: ["repair_items", "customers", "items", "suppliers", "categories"]','operation === "upsert_repair_item"','operation === "delete_repair_item"','rpc("upsert_repair_item_v1"','rpc("delete_repair_item_v1"'])assert.ok(gateway.includes(marker),`missing ${marker}`);
  assert.match(gateway,/operation === "upsert_repair_item"[\s\S]*?requireRole\(user,\["admin","operator"\]\)/);
  assert.match(gateway,/operation === "delete_repair_item"[\s\S]*?requireRole\(user,\["admin"\]\)/);
  assert.match(gateway,/維修流程日期順序不正確/);
});

test("repair migration keeps master data canonical, versioned, audited and private",()=>{
  const table=migration.slice(migration.indexOf("create table if not exists public.repair_items"),migration.indexOf("create index if not exists repair_items_customer_received_idx"));
  for(const marker of ["customer_id uuid not null references public.customers","inventory_item_id uuid not null references public.inventory_items","supplier_id uuid references public.suppliers","row_version integer not null default 1","repair_items_date_order_check"])assert.ok(table.includes(marker),`missing ${marker}`);
  assert.doesNotMatch(table,/customer_name|customer_category|item_name|item_category|supplier_name/);
  for(const marker of ["enable row level security","force row level security","revoke all on public.repair_items","grant select on public.repair_items to service_role","upsert_repair_item_v1","delete_repair_item_v1","CREATE_REPAIR_ITEM","UPDATE_REPAIR_ITEM","DELETE_REPAIR_ITEM"])assert.ok(migration.includes(marker),`missing ${marker}`);
  assert.doesNotMatch(migration,/grant (insert|update|delete) on public\.repair_items/i);
});
