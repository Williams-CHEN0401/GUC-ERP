import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function functionSource(name, nextName) {
  const start = app.indexOf(`function ${name}`);
  const end = app.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `${name} is missing`);
  assert.notEqual(end, -1, `${nextName} is missing`);
  return app.slice(start, end);
}

test("登入完成只顯示系統選擇，不預先讀取 ERP 或報價資料", () => {
  const chooser = functionSource("showSystemChooserAfterAuthentication", "hideSystemChooser");
  assert.match(chooser, /showSystemChooser\(\)/);
  assert.doesNotMatch(chooser, /loadQuotationAccess|loadScope|loadPageData|switchPage|apiRequest|fetch\(/);
  assert.match(app, /等待選擇系統/);
  assert.match(html, /選定後才會載入對應資料/);
});

test("選擇外部系統不會在背景載入 ERP Dashboard", () => {
  const choose = functionSource("chooseSystem", "logout");
  const sites = choose.slice(choose.indexOf('if(target==="sites")'), choose.indexOf('if(target==="quotations")'));
  const quotations = choose.slice(choose.indexOf('if(target==="quotations")'), choose.indexOf('if(target!=="erp")'));
  assert.match(sites, /openSiteSystem\(\)/);
  assert.doesNotMatch(sites, /switchPage|loadPageData|loadScope/);
  assert.match(quotations, /loadQuotationAccess\(\)/);
  assert.match(quotations, /openQuotationSystem\(pendingWindow\)/);
  assert.doesNotMatch(quotations, /switchPage|loadPageData|loadScope/);
});

test("只有選擇 ERP 後才載入 Dashboard scope", () => {
  const choose = functionSource("chooseSystem", "logout");
  const erp = choose.slice(choose.indexOf('if(target!=="erp")'));
  assert.match(erp, /await switchPage\("dashboard"\)/);
  assert.match(app, /async function switchPage[\s\S]*await loadPageData\(name\)/);
});
