export function createNasMemoryFixture() {
  const files = new Map(), folders = new Set(['/GUC-ERP']), calls = [], gatewayCalls = [];
  let role = 'admin', permissions, projectScoped = false;
  const context = { customer_id: 'customer-1', contract_service_type_id: 'service-1', project_id: 'project-1' };
  const fetch = async (url, init = {}) => {
    const value = String(url), method = init.method || 'GET';
    if (value.includes('scope=session')) { gatewayCalls.push('session');return Response.json({ current_user: { username: 'fixture', role, permissions, project_scoped: projectScoped } }); }
    if (value.includes('scope=sites') || value.includes('scope=nas_upload_context')) { gatewayCalls.push(value.includes('scope=sites')?'sites':'nas_upload_context');return Response.json({ customers: [{ id: context.customer_id, name: '測試客戶' }], contract_service_types: [{ id: context.contract_service_type_id, name: '維護保養', is_active: true }], customer_contract_services: [{ customer_id: context.customer_id, service_type_id: context.contract_service_type_id, is_active:true }], projects: [{ id: context.project_id, customer_id: context.customer_id, name: '測試專案' }] }); }
    const path = decodeURIComponent(new URL(value).pathname);
    calls.push({ method, path, bytes: method==='PUT'?Buffer.byteLength(init.body):method==='GET'?(files.get(path)?.length||0):0 });
    if (method === 'PROPFIND') return new Response('', { status: files.has(path) || folders.has(path) ? 207 : 404 });
    if (method === 'MKCOL') { folders.add(path); return new Response(null, { status: 201 }); }
    if (method === 'PUT') {
      if (init.headers?.['If-None-Match'] === '*' && files.has(path)) return new Response(null, { status: 412 });
      if (init.headers?.['If-Match'] === '*' && !files.has(path)) return new Response(null, { status: 412 });
      files.set(path, Buffer.from(init.body));return new Response(null, { status: 201 });
    }
    if (method === 'HEAD') return new Response(null, { status: files.has(path) ? 200 : 404, headers: files.has(path) ? { 'content-length': String(files.get(path).length) } : {} });
    if (method === 'GET') return new Response(files.get(path) || null, { status: files.has(path) ? 200 : 404 });
    if (method === 'DELETE') { for (const key of [...files.keys()]) if (key === path || key.startsWith(path + '/')) files.delete(key); folders.delete(path); return new Response(null, { status: 204 }); }
    throw new Error('Unexpected NAS fixture request ' + method);
  };
  return { files, folders, calls, gatewayCalls, context, fetch, setRole(value, grants, scoped = false) { role = value; permissions = grants; projectScoped = scoped; } };
}
