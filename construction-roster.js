// 施工規劃清冊（第二版）：設備基本資料、系統自動批次建立、Excel／CSV 匯入，以及設備與施工子項目的指派。
// 同一案件內「設備編號」即同一台設備；名稱、類型、型號、建築物、備註由伺服器依編號同步各施工規劃，設置區域依規劃保存。
const ROSTER_FIELDS=[['code','設備編號',80],['name','設備名稱',160],['type','設備類型',160],['model','設備型號',160],['location','設置區域',160],['building','所屬建築物',160],['note','備註',500]];
const ROSTER_HEADERS={
  code:['設備編號','編號'],name:['設備名稱','名稱'],type:['設備類型','類型'],model:['設備型號','型號'],location:['設置區域','位置','區域'],
  building:['所屬建築物','建築物'],plan:['對應施工主項目','施工主項目','施工規劃'],item:['對應施工子項目','施工子項目','子項目'],drawing:['對應工程圖','工程圖'],note:['備註']
};
const ROSTER_TEMPLATE_HEADERS=['設備編號','設備名稱','設備類型','設備型號','設置區域','所屬建築物','對應施工主項目','對應施工子項目','對應工程圖','備註'];

function rosterPointFrom(values,existing={}){
  const point={...existing};
  for(const [key,label,limit] of ROSTER_FIELDS){
    const value=String(values[key]??'').trim();
    if(value.length>limit||/[\u0000-\u001f\u007f]/.test(value))throw Error(`${label}格式錯誤或超過 ${limit} 字。`);
    if(key==='code'||key==='location')point[key]=value;
    else if(value||Object.hasOwn(existing,key))point[key]=value;
  }
  if(!point.code)throw Error('請輸入設備編號。');
  return point;
}
// 由「適用全部」改為指定設備時，保留已有施工紀錄的設備，與伺服器規則一致。
function itemAssignmentBase(plan,item){
  if(Array.isArray(item.equipment_codes))return item.equipment_codes;
  return [...new Set((plan.equipment_state||[]).filter(e=>e.item===item.id).map(e=>e.code))];
}
function rosterRelations(plan,code){
  const items=(plan.items||[]).filter(item=>Array.isArray(item.equipment_codes)&&item.equipment_codes.includes(code)).map(i=>i.title);
  const records=(plan.equipment_state||[]).filter(e=>e.code===code);
  return {items,records};
}
function rosterMatches(point,keyword,plan){
  if(!keyword)return true;
  const items=(plan.items||[]).filter(item=>Array.isArray(item.equipment_codes)&&item.equipment_codes.includes(point.code)).map(i=>i.title);
  return [point.code,point.name,point.type,point.model,point.location,point.building,point.note,...items].some(v=>String(v||'').toLowerCase().includes(keyword));
}

