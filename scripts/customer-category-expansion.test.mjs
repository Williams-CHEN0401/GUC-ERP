import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");
const app = readFileSync(new URL("app.js", root), "utf8");
const gateway = readFileSync(new URL("supabase/functions/inventory-gateway/index.ts", root), "utf8");
const migration = readFileSync(new URL("supabase/migrations/20260831105247_add_social_welfare_and_cleaning_customer_categories.sql", root), "utf8");

test("all customer category selectors include social welfare and cleaning team", () => {
  assert.ok((html.match(/value="social_welfare">社福機關/g) || []).length >= 3);
  assert.ok((html.match(/value="cleaning_team">清潔隊/g) || []).length >= 3);
  assert.match(app, /\["social_welfare", "社福機關"\]/);
  assert.match(app, /\["cleaning_team", "清潔隊"\]/);
});

test("category inference prioritizes exact customer-name markers", () => {
  assert.match(app, /value\.includes\("清潔隊"\).*return "cleaning_team"/);
  assert.match(app, /value\.includes\("社福"\).*return "social_welfare"/);
});

test("gateway and database accept only the four configured categories", () => {
  for (const category of ["school", "government", "social_welfare", "cleaning_team"]) {
    assert.ok(gateway.includes(`"${category}"`));
    assert.ok(migration.includes(`'${category}'`));
  }
  assert.match(migration, /revoke all on function public\.create_customer_auto_number_v2[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.create_customer_auto_number_v2[\s\S]*to service_role/);
});

test("migration classifies existing names without inventing customers", () => {
  assert.match(migration, /where name like '%社福%'[\s\S]*customer_category is distinct from 'social_welfare'/);
  assert.match(migration, /where name like '%清潔隊%'[\s\S]*customer_category is distinct from 'cleaning_team'/);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.customers/i);
  assert.doesNotMatch(migration, /select\s+public\.create_customer_auto_number_v2/i);
});
