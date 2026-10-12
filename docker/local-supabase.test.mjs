import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('Local Supabase proxies keep requests local and reject a cloud or missing target', async () => {
  for (const [file, slug] of [['inventory', 'inventory-gateway-preview-optimization'], ['quotation', 'quotation-gateway-preview']]) {
    const source = readFileSync(new URL(`../api/${file}.js`, import.meta.url), 'utf8');
    const baseEnv = { GUC_LOCAL_DOCKER: 'true', GUC_LOCAL_SUPABASE: 'true', VERCEL_ENV: 'preview' };
    const load = (env, fetch) => {
      const context = { process: { env }, module: { exports: {} }, URL, AbortController, setTimeout, clearTimeout, fetch };
      vm.runInNewContext(source, context);
      return context.module.exports;
    };
    for (const target of [undefined, 'https://bfgjdxhhnfotkjrbdckr.supabase.co/functions/v1', 'http://example.com:9000']) {
      assert.throws(() => load({ ...baseEnv, SUPABASE_FUNCTIONS_URL: target }), /Docker Edge Runtime/);
    }
    let called;
    const handler = load({ ...baseEnv, SUPABASE_FUNCTIONS_URL: 'http://guc-supabase-functions:9000' }, async (url) => {
      called = url;
      return { status: 401, text: async () => '{"error":"login required"}' };
    });
    let status;
    await handler({ method: 'GET', url: `/api/${file}?scope=session`, headers: {} }, {
      setHeader() {}, status(value) { status = value; return this; }, send() {},
    });
    assert.equal(called, `http://guc-supabase-functions:9000/${slug}?scope=session`);
    assert.equal(status, 401);
  }
});