/* ---------- Excel／CSV 匯入解析與驗證（寫入前完整預覽） ---------- */
function rosterHeaderIndex(headers){
  const index={};
  for(const [key,aliases] of Object.entries(ROSTER_HEADERS)){
    const at=headers.findIndex(h=>aliases.includes(h));
    if(at>=0)index[key]=at;
  }
  return index;
}
async function readRosterFile(file){
  if(file.size>5*1024*1024)throw Error('清冊檔案請小於 5 MB。');
  if(/\.xlsx$/i.test(file.name)){
    const {rows}=await GucWorkbookReader.readSheet(file,{maxRows:1001,maxColumns:20,maxBytes:5*1024*1024});
    return rows.map(row=>Array.from(row||[],v=>String(v??'').trim()));
  }
  const text=(await file.text()).replace(/^﻿/,'');
  const first=text.split(/\r?\n/,1)[0]||'';
  if(!/設備編號|編號/.test(first)){
    // 舊格式（無標題的「設備編號,位置,設備名稱」）沿用既有解析規則。
    return [['設備編號','設置區域','設備名稱'],...parseDrawingPoints(text).map(p=>[p.code,p.location,p.name||''])];
  }
  const delimiter=first.includes('\t')?'\t':',';
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;continue;}
    if(c==='"'&&!cell)quoted=true;
    else if(c===delimiter){row.push(cell.trim());cell='';}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell.trim());rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  if(cell||row.length){row.push(cell.trim());rows.push(row);}
  return rows;
}
function validateRosterImport(rows,{plans,current}){
  const headers=(rows[0]||[]).map(h=>String(h).trim()),index=rosterHeaderIndex(headers);
  if(index.code===undefined)throw Error('第一列須包含「設備編號」欄。可下載範本參考欄位。');
  const seen=new Set(),result=[];
  for(const [i,raw] of rows.slice(1).entries()){
    if(!raw.some(v=>String(v||'').trim()))continue;
    if(result.length>=1000)throw Error('每次最多匯入 1000 筆設備。');
    const line=i+2,cell=key=>index[key]===undefined?'':String(raw[index[key]]??'').trim(),errors=[];
    const planName=cell('plan'),plan=planName?plans.find(p=>p.content===planName):current;
    if(!plan)errors.push(`找不到施工主項目「${planName}」`);
    else if(!plan.can_manage)errors.push(`沒有「${plan.content}」的清冊管理權限`);
    const existing=plan?.drawing_points?.find(p=>p.code.toLowerCase()===cell('code').toLowerCase());
    let point=null;
    try{point=rosterPointFrom(Object.fromEntries(ROSTER_FIELDS.map(([key])=>[key,key==='location'&&index.location===undefined&&existing?existing.location:cell(key)])),existing||{});}
    catch(error){errors.push(error.message);}
    if(existing&&point&&existing.code!==point.code)errors.push('設備編號大小寫與清冊不同');
    const key=(plan?.id||'')+'\0'+cell('code').toLowerCase();
    if(cell('code')&&seen.has(key))errors.push('檔案內設備編號重複');
    seen.add(key);
    const itemNames=cell('item').split(/[、,，;；\n]/).map(s=>s.trim()).filter(Boolean),items=[];
    for(const name of itemNames){const item=plan?.items?.find(it=>it.title===name);if(item)items.push(item);else errors.push(`找不到施工子項目「${name}」`);}
    const changed=existing&&point?ROSTER_FIELDS.some(([k])=>(existing[k]||'')!==(point[k]||'')):true;
    result.push({line,plan,point,existing,items,drawing:cell('drawing'),errors,action:errors.length?'錯誤':existing?(changed?'更新':'不變'):'新增'});
  }
  if(!result.length)throw Error('檔案沒有設備資料。');
  return result;
}

