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
  return `<section class="span-2 construction-drawing-heading"><h3>${esc(project?.code || '')}｜${esc(project?.name || '')}</h3>${globalThis.GUC_PUBLIC_CONFIG?.constructionDrawingsIsolated ? '<p class="nas-upload-guard"><b>隔離測試：上傳檔案只保留在測試服務，不會寫入正式 NAS。</b></p>' : ''}</section>
    <section class="span-2"><div class="construction-drawing-toolbar"><h3>已上傳工程圖</h3><button type="button" class="outline" data-drawing-reload>重新讀取</button></div>${drawingDeviceSearchField()}<p id="constructionDrawingStatus" role="status" aria-live="polite"></p><div id="drawingServiceTabs"></div><div id="drawingPager"></div><div id="drawingAnnotationViewer" hidden></div><div id="constructionDrawingList"></div></section>
    ${context?.can_upload ? `<section class="span-2 construction-drawing-upload"><h3>上傳工程圖</h3>${drawingUploadPlanField()}${constructionDrawingContextFields()}<label class="attachment-dropzone"><span>選擇工程圖（可多選）</span><input name="drawingFiles" type="file" multiple required accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.dwg,.dxf"><small>每次最多 ${MAX_WORKLOG_ATTACHMENT_FILES} 個檔案，每個最多 ${formatBytes(MAX_ATTACHMENT_BYTES)}，合計最多 ${formatBytes(MAX_WORKLOG_ATTACHMENT_FILES * MAX_ATTACHMENT_BYTES)}。同名檔案會詢問覆蓋、另存或取消。</small><output id="constructionDrawingFileSummary">尚未選擇檔案</output></label><label>工程圖說明<textarea name="drawingDescription" maxlength="1000" rows="2"></textarea></label><div id="attachmentUploadProgress" class="attachment-upload-progress" role="status" aria-live="polite" hidden></div><div class="construction-drawing-toolbar"><button type="submit" class="primary">檢查並上傳工程圖</button><button type="button" class="outline" data-drawing-new-batch hidden>選擇其他檔案</button></div></section>` : '<p class="span-2 form-sync-hint">您可查看與下載此施工規劃的工程圖；上傳由具管理權限的人員操作。</p>'}
    <div class="span-2"><button type="button" class="outline" data-construction-project="${esc(context?.project_id || '')}">返回施工規劃</button></div>`;
}

function constructionDrawingStoredName(row) {
  return row.stored_name || row.nas_path?.split('/').pop() || row.original_name || row.title || '工程圖';
}

const drawingProgressLabels={pending:'未開始',working:'施工中',done:'已完成',na:'不適用'};
function drawingProgressByCode(plans) {
  const totals=new Map();
  for(const plan of plans){
    const items=new Set((plan.items||[]).map(item=>item.id));
    const points=new Set((plan.drawing_points||[]).map(point=>point.code));
    for(const code of points){
      if(!totals.has(code))totals.set(code,{applicable:0,done:0,working:false});
      totals.get(code).applicable+=items.size;
    }
    for(const cell of plan.equipment_state||[]){
      if(!points.has(cell.code)||!items.has(cell.item))continue;
      const value=totals.get(cell.code);
      if(cell.status==='na')value.applicable--;
      if(cell.status==='done')value.done++;
      if(cell.status==='working')value.working=true;
    }
  }
  return new Map([...totals].map(([code,v])=>[code,v.applicable===0?'na':v.done===v.applicable?'done':v.working||v.done?'working':'pending']));
}
function drawingLegend(){
  return '<div class="drawing-legend" aria-label="設備施工進度">'+Object.entries(drawingProgressLabels).map(([key,label])=>'<span data-point-state="'+key+'">'+label+'</span>').join('')+'</div>';
}
/* ---------- 第二版：設備圖示、設備搜尋、待配置清單與工程圖管理 ---------- */
function drawingTitle(row){return row?.title||constructionDrawingStoredName(row);}
function drawingService(row){return (constructionDrawingContext?.contract_service_types||[]).find(s=>s.id===row?.contract_service_type_id)||null;}
function drawingPlan(row){return (constructionDrawingContext?.plans||[]).find(p=>p.id===row?.construction_plan_id);}
// 同編號設備在本案任一施工規劃的資料（名稱、類型等由伺服器同步，取第一筆即可）。
function drawingPoint(code){
  for(const plan of constructionDrawingContext?.plans||[]){const point=plan.drawing_points?.find(p=>p.code===code);if(point)return {point,plan};}
  return {point:{code},plan:null};
}
function drawingIcon(code,row){const {point,plan}=drawingPoint(code);return equipmentIconFor(point,drawingService(row),drawingPlan(row)?.content||plan?.content);}
// 工程圖顯示的設備：有指定（drawing_codes）時只顯示指定的設備與圖上已定位的設備；
// 未指定（null）時顯示所屬規劃清冊中符合工程圖承攬類型的設備（例如廣播圖不顯示攝影機），
// 設備類型無法判斷承攬類型時仍顯示，圖上已定位的設備一定顯示。
function drawingCodes(row){
  const roster=(drawingPlan(row)?.drawing_points||[]).map(p=>p.code);
  if(!Array.isArray(row?.drawing_codes)){
    const service=drawingServiceList().find(s=>s.id===row?.contract_service_type_id);
    if(!service||!equipmentIconKey(`${service.code||''} ${service.name||''}`))return roster;
    return roster.filter(code=>{const ids=typeServiceIds(code);return Object.hasOwn(row.drawing_markers||{},code)||!ids.size||ids.has(service.id);});
  }
  const shown=new Set([...row.drawing_codes,...Object.keys(row.drawing_markers||{})]);
  return roster.filter(code=>shown.has(code));
}
function drawingAssigned(row,code){
  if(!drawingPlan(row)?.drawing_points?.some(p=>p.code===code))return false;
  return Object.hasOwn(row.drawing_markers||{},code)||Array.isArray(row.drawing_codes)&&row.drawing_codes.includes(code);
}
// 設備已配置的工程圖：圖上有定位，或工程圖已指定顯示此設備（不受承攬類型篩選影響）。
function drawingPlacements(code){
  return drawingImageRows().filter(row=>drawingAssigned(row,code));
}
function unplacedCodes(plans){
  return [...new Set(plans.flatMap(plan=>(plan.drawing_points||[]).map(p=>p.code)))].filter(code=>!drawingPlacements(code).length);
}
// 承攬類型：設備所在工程圖的承攬類型；尚未配置時依設備類型對應承攬項目圖示（與案場系統相同規則）。
function drawingServiceList(){
  return constructionDrawingContext?.contract_service_types||[];
}
// 依設備類型對應的承攬類型（例如「廣播喇叭」→ 廣播系統）。
function typeServiceIds(code){
  const ids=new Set(),key=equipmentIconKey(drawingPoint(code).point.type);
  if(key)for(const s of drawingServiceList())if(equipmentIconKey(`${s.code||''} ${s.name||''}`)===key)ids.add(s.id);
  return ids;
}
function deviceServiceIds(code){
  const ids=new Set(drawingPlacements(code).map(row=>row.contract_service_type_id).filter(Boolean));
  return ids.size?ids:typeServiceIds(code);
}
function serviceMatchesCode(code){
  const service=constructionDrawingFilter.service;return !service||deviceServiceIds(code).has(service);
}
function projectCodes(){
  return [...new Set((constructionDrawingContext?.plans||[]).flatMap(plan=>(plan.drawing_points||[]).map(p=>p.code)))];
}
// 同一案有多種承攬類型（例如監視、廣播）時，以頁籤分開查看工程圖與點位示意圖。
function drawingServiceTabs(){
  const rows=drawingImageRows(),codes=projectCodes(),ids=new Set([...rows.map(r=>r.contract_service_type_id).filter(Boolean),...codes.flatMap(c=>[...deviceServiceIds(c)])]);
  const services=drawingServiceList().filter(s=>ids.has(s.id));
  if(services.length<2)return '';
  const current=constructionDrawingFilter.service;
  const tab=(id,label,pages,devices)=>`<button type="button" class="outline" role="tab" data-drawing-service="${esc(id)}" aria-selected="${current===id}">${esc(label)}<small>${pages} 張圖・${devices} 台</small></button>`;
  return `<div class="drawing-service-tabs" role="tablist" aria-label="依承攬類型查看">${tab('','全部承攬類型',rows.length,codes.length)}${services.map(s=>tab(s.id,s.name,rows.filter(r=>r.contract_service_type_id===s.id).length,codes.filter(c=>deviceServiceIds(c).has(s.id)).length)).join('')}</div>`;
}
function drawingDeviceSearchField(){
  return `<div class="drawing-device-search"><label>搜尋設備並定位<input type="search" data-device-search placeholder="設備編號、名稱、類型、施工區域、施工項目" autocomplete="off"></label><ul class="device-search-results" data-device-results hidden></ul></div>`;
}
function searchDrawingDevices(keyword){
  keyword=keyword.trim().toLowerCase();if(!keyword)return [];
  const found=new Map();
  for(const plan of constructionDrawingContext?.plans||[]){
    for(const point of plan.drawing_points||[]){
      const items=(plan.items||[]).filter(item=>itemAppliesTo(item,point.code,plan)).map(i=>i.title);
      const haystack=[point.code,point.name,point.type,point.model,point.location,point.building,plan.content,...items].map(v=>String(v||'').toLowerCase());
      if(!haystack.some(v=>v.includes(keyword)))continue;
      const entry=found.get(point.code)||{point,plans:[]};entry.plans.push(plan.content);found.set(point.code,entry);
    }
  }
  return [...found.values()].slice(0,30);
}
function renderDeviceSearch(input){
  const list=input.closest('.drawing-device-search').querySelector('[data-device-results]'),results=searchDrawingDevices(input.value);
  list.hidden=!input.value.trim();
  list.innerHTML=results.map(({point,plans})=>{const places=drawingPlacements(point.code);return `<li><button type="button" data-locate-device="${esc(point.code)}"><img alt="" src="${esc(drawingIcon(point.code,places[0]))}"><span><b>${esc(point.code)}</b> ${esc(point.name||'')}<small>${esc([point.type,point.location,plans.join('、')].filter(Boolean).join(' · '))}</small></span><em>${places.length?`已配置（${places.length} 張）`:'待配置'}</em></button></li>`;}).join('')||'<li class="dashboard-empty">找不到符合的設備。</li>';
}
async function locateDevice(code){
  const status=document.querySelector('#constructionDrawingStatus'),places=drawingPlacements(code);
  const list=document.querySelector('[data-device-results]');if(list)list.hidden=true;
  if(!places.length){
    if(status)status.textContent=`${code} 尚未配置於任何工程圖，列在點位示意圖的「待配置」。開啟工程圖後可指定設備並在圖上設定位置。`;
    showToast(`${code} 尚未配置於工程圖。`,'設備定位');
    return false;
  }
  const marked=places.filter(r=>Object.hasOwn(r.drawing_markers||{},code));
  const row=marked.find(r=>r.id===activeDrawingAnnotation?.row?.id)||marked[0]||places.find(r=>r.id===activeDrawingAnnotation?.row?.id)||places[0];
  if(activeDrawingAnnotation?.row?.id!==row.id)await showDrawingAnnotation(row.id);
  const view=activeDrawingAnnotation;
  if(view?.row?.id===row.id){
    if(marked.includes(row)){focusDrawingMarker(view,code);if(status)status.textContent=`${code} 位於「${drawingTitle(row)}」。`;}
    else if(status)status.textContent=`${code} 已指定在「${drawingTitle(row)}」，尚未在圖上標示位置。`;
  }
  return true;
}
function drawingCategoryText(row){
  const c=row.drawing_category||{};return [c.building,c.floor,c.area].filter(Boolean).join(' / ');
}
function drawingFilterBar(rows){
  const values=key=>[...new Set(rows.map(r=>r.drawing_category?.[key]).filter(Boolean))].sort();
  const filter=constructionDrawingFilter;
  // 承攬類型改由上方頁籤切換（同時套用工程圖與點位示意圖）。
  const select=(key,label,options)=>options.length?`<label>${label}<select data-drawing-filter="${key}"><option value="">全部</option>${options.map(([v,t])=>`<option value="${esc(v)}" ${filter[key]===v?'selected':''}>${esc(t)}</option>`).join('')}</select></label>`:'';
  return `<div class="drawing-filter-bar"><label>搜尋工程圖<input type="search" data-drawing-filter="text" value="${esc(filter.text)}" placeholder="名稱、說明、建築物、樓層"></label>${select('building','建築物',values('building').map(v=>[v,v]))}${select('floor','樓層',values('floor').map(v=>[v,v]))}</div>`;
}
const constructionDrawingFilter={text:'',building:'',floor:'',service:''};
function drawingFilterMatches(row){
  const f=constructionDrawingFilter,c=row.drawing_category||{};
  if(f.building&&c.building!==f.building||f.floor&&c.floor!==f.floor||f.service&&row.contract_service_type_id!==f.service)return false;
  const text=f.text.trim().toLowerCase();
  return !text||[drawingTitle(row),constructionDrawingStoredName(row),row.description,c.building,c.floor,c.area,drawingService(row)?.name,drawingPlan(row)?.content].some(v=>String(v||'').toLowerCase().includes(text));
}
function canManageDrawing(row){return !!constructionDrawingContext?.contexts?.some(c=>c.construction_plan_id===row.construction_plan_id&&c.can_upload);}
function drawingEditForm(row){
  const c=row.drawing_category||{},services=constructionDrawingServices();
  // 位於上傳表單（#modalForm）內，不能使用巢狀 form；以按鈕送出。
  return `<details class="drawing-edit"><summary>編輯資訊</summary><div class="roster-editor" data-drawing-edit="${esc(row.id)}"><label>工程圖名稱<input data-field="title" maxlength="200" value="${esc(drawingTitle(row))}"></label><label>建築物<input data-field="building" maxlength="80" value="${esc(c.building||'')}"></label><label>樓層<input data-field="floor" maxlength="80" value="${esc(c.floor||'')}"></label><label>施工區域<input data-field="area" maxlength="80" value="${esc(c.area||'')}"></label><label>工程類型<select data-field="service">${services.map(s=>`<option value="${esc(s.id)}" ${s.id===row.contract_service_type_id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><label class="span-all">說明<textarea data-field="description" maxlength="1000" rows="2">${esc(row.description||'')}</textarea></label><div class="construction-plan-actions"><button type="button" class="primary" data-drawing-save="${esc(row.id)}">儲存工程圖資訊</button></div></div></details>`;
}
function drawingPointGrid(codes,progress,row){
  return '<div class="drawing-grid">'+codes.map(code=>{
    const key=progress.get(code)||'pending';
    return `<button type="button" class="drawing-grid-point" data-grid-code="${esc(code)}" data-point-state="${key}"><img alt="" src="${esc(drawingIcon(code,row))}"><span>${esc(code)}</span><small>${drawingProgressLabels[key]}</small></button>`;
  }).join('')+'</div>';
}
function drawingImageRows(){
  return (constructionDrawingContext?.drawings||[]).filter(row=>/\.(jpe?g|png|webp)$/i.test(constructionDrawingStoredName(row)));
}
// 翻頁只在目前承攬類型的工程圖之間切換。
function drawingPages(){
  const service=constructionDrawingFilter.service;
  return drawingImageRows().filter(row=>!service||row.contract_service_type_id===service);
}
function drawPager(id){
  const host=document.querySelector('#drawingPager');if(!host)return;
  const pages=drawingPages(),index=pages.findIndex(row=>row.id===id);
  host.innerHTML=index<0?'':`<nav class="drawing-pager" aria-label="切換工程圖"><button type="button" class="outline" data-drawing-page="${esc(pages[index-1]?.id||'')}" ${index===0?'disabled':''}>上一張</button><label>工程圖 <select data-gallery-select>${pages.map((r,i)=>`<option value="${esc(r.id)}" ${i===index?'selected':''}>${i+1}／${pages.length}　${esc(drawingTitle(r))}${drawingCategoryText(r)?'（'+esc(drawingCategoryText(r))+'）':''}</option>`).join('')}</select></label><button type="button" class="outline" data-drawing-page="${esc(pages[index+1]?.id||'')}" ${index===pages.length-1?'disabled':''}>下一張</button></nav>`;
}
function startDrawingGallery(preferred){
  const pages=drawingPages();
  const row=pages.find(r=>r.id===preferred)||pages[0];
  if(row)showDrawingAnnotation(row.id).catch(error=>showToast(error.message,'工程圖讀取失敗'));
  else if(constructionDrawingContext.plans.some(p=>p.drawing_points?.length))showDrawingGrid();
  else closeDrawingAnnotations();
}
function renderConstructionDrawings() {
  const host = document.querySelector('#constructionDrawingList');
  if (!host) return;
  const rows = constructionDrawingContext?.drawings || [];
  const plans=constructionDrawingContext?.plans||[],hasPoints=plans.some(plan=>plan.drawing_points?.length);
  // 點位示意圖與待配置設備整合為同一個入口；數量依目前承攬類型計算。
  const codes=hasPoints?projectCodes().filter(serviceMatchesCode):[],waiting=codes.filter(code=>!drawingPlacements(code).length);
  const gridButton=hasPoints ? `<div class="construction-plan-actions"><button type="button" class="outline" data-drawing-grid>點位示意圖（${codes.length} 台${waiting.length?`・待配置 ${waiting.length}`:''}）</button></div>` : '';
  const visible=rows.filter(drawingFilterMatches);
  // 承攬類型頁籤與點位示意圖入口放在工程圖檢視上方。
  const tabs=document.querySelector('#drawingServiceTabs');if(tabs)tabs.innerHTML=drawingServiceTabs()+gridButton;
  host.innerHTML = (tabs?'':gridButton) + (rows.length ? drawingFilterBar(rows)+`<p class="form-sync-hint">共 ${rows.length} 份工程圖${visible.length!==rows.length?`，符合篩選 ${visible.length} 份`:''}。</p><ul class="construction-drawing-list">${visible.map(row => {
    const name = constructionDrawingStoredName(row),title=drawingTitle(row);
    const preview = /\.(pdf|jpe?g|png|webp)$/i.test(name);
    const date = row.uploaded_at ? new Date(row.uploaded_at).toLocaleString('zh-TW') : '';
    const markers=Object.keys(row.drawing_markers||{}).length,category=drawingCategoryText(row),service=drawingService(row);
    const assigned=Array.isArray(row.drawing_codes)?`指定 ${drawingCodes(row).length} 台設備`:'';
    return `<li><div><strong>${esc(title)}</strong><small>${title!==name?esc(name)+' · ':''}${esc(formatBytes(Number(row.file_size || 0)))}${date ? ' · ' + esc(date) : ''}${row.uploaded_by ? ' · ' + esc(row.uploaded_by) : ''}</small><small>${esc([drawingPlan(row)?.content,service?.name,category,assigned,markers?`已定位 ${markers} 台設備`:''].filter(Boolean).join(' · '))}</small>${row.description ? `<p>${esc(row.description)}</p>` : ''}${canManageDrawing(row)?drawingEditForm(row):''}</div><div class="construction-plan-actions">${/\.(jpe?g|png|webp)$/i.test(name) ? `<button type="button" class="outline" data-drawing-default="${esc(row.id)}">設備點位</button>` : ''}${preview ? `<button type="button" class="outline" data-drawing-view="${esc(row.id)}">查看</button>` : ''}<button type="button" class="outline" data-drawing-download="${esc(row.id)}">下載原檔</button>${canManageDrawing(row)?`<button type="button" class="outline danger" data-drawing-archive="${esc(row.id)}">刪除</button>`:''}</div></li>`;
  }).join('')||'<li class="dashboard-empty">沒有符合篩選的工程圖。</li>'}</ul>` : '<p class="dashboard-empty">這筆施工規劃尚未上傳工程圖。</p>');
}
document.addEventListener('input',event=>{
  if(event.target.matches('[data-device-search]'))renderDeviceSearch(event.target);
  else if(event.target.matches('[data-drawing-filter="text"]')){
    constructionDrawingFilter.text=event.target.value;const caret=event.target.selectionStart;
    renderConstructionDrawings();const input=document.querySelector('[data-drawing-filter="text"]');if(input){input.focus();input.setSelectionRange(caret,caret);}
  }
});
document.addEventListener('change',event=>{
  const filter=event.target.closest('select[data-drawing-filter]');
  if(filter){constructionDrawingFilter[filter.dataset.drawingFilter]=filter.value;renderConstructionDrawings();}
});
document.addEventListener('click',async event=>{
  const save=event.target.closest('[data-drawing-save]'),archive=event.target.closest('[data-drawing-archive]');
  const tab=event.target.closest('[data-drawing-service]'),locate=event.target.closest('[data-locate-device]');
  if(!save&&!archive&&!tab&&!locate)return;
  event.preventDefault();
  try{
    if(locate){await locateDevice(locate.dataset.locateDevice);return;}
    if(tab){
      constructionDrawingFilter.service=tab.dataset.drawingService;
      const showingGrid=activeDrawingAnnotation&&!activeDrawingAnnotation.row,current=activeDrawingAnnotation?.row?.id;
      renderConstructionDrawings();
      if(showingGrid)showDrawingGrid(null,{waiting:activeDrawingAnnotation?.waiting});
      else startDrawingGallery(drawingPages().some(r=>r.id===current)?current:undefined);
      return;
    }
    const known=constructionDrawingContext?.drawings?.find(r=>r.id===(save||archive).dataset[save?'drawingSave':'drawingArchive']);
    if(!known)throw Error('工程圖已變更，請重新讀取。');
    // 設定點位會更新工程圖版本；操作前重新讀取，確認仍存在並取得最新版本與點位數。
    const latest=await apiRequest({method:'GET',scope:'construction_drawings',planId:known.construction_plan_id});
    const row=latest.drawings?.find(r=>r.id===known.id);
    if(!row){await refreshConstructionDrawings();throw Error('工程圖已被刪除或變更，清單已重新讀取。');}
    if(save){
      const box=save.closest('[data-drawing-edit]'),value=key=>String(box.querySelector(`[data-field="${key}"]`)?.value||'').trim();
      if(!value('title'))throw Error('請填寫工程圖名稱。');
      box.inert=true;
      try{await apiRequest({operation:'manage_construction_drawing',payload:{asset_id:row.id,row_version:row.row_version,action:'update',title:value('title'),description:value('description'),contract_service_type_id:value('service')||null,category:{building:value('building'),floor:value('floor'),area:value('area')}}});}
      finally{box.inert=false;}
      await refreshConstructionDrawings();showToast('工程圖資訊已更新。');
    }else{
      const markers=Object.keys(row.drawing_markers||{});
      if(!confirm(`刪除工程圖「${drawingTitle(row)}」？${markers.length?`\n此圖已定位 ${markers.length} 台設備（${markers.slice(0,8).join('、')}${markers.length>8?' 等':''}），刪除後這些設備會回到「待配置」。`:''}\n系統只會將工程圖標示為已刪除並保留紀錄與 NAS 原檔，施工日誌與設備進度不受影響。`))return;
      if(activeDrawingAnnotation?.row?.id===row.id)closeDrawingAnnotations();
      await apiRequest({operation:'manage_construction_drawing',payload:{asset_id:row.id,row_version:row.row_version,action:'archive',confirm_markers:markers.length>0}});
      await refreshConstructionDrawings();showToast('工程圖已刪除，原檔與紀錄保留。');
    }
  }catch(error){showToast(error.message,'工程圖操作未完成');}
});

async function refreshConstructionDrawings() {
  const request = ++constructionDrawingRequest;
  const planId = constructionDrawingContext?.construction_plan_id;
  const session = constructionDrawingSession;
  if (!planId) return;
  const status = document.querySelector('#constructionDrawingStatus');
  const gallery=[...document.querySelectorAll('#drawingPager,#drawingAnnotationViewer,#constructionDrawingList')];
  for(const part of gallery)part.inert=true;
  if (status) status.textContent = '正在讀取工程圖…';
  try {
    const data = await projectDrawingContext(constructionDrawingContext.project_id,planId);
    if (constructionDrawingSession !== session || request !== constructionDrawingRequest || constructionDrawingContext?.construction_plan_id !== planId) return;
    const previous=activeDrawingAnnotation?.row?.id;
    closeDrawingAnnotations();
    constructionDrawingContext = data;
    renderConstructionDrawings();
    startDrawingGallery(previous);
    if (status) status.textContent = `共 ${data.drawings?.length || 0} 份工程圖`;
    const upload = document.querySelector('.construction-drawing-upload');
    if (upload && !data.can_upload) upload.hidden = true;
  } catch (error) {
    if (constructionDrawingSession === session && status) status.textContent = `工程圖清單讀取失敗：${error.message}`;
    throw error;
  } finally {if(request===constructionDrawingRequest)for(const part of gallery)part.inert=false;}
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
  startDrawingGallery();
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
  activeDrawingAnnotation?.cleanup?.();
  activeDrawingAnnotation=null;
  const host=document.querySelector('#drawingAnnotationViewer');
  if(host){host.hidden=true;host.classList.remove('is-pseudo-fullscreen');host.replaceChildren();}
  if(document.fullscreenElement?.id==='drawingAnnotationViewer')document.exitFullscreen?.().catch(()=>{});
}

// 點位示意圖（整合原「待配置設備」）：顯示本案全部設備（依承攬類型篩選），依工程圖分組，
// 未指定工程圖的設備列在「待配置」；可切換只看待配置設備。
function showDrawingGrid(_row,{waiting=false}={}) {
  closeDrawingAnnotations();
  const host=document.querySelector('#drawingAnnotationViewer');
  const codes=projectCodes().filter(serviceMatchesCode),progress=drawingProgressByCode(constructionDrawingContext.plans);
  const unplaced=codes.filter(code=>!drawingPlacements(code).length);
  const view={host,abort:new AbortController(),lookup:0,waiting};
  activeDrawingAnnotation=view;
  drawPager(null);
  host.hidden=false;
  const groups=waiting?[]:drawingPages().map(row=>({row,codes:codes.filter(code=>drawingAssigned(row,code))})).filter(g=>g.codes.length)
    .sort((a,b)=>drawingTitle(a.row).localeCompare(drawingTitle(b.row),'zh-Hant',{numeric:true}));
  const section=(title,meta,list,action)=>`<section class="drawing-overview-group"><div class="drawing-overview-head"><h4>${esc(title)}<small>${esc(meta)}</small></h4>${action}</div>${drawingPointGrid(list,progress,null)}</section>`;
  host.innerHTML=`<div class="construction-drawing-toolbar"><h3>點位示意圖</h3><div class="drawing-overview-filter" role="group" aria-label="顯示範圍"><button type="button" class="outline" data-overview-mode="all" aria-pressed="${!waiting}">全部設備（${codes.length}）</button><button type="button" class="outline" data-overview-mode="waiting" aria-pressed="${waiting}">待配置（${unplaced.length}）</button></div><button type="button" class="outline" data-marker-close>收合示意圖</button></div>
    <p class="form-sync-hint">${waiting?'以下設備尚未指定到任何工程圖。開啟工程圖後，可在「指定本圖設備」加入，或在圖上設定位置。':'依工程圖分組；同一台設備可出現在多張工程圖。點選圖示或編號可查看工項進度。'}</p>
    ${drawingLegend()}<div class="drawing-canvas">${groups.map(g=>section(drawingTitle(g.row),[drawingCategoryText(g.row),drawingService(g.row)?.name,`${g.codes.length} 台`].filter(Boolean).join('・'),g.codes,`<button type="button" class="outline" data-drawing-default="${esc(g.row.id)}">開啟工程圖</button>`)).join('')}
    ${unplaced.length?section('待配置（尚未指定工程圖）',`${unplaced.length} 台`,unplaced,''):(waiting?'<p class="dashboard-empty">所有設備都已指定工程圖。</p>':'')}
    ${!codes.length?'<p class="dashboard-empty">此承攬類型尚無設備。</p>':''}<aside class="drawing-note" hidden role="status"></aside></div>`;
}

// 設備清單面板：只列本圖顯示的設備（已定位／未定位），可搜尋；點選即定位或選為設定點位的對象。
function updateGalleryPointList(view){
  const list=view.host.querySelector('.gallery-point-list');
  if(!list)return;
  const located=view.codes.filter(code=>Object.hasOwn(view.row.drawing_markers||{},code));
  const waiting=view.codes.filter(code=>!Object.hasOwn(view.row.drawing_markers||{},code));
  const keyword=(list.querySelector('[data-panel-search]')?.value||'').trim().toLowerCase();
  const match=code=>{if(!keyword)return true;const {point}=drawingPoint(code);return [point.code,point.name,point.type,point.location,point.building].some(v=>String(v||'').toLowerCase().includes(keyword));};
  const roster=(drawingPlan(view.row)?.drawing_points||[]).length;
  const filtered=!Array.isArray(view.row.drawing_codes)&&view.codes.length<roster;
  list.querySelector('[data-panel-count]').textContent=`本圖 ${view.codes.length} 台（${Array.isArray(view.row.drawing_codes)?`清冊 ${roster} 台`:filtered?`未指定，依承攬類型篩選清冊 ${roster} 台`:'未指定，顯示清冊全部'}）・已定位 ${located.length}`;
  list.querySelector('[data-panel-located]').innerHTML=located.filter(match).length?drawingPointGrid(located.filter(match),view.progress,view.row):'<p class="form-sync-hint">本圖尚未定位設備。</p>';
  list.querySelector('[data-panel-waiting]').innerHTML=waiting.filter(match).length?drawingPointGrid(waiting.filter(match),view.progress,view.row):'<p class="form-sync-hint">本圖設備都已定位。</p>';
  const assign=view.host.querySelector('[data-drawing-assign-summary]');
  if(assign)assign.textContent=Array.isArray(view.row.drawing_codes)?`已指定 ${view.codes.length} 台設備顯示在本圖。`
    :filtered?`尚未指定：本圖依承攬類型「${drawingService(view.row)?.name||''}」顯示「${drawingPlan(view.row)?.content||''}」清冊中的 ${view.codes.length} 台（類型不符的設備不顯示）。`
    :`尚未指定：本圖顯示「${drawingPlan(view.row)?.content||''}」清冊全部 ${roster} 台。`;
}
// 依工程圖分類（建築物／樓層）建議本圖設備：設備的建築物、設置區域含相同文字。
function suggestDrawingCodes(row){
  const c=row.drawing_category||{},words=[c.floor,c.area].filter(Boolean).map(w=>String(w).toLowerCase());
  if(!words.length)return [];
  const service=row.contract_service_type_id;
  return (drawingPlan(row)?.drawing_points||[]).filter(p=>{
    const ids=typeServiceIds(p.code);if(service&&ids.size&&!ids.has(service))return false;
    const place=[p.location,p.name].map(v=>String(v||'').toLowerCase()).join(' ');
    return words.every(w=>place.includes(w))&&(!c.building||!p.building||String(p.building).toLowerCase().includes(String(c.building).toLowerCase()));
  }).map(p=>p.code);
}
function drawingAssignPanel(row){
  const suggestion=suggestDrawingCodes(row);
  return `<details class="drawing-locator-settings drawing-assign"><summary>指定本圖設備</summary><div class="drawing-assign-body">
    <p data-drawing-assign-summary></p>
    <label>設備編號區間<span class="roster-range"><input data-assign-from placeholder="CAM10" maxlength="80" aria-label="起始編號"><span aria-hidden="true">～</span><input data-assign-to placeholder="CAM50" maxlength="80" aria-label="結束編號"></span></label>
    <div class="construction-plan-actions"><button type="button" class="primary" data-drawing-assign="add">加入本圖</button><button type="button" class="outline" data-drawing-assign="remove">自本圖移出</button>${suggestion.length?`<button type="button" class="outline" data-drawing-assign="suggest">依樓層帶入（${suggestion.length} 台）</button>`:''}<button type="button" class="outline" data-drawing-assign="reset">改為顯示清冊全部</button></div>
    <small>例如 1F 平面圖指定 CAM10～CAM50，2F 平面圖指定 CAM60～CAM88；其他樓層的設備不會顯示在本圖，可翻頁到對應工程圖查看。圖上已定位的設備會保留。</small></div></details>`;
}
function paintDrawingMarkers(view) {
  updateGalleryPointList(view);
  const layer=view.host.querySelector('.drawing-markers');
  layer.replaceChildren();
  for(const [code,pos] of Object.entries(view.row.drawing_markers || {})){
    if(!view.codes.includes(code))continue;
    const key=view.progress.get(code)||'pending';
    for(const [kind,anchor] of [['icon',pos],['label',pos.label]]){
      if(!Number.isFinite(anchor?.x)||!Number.isFinite(anchor.y))continue;
      const button=document.createElement('button');
      button.type='button';button.className='drawing-marker';button.dataset.markerCode=code;button.dataset.anchor=kind;
      button.title=code+' · '+drawingProgressLabels[key];button.dataset.pointState=key;button.setAttribute('aria-label',code+(kind==='label'?' 編號':' 圖示')+' · '+drawingProgressLabels[key]);
      button.style.left=(anchor.x*100)+'%';button.style.top=(anchor.y*100)+'%';
      if(kind==='icon'){const icon=document.createElement('img');icon.alt='';icon.src=drawingIcon(code,view.row);button.append(icon);}
      const tag=document.createElement('span');tag.textContent=code;button.append(tag);
      if(code===view.highlight)button.classList.add('is-highlight');
      layer.append(button);
    }
  }
}

/* ---------- 工程圖檢視：縮放、拖曳、雙指縮放、適應視窗、全螢幕 ---------- */
function drawingZoomApply(view){
  const z=view.zoom;if(!z?.fit)return;
  z.scale=Math.max(z.fit*0.5,Math.min(z.fit*12,z.scale));
  view.stage.style.transform=`translate(${z.x}px,${z.y}px) scale(${z.scale})`;
  view.stage.style.setProperty('--marker-scale',String(1/z.scale));
  const label=view.host.querySelector('[data-zoom-level]');if(label)label.textContent=Math.round(z.scale/z.fit*100)+'%';
}
function drawingFit(view){
  const z=view.zoom,box=view.viewport.getBoundingClientRect();
  if(!z.width||!box.width||!box.height)return;
  z.fit=Math.min(box.width/z.width,box.height/z.height);z.scale=z.fit;
  z.x=(box.width-z.width*z.scale)/2;z.y=(box.height-z.height*z.scale)/2;
  drawingZoomApply(view);
}
function drawingZoomAt(view,factor,cx,cy){
  const z=view.zoom,old=z.scale;z.scale=old*factor;drawingZoomApply(view);
  const ratio=z.scale/old;z.x=cx-(cx-z.x)*ratio;z.y=cy-(cy-z.y)*ratio;drawingZoomApply(view);
}
function initDrawingViewport(view){
  const viewport=view.viewport,z=view.zoom={scale:1,x:0,y:0,fit:0,width:0,height:0};
  const img=view.stage.querySelector('img');
  img.addEventListener('load',()=>{z.width=img.naturalWidth;z.height=img.naturalHeight;view.stage.style.width=z.width+'px';view.stage.style.height=z.height+'px';drawingFit(view);if(view.pendingFocus){focusDrawingMarker(view,view.pendingFocus);view.pendingFocus=null;}},{once:true});
  const pointers=new Map();let start=null;
  viewport.addEventListener('wheel',event=>{event.preventDefault();const r=viewport.getBoundingClientRect();drawingZoomAt(view,event.deltaY<0?1.2:1/1.2,event.clientX-r.left,event.clientY-r.top);},{passive:false});
  viewport.addEventListener('pointerdown',event=>{
    if(event.pointerType==='mouse'&&event.button!==0)return;
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    start={x:z.x,y:z.y,scale:z.scale,points:new Map([...pointers].map(([k,v])=>[k,{...v}])),moved:false};
  });
  viewport.addEventListener('pointermove',event=>{
    if(!pointers.has(event.pointerId)||!start)return;
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    const r=viewport.getBoundingClientRect();
    if(pointers.size===1){
      const begin=start.points.get(event.pointerId);if(!begin)return;
      const dx=event.clientX-begin.x,dy=event.clientY-begin.y;
      if(!start.moved&&Math.hypot(dx,dy)<6)return;
      if(!start.moved){start.moved=true;viewport.setPointerCapture?.(event.pointerId);viewport.classList.add('is-dragging');}
      z.x=start.x+dx;z.y=start.y+dy;drawingZoomApply(view);
    }else if(pointers.size===2){
      const [a,b]=[...pointers.values()],[a0,b0]=[...start.points.values()];if(!a0||!b0)return;
      start.moved=true;
      const ratio=Math.hypot(a.x-b.x,a.y-b.y)/Math.max(1,Math.hypot(a0.x-b0.x,a0.y-b0.y));
      const mid0={x:(a0.x+b0.x)/2-r.left,y:(a0.y+b0.y)/2-r.top},mid={x:(a.x+b.x)/2-r.left,y:(a.y+b.y)/2-r.top};
      z.scale=start.scale*ratio;drawingZoomApply(view);
      const k=z.scale/start.scale;z.x=mid.x-(mid0.x-start.x)*k;z.y=mid.y-(mid0.y-start.y)*k;drawingZoomApply(view);
    }
  });
  const end=event=>{
    if(!pointers.has(event.pointerId))return;
    pointers.delete(event.pointerId);
    if(start?.moved){view.suppressClick=Date.now();viewport.classList.remove('is-dragging');}
    start=pointers.size?{x:z.x,y:z.y,scale:z.scale,points:new Map([...pointers].map(([k,v])=>[k,{...v}])),moved:true}:null;
  };
  viewport.addEventListener('pointerup',end);viewport.addEventListener('pointercancel',end);
  const resize=new ResizeObserver(()=>{if(view.autoFit!==false)drawingFit(view);});
  resize.observe(viewport);
  const fullscreen=()=>{view.autoFit=true;requestAnimationFrame(()=>drawingFit(view));const b=view.host.querySelector('[data-drawing-fullscreen]');if(b)b.textContent=document.fullscreenElement===view.host||view.host.classList.contains('is-pseudo-fullscreen')?'離開全螢幕':'全螢幕';};
  document.addEventListener('fullscreenchange',fullscreen);
  view.cleanup=()=>{resize.disconnect();document.removeEventListener('fullscreenchange',fullscreen);};
}
function focusDrawingMarker(view,code){
  const pos=view.row.drawing_markers?.[code],z=view.zoom;
  if(!pos)return false;
  view.highlight=code;paintDrawingMarkers(view);
  if(!z?.fit){view.pendingFocus=code;return true;}
  const box=view.viewport.getBoundingClientRect();
  view.autoFit=false;z.scale=Math.max(z.scale,z.fit*2.5);
  z.x=box.width/2-pos.x*z.width*z.scale;z.y=box.height/2-pos.y*z.height*z.scale;drawingZoomApply(view);
  const marker=view.host.querySelector(`[data-marker-code="${CSS.escape(code)}"][data-anchor="icon"]`)||view.host.querySelector(`[data-marker-code="${CSS.escape(code)}"]`);
  marker?.focus({preventScroll:true});
  const status=view.host.querySelector('[data-marker-status]');if(status)status.textContent=`已定位並標示 ${code}。`;
  return true;
}
async function toggleDrawingFullscreen(view){
  const host=view.host;
  if(document.fullscreenElement===host){await document.exitFullscreen();return;}
  if(host.classList.contains('is-pseudo-fullscreen')){host.classList.remove('is-pseudo-fullscreen');document.dispatchEvent(new Event('fullscreenchange'));return;}
  if(host.requestFullscreen&&document.fullscreenEnabled!==false){try{await host.requestFullscreen();return;}catch{}}
  // iOS Safari 等不支援元素全螢幕時，以覆蓋整個視窗的版面代替。
  host.classList.add('is-pseudo-fullscreen');document.dispatchEvent(new Event('fullscreenchange'));
}

async function showDrawingAnnotation(id) {
  const ctx=constructionDrawingContext, row=ctx.drawings.find(r=>r.id===id);
  if(!row)throw Error('請重新讀取工程圖。');
  const keepFullscreen=document.fullscreenElement?.id==='drawingAnnotationViewer'||document.querySelector('#drawingAnnotationViewer.is-pseudo-fullscreen');
  activeDrawingAnnotation?.abort.abort();activeDrawingAnnotation?.cleanup?.();activeDrawingAnnotation=null;
  const host=document.querySelector('#drawingAnnotationViewer'), plan=ctx.plans.find(p=>p.id===row.construction_plan_id);
  if(!keepFullscreen){host.classList.remove('is-pseudo-fullscreen');}
  const codes=drawingCodes(row);
  const editable=ctx.contexts.some(c=>c.construction_plan_id===plan?.id && c.can_upload);
  drawPager(id);
  const view={host,row,codes,progress:drawingProgressByCode(ctx.plans),abort:new AbortController(),pending:false,lookup:0};
  activeDrawingAnnotation=view;host.hidden=false;host.textContent='正在讀取工程圖…';
  try {
    const response=await fetch(NAS_API_ENDPOINT+'?mode=drawing&asset_id='+encodeURIComponent(id),{headers:{Authorization:'Bearer '+accessToken},cache:'no-store',signal:view.abort.signal});
    if(!response.ok)throw Error('無法讀取工程圖，請重新確認登入及權限。');
    const blob=await response.blob();
    if(!['image/jpeg','image/png','image/webp'].includes(blob.type.split(';')[0]))throw Error('點位檢視支援 JPG、PNG、WebP。');
    const src=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});
    if(view!==activeDrawingAnnotation || !host.isConnected)return;
    host.innerHTML=`<div class="construction-drawing-toolbar drawing-viewer-toolbar"><h3>${esc(drawingTitle(row))}${drawingCategoryText(row)?`<small>${esc(drawingCategoryText(row))}</small>`:''}</h3>
        <div class="drawing-zoom-controls" role="group" aria-label="工程圖檢視"><button type="button" class="outline" data-drawing-zoom-out aria-label="縮小">－</button><output data-zoom-level>100%</output><button type="button" class="outline" data-drawing-zoom-in aria-label="放大">＋</button><button type="button" class="outline" data-drawing-fit>適應視窗</button><button type="button" class="outline" data-drawing-reset>重設視角</button><button type="button" class="outline" data-drawing-fullscreen>全螢幕</button><button type="button" class="outline" data-drawing-panel aria-expanded="true">設備清單</button><button type="button" class="outline" data-marker-close>收合工程圖</button></div></div>
      ${drawingLegend()}
      ${editable&&plan?.drawing_points?.length?drawingAssignPanel(row):''}
      ${editable&&codes.length?`<details class="drawing-locator-settings"><summary>設定原圖點位</summary><fieldset class="drawing-locator"><legend>設定原圖點位</legend><label>設備編號<select data-marker-select><option value="">請選擇編號</option>${codes.map(c=>`<option value="${esc(c)}">${esc(equipmentLabel(drawingPoint(c).point))}</option>`).join('')}</select></label><label>定位對象<select data-marker-kind><option value="pair">編號 → 設備圖示</option><option value="icon">設備圖示</option><option value="label">圖上的編號</option></select></label>
        <small>選擇設備後，先點圖上的編號，再點同一台設備的圖示。若圖上只有其中一種標記，可切換定位對象。拖曳可移動工程圖，不會誤設點位。</small><button type="button" class="outline danger" data-marker-remove>移除所選定位</button></fieldset></details>`:''}
      <div class="drawing-workspace"><div class="drawing-canvas"><div class="drawing-viewport" tabindex="0" aria-label="工程圖：滾輪或雙指縮放，拖曳移動"><div class="drawing-stage"><img alt="工程圖" draggable="false"><div class="drawing-markers"></div></div></div><aside class="drawing-note" hidden role="status"></aside></div>
      <aside class="gallery-point-list drawing-side-panel"><div class="drawing-panel-head"><b>設備清單</b><small data-panel-count></small></div><label>搜尋<input type="search" data-panel-search placeholder="編號、名稱、類型"></label><details open><summary>本圖已定位</summary><div data-panel-located></div></details><details open><summary>本圖未定位</summary><div data-panel-waiting></div></details></aside></div>
      <output aria-live="polite" data-marker-status></output>`;
    view.viewport=host.querySelector('.drawing-viewport');view.stage=host.querySelector('.drawing-stage');
    initDrawingViewport(view);
    host.querySelector('.drawing-stage img').src=src;paintDrawingMarkers(view);
    const count=Object.keys(row.drawing_markers||{}).filter(c=>codes.includes(c)).length;
    host.querySelector('[data-marker-status]').textContent=`已定位 ${count}／${codes.length}。點選標記可查看施工進度；滾輪或雙指縮放、拖曳移動。`;
  }catch(error){if(view===activeDrawingAnnotation){host.textContent='工程圖讀取失敗。';throw error;}}
}

