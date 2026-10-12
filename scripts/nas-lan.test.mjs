import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import nasApi from '../api/nas.mjs';
import { createNasMemoryFixture } from './nas-memory-fixture.mjs';

test('HTTP LAN browser uploads files over 4 MiB through authenticated Docker direct upload', async () => {
  const names = ['VERCEL_ENV', 'NAS_WEBDAV_URL', 'NAS_WEBDAV_USERNAME', 'NAS_WEBDAV_PASSWORD', 'NAS_WEBDAV_ROOT'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const savedFetch = globalThis.fetch;
  Object.assign(process.env, { VERCEL_ENV: 'production', NAS_WEBDAV_URL: 'https://nas.fixture.test', NAS_WEBDAV_USERNAME: 'fixture', NAS_WEBDAV_PASSWORD: 'fixture-only', NAS_WEBDAV_ROOT: '/GUC-ERP' });
  const context = vm.createContext({ FormData, File, Blob, Uint8Array, crypto: {}, GUC_PUBLIC_CONFIG: { localProduction: true } });
  vm.runInContext(readFileSync(new URL('../attachment-upload.js', import.meta.url), 'utf8'), context);
  const fixture = createNasMemoryFixture();
  globalThis.fetch = fixture.fetch;
  const modes = [], registered = [];
  try {
    const file = new File([Buffer.alloc(6 * 1024 * 1024, 57)], 'lan-photo.jpg');
    const result = await context.transferNasFiles({ files: [file], context: fixture.context, progress() {}, conflictChoice: () => 'rename', register: async rows => registered.push(...rows), request: async body => {
      modes.push(body.get('mode'));
      const response = await nasApi.fetch(new Request('http://192.168.17.213:8080/api/nas', { method: 'POST', headers: { Authorization: 'Bearer test' }, body }));
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      return data;
    } });
    assert.equal(result.failed.length, 0);
    assert.equal(result.uploaded.length, 1);
    assert.equal(registered.length, 1);
    assert.ok(modes.includes('upload') && !modes.includes('begin_file'));
    assert.deepEqual(fixture.files.get(result.uploaded[0].nas_path), Buffer.from(await file.arrayBuffer()));
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
});
