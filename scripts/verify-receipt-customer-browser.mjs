// Browser-only fixture verification; no production API or credentials are used.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright";
const loadedPlaywright = await import(playwrightModule);
const { chromium } = loadedPlaywright.default || loadedPlaywright;
const files = new Map([
  ["/", "index.html"], ["/styles.css", "styles.css"], ["/interface-theme.css", "interface-theme.css"],
  ["/project-report.js", "project-report.js"], ["/audit-ui.js", "audit-ui.js"],
  ["/permissions-ui.js", "permissions-ui.js"], ["/receipt-customers.js", "receipt-customers.js"],
  ["/attachment-upload.js", "attachment-upload.js"], ["/app.js", "app.js"],
  ["/customer-services.js", "customer-services.js"],
]);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (pathname === "/api/public-config") {
    response.setHeader("Content-Type", "application/javascript");
    response.end("globalThis.GUC_PUBLIC_CONFIG={};");
    return;
  }
  const file = files.get(pathname);
  if (!file) {
    response.statusCode = pathname === "/favicon.ico" ? 204 : 404;
    response.end();
    return;
  }
  response.setHeader("Content-Type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
  response.end(await readFile(new URL(`../${file}`, import.meta.url)));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const address = server.address();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

try {
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle" });
  await page.evaluate((snapshot) => {
    hydrateSnapshot(snapshot);
    storeAccessToken("isolated-receipt-test-token");
    loadedScopes.add("transactions");
    hideLogin();
    document.querySelector("#systemChooser").classList.remove("open");
  }, {
    current_user: { id: "admin-1", username: "admin", display_name: "測試管理員", role: "admin" },
    customers: [
      { id: "customer-school", customer_code: "C001", customer_category: "school", name: "測試學校" },
      { id: "customer-government", customer_code: "C002", customer_category: "government", name: "測試機關" },
    ],
    suppliers: [{ id: "supplier-1", name: "測試供應商" }],
    categories: [{ id: "category-1", name: "測試設備", code_prefix: "T", is_active: true }],
    items: [{ id: "item-1", inventory_code: "T001", category_id: "category-1", item_name: "測試品項", brand: "測試品牌", model: "M1", unit: "台" }],
    projects: [], pickups: [], receipts: [], adjustments: [], errors: [], scope: "transactions",
  });

  await page.locator('a[data-page="transactions"]').click();
  await page.locator('[data-tabs="transaction"] [data-tab="receipts"]').click();
  await page.locator('[data-open="receiptModal"]').click();
  const form = page.locator("#modalForm");
  assert.equal(await form.locator("#receiptCustomerEmpty").textContent(), "請先選擇客戶分類。");

  await form.locator("#receiptCustomerCategory").selectOption("school");
  const school = form.locator('[data-receipt-customer][data-category="school"]');
  assert.equal(await school.isVisible(), true);
  assert.equal(await form.locator('[data-receipt-customer][data-category="government"]').isHidden(), true);
  const labelBox = await school.boundingBox();
  const checkboxBox = await school.locator("input").boundingBox();
  const nameBox = await school.locator("span").boundingBox();
  assert.ok(labelBox && checkboxBox && nameBox);
  assert.ok(checkboxBox.width <= 24, `checkbox width is ${checkboxBox.width}`);
  assert.ok(nameBox.x - checkboxBox.x < 40, "customer name stays beside its checkbox");
  assert.ok(nameBox.x + nameBox.width <= labelBox.x + labelBox.width + 1, "customer name stays inside the list row");
  await school.locator("input").check();
  assert.equal(await form.locator("#receiptCustomerCount").textContent(), "已選 1 位");
  assert.equal(await form.locator("#receiptCustomerSelected").textContent(), "測試學校");

  await form.locator("#receiptCustomerSearch").fill("不存在");
  assert.equal(await school.isHidden(), true);
  assert.equal(await form.locator("#receiptCustomerEmpty").textContent(), "沒有符合搜尋條件的客戶。");
  await form.locator("#receiptCustomerSearch").fill("測試學校");
  assert.equal(await school.isVisible(), true);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileOverflow = await form.locator(".receipt-customers").evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  assert.equal(mobileOverflow, false, "customer picker stays inside an iPhone-sized viewport");
  assert.ok((await school.locator("input").boundingBox()).width <= 24);
  await page.setViewportSize({ width: 1440, height: 1000 });

  assert.equal(await page.title(), "GUC ERP｜進出貨管理");
  await page.locator('.modal-head button[data-close]').click();
  await page.locator('a[data-page="repairs"]').click();
  assert.equal(await page.title(), "GUC ERP｜維修品管理");
  assert.deepEqual(errors, []);
  console.log("Receipt customer picker and per-page browser titles verified.");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
