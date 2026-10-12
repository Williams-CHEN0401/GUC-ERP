import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createERPServer } from './server.mjs';

test('Production adapter refuses a cloud backend, forwards authenticated writes locally, and retains NAS authentication', async () => {
  process.env.VERCEL_ENV = 'production';
  process.env.GUC_LOCAL_DOCKER = 'true';
  delete process.env.GUC_LOCAL_SUPABASE;
  await assert.rejects(createERPServer(), /local Docker Supabase/);
  process.env.GUC_LOCAL_SUPABASE = 'true';
  process.env.SUPABASE_FUNCTIONS_URL = 'https://example.com';
  await assert.rejects(createERPServer(), /local Docker Supabase/);
  process.env.SUPABASE_FUNCTIONS_URL = 'http://guc-supabase-functions:9000';
  const nativeFetch = globalThis.fetch;
  const upstreamCalls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://guc-supabase-functions:9000/')) {
      upstreamCalls.push({ url: String(url), options });
      return Response.json({ accepted: true }, { status: 200 });
    }
    throw new Error('Unexpected backend request');
  };
  const server = await createERPServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await (await nativeFetch(`${base}/healthz`)).json()).mode, 'production');
    assert.match(await (await nativeFetch(`${base}/api/public-config`)).text(), /"localProduction":true/);
    for (const [path, gateway] of [['inventory', 'inventory-gateway'], ['quotation', 'quotation-gateway']]) {
      const result = await nativeFetch(`${base}/api/${path}`, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'test-write', payload: { note: 'test' } }) });
      assert.equal(result.status, 200);
      const call = upstreamCalls.at(-1);
      assert.equal(call.url, `http://guc-supabase-functions:9000/${gateway}`);
      assert.equal(call.options.headers.Authorization, 'Bearer test-token');
      assert.equal(JSON.parse(call.options.body).operation, 'test-write');
    }
    const beforeNas = upstreamCalls.length;
    assert.equal((await nativeFetch(`${base}/api/nas`)).status, 401);
    const form = new FormData(); form.set('file', new Blob(['test']), 'test.pdf');
    assert.equal((await nativeFetch(`${base}/api/nas`, { method: 'POST', body: form })).status, 401);
    assert.equal(upstreamCalls.length, beforeNas, 'Unauthenticated NAS requests must not contact any backend');
    assert.equal((await nativeFetch(`${base}/.env.production`)).status, 404);
    assert.equal((await nativeFetch(`${base}/api/nas.mjs`)).status, 404);
  } finally {
    globalThis.fetch = nativeFetch;
    await new Promise(resolve => server.close(resolve));
  }
});
