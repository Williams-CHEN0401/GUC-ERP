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
  const context = constructionDrawingContext;
  const project = byId(state.projects, context?.project_id);
  return `<section class="span-2 construction-drawing-heading"><h3>${esc(project?.code || '')}｜${esc(project?.name || '')}</h3><p>圖上沒有編號時，使用清冊產生的點位示意圖。有編號時，選擇該圖片的「設備點位」，首次定位時選「圖上有編號，使用原圖」。</p>${globalThis.GUC_PUBLIC_CONFIG?.constructionDrawingsIsolated ? '<p class="nas-upload-guard"><b>隔離測試：上傳檔案只保留在測試服務，不會寫入正式 NAS。</b></p>' : ''}</section>
    <section class="span-2"><div class="construction-drawing-toolbar"><h3>已上傳工程圖</h3><button type="button" class="outline" data-drawing-reload>重新讀取</button></div><p id="constructionDrawingStatus" role="status" aria-live="polite"></p><div id="constructionDrawingList"></div><div id="drawingAnnotationViewer" hidden></div></section>
    ${context?.can_upload ? `<section class="span-2 construction-drawing-upload"><h3>上傳工程圖</h3>${drawingUploadPlanField()}${constructionDrawingContextFields()}<label class="attachment-dropzone"><span>選擇工程圖（可多選）</span><input name="drawingFiles" type="file" multiple required accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.dwg,.dxf"><small>每次最多 ${MAX_WORKLOG_ATTACHMENT_FILES} 個檔案，每個最多 ${formatBytes(MAX_ATTACHMENT_BYTES)}，合計最多 ${formatBytes(MAX_WORKLOG_ATTACHMENT_FILES * MAX_ATTACHMENT_BYTES)}。同名檔案會詢問覆蓋、另存或取消。</small><output id="constructionDrawingFileSummary">尚未選擇檔案</output></label><label>工程圖說明<textarea name="drawingDescription" maxlength="1000" rows="2"></textarea></label><div id="attachmentUploadProgress" class="attachment-upload-progress" role="status" aria-live="polite" hidden></div><div class="construction-drawing-toolbar"><button type="submit" class="primary">檢查並上傳工程圖</button><button type="button" class="outline" data-drawing-new-batch hidden>選擇其他檔案</button></div></section>` : '<p class="span-2 form-sync-hint">您可查看與下載此施工規劃的工程圖；上傳由具管理權限的人員操作。</p>'}
    <div class="span-2"><button type="button" class="outline" data-construction-project="${esc(context?.project_id || '')}">返回施工規劃</button></div>`;
}

function constructionDrawingStoredName(row) {
  return row.stored_name || row.nas_path?.split('/').pop() || row.original_name || row.title || '工程圖';
}

function renderConstructionDrawings() {
  const host = document.querySelector('#constructionDrawingList');
  if (!host) return;
  const rows = constructionDrawingContext?.drawings || [];
  const hasPoints=constructionDrawingContext?.plans.some(plan=>plan.drawing_points?.length);
  const gridButton=hasPoints ? '<button type="button" class="outline" data-drawing-grid>點位示意圖（無編號）</button>' : '';
  host.innerHTML = gridButton + (rows.length ? `<ul class="construction-drawing-list">${rows.map(row => {
    const name = constructionDrawingStoredName(row);
    const preview = /\.(pdf|jpe?g|png|webp)$/i.test(name);
    const date = row.uploaded_at ? new Date(row.uploaded_at).toLocaleString('zh-TW') : '';
    return `<li><div><strong>${esc(name)}</strong><small>${esc(formatBytes(Number(row.file_size || 0)))}${date ? ' · ' + esc(date) : ''}${row.uploaded_by ? ' · ' + esc(row.uploaded_by) : ''}</small>${row.description ? `<p>${esc(row.description)}</p>` : ''}</div><div class="construction-plan-actions">${/\.(jpe?g|png|webp)$/i.test(name) ? `<button type="button" class="outline" data-drawing-default="${esc(row.id)}">設備點位</button>` : ''}${preview ? `<button type="button" class="outline" data-drawing-view="${esc(row.id)}">查看</button>` : ''}<button type="button" class="outline" data-drawing-download="${esc(row.id)}">下載原檔</button></div></li>`;
  }).join('')}</ul>` : '<p class="dashboard-empty">這筆施工規劃尚未上傳工程圖。</p>');
}

async function refreshConstructionDrawings() {
  const request = constructionDrawingRequest;
  const planId = constructionDrawingContext?.construction_plan_id;
  const session = constructionDrawingSession;
  if (!planId) return;
  const status = document.querySelector('#constructionDrawingStatus');
  if (status) status.textContent = '正在讀取工程圖…';
  try {
    const data = await projectDrawingContext(constructionDrawingContext.project_id,planId);
    if (constructionDrawingSession !== session || request !== constructionDrawingRequest || constructionDrawingContext?.construction_plan_id !== planId) return;
    closeDrawingAnnotations();
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

async function openProjectDrawings(projectId,planId) {
  const generation = ++constructionDrawingRequest;
  const data = await projectDrawingContext(projectId,planId);
  if (generation !== constructionDrawingRequest) return;
  constructionDrawingContext = data;
  closeDrawingAnnotations();
  openModal('constructionDrawingModal', data.construction_plan_id);
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
  const target = event.target.closest('[data-project-drawings],[data-drawing-reload],[data-drawing-view],[data-drawing-download],[data-drawing-new-batch]');
  if (!target) return;
  event.preventDefault();
  const form = document.querySelector('#modalForm');
  if (form.classList.contains('busy')) { showToast('工程圖仍在處理中，請等待完成。'); return; }
  try {
    if (target.hasAttribute('data-project-drawings')) await openProjectDrawings(target.dataset.projectDrawings);
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

// All files retain their plan ownership and use the existing authenticated NAS path.
async function projectDrawingContext(projectId, preferredPlanId) {
  const scope = await apiRequest({method:'GET',scope:'construction_plans',projectId});
  const plans = (scope.construction_plans || []).filter(plan => plan.project_id === projectId);
  if (!plans.length) throw Error('此案沒有可查看的施工規劃。');
  const contexts = [];
  for (let i=0;i<plans.length;i+=4) {
    contexts.push(...await Promise.all(plans.slice(i,i+4).map(plan => apiRequest({method:'GET',scope:'construction_drawings',planId:plan.id}))));
  }
  const selected = contexts.find(row=>row.construction_plan_id===preferredPlanId)
    || contexts.find(row=>row.can_upload && row.drawings.length) || contexts.find(row=>row.can_upload) || contexts[0];
  const drawings = contexts.flatMap(row=>row.drawings).sort((a,b)=>String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
  return {...selected,drawings,plans,contexts};
}

function drawingUploadPlanField() {
  const {plans,contexts,construction_plan_id:id} = constructionDrawingContext;
  const allowed = plans.filter(plan=>contexts.some(row=>row.construction_plan_id===plan.id && row.can_upload));
  return allowed.length>1 ? `<label>檔案所屬規劃<select name="drawingOwnerPlan">${allowed.map(p=>`<option value="${esc(p.id)}" ${p.id===id?'selected':''}>${esc(p.content)}</option>`).join('')}</select></label>` : '';
}

document.addEventListener('change',async event=>{
  if (event.target.name!=='drawingOwnerPlan') return;
  const form=event.target.form, context=constructionDrawingContext, planId=event.target.value;
  event.target.value=context.construction_plan_id;
  if(planId===context.construction_plan_id)return;
  if (form.classList.contains('busy') || form._nasBatch || form.elements.drawingFiles?.files.length) {
    showToast('請先完成目前的檔案上傳，再切換所屬規劃。'); return;
  }
  try { await openProjectDrawings(context.project_id,planId); } catch(error){showToast(error.message);}
});

let activeDrawingAnnotation = null;
function closeDrawingAnnotations(){
  activeDrawingAnnotation?.abort.abort();
  activeDrawingAnnotation=null;
  const host=document.querySelector('#drawingAnnotationViewer');
  if(host){host.hidden=true;host.replaceChildren();}
}

function showDrawingGrid(row) {
  closeDrawingAnnotations();
  const host=document.querySelector('#drawingAnnotationViewer');
  const plans=row?constructionDrawingContext.plans.filter(plan=>plan.id===row.construction_plan_id):constructionDrawingContext.plans;
  const codes=[...new Set(plans.flatMap(plan=>(plan.drawing_points||[]).map(p=>p.code)))];
  const view={host,abort:new AbortController(),lookup:0};
  activeDrawingAnnotation=view;
  host.hidden=false;
  host.innerHTML=`<div class="construction-drawing-toolbar"><h3>點位示意圖</h3>${row?`<button type="button" class="outline" data-drawing-annotate="${esc(row.id)}">圖上有編號，使用原圖</button>`:''}<button type="button" class="outline" data-marker-close>收合示意圖</button></div>
    <p>依設備清冊排列，共 ${codes.length} 台。點選圖示或編號可查看工項進度。</p>
    <div class="drawing-canvas"><div class="drawing-grid">${codes.map(code=>`<button type="button" class="drawing-grid-point" data-grid-code="${esc(code)}" aria-label="${esc(code)} 施工進度"><img alt="" src="/assets/construction-camera.png"><span>${esc(code)}</span></button>`).join('')}</div><aside class="drawing-note" hidden role="status"></aside></div>`;
  host.scrollIntoView({block:'nearest'});
}

function paintDrawingMarkers(view) {
  const layer=view.host.querySelector('.drawing-markers');
  layer.replaceChildren();
  for(const [code,pos] of Object.entries(view.row.drawing_markers || {})){
    if(!view.codes.includes(code))continue;
    for(const [kind,anchor] of [['icon',pos],['label',pos.label]]){
      if(!Number.isFinite(anchor?.x)||!Number.isFinite(anchor.y))continue;
      const button=document.createElement('button');
      button.type='button';button.className='drawing-marker';button.dataset.markerCode=code;button.dataset.anchor=kind;
      button.setAttribute('aria-label',code+(kind==='label'?' 編號':' 圖示')+' 施工進度');button.title=code;
      button.style.left=(anchor.x*100)+'%';button.style.top=(anchor.y*100)+'%';
      layer.append(button);
    }
  }
}

async function showDrawingAnnotation(id) {
  const ctx=constructionDrawingContext, row=ctx.drawings.find(r=>r.id===id);
  if(!row)throw Error('請重新讀取工程圖。');
  closeDrawingAnnotations();
  const host=document.querySelector('#drawingAnnotationViewer'), plan=ctx.plans.find(p=>p.id===row.construction_plan_id);
  const codes=(plan?.drawing_points||[]).map(p=>p.code);
  const editable=ctx.contexts.some(c=>c.construction_plan_id===plan?.id && c.can_upload);
  const view={host,row,codes,abort:new AbortController(),pending:false,lookup:0};
  activeDrawingAnnotation=view;host.hidden=false;host.textContent='正在讀取工程圖…';host.scrollIntoView({block:'nearest'});
  try {
    const response=await fetch(NAS_API_ENDPOINT+'?mode=drawing&asset_id='+encodeURIComponent(id),{headers:{Authorization:'Bearer '+accessToken},cache:'no-store',signal:view.abort.signal});
    if(!response.ok)throw Error('無法讀取工程圖，請重新確認登入及權限。');
    const blob=await response.blob();
    if(!['image/jpeg','image/png','image/webp'].includes(blob.type.split(';')[0]))throw Error('點位檢視支援 JPG、PNG、WebP。');
    const src=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});
    if(view!==activeDrawingAnnotation || !host.isConnected)return;
    host.innerHTML=`<div class="construction-drawing-toolbar"><h3>${esc(constructionDrawingStoredName(row))}</h3><button type="button" class="outline" data-marker-close>收合工程圖</button></div>
      ${editable&&codes.length?`<fieldset class="drawing-locator"><legend>設定原圖點位</legend><label>設備編號<select data-marker-select><option value="">請選擇編號</option>${codes.map(c=>`<option>${esc(c)}</option>`).join('')}</select></label><label>定位對象<select data-marker-kind><option value="pair">編號 → 攝影機圖示</option><option value="icon">攝影機圖示</option><option value="label">圖上的編號</option></select></label>
        <small>選擇設備後，先點圖上的編號，再點同一台攝影機。若圖上只有其中一種標記，可切換定位對象。</small></fieldset>`:''}
      <div class="drawing-canvas"><div class="drawing-scroll" tabindex="0" aria-label="工程圖，可橫向捲動"><div class="drawing-stage"><img alt="工程圖"><div class="drawing-markers"></div></div></div><aside class="drawing-note" hidden role="status"></aside></div>
      <output aria-live="polite" data-marker-status></output>`;
    host.querySelector('img').src=src;paintDrawingMarkers(view);
    const count=Object.keys(row.drawing_markers||{}).filter(c=>codes.includes(c)).length;
    host.querySelector('output').textContent=`已定位 ${count}／${codes.length}。點選標記可查看施工進度。`;
  }catch(error){if(view===activeDrawingAnnotation){host.textContent='工程圖讀取失敗。';throw error;}}
}

async function openMarkerNote(view,code,pos){
  const seq=++view.lookup, note=view.host.querySelector('.drawing-note');
  note.hidden=false;note.textContent='正在讀取日誌進度…';
  note.style.left=Math.min(pos.x*100,65)+'%';note.style.top=(pos.y*100)+'%';
  note.classList.toggle('above',pos.y>.55);
  try {
    const data=await apiRequest({method:'GET',scope:'construction_plans',projectId:constructionDrawingContext.project_id});
    if(activeDrawingAnnotation!==view||seq!==view.lookup)return;
    const visible=(data.construction_plans||[]).filter(p=>p.drawing_points?.some(pt=>pt.code===code));
    note.innerHTML=`<div><strong>${esc(code)}</strong> <button type="button" class="outline" data-note-close aria-label="關閉註解">×</button></div>`+
      visible.map(p=>`<strong>${esc(p.content)}</strong><ul>${(p.items||[]).map(i=>{
        const record=(p.equipment_state||[]).find(e=>e.code===code&&e.item===i.id);
        return `<li>${esc(i.title)}　${esc(equipmentStates[record?.status]||'未填報')}</li>`;
      }).join('')}</ul>`).join('');
  }catch(error){if(activeDrawingAnnotation===view&&seq===view.lookup)note.textContent=error.message;}
}

document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-drawing-annotate]');
  const view=activeDrawingAnnotation;
  try{
    const open=event.target.closest('[data-drawing-default]');
    if(open){
      const row=constructionDrawingContext.drawings.find(file=>file.id===open.dataset.drawingDefault);
      if(!row)throw Error('請重新讀取工程圖。');
      if(Object.keys(row.drawing_markers||{}).length)await showDrawingAnnotation(row.id);
      else showDrawingGrid(row);
      return;
    }
    if(event.target.closest('[data-drawing-grid]')){showDrawingGrid();return;}
    if(button){await showDrawingAnnotation(button.dataset.drawingAnnotate);return;}
    if(!view?.host.contains(event.target))return;
    if(event.target.closest('[data-marker-close]')){closeDrawingAnnotations();return;}
    const note=view.host.querySelector('.drawing-note');
    if(event.target.closest('[data-note-close]')){view.lookup++;note.hidden=true;return;}
    if(event.target.closest('.drawing-note'))return;
    const cell=event.target.closest('[data-grid-code]');
    if(cell){
      if(window.matchMedia('(max-width:650px)').matches)cell.after(note);
      const canvas=cell.closest('.drawing-canvas').getBoundingClientRect(), bounds=cell.getBoundingClientRect();
      await openMarkerNote(view,cell.dataset.gridCode,{x:(bounds.right-canvas.left)/canvas.width,y:(bounds.top+bounds.height/2-canvas.top)/canvas.height});
      return;
    }
    const stage=event.target.closest('.drawing-stage');
    if(!stage||view.pending)return;
    const select=view.host.querySelector('[data-marker-select]'), code=select?.value;
    if(!code){
      const marker=event.target.closest('[data-marker-code]');
      if(marker){
        const point=view.row.drawing_markers[marker.dataset.markerCode];
        await openMarkerNote(view,marker.dataset.markerCode,marker.dataset.anchor==='label'?point.label:point);
      }
      else {view.lookup++;note.hidden=true;}
      return;
    }
    const rect=stage.getBoundingClientRect(), limit=n=>Math.max(0,Math.min(1,n));
    if(!rect.width||!rect.height)return;
    const anchor={x:limit((event.clientX-rect.left)/rect.width),y:limit((event.clientY-rect.top)/rect.height)};
    const kind=view.host.querySelector('[data-marker-kind]');
    const previous=Object.hasOwn(view.row.drawing_markers||{},code)?view.row.drawing_markers[code]:null;
    if(kind.value==='pair'&&!view.draftLabel){
      view.draftLabel=anchor;
      view.lookup++;note.hidden=true;
      view.host.querySelector('output').textContent=code+' 已選取編號位置，請點同一台攝影機的圖示以儲存。';
      return;
    }
    const position=kind.value==='pair'?{...anchor,label:view.draftLabel}:kind.value==='label'?{...previous,label:anchor}:{...previous,...anchor};
    view.pending=true;select.disabled=true;kind.disabled=true;note.hidden=true;view.lookup++;
    try{
      const data=await apiRequest({operation:'save_construction_drawing_marker',payload:{asset_id:view.row.id,sha256:view.row.sha256,code,expected:previous,position}});
      if(view!==activeDrawingAnnotation)return;
      view.row.drawing_markers=data.result;view.draftLabel=null;select.value='';paintDrawingMarkers(view);
      view.host.querySelector('output').textContent=code+' 已定位。';
      await openMarkerNote(view,code,anchor);
    }finally{view.pending=false;select.disabled=false;kind.disabled=false;}
  }catch(error){showToast(error.message,'工程圖操作未完成');}
});

document.addEventListener('change',event=>{
  if(!event.target.matches('[data-marker-kind],[data-marker-select]'))return;
  const view=activeDrawingAnnotation;
  if(!view?.host.contains(event.target))return;
  view.draftLabel=null;
  view.lookup++;
  view.host.querySelector('.drawing-note').hidden=true;
  const code=view.host.querySelector('[data-marker-select]').value;
  const kind=view.host.querySelector('[data-marker-kind]').value;
  view.host.querySelector('output').textContent=code ? code+(kind==='icon'?'：請點攝影機圖示。':'：請點圖上的編號。') : '點選已定位的編號或圖示，可查看施工進度。';
});

window.addEventListener('guc:session-changed',closeDrawingAnnotations);
