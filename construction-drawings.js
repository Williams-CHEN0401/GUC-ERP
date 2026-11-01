// Engineering drawings use the existing NAS transfer pipeline and construction permissions.
let constructionDrawingContext = null, constructionDrawingRequest = 0, constructionDrawingSession = 0;
const constructionDrawingBatches = new Map();
const constructionDrawingDownloads = new Set();
const CONSTRUCTION_DRAWING_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif|pdf|dwg|dxf)$/i;

function constructionDrawingServices() {
  const context = constructionDrawingContext;
  return (context?.contract_service_types || []).filter(service => service.is_active !== false && (context.customer_contract_services || []).some(link => link.customer_id === context.customer_id && link.service_type_id === service.id && link.is_active !== false));
}

function constructionDrawingContextFields() {
  const context = constructionDrawingContext, project = byId(state.projects,context.project_id), customer = byId(state.customers,context.customer_id);
  const services = constructionDrawingServices(), selected = services.length === 1 ? services[0].id : '';
  return `<div class="construction-drawing-context-grid"><label>客戶名稱<input value="${esc(customer ? `${customer.code || ''}｜${customer.name}` : '')}" readonly></label><label>承攬內容<select name="drawingContractServiceId" required><option value="">${services.length ? '請選擇承攬內容' : '此客戶尚未啟用承攬內容'}</option>${services.map(service => `<option value="${esc(service.id)}"${service.id === selected ? ' selected' : ''}>${esc(service.name)}</option>`).join('')}</select></label><label class="span-2">工作內容名稱<input value="${esc(project ? `${project.code || ''}｜${project.name}` : '')}" readonly></label></div>${!services.length ? '<p class="form-sync-hint">請先在「客戶與供應商」為此客戶啟用承攬內容，再上傳工程圖。</p>' : ''}<div class="attachment-upload-summary"><div><b>NAS 共用資料夾：施工規劃圖</b><output id="constructionDrawingPathHint"></output></div></div>`;
}

function updateConstructionDrawingPathHint() {
  const host = document.querySelector('#constructionDrawingPathHint');
  if (!host || !constructionDrawingContext) return;
  const context = constructionDrawingContext, project = byId(state.projects,context.project_id), customer = byId(state.customers,context.customer_id);
  const service = constructionDrawingServices().find(row => row.id === document.querySelector('#modalForm').elements.drawingContractServiceId?.value);
  const uploadDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  host.textContent = service ? `/施工規劃圖/${safePathPart(customer?.name || '未命名客戶')}/${safePathPart(service.name)}/${safePathPart(project?.name || '未命名專案')}/${uploadDate}/${context.construction_plan_id}/檔名` : '選擇承攬內容後，依「客戶／承攬內容／工作內容／上傳日期／施工規劃」分開存放。';
}

