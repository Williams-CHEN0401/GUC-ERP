import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import nasApi, { validateFileNames, validateUploadFiles, validateDrawingBytes, createPreflightTicket, verifyPreflightTicket, formatTaipeiDate } from '../api/nas.mjs';
import { createNasMemoryFixture } from './nas-memory-fixture.mjs';

const planId = '11111111-1111-4111-8111-111111111111', otherPlanId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333', customerId = '44444444-4444-4444-8444-444444444444';
const serviceId = '55555555-5555-4555-8555-555555555555';
const context = { customer_id: customerId, project_id: projectId, construction_plan_id: planId, contract_service_type_id: serviceId };
const pdf = Buffer.from('%PDF-1.4\nfixture drawing original bytes\n%%EOF');
const config = { root: '/施工規劃圖', password: 'isolated-test-password' };
const folderParts = (selectedPlan = planId) => ['測試客戶','測試承攬','測試工程',formatTaipeiDate(),selectedPlan];

function form(mode, fields = {}, files = [], scope = context) {
  const body = new FormData();
  for (const [key, value] of Object.entries({ ...scope, mode, ...fields })) body.set(key, String(value));
  for (const file of files) body.append('files', file);
  return body;
}

async function fixture(run) {
  const previousFetch = globalThis.fetch, savedEnv = { ...process.env };
  Object.assign(process.env, { VERCEL_ENV: 'production', NAS_WEBDAV_URL: 'https://nas.invalid', NAS_WEBDAV_USERNAME: 'fixture', NAS_WEBDAV_PASSWORD: config.password, NAS_WEBDAV_ROOT: '/GUC-ERP' });
  const nas = createNasMemoryFixture(), state = { allowUpload: true, allowRead: true, protectedPaths: [], asset: null, contextCalls: 0 };
  nas.folders.add(config.root);
  nas.setRole('operator', [{ module: 'projects', can_view: true, can_update: true }], true);
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url)), scope = parsed.searchParams.get('scope');
    if (scope === 'nas_upload_context') {
      state.contextCalls++;
      if (!state.allowUpload) return Response.json({ error: '無權管理此施工規劃' }, { status: 403 });
      const requestedPlan = parsed.searchParams.get('construction_plan_id');
      if (![planId, otherPlanId].includes(requestedPlan) || parsed.searchParams.get('project_id') !== projectId || parsed.searchParams.get('customer_id') !== customerId || parsed.searchParams.get('contract_service_type_id') !== serviceId) return Response.json({ error: '錯誤關聯' }, { status: 403 });
      return Response.json({ construction_plan_id: requestedPlan, can_upload: true, protected_paths: state.protectedPaths, customers: [{ id: customerId, name:'測試客戶' }], projects: [{ id: projectId, customer_id: customerId, name:'測試工程' }], contract_service_types:[{id:serviceId,name:'測試承攬',is_active:true}], customer_contract_services:[{customer_id:customerId,service_type_id:serviceId,is_active:true}], folder_parts:folderParts(requestedPlan),upload_root:config.root });
    }
    if (scope === 'construction_drawing_file') {
      if (!state.allowRead) return Response.json({ error: '無權讀取此施工規劃' }, { status: 403 });
      return Response.json({ asset: state.asset });
    }
    return nas.fetch(url, init);
  };
  const post = body => nasApi.fetch(new Request('https://erp.invalid/api/nas', { method: 'POST', headers: { Authorization: 'Bearer synthetic-session' }, body }));
  const get = (id, extra = '') => nasApi.fetch(new Request(`https://erp.invalid/api/nas?mode=drawing&asset_id=${id}${extra}`, { headers: { Authorization: 'Bearer synthetic-session' } }));
  const prepare = async (file, scope = context) => {
    const response = await post(form('prepare_batch', { file_metadata: JSON.stringify([{ name: file.name, size: file.size }]) }, [], scope));
    assert.equal(response.status, 200);
    return response.json();
  };
  try { await run({ nas, state, post, get, prepare }); }
  finally { globalThis.fetch = previousFetch; for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv); }
}