async function openConstructionRoster(projectId){
  const dialog=document.createElement('dialog');
  dialog.className='matrix-import-dialog project-roster roster-v2';
  dialog.setAttribute('aria-label','施工規劃清冊');
  dialog.innerHTML=`<div class="construction-drawing-toolbar"><h2>施工規劃清冊</h2><button type="button" class="outline" data-roster-close>關閉</button></div>
    <div class="roster-top"><label>施工規劃（施工主項目）<select data-roster-plan></select></label><label>搜尋設備<input type="search" data-roster-search placeholder="編號、名稱、類型、區域、建築物、子項目"></label></div>
    <datalist id="rosterTypeOptions">${EQUIPMENT_TYPE_SUGGESTIONS.map(t=>`<option value="${esc(t)}">`).join('')}</datalist>
    <div data-roster-body></div><output role="status" aria-live="polite"></output>`;
  document.body.append(dialog);
  dialog.showModal();
  const status=dialog.querySelector('output'),picker=dialog.querySelector('[data-roster-plan]'),body=dialog.querySelector('[data-roster-body]'),search=dialog.querySelector('[data-roster-search]');
  let plans=[],busy=false,editing=null,selected=new Set(),itemFilter='',importRows=null,openPanels=new Set();
  const plan=()=>plans.find(p=>p.id===picker.value);
  const versions=()=>Object.fromEntries(plans.map(p=>[p.id,p.row_version]));
  const visiblePoints=()=>{
    const current=plan(),keyword=search.value.trim().toLowerCase(),item=current?.items?.find(i=>i.id===itemFilter);
    return (current?.drawing_points||[]).filter(p=>rosterMatches(p,keyword,current)&&(!item||(Array.isArray(item.equipment_codes)?item.equipment_codes.includes(p.code):true)));
  };
  function itemChips(current){
    const items=current.items||[];
    if(!items.length)return '<p class="form-sync-hint">此施工規劃尚未建立子項目；可先在「修改規劃」新增子項目，再指派設備。</p>';
    return `<div class="roster-item-chips" role="group" aria-label="依施工子項目篩選"><button type="button" class="outline" data-roster-item-filter="" aria-pressed="${!itemFilter}">全部設備</button>${items.map(item=>`<button type="button" class="outline" data-roster-item-filter="${esc(item.id)}" aria-pressed="${itemFilter===item.id}">${esc(item.title)}<small>${Array.isArray(item.equipment_codes)?`指派 ${item.equipment_codes.length} 台`:'適用全部'}</small></button>`).join('')}</div>`;
  }
  function singleForm(current){
    return `<details class="roster-panel" data-panel="single" ${openPanels.has('single')||editing?'open':''}><summary>${editing?'修改設備資料':'新增單筆設備'}</summary><form class="roster-editor" data-form="single">
      ${ROSTER_FIELDS.map(([key,label,limit])=>`<label${key==='note'?' class="span-all"':''}>${label}<input name="${key}" maxlength="${limit}" ${key==='code'?'required':''} ${key==='type'?'list="rosterTypeOptions"':''}></label>`).join('')}
      <div class="construction-plan-actions"><button class="primary" data-roster-save>${editing?'儲存修改':'新增設備'}</button>${editing?'<button type="button" class="outline" data-roster-reset>取消修改</button>':''}</div></form>
      <p class="form-sync-hint">名稱、類型、型號、建築物、備註會同步此案各施工規劃的同編號設備；設置區域依各規劃保存。</p></details>`;
  }
  function batchForm(current){
    const manageable=plans.filter(p=>p.can_manage);
    return `<details class="roster-panel" data-panel="batch" ${openPanels.has('batch')?'open':''}><summary>系統自動批次建立設備</summary><form class="roster-editor" data-form="batch">
      <label>設備類型<input name="type" list="rosterTypeOptions" maxlength="160" placeholder="例如：監視攝影機"></label>
      <label>設備名稱<input name="name" maxlength="160" placeholder="例如：監視攝影機"></label>
      <label>設備編號前綴<input name="prefix" maxlength="60" required placeholder="例如：CAM"></label>
      <label>起始編號<input name="start" type="number" min="0" max="999999" step="1" required value="1"></label>
      <label>設備數量<input name="count" type="number" min="1" max="1000" step="1" required value="1"></label>
      <label>編號位數<input name="digits" type="number" min="1" max="8" step="1" required value="2"></label>
      <label>設置區域<input name="location" maxlength="160"></label>
      <label>所屬建築物<input name="building" maxlength="160"></label>
      <fieldset class="span-all"><legend>加入施工規劃（可複選，同一設備可對應多個施工階段）</legend>${manageable.map(p=>`<label class="construction-item-check"><input type="checkbox" name="plans" value="${esc(p.id)}" ${p.id===current.id?'checked':''}>${esc(p.content)}</label>`).join('')}</fieldset>
      <label class="span-all">同時指派至施工子項目（選填，限目前施工規劃）<select name="assign"><option value="">不指派</option>${(current.items||[]).map(i=>`<option value="${esc(i.id)}">${esc(i.title)}</option>`).join('')}</select></label>
      <output class="span-all" data-batch-preview></output>
      <div class="construction-plan-actions"><button class="primary" data-roster-batch>建立設備清冊</button></div></form>
      <p class="form-sync-hint">例如前綴 CAM、起始編號 1、位數 2、數量 79，會建立 CAM01～CAM79。尚未設定工程圖位置的設備會列在工程圖的「待配置設備」。</p></details>`;
  }
  function importPanel(){
    return `<details class="roster-panel" data-panel="import" ${openPanels.has('import')?'open':''}><summary>Excel／CSV 匯入設備清冊</summary>
      <p class="form-sync-hint">欄位：${ROSTER_TEMPLATE_HEADERS.join('、')}。只有「設備編號」必填；「對應施工主項目」空白時加入目前規劃，「對應施工子項目」可用「、」分隔多個。舊版「設備編號,位置,設備名稱」CSV 仍可使用。</p>
      <div class="construction-plan-actions"><label class="outline-file">選擇檔案<input type="file" data-roster-file accept=".xlsx,.csv,.tsv,.txt"></label><button type="button" class="outline" data-roster-template>下載範本（含目前清冊）</button></div>
      <div data-roster-preview></div></details>`;
  }
  function previewTable(){
    if(!importRows)return '';
    const errors=importRows.filter(r=>r.errors.length).length,adds=importRows.filter(r=>r.action==='新增').length,updates=importRows.filter(r=>r.action==='更新').length;
    const assigns=importRows.reduce((n,r)=>n+r.items.length,0),drawings=importRows.filter(r=>r.drawing).length;
    return `<p role="status">共 ${importRows.length} 列：新增 ${adds}、更新 ${updates}、子項目指派 ${assigns}${errors?`，<b class="danger-text">${errors} 列有錯誤，請修正後重新選擇檔案</b>`:''}。${drawings?'「對應工程圖」僅供核對，點位請在工程圖上設定。':''}</p>
      <div class="construction-gantt-scroll"><table class="roster-preview"><thead><tr><th>列</th><th>設備編號</th><th>設備名稱</th><th>施工主項目</th><th>子項目</th><th>動作</th><th>檢查結果</th></tr></thead><tbody>${importRows.map(r=>`<tr class="${r.errors.length?'is-error':''}"><td>${r.line}</td><td>${esc(r.point?.code||'')}</td><td>${esc(r.point?.name||'')}</td><td>${esc(r.plan?.content||'')}</td><td>${esc(r.items.map(i=>i.title).join('、'))}</td><td>${r.action}</td><td>${esc(r.errors.join('；')||'✓')}</td></tr>`).join('')}</tbody></table></div>
      <div class="construction-plan-actions"><button type="button" class="primary" data-roster-import-confirm ${errors||!importRows.some(r=>r.action!=='不變'||r.items.length)?'disabled':''}>確認匯入</button><button type="button" class="outline" data-roster-import-cancel>取消</button></div>`;
  }
  function selectionBar(current){
    if(!current.can_manage)return '';
    return `<div class="roster-selection"><span>已選 <b>${selected.size}</b> 台</span><button type="button" class="outline" data-roster-select-visible>全選目前列表</button><button type="button" class="outline" data-roster-select-clear>清除選取</button>
      <label>區間<input data-range-from placeholder="CAM10" maxlength="80"></label><label>至<input data-range-to placeholder="CAM20" maxlength="80"></label><button type="button" class="outline" data-roster-select-range>依編號區間選取</button></div>
      ${(current.items||[]).length?`<div class="roster-selection"><label>施工子項目<select data-assign-item>${current.items.map(i=>`<option value="${esc(i.id)}" ${i.id===itemFilter?'selected':''}>${esc(i.title)}</option>`).join('')}</select></label><button type="button" class="primary" data-assign-add>指派選取設備</button><button type="button" class="outline" data-assign-remove>移出選取設備</button><button type="button" class="outline" data-assign-all>改為適用全部設備</button></div>`:''}`;
  }
  function render(){
    const current=plan();
    if(!current){body.textContent='請先新增施工規劃，再建立設備清冊。';return;}
    const editable=current.can_manage,points=visiblePoints(),total=current.drawing_points?.length||0;
    body.innerHTML=itemChips(current)+(editable?singleForm(current)+batchForm(current)+importPanel():'')+selectionBar(current)+
      `<p>設備共 ${total} 筆${points.length!==total?`，符合篩選 ${points.length} 筆`:''}</p>
      <div class="roster-table-scroll"><table class="roster-table"><thead><tr>${editable?'<th><span class="visually-hidden">選取</span></th>':''}<th>圖示</th><th>設備編號</th><th>名稱</th><th>類型／型號</th><th>設置區域</th><th>建築物</th><th>施工子項目</th>${editable?'<th>操作</th>':''}</tr></thead>
      <tbody>${points.map(p=>{const rel=rosterRelations(current,p.code);return `<tr${selected.has(p.code)?' class="is-selected"':''}>${editable?`<td data-label="選取"><input type="checkbox" data-roster-pick="${esc(p.code)}" ${selected.has(p.code)?'checked':''} aria-label="選取 ${esc(p.code)}"></td>`:''}<td data-label="圖示"><img class="roster-icon" alt="" src="${esc(equipmentIconFor(p,null,current.content))}"></td><th scope="row" data-label="設備編號">${esc(p.code)}</th><td data-label="名稱">${esc(p.name||'')}${p.note?`<small>${esc(p.note)}</small>`:''}</td><td data-label="類型／型號">${esc([p.type,p.model].filter(Boolean).join('／'))}</td><td data-label="設置區域">${esc(p.location||'')}</td><td data-label="建築物">${esc(p.building||'')}</td><td data-label="施工子項目">${rel.items.length?rel.items.map(t=>`<span class="roster-chip">${esc(t)}</span>`).join(''):(current.items?.length?'<small>未指定（適用全部）</small>':'')}</td>${editable?`<td data-label="操作"><div class="construction-plan-actions"><button type="button" class="outline" data-roster-edit="${esc(p.code)}">修改</button><button type="button" class="outline danger" data-roster-delete="${esc(p.code)}">刪除</button></div></td>`:''}</tr>`;}).join('')||`<tr><td colspan="9">${total?'沒有符合篩選的設備。':'尚未建立設備清冊。'}</td></tr>`}</tbody></table></div>`;
    if(editing){
      const point=current.drawing_points.find(p=>p.code===editing),form=body.querySelector('[data-form="single"]');
      if(point&&form){for(const [key] of ROSTER_FIELDS)form.elements.namedItem(key).value=point[key]||'';form.elements.code.readOnly=true;form.elements.name.focus();}
    }
    const preview=body.querySelector('[data-roster-preview]');if(preview)preview.innerHTML=previewTable();
    updateBatchPreview();
  }
  function updateBatchPreview(){
    const form=body.querySelector('[data-form="batch"]'),out=form?.querySelector('[data-batch-preview]');if(!out)return;
    try{
      const codes=generateEquipmentCodes(Object.fromEntries(['prefix','start','count','digits'].map(k=>[k,form.elements.namedItem(k).value])));
      const targets=[...form.querySelectorAll('[name=plans]:checked')].map(b=>plans.find(p=>p.id===b.value));
      const lower=new Set(codes.map(c=>c.toLowerCase()));
      const duplicates=targets.flatMap(p=>(p.drawing_points||[]).filter(pt=>lower.has(pt.code.toLowerCase())).map(pt=>`${p.content}：${pt.code}`));
      out.textContent=`將建立 ${codes[0]}～${codes.at(-1)} 共 ${codes.length} 筆，加入 ${targets.length} 筆施工規劃。`+(duplicates.length?`已有相同編號（${duplicates.slice(0,5).join('、')}${duplicates.length>5?' 等':''}），請調整起始編號。`:'');
      out.dataset.invalid=String(!!duplicates.length||!targets.length);
    }catch(error){out.textContent=error.message;out.dataset.invalid='true';}
  }
  async function load(preferred){
    const data=await apiRequest({method:'GET',scope:'construction_plans',projectId});
    if(!dialog.open)return;
    mergeConstructionContext(data);
    plans=(data.construction_plans||[]).filter(p=>p.project_id===projectId);
    picker.innerHTML=plans.map(p=>`<option value="${esc(p.id)}">${esc(p.content)}</option>`).join('');
    if(plans.some(p=>p.id===preferred))picker.value=preferred;
    const current=plan();
    if(current){const codes=new Set((current.drawing_points||[]).map(p=>p.code));selected=new Set([...selected].filter(c=>codes.has(c)));if(itemFilter&&!current.items?.some(i=>i.id===itemFilter))itemFilter='';}
    render();
  }
  async function run(task,done){
    if(busy)return;
    busy=true;body.inert=true;picker.disabled=true;status.textContent='處理中…';
    const keep=plan()?.id;let saved=false;
    try{const message=await task();saved=true;await load(keep);await refreshConstructionProgressViews();status.textContent=message||done||'已儲存。';}
    catch(error){status.textContent=saved?'已儲存，請重新開啟以讀取最新資料。':error.message;if(!saved)await load(keep).catch(()=>{});}
    finally{busy=false;body.inert=false;picker.disabled=false;}
  }
  const saveRoster=(current,points)=>apiRequest({operation:'save_construction_roster',payload:{plan_id:current.id,versions:versions(),points}});
  const assign=(item,codes)=>apiRequest({operation:'assign_construction_item_equipment',payload:{item_id:item.id,row_version:item.row_version,codes}});
  picker.onchange=()=>{status.textContent='';selected.clear();itemFilter='';editing=null;importRows=null;render();};
  search.oninput=()=>render();
  dialog.addEventListener('toggle',event=>{const panel=event.target.closest?.('[data-panel]');if(panel)panel.open?openPanels.add(panel.dataset.panel):openPanels.delete(panel.dataset.panel);},true);
  dialog.addEventListener('input',event=>{if(event.target.closest('[data-form="batch"]'))updateBatchPreview();});
  dialog.addEventListener('change',async event=>{
    const pick=event.target.closest('[data-roster-pick]');
    if(pick){pick.checked?selected.add(pick.dataset.rosterPick):selected.delete(pick.dataset.rosterPick);pick.closest('tr').classList.toggle('is-selected',pick.checked);body.querySelector('.roster-selection b').textContent=selected.size;return;}
    if(event.target.closest('[data-form="batch"]'))updateBatchPreview();
    const file=event.target.closest('[data-roster-file]');
    if(file?.files[0]){
      const preview=body.querySelector('[data-roster-preview]');importRows=null;preview.textContent='正在讀取並檢查檔案…';
      try{importRows=validateRosterImport(await readRosterFile(file.files[0]),{plans,current:plan()});preview.innerHTML=previewTable();}
      catch(error){preview.textContent=error.message;}
      finally{file.value='';}
    }
  });
  dialog.onsubmit=event=>{
    event.preventDefault();const current=plan();if(busy||!current?.can_manage)return;
    const form=event.target;
    if(form.dataset.form==='single'){
      let point;
      try{point=rosterPointFrom(Object.fromEntries(ROSTER_FIELDS.map(([k])=>[k,form.elements.namedItem(k).value])),editing?current.drawing_points.find(p=>p.code===editing):{});}
      catch(error){status.textContent=error.message;return;}
      const points=[...current.drawing_points];
      if(!editing){
        if(points.some(p=>p.code.toLowerCase()===point.code.toLowerCase())){status.textContent='設備編號已存在。';return;}
        points.push(point);
      }else points[points.findIndex(p=>p.code===editing)]=point;
      editing=null;
      void run(async()=>{const r=await saveRoster(current,points);return `已儲存 ${point.code}，同步更新 ${r.result.plan_count} 筆規劃。`;});
    }else if(form.dataset.form==='batch'){
      let codes;
      try{codes=generateEquipmentCodes(Object.fromEntries(['prefix','start','count','digits'].map(k=>[k,form.elements.namedItem(k).value])));}
      catch(error){status.textContent=error.message;return;}
      if(form.querySelector('[data-batch-preview]').dataset.invalid==='true'){status.textContent='請先修正批次設定。';return;}
      const targets=[...form.querySelectorAll('[name=plans]:checked')].map(b=>b.value),assignItem=form.elements.assign.value;
      const attrs=Object.fromEntries(['name','type','location','building'].map(k=>[k,form.elements.namedItem(k).value.trim()]));
      const points=codes.map(code=>{const p={code,location:attrs.location};for(const k of ['name','type','building'])if(attrs[k])p[k]=attrs[k];return p;});
      if(!confirm(`建立 ${codes[0]}～${codes.at(-1)} 共 ${codes.length} 筆設備，加入 ${targets.length} 筆施工規劃${assignItem?'，並指派至所選子項目':''}？`))return;
      void run(async()=>{
        const r=await apiRequest({operation:'batch_construction_roster',payload:{project_id:projectId,plans:targets,versions:versions(),points,assign_item_id:assignItem||null}});
        return `已建立 ${r.result.point_count} 筆設備，加入 ${r.result.plan_count} 筆施工規劃。`;
      });
    }
  };
  dialog.onclick=async event=>{
    const target=event.target.closest('button');if(!target||busy)return;
    if(target.hasAttribute('data-roster-close')){dialog.close();return;}
    const current=plan();if(!current)return;
    if(target.hasAttribute('data-roster-item-filter')){itemFilter=target.dataset.rosterItemFilter;render();return;}
    if(!current.can_manage)return;
    if(target.hasAttribute('data-roster-edit')){editing=target.dataset.rosterEdit;openPanels.add('single');render();body.querySelector('[data-panel="single"]').scrollIntoView({block:'nearest'});return;}
    if(target.hasAttribute('data-roster-reset')){editing=null;render();return;}
    if(target.hasAttribute('data-roster-delete')){
      const code=target.dataset.rosterDelete,rel=rosterRelations(current,code);
      if(rel.records.length){status.textContent=`${code} 已有 ${rel.records.length} 筆設備施工紀錄，為保留施工歷程不能刪除。`;return;}
      if(!confirm(`從「${current.content}」清冊刪除 ${code}？${rel.items.length?`\n已指派子項目：${rel.items.join('、')}（會一併移除指派）`:''}\n若工程圖上已有此設備的定位，系統會要求先移除定位。`))return;
      selected.delete(code);
      void run(async()=>{await saveRoster(current,current.drawing_points.filter(p=>p.code!==code));return `已刪除 ${code}。`;});
      return;
    }
    if(target.hasAttribute('data-roster-select-visible')){for(const p of visiblePoints())selected.add(p.code);render();return;}
    if(target.hasAttribute('data-roster-select-clear')){selected.clear();render();return;}
    if(target.hasAttribute('data-roster-select-range')){
      try{const codes=equipmentCodeRange(current.drawing_points.map(p=>p.code),body.querySelector('[data-range-from]').value,body.querySelector('[data-range-to]').value);
        for(const code of codes)selected.add(code);render();status.textContent=`已依區間選取 ${codes.length} 台設備。`;}
      catch(error){status.textContent=error.message;}
      return;
    }
    if(target.matches('[data-assign-add],[data-assign-remove],[data-assign-all]')){
      const item=current.items.find(i=>i.id===body.querySelector('[data-assign-item]').value);if(!item)return;
      let codes;
      if(target.hasAttribute('data-assign-all')){
        if(!confirm(`「${item.title}」改為適用本規劃全部 ${current.drawing_points.length} 台設備？`))return;
        codes=null;
      }else{
        if(!selected.size){status.textContent='請先勾選設備，或使用「依編號區間選取」。';return;}
        const base=target.hasAttribute('data-assign-remove')&&!Array.isArray(item.equipment_codes)?current.drawing_points.map(p=>p.code):itemAssignmentBase(current,item);
        codes=target.hasAttribute('data-assign-add')?[...new Set([...base,...selected])]:base.filter(c=>!selected.has(c));
        const note=!Array.isArray(item.equipment_codes)&&target.hasAttribute('data-assign-add')?'\n此子項目目前適用全部設備，指派後填寫日誌只會列出指派的設備（已有紀錄的設備會保留）。':'';
        if(!confirm(`${target.hasAttribute('data-assign-add')?'指派':'移出'} ${selected.size} 台設備${target.hasAttribute('data-assign-add')?'至':'自'}「${item.title}」？指派後共 ${codes.length} 台。${note}`))return;
      }
      void run(async()=>{await assign(item,codes);if(codes)selected.clear();itemFilter=item.id;return codes?`「${item.title}」已指派 ${codes.length} 台設備。`:`「${item.title}」已改為適用全部設備。`;});
      return;
    }
    if(target.hasAttribute('data-roster-template')){
      try{
        const rows=(current.drawing_points||[]).map(p=>[p.code,p.name||'',p.type||'',p.model||'',p.location||'',p.building||'',current.content,rosterRelations(current,p.code).items.join('、'),'',p.note||'']);
        await GucExcelExport.saveBytes(GucExcelExport.buildWorkbook(ROSTER_TEMPLATE_HEADERS.map(label=>({label})),rows.length?rows:[['CAM01','監視攝影機','監視攝影機','','1F','總務處大樓',current.content,'','','']],'設備清冊'),GucExcelExport.filenameFor((byId(state.projects,projectId)?.code||'施工規劃')+'_'+current.content+'_設備清冊'));
      }catch(error){status.textContent=error.message;}
      return;
    }
    if(target.hasAttribute('data-roster-import-cancel')){importRows=null;render();return;}
    if(target.hasAttribute('data-roster-import-confirm')&&importRows&&!importRows.some(r=>r.errors.length)){
      const rows=importRows;
      void run(async()=>{
        const touched=[...new Set(rows.map(r=>r.plan.id))],messages=[];
        for(const planId of touched){
          const fresh=plans.find(p=>p.id===planId),points=[...fresh.drawing_points];
          for(const r of rows.filter(r=>r.plan.id===planId&&r.action!=='不變')){
            const at=points.findIndex(p=>p.code===r.point.code);
            if(at>=0)points[at]=r.point;else points.push(r.point);
          }
          if(points.length>1000)throw Error(`「${fresh.content}」超過 1000 台設備。`);
          if(rows.some(r=>r.plan.id===planId&&r.action!=='不變')){await saveRoster(fresh,points);messages.push(fresh.content);}
          await load(plan()?.id);
        }
        const byItem=new Map();
        for(const r of rows)for(const item of r.items){const key=r.plan.id+'\0'+item.id;byItem.set(key,[...(byItem.get(key)||[]),r.point.code]);}
        let assigned=0;
        for(const [key,codes] of byItem){
          const [planId,itemId]=key.split('\0'),fresh=plans.find(p=>p.id===planId),item=fresh?.items?.find(i=>i.id===itemId);
          if(!item)continue;
          await assign(item,[...new Set([...itemAssignmentBase(fresh,item),...codes])]);assigned++;await load(plan()?.id);
        }
        importRows=null;
        return `匯入完成：更新 ${messages.length} 筆施工規劃清冊、${assigned} 個子項目指派。`;
      });
    }
  };
  const endSession=()=>dialog.close();
  window.addEventListener('guc:session-changed',endSession);
  dialog.oncancel=event=>{if(busy)event.preventDefault();};
  dialog.onclose=()=>{window.removeEventListener('guc:session-changed',endSession);dialog.remove();
    if(document.querySelector('#simpleModal.open') && document.querySelector('#modalForm [data-open-roster]')?.dataset.openRoster===projectId && state.currentUser)openConstructionPlans(projectId).catch(e=>showToast(e.message));
  };
  try{await load();}catch(error){status.textContent=error.message;}
}