function constructionDrawingFields() {
  const context = constructionDrawingContext, plan = constructionPlanById(context?.construction_plan_id);
  const project = byId(state.projects, context?.project_id);
  return `<section class="span-2 construction-drawing-heading"><h3>${esc(plan?.content || '施工規劃')}</h3><p>${esc(project?.code || '')}｜${esc(project?.name || '')}</p><p>原檔存放在 NAS「施工規劃圖」共用資料夾，沿用工作日誌附件上傳流程，依施工規劃分開管理；PDF、JPG、PNG、WebP 可開啟查看，其他格式可下載。</p>${globalThis.GUC_PUBLIC_CONFIG?.constructionDrawingsIsolated ? '<p class="nas-upload-guard"><b>隔離測試：上傳檔案只保留在測試服務，不會寫入正式 NAS。</b></p>' : ''}</section>
    <section class="span-2"><div class="construction-drawing-toolbar"><h3>已上傳工程圖</h3><button type="button" class="outline" data-drawing-reload>重新讀取</button></div><p id="constructionDrawingStatus" role="status" aria-live="polite"></p><div id="constructionDrawingList"></div></section>
    ${context?.can_upload ? `<section class="span-2 construction-drawing-upload"><h3>上傳工程圖</h3>${constructionDrawingContextFields()}<label class="attachment-dropzone"><span>選擇工程圖（可多選）</span><input name="drawingFiles" type="file" multiple required accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.dwg,.dxf"><small>每次最多 ${MAX_WORKLOG_ATTACHMENT_FILES} 個檔案，每個最多 ${formatBytes(MAX_ATTACHMENT_BYTES)}，合計最多 ${formatBytes(MAX_WORKLOG_ATTACHMENT_FILES * MAX_ATTACHMENT_BYTES)}。同名檔案會詢問覆蓋、另存或取消。</small><output id="constructionDrawingFileSummary">尚未選擇檔案</output></label><label>工程圖說明<textarea name="drawingDescription" maxlength="1000" rows="2"></textarea></label><div id="attachmentUploadProgress" class="attachment-upload-progress" role="status" aria-live="polite" hidden></div><div class="construction-drawing-toolbar"><button type="submit" class="primary">檢查並上傳工程圖</button><button type="button" class="outline" data-drawing-new-batch hidden>選擇其他檔案</button></div></section>` : '<p class="span-2 form-sync-hint">您可查看與下載此施工規劃的工程圖；上傳由具管理權限的人員操作。</p>'}
    <div class="span-2"><button type="button" class="outline" data-construction-project="${esc(context?.project_id || '')}">返回施工規劃</button></div>`;
}

function constructionDrawingStoredName(row) {
  return row.stored_name || row.nas_path?.split('/').pop() || row.original_name || row.title || '工程圖';
}

function renderConstructionDrawings() {
  const host = document.querySelector('#constructionDrawingList');
  if (!host) return;
  const rows = constructionDrawingContext?.drawings || [];
  host.innerHTML = rows.length ? `<ul class="construction-drawing-list">${rows.map(row => {
    const name = constructionDrawingStoredName(row);
    const preview = /\.(pdf|jpe?g|png|webp)$/i.test(name);
    const date = row.uploaded_at ? new Date(row.uploaded_at).toLocaleString('zh-TW') : '';
    return `<li><div><strong>${esc(name)}</strong><small>${esc(formatBytes(Number(row.file_size || 0)))}${date ? ' · ' + esc(date) : ''}${row.uploaded_by ? ' · ' + esc(row.uploaded_by) : ''}</small>${row.description ? `<p>${esc(row.description)}</p>` : ''}</div><div class="construction-plan-actions">${preview ? `<button type="button" class="outline" data-drawing-view="${esc(row.id)}">查看</button>` : ''}<button type="button" class="outline" data-drawing-download="${esc(row.id)}">下載原檔</button></div></li>`;
  }).join('')}</ul>` : '<p class="dashboard-empty">這筆施工規劃尚未上傳工程圖。</p>';
}

async function refreshConstructionDrawings() {
  const planId = constructionDrawingContext?.construction_plan_id;
  const session = constructionDrawingSession;
  if (!planId) return;
  const status = document.querySelector('#constructionDrawingStatus');
  if (status) status.textContent = '正在讀取工程圖…';
  try {
    const data = await apiRequest({method:'GET',scope:'construction_drawings',planId});
    if (constructionDrawingSession !== session || constructionDrawingContext?.construction_plan_id !== planId) return;
    constructionDrawingContext = data;
    renderConstructionDrawings();
    if (status) status.textContent = `共 ${data.drawings?.length || 0} 份工程圖`;
    const upload = document.querySelector('.construction-drawing-upload');
    if (upload && !data.can_upload) upload.hidden = true;
  } catch (error) {
    if (constructionDrawingSession === session && status) status.textContent = `工程圖清單讀取失敗：${error.message}`;
    throw error;
  }
}

function restoreConstructionDrawingBatch(form) {
  const batch = constructionDrawingBatches.get(constructionDrawingContext?.construction_plan_id);
  if (!batch || !form.elements.drawingFiles) return;
  form._nasBatch = batch;
  form.elements.drawingFiles.disabled = true;
  form.elements.drawingContractServiceId.value = batch.serviceTypeId;
  form.elements.drawingContractServiceId.disabled = true;
  form.elements.drawingDescription.value = batch.description;
  form.elements.drawingDescription.readOnly = true;
  document.querySelector('#constructionDrawingFileSummary').textContent = batch.files.map(file => file.name).join('、');
  form.querySelector('[type="submit"]').textContent = '只重試未完成的檔案';
  form.querySelector('[data-drawing-new-batch]').hidden = batch.progress?.some(file => file.nasRows && file.state !== 'done') || false;
  updateConstructionDrawingPathHint();
}

async function openConstructionDrawings(planId) {
  const generation = ++constructionDrawingRequest;
  const data = await apiRequest({method:'GET',scope:'construction_drawings',planId});
  if (generation !== constructionDrawingRequest) return;
  constructionDrawingContext = data;
  openModal('constructionDrawingModal', planId);
  document.querySelector('#modalHint').textContent = '查看及上傳依施工規劃權限驗證；上傳完成後會重新讀取工程圖清單。';
  renderConstructionDrawings();
  document.querySelector('#constructionDrawingStatus').textContent = `共 ${data.drawings?.length || 0} 份工程圖`;
  restoreConstructionDrawingBatch(document.querySelector('#modalForm'));
  updateConstructionDrawingPathHint();
}

function validateConstructionDrawingFiles(files) {
  if (!files.length || files.length > MAX_WORKLOG_ATTACHMENT_FILES) throw new Error(`請選擇 1～${MAX_WORKLOG_ATTACHMENT_FILES} 個工程圖檔案。`);
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_WORKLOG_ATTACHMENT_FILES * MAX_ATTACHMENT_BYTES) throw new Error(`單次工程圖合計不可超過 ${formatBytes(MAX_WORKLOG_ATTACHMENT_FILES * MAX_ATTACHMENT_BYTES)}。`);
  for (const file of files) {
    if (!file.size) throw new Error(`${file.name} 是空白檔案，請重新選擇。`);
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超過 ${formatBytes(MAX_ATTACHMENT_BYTES)}。`);
    if (!CONSTRUCTION_DRAWING_EXTENSIONS.test(file.name)) throw new Error(`${file.name} 的檔案格式不支援。`);
  }
}

