import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const pickerSource = readFileSync(new URL("../receipt-customers.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const gatewaySource = readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts", import.meta.url), "utf8");

function pickerContext(document) {
  const state = {
    customers: [
      { id: "customer-school", code: "C001", category: "school", name: "測試學校" },
      { id: "customer-government", code: "C002", category: "government", name: "測試機關" },
    ],
  };
  const context = {
    document,
    state,
    CUSTOMER_CATEGORIES: [["school", "學校機關"], ["government", "政府機關"]],
    esc: (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]),
    byId: (rows, id) => rows.find((row) => row.id === id),
  };
  vm.runInNewContext(pickerSource, context);
  return context;
}

test("訂貨客戶選擇器沿用既有客戶 UUID 與分類", () => {
  const document = { addEventListener() {} };
  const context = pickerContext(document);
  const html = context.receiptCustomerPicker(["customer-school"]);
  assert.match(html, /option value="school" selected/);
  assert.match(html, /name="receiptCustomerId" value="customer-school" checked/);
  assert.match(html, /<span>C001｜測試學校<\/span>/);
  assert.match(html, /data-category="government"/);
});

test("分類與搜尋會顯示可選客戶，沒有結果時提供明確提示", () => {
  const category = { value: "school" };
  const search = { value: "" };
  const empty = { hidden: true, textContent: "" };
  const count = { textContent: "" };
  const names = { textContent: "" };
  const rows = [
    { hidden: true, dataset: { category: "school", search: "c001 測試學校" } },
    { hidden: true, dataset: { category: "government", search: "c002 測試機關" } },
  ];
  const selectedInputs = [{ value: "customer-school" }];
  const form = {
    querySelector(selector) {
      return new Map([
        ["#receiptCustomerCategory", category], ["#receiptCustomerSearch", search],
        ["#receiptCustomerEmpty", empty], ["#receiptCustomerCount", count],
        ["#receiptCustomerSelected", names],
      ]).get(selector) ?? null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-receipt-customer]") return rows;
      if (selector === "input[name=receiptCustomerId]:checked") return selectedInputs;
      return [];
    },
  };
  const document = { addEventListener() {}, querySelector: (selector) => selector === "#modalForm" ? form : null };
  const context = pickerContext(document);

  context.refreshReceiptCustomerPicker();
  assert.equal(rows[0].hidden, false);
  assert.equal(rows[1].hidden, true);
  assert.equal(empty.hidden, true);
  assert.equal(count.textContent, "已選 1 位");
  assert.equal(names.textContent, "測試學校");

  search.value = "不存在";
  context.refreshReceiptCustomerPicker();
  assert.equal(rows[0].hidden, true);
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, "沒有符合搜尋條件的客戶。");
});

test("開啟進貨表單會先確認交易資料並初始化客戶清單", () => {
  assert.match(appSource, /async function openReceiptModal\(id=""\).*loadScope\("transactions",\{silent:true\}\)/s);
  assert.match(appSource, /if\(type==="receiptModal"\)refreshReceiptCustomerPicker\(\)/);
  assert.match(appSource, /open\.dataset\.open==="receiptModal"\)await openReceiptModal\(\)/);
  assert.match(appSource, /customer_ids=\[\.\.\.new FormData\(form\)\.getAll\("receiptCustomerId"\)\]/);
  assert.match(gatewaySource, /transactions: \["customers", "projects", "items", "pickups", "receipts", "suppliers", "categories"\]/);
});

test("勾選框維持固定尺寸且與客戶名稱同列", () => {
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.modal-card \.form-grid \.receipt-customer-list input\[type=checkbox\]\{[^}]*flex:0 0 20px;[^}]*width:20px;/);
  assert.match(styles, /\.receipt-customer-list label span\{[^}]*overflow-wrap:anywhere/);
});
