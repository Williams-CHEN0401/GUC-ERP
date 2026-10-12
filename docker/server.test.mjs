import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createERPServer } from './server.mjs';

test('Docker HTTP adapter serves the application and preserves API boundaries', async () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.GUC_LOCAL_DOCKER = 'true';
  process.env.NEXT_PUBLIC_SITE_DATA_URL = 'http://localhost:8081/';
  process.env.NEXT_PUBLIC_QUOTATION_URL = 'http://localhost:8082/';
  const server = await createERPServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="loginForm"/);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal((await fetch(base + '/app.js')).status, 200);
    assert.equal((await fetch(base + '/healthz')).status, 200);
    const config = await (await fetch(base + '/api/public-config')).text();
    assert.match(config, /http:\/\/localhost:8081\//);
    assert.match(config, /http:\/\/localhost:8082\//);
    assert.match(config, /"localProduction":false/);
    for (const path of ['/.env', '/package.json', '/vercel.json', '/docker/server.mjs', '/api/inventory.js', '/assets/../package.json']) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
    for (const path of ['/api/inventory', '/api/quotation']) {
      const blocked = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'create_customer', payload: {} }) });
      assert.equal(blocked.status, 403, path);
    }
    assert.equal((await fetch(base + '/api/nas')).status, 403);
    assert.equal((await fetch(base + '/api/inventory', { method: 'POST', body: '{invalid' })).status, 400);
    assert.equal((await fetch(base + '/api/inventory', { method: 'POST', body: 'x'.repeat(2_000_001) })).status, 413);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Docker navigation permits configured HTTPS or localhost roots and leaves cloud defaults unchanged', () => {
  const handler = createRequire(import.meta.url)('../api/public-config.js');
  const render = () => { let result; handler({}, { setHeader() {}, status() { return this; }, send(v) { result = v; } }); return result; };
  process.env.GUC_LOCAL_DOCKER = 'true';
  process.env.NEXT_PUBLIC_QUOTATION_URL = 'https://quote.example.com/';
  assert.match(render(), /"quotationUrl":"https:\/\/quote.example.com\/"/);
  for (const value of ['http://192.168.17.213:8082/', 'http://10.0.0.2:8082/', 'http://172.16.0.2:8082/']) {
    process.env.NEXT_PUBLIC_QUOTATION_URL = value;
    assert.ok(render().includes(`"quotationUrl":"${value}"`));
  }
  for (const value of ['http://192.168.17.213.evil.test:8082/', 'http://192.169.1.2:8082/', 'http://172.32.1.2:8082/', 'http://user@192.168.17.213:8082/']) {
    process.env.NEXT_PUBLIC_QUOTATION_URL = value;
    assert.match(render(), /"quotationUrl":""/);
  }
  for (const value of ['http://example.com/', 'http://localhost.evil.test/', 'http://user:pass@localhost:8082/', 'http://localhost:8082/?token=abc', 'https://quote.example.com/path', 'https://user:pass@quote.example.com/', 'https://quote.example.com/#token']) {
    process.env.NEXT_PUBLIC_QUOTATION_URL = value;
    assert.match(render(), /"quotationUrl":""/);
  }
  delete process.env.GUC_LOCAL_DOCKER;
  delete process.env.NEXT_PUBLIC_SITE_DATA_URL;
  delete process.env.NEXT_PUBLIC_QUOTATION_URL;
  process.env.VERCEL_ENV = 'production';
  assert.match(render(), /https:\/\/guc-quotation-system.vercel.app\//);
});
