const SUPABASE_BASE = "https://bfgjdxhhnfotkjrbdckr.supabase.co/functions/v1";
const UPSTREAM = process.env.VERCEL_ENV === 'production' ? `${SUPABASE_BASE}/inventory-gateway` : `${SUPABASE_BASE}/inventory-gateway-preview`;
const UPSTREAM_TIMEOUT_MS = 30_000;

module.exports = async function handler(request, response) {
  if (!['GET', 'POST'].includes(request.method)) {
    return response.status(405).json({ error: '僅支援 GET 與 POST。' });
  }

  const contentLength = Number(request.headers['content-length'] || 0);
  if (contentLength > 2_000_000) {
    return response.status(413).json({ error: '請求內容超過允許大小。' });
  }

  if (process.env.VERCEL_ENV !== 'production' && request.method === 'POST') {
    const operation = request.body && typeof request.body === 'object' ? request.body.operation : '';
    if (operation !== 'login') {
      return response.status(403).json({ error: '安全預覽模式禁止寫入正式資料庫。' });
    }
  }

  const incomingUrl = new URL(request.url, 'https://local.invalid');
  const target = `${UPSTREAM}${incomingUrl.search}`;
  const headers = { 'Content-Type': 'application/json' };
  if (request.headers.authorization) headers.Authorization = request.headers.authorization;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? JSON.stringify(request.body || {}) : undefined,
      redirect: 'error',
      signal: controller.signal
    });
    const body = await upstream.text();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    return response.status(upstream.status).send(body);
  } catch (error) {
    if (error && error.name === 'AbortError') return response.status(504).json({ error: 'ERP 資料服務回應逾時，請稍後重試。' });
    return response.status(502).json({ error: '目前無法連接 ERP 資料服務。' });
  } finally { clearTimeout(timer); }
};