async function uploadConstructionDrawings(form) {
  if (PREVIEW_MODE) throw new Error('此預覽未連接隔離附件服務，不能上傳工程圖。');
  if (!constructionDrawingContext?.can_upload) throw new Error('沒有上傳此施工規劃工程圖的權限。');
  const {construction_plan_id,project_id,customer_id} = constructionDrawingContext;
  const serviceTypeId = form._nasBatch?.serviceTypeId || form.elements.drawingContractServiceId.value;
  if (!constructionDrawingServices().some(service => service.id === serviceTypeId)) throw new Error('請選擇此客戶已啟用的承攬內容；如設定已變更，請重新開啟工程圖。');
  const context = {construction_plan_id,project_id,customer_id,contract_service_type_id:serviceTypeId};
  const session = constructionDrawingSession, token = accessToken;
  const currentSession = () => session === constructionDrawingSession && token === accessToken;
  const assertSession = () => { if (!currentSession()) throw new Error('登入帳號已變更，工程圖操作已停止，請重新查看檔案狀態。'); };
  const files = form._nasBatch?.files || [...form.elements.drawingFiles.files];
  validateConstructionDrawingFiles(files);
  const batch = form._nasBatch ||= {files,description:form.elements.drawingDescription.value.trim(),serviceTypeId};
  constructionDrawingBatches.set(construction_plan_id,batch);
  setAttachmentFormUploading(form,true);
  try {
    const result = await transferNasFiles({files,context,batchState:batch,description:batch.description,attachmentType:'document',
      request:async(...args) => {
        assertSession(); const result = await nasFormRequest(...args); assertSession();
        const targetFolder = result.target_folder || result.upload_folder;
        const pathHint = document.querySelector('#constructionDrawingPathHint');
        if (targetFolder && pathHint) pathHint.textContent = targetFolder;
        return result;
      },
      progress:(...args) => { if (currentSession()) setAttachmentUploadProgress(...args); },
      conflictChoice:conflict => {
        assertSession();
        const choice = window.prompt(`NAS 已有同名工程圖：${conflict.name}\n\n輸入 1：覆蓋原檔\n輸入 2：另存新檔（${conflict.suggested_name}）\n輸入 3：取消此檔案`,'2');
        return choice === '1' ? 'overwrite' : choice === '2' ? 'rename' : 'cancel';
      },register:async rows => { assertSession(); const result = await apiRequest({operation:'create_construction_drawing_batch',payload:{...context,rows}}); assertSession(); return result; }});
    assertSession();
    // An index read failure must not cause successfully stored files to be uploaded again.
    let reloadError = '';
    try { await refreshConstructionDrawings(); } catch (error) { reloadError = error.message; }
    assertSession();
    if (result.failed.some(file => !file.skipped)) {
      restoreConstructionDrawingBatch(form);
      throw new Error(`${result.uploaded.length} 份已完成；${result.failed.map(file => file.name + '：' + file.error).join('；')}。成功檔案已保留，可只重試未完成項目。`);
    }
    constructionDrawingBatches.delete(construction_plan_id);
    delete form._nasBatch;
    form.elements.drawingFiles.disabled = false;
    form.elements.drawingFiles.value = '';
    form.elements.drawingDescription.readOnly = false;
    form.elements.drawingContractServiceId.disabled = false;
    form.querySelector('[type="submit"]').textContent = '檢查並上傳工程圖';
    form.querySelector('[data-drawing-new-batch]').hidden = true;
    document.querySelector('#constructionDrawingFileSummary').textContent = '尚未選擇檔案';
    showToast(`${result.uploaded.length} 份工程圖已上傳、校驗並保存${result.failed.length ? `，${result.failed.length} 份已取消` : ''}。${reloadError ? '清單暫時無法讀取，請按「重新讀取」，毋須重傳。' : ''}`);
  } finally { if (currentSession()) setAttachmentFormUploading(form,false); }
}

