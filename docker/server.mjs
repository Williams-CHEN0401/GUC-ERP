import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { proxySystemBackup } from '../api/system-backup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const bodyLimit = 2_000_000;

export async function createERPServer() {
  const mode = process.env.VERCEL_ENV;
  if (!['preview', 'production'].includes(mode) || process.env.GUC_LOCAL_DOCKER !== 'true') {
    throw new Error('Docker ERP requires an explicit preview or production mode and GUC_LOCAL_DOCKER=true.');
  }
  if (mode === 'production' && (process.env.GUC_LOCAL_SUPABASE !== 'true'
    || process.env.SUPABASE_FUNCTIONS_URL !== 'http://guc-supabase-functions:9000')) {
    throw new Error('Docker ERP production requires the local Docker Supabase backend.');
  }
  const nas = mode === 'production' ? (await import('../api/nas.mjs')).default : null;
  const handlers = {
    '/api/inventory': require('../api/inventory.js'),
    '/api/quotation': require('../api/quotation.js'),
    '/api/public-config': require('../api/public-config.js'),
  };
  const publicFiles = new Set((await readdir(root)).filter(name => /\.(?:js|css)$/.test(name)));
  publicFiles.add('index.html');
  const config = JSON.parse(await readFile(resolve(root, 'vercel.json'), 'utf8'));
  const headers = config.headers.find(rule => rule.source === '/(.*)').headers;

  return createServer(async (req, res) => {
    for (const header of headers) res.setHeader(header.key, header.value);
    res.setHeader('Cache-Control', 'no-store');
    res.status = code => { res.statusCode = code; return res; };
    res.send = body => { res.end(body); return res; };
    res.json = body => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); return res; };
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/healthz') return res.json({ ok: true, service: 'guc-erp', mode });
      if (pathname.startsWith('/api/system-backup')) return await proxySystemBackup(req,res);
      if (pathname === '/api/nas') {
        if (!nas) return res.status(403).json({ error: '本機 Docker 預覽不連線 NAS；附件操作使用既有預覽流程。', code: 'PREVIEW_NAS_WRITE_BLOCKED' });
        if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
        const uploadLimit = 82 * 1024 * 1024;
        if (Number(req.headers['content-length'] || 0) > uploadLimit) {
          req.resume(); return res.status(413).json({ error: 'Request body too large.' });
        }
        let size = 0; const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > uploadLimit) { req.resume(); return res.status(413).json({ error: 'Request body too large.' }); }
          chunks.push(chunk);
        }
        const requestHeaders = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (value !== undefined) requestHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const result = await nas.fetch(new Request(new URL(req.url, 'http://localhost'), {
          method: req.method, headers: requestHeaders,
          body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
        }));
        res.statusCode = result.status;
        for (const [name, value] of result.headers) res.setHeader(name, value);
        return res.end(Buffer.from(await result.arrayBuffer()));
      }
      const handler = handlers[pathname];
      if (handler) {
        if (pathname === '/api/public-config' && !['GET', 'HEAD'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
        if (req.method === 'POST') {
          if (Number(req.headers['content-length'] || 0) > bodyLimit) {
            req.resume();
            return res.status(413).json({ error: 'Request body too large.' });
          }
          let size = 0; const chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size <= bodyLimit) chunks.push(chunk);
          }
          if (size > bodyLimit) return res.status(413).json({ error: 'Request body too large.' });
          try { req.body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
          catch { return res.status(400).json({ error: 'Invalid JSON.' }); }
        }
        return await handler(req, res);
      }
      if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      const asset = relative.startsWith('assets/') && ['.png', '.svg', '.ico', '.jpg', '.webp'].includes(extname(relative));
      const path = resolve(root, relative);
      if ((!publicFiles.has(relative) && !asset) || !path.startsWith(root + sep)) return res.status(404).json({ error: 'Not found.' });
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return res.status(404).json({ error: 'Not found.' });
      res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
      res.setHeader('Content-Length', info.size);
      if (req.method === 'HEAD') return res.end();
      createReadStream(path).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof URIError) return res.status(400).json({ error: 'Invalid URL.' });
      console.error('ERP request failed:', error.name);
      return res.status(500).json({ error: 'ERP local server error.' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await createERPServer();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => console.log(`GUC ERP Docker ${process.env.VERCEL_ENV} listening on ${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
