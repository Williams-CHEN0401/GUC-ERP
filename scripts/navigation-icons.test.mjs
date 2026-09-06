import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("ERP primary pages use the supplied local navigation images", () => {
  const pages = ["dashboard", "transactions", "repairs", "inventory", "crm", "worklogs", "materials", "backup", "settings"];
  for (const page of pages) {
    const link = html.match(new RegExp(`<a [^>]*data-page="${page}"[^>]*>(.*?)</a>`))?.[1];
    assert.ok(link, `missing ${page} link`);
    assert.ok(link.includes(`src="/assets/navigation/${page}.png"`), `wrong ${page} navigation image`);
    assert.match(link, /alt="" aria-hidden="true"/, "adjacent link label names the decorative image");
    const png = readFileSync(new URL(`../assets/navigation/${page}.png`, import.meta.url));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `invalid ${page} PNG`);
    assert.equal(png.readUInt32BE(16), 144);
    assert.equal(png.readUInt32BE(20), 144);
    assert.ok(png.length < 50000, `${page} should be optimized for the sidebar`);
  }
  assert.equal((html.match(/class="nav-icon-shell"/g) || []).length, pages.length);
  assert.match(styles, /\.nav-item\.active \.nav-icon-shell/);
  assert.match(styles, /\.nav-item:focus-visible/);
});