async function retrieveConstructionDrawing(id,download) {
  const row = constructionDrawingContext?.drawings?.find(file => file.id === id);
  if (!row) throw new Error('工程圖已變更，請重新讀取。');
  const session = constructionDrawingSession, token = accessToken;
  const viewer = !download ? window.open('about:blank','_blank') : null;
  if (viewer) { viewer.opener = null; viewer.document.title = '載入工程圖'; viewer.document.body.textContent = '正在從 NAS 讀取工程圖…'; }
  if (!download && !viewer) throw new Error('請允許此網站開啟新分頁，或使用「下載原檔」。');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(),90000);
  const pending = {controller,viewer}; constructionDrawingDownloads.add(pending);
  try {
    const response = await fetch(`${NAS_API_ENDPOINT}?mode=drawing&asset_id=${encodeURIComponent(id)}${download ? '&download=1' : ''}`,{headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:controller.signal});
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || '工程圖讀取失敗。'); }
    const blob = await response.blob();
    if (session !== constructionDrawingSession || token !== accessToken) { viewer?.close(); return; }
    const allowedInline = ['application/pdf','image/jpeg','image/png','image/webp'];
    if (!download && !allowedInline.includes(blob.type.split(';')[0])) throw new Error('此格式無法直接預覽，請下載原檔。');
    const url = URL.createObjectURL(blob);
    if (download) { const link = document.createElement('a'); link.href = url; link.download = constructionDrawingStoredName(row); link.click(); }
    else viewer.location.replace(url);
    setTimeout(() => URL.revokeObjectURL(url),300000);
  } catch (error) { viewer?.close(); if (session !== constructionDrawingSession) return; throw new Error(error.name === 'AbortError' ? '工程圖下載逾時，請稍後再試。' : error.message); }
  finally { clearTimeout(timer); constructionDrawingDownloads.delete(pending); }
}

document.addEventListener('change',event => {
  if (event.target.name === 'drawingContractServiceId') { updateConstructionDrawingPathHint(); return; }
  if (event.target.name !== 'drawingFiles') return;
  const files = [...event.target.files];
  document.querySelector('#constructionDrawingFileSummary').textContent = files.length ? `${files.length} 個檔案，共 ${formatBytes(files.reduce((sum,file) => sum + file.size,0))}` : '尚未選擇檔案';
});
document.addEventListener('click',async event => {
  const target = event.target.closest('[data-open-construction-drawings],[data-drawing-reload],[data-drawing-view],[data-drawing-download],[data-drawing-new-batch]');
  if (!target) return;
  event.preventDefault();
  const form = document.querySelector('#modalForm');
  if (form.classList.contains('busy')) { showToast('工程圖仍在處理中，請等待完成。'); return; }
  try {
    if (target.hasAttribute('data-open-construction-drawings')) await openConstructionDrawings(target.dataset.openConstructionDrawings);
    else if (target.hasAttribute('data-drawing-reload')) await refreshConstructionDrawings();
    else if (target.hasAttribute('data-drawing-new-batch')) {
      if (form._nasBatch?.progress?.some(file => file.nasRows && file.state !== 'done')) throw new Error('請先完成已寫入 NAS 的附件紀錄保存。');
      constructionDrawingBatches.delete(constructionDrawingContext.construction_plan_id); delete form._nasBatch;
      form.elements.drawingFiles.disabled = false; form.elements.drawingFiles.value = ''; form.elements.drawingDescription.readOnly = false;
      form.elements.drawingContractServiceId.disabled = false;
      form.querySelector('[type="submit"]').textContent = '檢查並上傳工程圖'; target.hidden = true;
      document.querySelector('#constructionDrawingFileSummary').textContent = '尚未選擇檔案';
    } else await retrieveConstructionDrawing(target.dataset.drawingView || target.dataset.drawingDownload,target.hasAttribute('data-drawing-download'));
  } catch (error) { showToast(error.message,'工程圖操作未完成'); }
});
window.addEventListener('guc:session-changed',() => {
  constructionDrawingSession++;
  for (const download of constructionDrawingDownloads) { download.controller.abort(); download.viewer?.close(); }
  constructionDrawingDownloads.clear();
  constructionDrawingBatches.clear(); constructionDrawingContext = null; constructionDrawingRequest++;
  const modal = document.querySelector('#simpleModal');
  if (modal?.dataset.type === 'constructionDrawingModal') {
    const form = document.querySelector('#modalForm');
    form.replaceChildren(); form.classList.remove('busy','attachment-transfer-active'); delete form._nasBatch;
    modal.classList.remove('open'); modal.setAttribute('aria-hidden','true'); modal.dataset.type = ''; modal.dataset.id = '';
  }
});