async function openMarkerNote(view,code,pos){
  const seq=++view.lookup, note=view.host.querySelector('.drawing-note');
  note.hidden=false;note.textContent='正在讀取日誌進度…';
  // 原圖檢視可縮放移動，進度說明固定在檢視區角落；示意圖維持貼近點選的設備。
  const docked=!!note.closest('.drawing-workspace');
  note.classList.toggle('is-docked',docked);
  if(docked){note.style.left='';note.style.top='';note.classList.remove('above');}
  else{note.style.left=Math.min(pos.x*100,65)+'%';note.style.top=(pos.y*100)+'%';note.classList.toggle('above',pos.y>.55);}
  try {
    const data=await apiRequest({method:'GET',scope:'construction_plans',projectId:constructionDrawingContext.project_id});
    if(activeDrawingAnnotation!==view||seq!==view.lookup)return;
    const latestProgress=drawingProgressByCode(data.construction_plans||[]);
    for(const element of view.host.querySelectorAll('[data-grid-code],[data-marker-code]')){
      const device=element.dataset.gridCode||element.dataset.markerCode,key=latestProgress.get(device)||'pending';
      element.dataset.pointState=key;
      if(element.dataset.gridCode)element.querySelector('small').textContent=drawingProgressLabels[key];
      else {element.title=device+' · '+drawingProgressLabels[key];element.setAttribute('aria-label',element.title);}
    }
    view.progress=latestProgress;
    const visible=(data.construction_plans||[]).filter(p=>p.drawing_points?.some(pt=>pt.code===code));
    const point=visible[0]?.drawing_points.find(pt=>pt.code===code)||{code};
    const places=drawingPlacements(code).filter(r=>r.id!==view.row?.id);
    const placeLine=view.row?(places.length?`<p class="drawing-note-places">也在：${places.map(r=>`<button type="button" class="link-button" data-drawing-default="${esc(r.id)}">${esc(drawingTitle(r))}</button>`).join('、')}</p>`:'')
      :`<p class="drawing-note-places">${places.length?`工程圖：${places.map(r=>`<button type="button" class="link-button" data-drawing-default="${esc(r.id)}">${esc(drawingTitle(r))}</button>`).join('、')}`:'尚未指定工程圖（待配置）'}</p>`;
    note.innerHTML=`<div><strong>${esc(code)}</strong> <button type="button" class="outline" data-note-close aria-label="關閉註解">×</button></div>${[point.name,point.type,point.model,point.location,point.building].filter(Boolean).length?`<p>${esc([point.name,point.type,point.model,point.location,point.building].filter(Boolean).join(' · '))}</p>`:''}${placeLine}`+
      visible.map(p=>`<strong>${esc(p.content)}</strong><ul>${(p.items||[]).filter(i=>itemAppliesTo(i,code,p)||(p.equipment_state||[]).some(e=>e.code===code&&e.item===i.id)).map(i=>{
        const record=(p.equipment_state||[]).find(e=>e.code===code&&e.item===i.id);
        return `<li>${esc(i.title)}　${esc(equipmentStates[record?.status]||'未填報')}${record?.log_date?`（${esc(record.log_date)}）`:''}</li>`;
      }).join('')||'<li>未指派施工子項目</li>'}</ul>`).join('');
  }catch(error){if(activeDrawingAnnotation===view&&seq===view.lookup)note.textContent=error.message;}
}