test('drawing formats and content checks are scoped; regular attachments still reject CAD', () => {
  assert.throws(() => validateFileNames(['plan.dwg']), /不支援/);
  assert.deepEqual(validateFileNames(['plan.dwg', 'plan.dxf'], 10, true), ['plan.dwg', 'plan.dxf']);
  assert.throws(() => validateFileNames(['document.docx'], 10, true), /不支援/);
  assert.throws(() => validateUploadFiles([{ name: 'plan.pdf', size: 21 * 1024 * 1024 }], 10, 80 * 1024 * 1024, true), /20 MB/);
  validateDrawingBytes('plan.dwg', Buffer.from('AC1032\0drawing'));
  validateDrawingBytes('plan.dxf', Buffer.from('0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nENDSEC\r\n0\r\nEOF'));
  assert.throws(() => validateDrawingBytes('plan.pdf', Buffer.from('<script>alert(1)</script>')), /副檔名不符/);
});

test('missing or expired sessions reject malformed multipart before parsing its body', async () => fixture(async ({ nas }) => {
  const previousFetch = globalThis.fetch;
  let sessionCalls = 0, parseCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).searchParams.get('scope') === 'session') { sessionCalls++; return Response.json({ error: 'expired' }, { status: 401 }); }
    return previousFetch(url, init);
  };
  try {
    for (const authorization of ['', 'Bearer expired-synthetic-session']) {
      const request = new Request('https://erp.invalid/api/nas', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=broken', ...(authorization ? { Authorization: authorization } : {}) }, body: 'invalid multipart body' });
      const parse = request.formData.bind(request);
      request.formData = () => { parseCalls++; return parse(); };
      const response = await nasApi.fetch(request);
      assert.equal(response.status, 401);
    }
    assert.equal(parseCalls, 0); assert.equal(sessionCalls, 1); assert.equal(nas.calls.length, 0);
  } finally { globalThis.fetch = previousFetch; }
}));

test('signed drawing ticket binds plan, contract and drawing share in addition to current actor/session', () => {
  const payload = { ...context, actor: 'fixture', file_names: ['plan.dwg'], folder_parts: folderParts(), target_folder: `${config.root}/${folderParts().join('/')}`, existing_folder_depth: 5 };
  const signed = createPreflightTicket(config, payload, 'Bearer synthetic-session');
  assert.equal(verifyPreflightTicket(config, signed, payload, 'Bearer synthetic-session').construction_plan_id, planId);
  assert.throws(() => verifyPreflightTicket(config, signed, { ...payload, construction_plan_id: otherPlanId }, 'Bearer synthetic-session'), /失效/);
  assert.throws(() => verifyPreflightTicket(config, signed, payload, 'Bearer another-session'), /失效/);
  assert.throws(() => verifyPreflightTicket(config, signed, {...payload,contract_service_type_id:otherPlanId}, 'Bearer synthetic-session'), /失效/);
  assert.throws(() => verifyPreflightTicket({...config,root:'/GUC-ERP'}, signed, payload, 'Bearer synthetic-session'), /失效/);
  const forgedPath = createPreflightTicket(config, { ...payload, folder_parts: folderParts(otherPlanId), target_folder: `${config.root}/${folderParts(otherPlanId).join('/')}` }, 'Bearer synthetic-session');
  assert.throws(() => verifyPreflightTicket(config, forgedPath, payload, 'Bearer synthetic-session'), /失效/);
});

test('project-scoped manager can upload/read original drawings; duplicate choices and cross-plan denial preserve files', async () => fixture(async ({ nas, state, post, get, prepare }) => {
  const file = new File([pdf], '工程圖.pdf', { type: 'text/html' }), prepared = await prepare(file);
  assert.equal(prepared.upload_folder, `${config.root}/${folderParts().join('/')}`);
  const upload = await post(form('upload', { preflight_ticket: prepared.file_tickets[0] }, [file]));
  assert.equal(upload.status, 201);
  const row = (await upload.json()).uploaded[0];
  assert.equal(row.mime_type, 'application/pdf'); assert.equal(row.construction_plan_id, planId);
  assert.deepEqual(nas.files.get(row.nas_path), pdf);
  state.asset = { ...row, storage_provider: 'nas' };
  const read = await get(row.id);
  assert.equal(read.status, 200); assert.equal(read.headers.get('content-type'), 'application/pdf');
  assert.match(read.headers.get('content-disposition'), /^inline/);
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), pdf);
  assert.match((await get(row.id, '&download=1')).headers.get('content-disposition'), /^attachment/);
  const duplicate = await prepare(file); assert.equal(duplicate.files[0].exists, true);
  const writesBefore = nas.calls.filter(x => x.method === 'PUT').length;
  const denied = await post(form('upload', { preflight_ticket: duplicate.file_tickets[0] }, [file], { ...context, construction_plan_id: otherPlanId }));
  assert.equal(denied.status, 409); assert.equal(nas.calls.filter(x => x.method === 'PUT').length, writesBefore);
  const cancelled = await post(form('upload', { preflight_ticket: duplicate.file_tickets[0], conflict_actions: JSON.stringify({ '工程圖.pdf': 'cancel' }) }, [file]));
  assert.equal(cancelled.status, 200); assert.equal(nas.calls.filter(x => x.method === 'PUT').length, writesBefore);
  const renamed = await post(form('upload', { preflight_ticket: duplicate.file_tickets[0], conflict_actions: JSON.stringify({ '工程圖.pdf': 'rename' }) }, [file]));
  assert.equal(renamed.status, 201); assert.equal((await renamed.json()).uploaded[0].stored_name, '工程圖 (2).pdf');
  assert.deepEqual(nas.files.get(row.nas_path), pdf);
  state.allowUpload = false;
  const beforeDenied = nas.calls.length;
  assert.equal((await post(form('upload', { preflight_ticket: duplicate.file_tickets[0] }, [file]))).status, 403);
  assert.equal(nas.calls.length, beforeDenied);
  state.allowRead = false;
  assert.equal((await get(row.id)).status, 403); assert.equal(nas.calls.length, beforeDenied);
}));

