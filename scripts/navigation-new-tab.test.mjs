import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("sidebar pages are real allowlisted links that can use the native new-tab menu", () => {
  const pages = ["dashboard", "transactions", "repairs", "inventory", "crm", "worklogs", "materials", "backup", "settings"];
  for (const page of pages) {
    assert.match(html, new RegExp(`<a class="nav-item(?: active)?" data-page="${page}" href="/\\?page=${page}"`));
  }
  assert.doesNotMatch(html, /<button class="nav-item/);
  assert.match(css, /\.nav-item\{[^}]*text-decoration:none/);
  assert.match(js, /requestedPageFromUrl\(\).*PAGE_SCOPES/);
  assert.match(js, /event\.preventDefault\(\);await switchPage\(nav\.dataset\.page\)/);
  assert.match(js, /!event\.metaKey&&!event\.ctrlKey&&!event\.shiftKey&&!event\.altKey/);
});

test("deep-linked pages keep tokens out of the URL and lazy-load only their page scope", () => {
  assert.match(js, /function pageUrl\(name\).*searchParams\.set\("page",name\)/);
  assert.doesNotMatch(js, /searchParams\.set\([^\n]*(?:accessToken|SESSION_KEY)/);
  assert.match(js, /sessionStorage\.setItem\(SESSION_KEY,accessToken\)/);
  assert.match(js, /continueAfterAuthentication\(\).*switchPage\(requestedPage\)/);
  assert.match(js, /switchPage\(name\).*loadPageData\(name\)/);
  assert.match(js, /function logout\(options=\{\}\).*clearPageUrl\(\)/);
  assert.match(js, /logout\(\{preservePage:true\}\)/);
});