document.addEventListener('keydown',event=>{
  if(event.key!=='Enter'||!event.target.matches?.('[data-device-search],[data-drawing-filter],[data-panel-search],[data-drawing-edit] input'))return;
  event.preventDefault();
  if(event.target.matches('[data-device-search]')){const first=event.target.closest('.drawing-device-search').querySelector('[data-locate-device]');if(first)first.click();}
});
document.addEventListener('input',event=>{
  if(!event.target.matches('[data-panel-search]'))return;
  const view=activeDrawingAnnotation;if(view?.row&&view.host.contains(event.target))updateGalleryPointList(view);
});

document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-drawing-annotate]');
  const view=activeDrawingAnnotation;
  try{
    const open=event.target.closest('[data-drawing-default]');
    const jump=event.target.closest('[data-drawing-page]');
    if(jump){await showDrawingAnnotation(jump.dataset.drawingPage);return;}
    if(open){
      const row=constructionDrawingContext.drawings.find(file=>file.id===open.dataset.drawingDefault);
      if(!row)throw Error('請重新讀取工程圖。');
      await showDrawingAnnotation(row.id);
      return;
    }
    if(event.target.closest('[data-drawing-grid]')){showDrawingGrid();return;}
    if(button){await showDrawingAnnotation(button.dataset.drawingAnnotate);return;}
    if(!view?.host.contains(event.target))return;
    if(view.zoom){
      const box=()=>view.viewport.getBoundingClientRect();
      if(event.target.closest('[data-drawing-zoom-in]')){view.autoFit=false;drawingZoomAt(view,1.4,box().width/2,box().height/2);return;}
      if(event.target.closest('[data-drawing-zoom-out]')){view.autoFit=false;drawingZoomAt(view,1/1.4,box().width/2,box().height/2);return;}
      if(event.target.closest('[data-drawing-fit]')){view.autoFit=true;drawingFit(view);return;}
      if(event.target.closest('[data-drawing-reset]')){view.autoFit=true;view.highlight=null;paintDrawingMarkers(view);drawingFit(view);return;}
      if(event.target.closest('[data-drawing-fullscreen]')){await toggleDrawingFullscreen(view);return;}
      const panel=event.target.closest('[data-drawing-panel]');
      if(panel){const hidden=view.host.classList.toggle('is-panel-hidden');panel.setAttribute('aria-expanded',String(!hidden));requestAnimationFrame(()=>{if(view.autoFit!==false)drawingFit(view);});return;}
    }
    if(event.target.closest('[data-marker-close]')){closeDrawingAnnotations();return;}
    const overview=event.target.closest('[data-overview-mode]');
    if(overview){showDrawingGrid(null,{waiting:overview.dataset.overviewMode==='waiting'});return;}
    const assignButton=event.target.closest('[data-drawing-assign]');
    if(assignButton&&view.row){
      if(view.pending)return;
      const mode=assignButton.dataset.drawingAssign,roster=(drawingPlan(view.row)?.drawing_points||[]).map(p=>p.code);
      const explicit=Array.isArray(view.row.drawing_codes),current=explicit?view.row.drawing_codes:[];
      let picked=[];
      if(mode==='add'||mode==='remove'){
        const from=view.host.querySelector('[data-assign-from]').value.trim(),to=view.host.querySelector('[data-assign-to]').value.trim()||from;
        if(!from){showToast('請輸入設備編號或區間。');return;}
        picked=equipmentCodeRange(roster,from,to);
        if(!picked.length){showToast('區間內沒有清冊設備。');return;}
      }else if(mode==='suggest')picked=suggestDrawingCodes(view.row);
      const codes=mode==='reset'?null:mode==='remove'?(explicit?current:roster).filter(c=>!picked.includes(c)):[...new Set([...current,...picked])];
      const title=drawingTitle(view.row);
      const message=mode==='reset'?`「${title}」改為顯示「${drawingPlan(view.row)?.content}」清冊全部 ${roster.length} 台設備？`
        :mode==='remove'?`自「${title}」移出 ${picked.length} 台設備（${picked.slice(0,6).join('、')}${picked.length>6?' 等':''}）？圖上已定位的設備會保留。`
        :`將 ${picked.length} 台設備（${picked.slice(0,6).join('、')}${picked.length>6?' 等':''}）指定顯示在「${title}」？${explicit?'':`\n目前本圖顯示清冊全部 ${roster.length} 台；指定後只顯示指定的設備與圖上已定位的設備。`}`;
      if(!confirm(message))return;
      view.pending=true;
      try{
        const latest=(await apiRequest({method:'GET',scope:'construction_drawings',planId:view.row.construction_plan_id})).drawings?.find(d=>d.id===view.row.id);
        if(!latest){await refreshConstructionDrawings();throw Error('工程圖已被刪除或變更，清單已重新讀取。');}
        const saved=(await apiRequest({operation:'assign_construction_drawing_equipment',payload:{asset_id:view.row.id,row_version:latest.row_version,codes}})).result;
        Object.assign(view.row,saved);
      }finally{view.pending=false;}
      renderConstructionDrawings();await showDrawingAnnotation(view.row.id);
      const status=document.querySelector('#constructionDrawingStatus');
      if(status)status.textContent=`「${title}」目前顯示 ${drawingCodes(view.row).length} 台設備。`;
      showToast(`「${title}」顯示設備已更新。`);
      return;
    }
    if(event.target.closest('[data-marker-remove]')){
      const select=view.host.querySelector('[data-marker-select]'),code=select.value;
      const expected=view.row.drawing_markers?.[code];
      if(!expected){showToast('請選擇已定位的設備。');return;}
      if(view.pending||!confirm('移除這張工程圖上 '+code+' 的定位？'))return;
      view.pending=true;
      try{const data=await apiRequest({operation:'save_construction_drawing_marker',payload:{asset_id:view.row.id,code,sha256:view.row.sha256,expected,position:null}});
        view.row.drawing_markers=data.result;if(activeDrawingAnnotation===view){view.draftLabel=null;select.value='';paintDrawingMarkers(view);renderConstructionDrawings();view.host.querySelector('[data-marker-status]').textContent=code+' 已移除定位。';}
      }finally{view.pending=false;}
      return;
    }
    const note=view.host.querySelector('.drawing-note');
    if(event.target.closest('[data-note-close]')){view.lookup++;note.hidden=true;return;}
    if(event.target.closest('.drawing-note'))return;
    const cell=event.target.closest('[data-grid-code]');
    if(cell){
      const code=cell.dataset.gridCode;
      // 原圖檢視的設備清單：已定位的設備直接定位；待配置設備可選為設定點位的對象。
      if(view.row&&cell.closest('.drawing-side-panel')){
        if(Object.hasOwn(view.row.drawing_markers||{},code)&&view.codes.includes(code)){focusDrawingMarker(view,code);view.viewport.closest('.drawing-canvas').append(note);await openMarkerNote(view,code,{x:.5,y:.5});return;}
        const select=view.host.querySelector('[data-marker-select]');
        if(select){select.closest('details').open=true;select.value=code;select.dispatchEvent(new Event('change',{bubbles:true}));view.host.querySelector('[data-marker-status]').textContent=`${code} 尚未配置：請在工程圖上點選位置（依「定位對象」設定）。`;return;}
        if(await locateDevice(code))return;
      }
      if(window.matchMedia('(max-width:650px)').matches)cell.after(note);
      else cell.closest('.drawing-canvas').append(note);
      const canvas=cell.closest('.drawing-canvas').getBoundingClientRect(), bounds=cell.getBoundingClientRect();
      await openMarkerNote(view,code,{x:(bounds.right-canvas.left)/canvas.width,y:(bounds.top+bounds.height/2-canvas.top)/canvas.height});
      return;
    }
    const stage=event.target.closest('.drawing-stage');
    if(!stage||view.pending)return;
    if(view.suppressClick&&Date.now()-view.suppressClick<400){view.suppressClick=0;return;}
    const select=view.host.querySelector('[data-marker-select]'), code=select?.value;
    if(!code){
      const marker=event.target.closest('[data-marker-code]');
      if(marker){
        view.highlight=marker.dataset.markerCode;for(const m of view.host.querySelectorAll('.drawing-marker'))m.classList.toggle('is-highlight',m.dataset.markerCode===view.highlight);
        view.viewport.closest('.drawing-canvas').append(note);
        const point=view.row.drawing_markers[marker.dataset.markerCode];
        await openMarkerNote(view,marker.dataset.markerCode,marker.dataset.anchor==='label'?point.label:point);
      }
      else {view.lookup++;note.hidden=true;}
      return;
    }
    const rect=stage.getBoundingClientRect(), limit=n=>Math.max(0,Math.min(1,n));
    if(!rect.width||!rect.height)return;
    // 以工程圖原始尺寸的標準化座標（0～1）儲存，縮放、裝置或解析度不同都不會偏移。
    const anchor={x:limit((event.clientX-rect.left)/rect.width),y:limit((event.clientY-rect.top)/rect.height)};
    const kind=view.host.querySelector('[data-marker-kind]');
    const previous=Object.hasOwn(view.row.drawing_markers||{},code)?view.row.drawing_markers[code]:null;
    if(kind.value==='pair'&&!view.draftLabel){
      view.draftLabel=anchor;
      view.lookup++;note.hidden=true;
      view.host.querySelector('[data-marker-status]').textContent=code+' 已選取編號位置，請點同一台設備的圖示以儲存。';
      return;
    }
    const position=kind.value==='pair'?{...anchor,label:view.draftLabel}:kind.value==='label'?{...previous,label:anchor}:{...previous,...anchor};
    view.pending=true;select.disabled=true;kind.disabled=true;note.hidden=true;view.lookup++;
    try{
      const data=await apiRequest({operation:'save_construction_drawing_marker',payload:{asset_id:view.row.id,sha256:view.row.sha256,code,expected:previous,position}});
      if(view!==activeDrawingAnnotation)return;
      view.row.drawing_markers=data.result;view.draftLabel=null;select.value='';view.highlight=code;paintDrawingMarkers(view);renderConstructionDrawings();
      view.host.querySelector('[data-marker-status]').textContent=code+' 已定位。';
      view.viewport.closest('.drawing-canvas').append(note);
      await openMarkerNote(view,code,anchor);
    }finally{view.pending=false;select.disabled=false;kind.disabled=false;}
  }catch(error){showToast(error.message,'工程圖操作未完成');}
});

document.addEventListener('change',event=>{
  if(event.target.matches('[data-gallery-select]')){showDrawingAnnotation(event.target.value).catch(error=>showToast(error.message));return;}
  if(!event.target.matches('[data-marker-kind],[data-marker-select]'))return;
  const view=activeDrawingAnnotation;
  if(!view?.host.contains(event.target))return;
  view.draftLabel=null;
  view.lookup++;
  view.host.querySelector('.drawing-note').hidden=true;
  const code=view.host.querySelector('[data-marker-select]').value;
  const kind=view.host.querySelector('[data-marker-kind]').value;
  view.host.querySelector('[data-marker-status]').textContent=code ? code+(kind==='icon'?'：請點設備圖示。':'：請點圖上的編號。') : '點選已定位的編號或圖示，可查看施工進度。';
});

window.addEventListener('guc:session-changed',closeDrawingAnnotations);