test('download never accepts a forged path, unrelated asset or altered NAS contents', async () => fixture(async ({ nas, state, post, get, prepare }) => {
  const file = new File([pdf], 'plan.pdf'), prepared = await prepare(file);
  const uploaded = await post(form('upload', { preflight_ticket: prepared.file_tickets[0] }, [file]));
  const row = (await uploaded.json()).uploaded[0];
  const count = nas.calls.length;
  state.asset = { ...row, storage_provider: 'nas', nas_path: '/GUC-ERP/secret.pdf' };
  assert.equal((await get(row.id)).status, 409); assert.equal(nas.calls.length, count);
  state.asset = { ...row, storage_provider: 'nas', construction_plan_id: otherPlanId };
  assert.equal((await get(row.id)).status, 409); assert.equal(nas.calls.length, count);
  state.asset = { ...row, storage_provider: 'nas' }; nas.files.set(row.nas_path, Buffer.from('%PDF-1.4 altered'));
  assert.equal((await get(row.id)).status, 409);
  state.asset = { ...row, storage_provider: 'nas', id: otherPlanId };
  assert.equal((await get(row.id)).status, 404);
}));

test('chunked drawings verify original hash, recheck revocation before every write and safely cancel', async () => fixture(async ({ nas, state, post, prepare }) => {
  const bytes = Buffer.alloc(5 * 1024 * 1024, 32); pdf.copy(bytes);
  const file = new File([bytes], 'large.pdf'), prepared = await prepare(file);
  const begin = await post(form('begin_file', { preflight_ticket: prepared.file_tickets[0], file_name: file.name, file_size: file.size, sha256: createHash('sha256').update(bytes).digest('hex'), inline_tail: 'true' }));
  assert.equal(begin.status, 200); const ticket = await begin.json();
  const chunk = form('upload_chunk', { upload_ticket: ticket.upload_ticket, chunk_index: 0 }); chunk.set('chunk', file.slice(0, file.size - ticket.tail_bytes));
  state.allowUpload = false; const before = nas.calls.length;
  assert.equal((await post(chunk)).status, 403); assert.equal(nas.calls.length, before);
  state.allowUpload = true;
  assert.equal((await post(chunk)).status, 200);
  assert.equal((await post(chunk)).status, 200);
  const finish = form('complete_file', { upload_ticket: ticket.upload_ticket }); finish.set('tail', file.slice(file.size - ticket.tail_bytes));
  const complete = await post(finish); assert.equal(complete.status, 201);
  const row = (await complete.json()).uploaded[0]; assert.deepEqual(nas.files.get(row.nas_path), bytes);
  const second = await post(form('begin_file', { preflight_ticket: prepared.file_tickets[0], file_name: file.name, file_size: file.size, sha256: row.sha256, conflict_action: 'rename', inline_tail: 'true' }));
  const secondTicket = await second.json();
  const badScope = form('cancel_file', { upload_ticket: secondTicket.upload_ticket }, [], { ...context, construction_plan_id: otherPlanId });
  assert.equal((await post(badScope)).status, 409);
  assert.equal((await post(form('cancel_file', { upload_ticket: secondTicket.upload_ticket }))).status, 200);
  assert.equal([...nas.folders].filter(path => path.includes('.erp-upload')).length, 0);
}));

