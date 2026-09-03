import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("ERP primary pages use semantic SVG navigation icons", () => {
  const pages = ["dashboard", "transactions", "repairs", "inventory", "crm", "worklogs", "materials", "backup", "settings"];
  for (const page of pages) {
    assert.match(html, new RegExp(`<symbol id="icon-${page}"`), `missing ${page} symbol`);
    assert.match(html, new RegExp(`data-page="${page}"[\\s\\S]*?<use href="#icon-${page}"`), `missing ${page} navigation icon`);
  }
  assert.equal((html.match(/class="nav-icon-shell"/g) || []).length, pages.length);
  assert.match(styles, /\.nav-item\.active \.nav-icon-shell/);
  assert.match(styles, /\.nav-item:focus-visible/);
});
