import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const app = read("app.js");
const html = read("index.html");
const bffSource = read("api/quotation.js");
const configSource = read("api/public-config.js");
const gateway = read("supabase/functions/quotation-gateway/index.ts");
const previewGateway = read("supabase/functions/quotation-gateway-preview/index.ts");
const migration = read("supabase/migrations/20260902180000_quotation_management_system.sql");

function responseHarness() {
  return {
    code: 200,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return body; },
    send(body) { this.body = body; return body; },
    setHeader() {},
  };
}

test("ERP 只為白名單使用者顯示報價入口並以 nonce SSO 交接", () => {
  assert.match(html, /data-system-choice="quotations"/);
  assert.match(app, /canAccessQuotations\(\)/);
  assert.match(app, /state\.quotationAccess===true/);
  assert.match(app, /event\.origin!==origin\|\|event\.source!==externalWindow/);
  assert.match(app, /message\.nonce!==nonce/);
  assert.doesNotMatch(app, /searchParams\.set\([^,]+,accessToken\)/);
});

test("報價公開設定採精確 host 白名單且沒有硬編碼正式 fallback", () => {
  assert.match(configSource, /ALLOWED_QUOTATION_HOSTS = new Set/);
  assert.match(configSource, /url\.pathname !== "\/" \|\| url\.search \|\| url\.hash/);
  assert.doesNotMatch(configSource, /DEFAULT_QUOTATION_URL/);
  const handler = require("../api/public-config.js");
  const previous = process.env.NEXT_PUBLIC_QUOTATION_URL;
  const previousEnvironment = process.env.VERCEL_ENV;
  try {
    delete process.env.VERCEL_ENV;
    for (const unsafe of [
      "https://guc-quotation-system-evil.vercel.app/",
      "https://user:pass@guc-quotation-system.vercel.app/",
      "https://guc-quotation-system.vercel.app/path",
      "https://guc-quotation-system.vercel.app/?token=x",
    ]) {
      process.env.NEXT_PUBLIC_QUOTATION_URL = unsafe;
      const response = responseHarness();
      handler({}, response);
      assert.match(String(response.body), /"quotationUrl":""/);
    }
    delete process.env.NEXT_PUBLIC_QUOTATION_URL;
    const response = responseHarness();
    handler({}, response);
    assert.match(String(response.body), /"quotationUrl":""/);
    process.env.VERCEL_ENV = "preview";
    const previewResponse = responseHarness();
    handler({}, previewResponse);
    assert.match(String(previewResponse.body), /guc-quotation-system-eqeua6i0g-sam5321051-5955s-projects\.vercel\.app/);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_QUOTATION_URL;
    else process.env.NEXT_PUBLIC_QUOTATION_URL = previous;
    if (previousEnvironment === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousEnvironment;
  }
});

test("Preview BFF 在 Edge 前阻擋所有 login 以外的 POST", async () => {
  assert.match(bffSource, /TextEncoder/);
  const previous = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "preview";
  try {
    delete require.cache[require.resolve("../api/quotation.js")];
    const handler = require("../api/quotation.js");
    const response = responseHarness();
    await handler({ method: "POST", headers: {}, body: { operation: "create_quotation" }, url: "/api/quotation" }, response);
    assert.equal(response.code, 403);
    assert.match(response.body.error, /禁止寫入/);
  } finally {
    if (previous === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous;
  }
});

test("Gateway 僅接受精確函式路徑並核對 Auth UUID 與 app_users", () => {
  assert.match(gateway, /quotation-gateway\|quotation-gateway-preview/);
  assert.match(gateway, /app_users\?auth_user_id=eq\.\$\{encodeURIComponent\(authUser\.id\)\}/);
  assert.match(gateway, /session\.user\.id !== profiles\[0\]\.auth_user_id/);
  assert.match(gateway, /normalizedPath\.match\(\/\^\\\/\(\?:functions/);
  for (const stableId of [
    "bb880df3-a731-4735-8e1a-c95575aec875",
    "79ce8566-898e-4dd3-a67b-d4eba7c088f5",
    "5926554a-b8cc-4756-8d66-0a9a0877f94e",
  ]) assert.ok(gateway.includes(stableId), `missing preview access id: ${stableId}`);
  assert.match(gateway, /PREVIEW_READ_ONLY/);
  assert.match(previewGateway, /\.\.\/quotation-gateway\/index\.ts/);
});

test("Migration 有狀態機、金額、版本、稽核、RLS 與最小權限防線", () => {
  for (const marker of [
    "quotations_billing_requires_won_check",
    "請款狀態倒退時必須填寫更正原因",
    "quotation_audit_log",
    "quotation_version_detail_v1",
    "quotation_project_tracking_v1",
    "force row level security",
    "quotation_insert_items_v1",
    "報價總額超過允許範圍",
    "from public, anon, authenticated, service_role",
  ]) assert.ok(migration.includes(marker), `missing SQL guard: ${marker}`);
  assert.doesNotMatch(migration, /\bdrop\s+table\b|\btruncate\b/i);
});