test('invalid drawing content cannot reach NAS final PUT and mixed log/plan context is rejected', async () => fixture(async ({ nas, post, prepare }) => {
  const file = new File(['not pdf'], 'bad.pdf'), prepared = await prepare(file);
  const response = await post(form('upload', { preflight_ticket: prepared.file_tickets[0] }, [file]));
  assert.equal(response.status, 415); assert.equal(nas.calls.filter(x => x.method === 'PUT').length, 0);
  assert.equal((await post(form('upload', {}, [file], { ...context, work_log_id: otherPlanId }))).status, 400);
}));

test('long drawing names retain extension across rename and invalid overwrite leaves original bytes intact', async () => fixture(async ({ nas, post, prepare }) => {
  const file = new File([pdf], `${'工程'.repeat(60)}.PDF`), prepared = await prepare(file);
  assert.equal(prepared.files[0].name.length, 100); assert.match(prepared.files[0].name, /\.pdf$/);
  const initial = await post(form('upload', { preflight_ticket: prepared.file_tickets[0] }, [file]));
  assert.equal(initial.status, 201); const row = (await initial.json()).uploaded[0];
  const rename = await post(form('upload', { preflight_ticket: prepared.file_tickets[0], conflict_actions: JSON.stringify({ [prepared.files[0].name]: 'rename' }) }, [file]));
  assert.equal(rename.status, 201); const renamed = (await rename.json()).uploaded[0];
  assert.equal(renamed.stored_name.length, 100); assert.match(renamed.stored_name, / \(2\)\.pdf$/);
  assert.equal(renamed.original_name, file.name);
  const invalid = new File([Buffer.alloc(pdf.length, 65)], file.name);
  const overwrite = await post(form('upload', { preflight_ticket: prepared.file_tickets[0], conflict_actions: JSON.stringify({ [prepared.files[0].name]: 'overwrite' }) }, [invalid]));
  assert.equal(overwrite.status, 415); assert.deepEqual(nas.files.get(row.nas_path), pdf);
  assert.deepEqual(nas.files.get(renamed.nas_path), pdf);
}));

test('drawing share accepts thirty files while rejecting missing contracts and oversized batches before NAS access', async () => fixture(async ({nas,post}) => {
  const files = Array.from({length:30},(_,index) => ({name:`工程圖-${index+1}.pdf`,size:20*1024*1024}));
  const prepared = await post(form('prepare_batch',{file_metadata:JSON.stringify(files)}));
  assert.equal(prepared.status,200);
  assert.equal((await prepared.json()).file_tickets.length,30);
  assert.ok(nas.folders.has('/GUC-ERP'));
  assert.ok(nas.folders.has(`${config.root}/${folderParts().join('/')}`));
  const beforeDenied = nas.calls.length;
  const excessive = await post(form('prepare_batch',{file_metadata:JSON.stringify([...files,{name:'31.pdf',size:1}])}));
  assert.equal(excessive.status,400);
  const missing = await post(form('prepare_batch',{file_metadata:JSON.stringify(files)},[],{...context,contract_service_type_id:''}));
  assert.equal(missing.status,400);
  const wrong = await post(form('prepare_batch',{file_metadata:JSON.stringify(files)},[],{...context,contract_service_type_id:otherPlanId}));
  assert.equal(wrong.status,403);
  assert.equal(nas.calls.length,beforeDenied);
}));

test('legacy drawing indexes remain readable without moving files or allowing old-root upload tickets', async () => fixture(async ({nas,state,get}) => {
  const pathname = `/GUC-ERP/施工規劃/${projectId}/${planId}/原有工程圖.pdf`;
  state.asset = {id:otherPlanId,construction_plan_id:planId,project_id:projectId,storage_provider:'nas',nas_path:pathname,original_name:'原有工程圖.pdf',file_size:pdf.length,sha256:createHash('sha256').update(pdf).digest('hex')};
  nas.files.set(pathname,pdf);
  const read = await get(otherPlanId);
  assert.equal(read.status,200);
  assert.deepEqual(Buffer.from(await read.arrayBuffer()),pdf);
  assert.ok(nas.calls.every(call => call.method === 'GET'));
  const payload = {...context,actor:'fixture',file_names:['plan.pdf'],folder_parts:['施工規劃',projectId,planId],target_folder:`/GUC-ERP/施工規劃/${projectId}/${planId}`,existing_folder_depth:3};
  const oldTicket = createPreflightTicket({...config,root:'/GUC-ERP'},payload,'Bearer synthetic-session');
  assert.throws(() => verifyPreflightTicket(config,oldTicket,payload,'Bearer synthetic-session'),/失效/);
}));
