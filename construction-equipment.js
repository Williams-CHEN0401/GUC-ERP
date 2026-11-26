// The plan's checklist supplies the columns. Equipment numbers identify drawing points within this plan.
const equipmentStates = {pending:'○ 未開始', working:'◐ 施工中', done:'✓ 已完成', na:'— 不適用'};
function constructionItemIds(log) {
  return log?.construction_item_ids ?? (log?.construction_item_id ? [log.construction_item_id] : []);
}
function parseDrawingPoints(text) {
  const points = [], seen = new Set();
  for (const [index, raw] of text.replace(/^\uFEFF/,'').split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    let columns;
    if (raw.includes('\t')) columns = raw.split('\t').map(s=>s.trim());
    else {
      const match = raw.match(/^\s*("(?:[^"]|"")*"|[^",]*)(?:,\s*("(?:[^"]|"")*"|[^",]*))?(?:,\s*("(?:[^"]|"")*"|[^",]*))?\s*$/);
      if (!match) throw Error(`第 ${index+1} 列格式錯誤，請使用「設備編號,位置,設備名稱」。`);
      columns = match.slice(1).filter(value=>value!==undefined).map(s=>(s||'').trim().replace(/^"(.*)"$/,'$1').replace(/""/g,'"'));
    }
    const [code, location='', name] = columns;
    if (!points.length && code==='設備編號' && (!location||location==='位置')) continue;
    if (!code || code.length>80 || location.length>160 || (name||'').length>160 || columns.length>3 || seen.has(code.toLowerCase()))
      throw Error(`第 ${index+1} 列的設備編號重複、空白或欄位格式錯誤。`);
    seen.add(code.toLowerCase());
    points.push(name===undefined?{code,location}:{code,location,name});
  }
  if (points.length>1000) throw Error('每筆施工規劃最多 1000 個點位。');
  return points;
}
function pointsText(points) {
  return points.map(p=>[p.code,p.location,...(p.name===undefined?[]:[p.name])].map(s=>'"'+s.replaceAll('"','""')+'"').join(',')).join('\n');
}
function mergeImportedPoints(points, imported) {
  const merged=new Map(points.map(p=>[p.code.toLowerCase(),p]));
  for(const point of imported){
    const key=point.code.toLowerCase(),existing=merged.get(key);
    if(existing && (existing.location!==point.location || existing.code!==point.code || (point.name!==undefined && existing.name && existing.name!==point.name)))
      throw Error('編號 '+point.code+' 已存在，請先核對資料。');
    merged.set(key,{...existing,...point});
  }
  if(merged.size>1000)throw Error('每筆施工規劃最多 1000 個點位。');
  return [...merged.values()];
}
async function appendDrawingPoints(target, file) {
  const field = target.closest('fieldset'), editor = field.querySelector('[name=drawingPoints]'), message = field.querySelector('output');
  try {
    if (file?.size>1024*1024) throw Error('清冊檔案請小於 1 MB。');
    const imported = parseDrawingPoints(await file.text());
    const merged=mergeImportedPoints(parseDrawingPoints(editor.value),imported);
    editor.value=pointsText(merged);
    message.textContent=`清冊共 ${merged.length} 個點位，請核對後儲存。`;
  } catch (error) { message.textContent=error.message; }
  finally { if (file) target.value=''; }
}
function equipmentWorkbookControls(plan) {
  const editable=plan.can_manage || (plan.can_create_log && plan.can_complete_items);
  return `<div class="construction-plan-actions">${canModule('data_export')?`<button type="button" class="outline" data-matrix-export="${esc(plan.id)}">匯出 Excel</button>`:''}${editable?`<button type="button" class="outline" data-matrix-import="${esc(plan.id)}">匯入 Excel</button>`:''}</div>`;
}

function equipmentMatrix(plan) {
  if (!plan.items?.length) return '';
  const cells=new Map((plan.equipment_state||[]).map(e=>[JSON.stringify([e.code,e.item]),e]));
  const totals=plan.items.map(()=>({done:0,applicable:0}));
  const rows=(plan.drawing_points||[]).map(p=>`<tr><th scope="row">${esc(p.code)}</th><td>${esc(p.name||"")}</td><td>${esc(p.location)}</td>${plan.items.map((item,index)=>{
    const record=cells.get(JSON.stringify([p.code,item.id]));
    const status=record?.status||'pending';
    if (status!=='na') totals[index].applicable++;
    if (status==='done') totals[index].done++;
    return `<td data-cell-status="${status}">${record?.log_id?`<button type="button" class="outline" data-construction-open-log="${esc(record.log_id)}" aria-label="${esc([p.code,item.title,record.log_date,equipmentStates[status]].join(' · '))}">${equipmentStates[status]}</button>`:(record?equipmentStates[status]:'未填報')}</td>`;
  }).join('')}</tr>`).join('');
  return `<details class="construction-matrix"><summary>設備施工進度表（${plan.drawing_points?.length||0} 個點位）</summary>${equipmentWorkbookControls(plan)}<div class="construction-gantt-scroll" tabindex="0"><table><thead><tr><th>設備編號</th><th>設備名稱</th><th>位置</th>${plan.items.map(i=>`<th>${esc(i.title)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody><tfoot><tr><th colspan="3">已完成／適用</th>${totals.map(t=>`<td>${t.done}／${t.applicable}</td>`).join('')}</tr></tfoot></table></div></details>`;
}
// Keep the per-task draft while the user moves between device checklists in this form.
const equipmentDrafts = new WeakMap();
function equipmentEntriesEditor(plan) {
  if (!plan?.drawing_points?.length || !plan.items?.length) return '';
  return `<section class="span-2 equipment-log-editor" data-equipment-editor><h3>本篇日誌的設備施工進度</h3>
    <p data-equipment-hint></p><label data-equipment-picker hidden>填報工項<select data-equipment-item></select></label>
    <div class="equipment-device-list" data-equipment-devices></div></section>`;
}
function initEquipmentEditor(host, plan, entries, editable, preferredItem) {
  const editor=host.querySelector('[data-equipment-editor]');
  if (!editor) return;
  const byItem=new Map(plan.items.map(item=>[item.id,new Map()]));
  for (const entry of entries) byItem.get(entry.item)?.set(entry.code,entry.status);
  const allowed=editable && plan.can_complete_items;
  equipmentDrafts.set(editor,{plan,byItem,allowed});
  if (!allowed) {
    for (const box of host.querySelectorAll('[data-log-item]:checked')) {
      if (byItem.get(box.value)?.size) box.disabled=true;
    }
  }
  renderEquipmentChecklist(editor,preferredItem);
}
function renderEquipmentChecklist(editor, preferredItem) {
  const {plan,byItem,allowed}=equipmentDrafts.get(editor);
  const host=editor.closest('[data-construction-selectors]');
  const selected=new Set([...host.querySelectorAll('[data-log-item]:checked')].map(box=>box.value));
  const items=plan.items.filter(item=>selected.has(item.id));
  const picker=editor.querySelector('[data-equipment-item]');
  const active=[preferredItem,picker.value,items[0]?.id].find(id=>selected.has(id));
  picker.innerHTML=items.map(item=>`<option value="${esc(item.id)}">${esc(item.title)}</option>`).join('');
  if (active) picker.value=active;
  editor.querySelector('[data-equipment-picker]').hidden=!items.length;
  const hint=editor.querySelector('[data-equipment-hint]');
  const list=editor.querySelector('[data-equipment-devices]');
  const records=byItem.get(active);
  if (!records) {
    hint.textContent=allowed?'請先勾選上方的今日施作子項目。':'本篇日誌未填報設備進度。';
    list.replaceChildren();
    return;
  }
  hint.textContent=allowed?'勾選本工項施作的設備，再分別選擇本次進度。':'設備進度僅供檢視。';
  // Older logs can refer to equipment that no longer appears in the active roster.
  const points=new Map(plan.drawing_points.map(point=>[point.code,point]));
  for (const code of records.keys()) if (!points.has(code)) points.set(code,{code});
  list.innerHTML=[...points.values()].filter(point=>allowed || records.has(point.code)).map(point=>{
    const checked=records.has(point.code),status=records.get(point.code)||'working';
    const label=[point.code,point.name,point.location].filter(Boolean).join(' · ');
    return `<div class="equipment-device-row"><label class="construction-item-check"><input type="checkbox" data-device-code value="${esc(point.code)}" ${checked?'checked':''} ${allowed?'':'disabled'}>${esc(label)}</label>
      <select data-device-status aria-label="${esc(point.code)} 本次進度" ${allowed && checked?'':'disabled'}>${Object.entries(equipmentStates).map(([key,text])=>`<option value="${key}" ${key===status?'selected':''}>${text}</option>`).join('')}</select></div>`;
  }).join('') || '<p>此工項未填報設備進度。</p>';
}
function equipmentEntryValues(form) {
  const editor=form.querySelector('[data-equipment-editor]');
  const draft=equipmentDrafts.get(editor);
  if (!draft) return [];
  return [...form.querySelectorAll('[data-log-item]:checked')].flatMap(box=>
    [...(draft.byItem.get(box.value)||[])].map(([code,status])=>({code,item:box.value,status})));
}
function constructionLogFields(form) {
  const items=[...form.querySelectorAll('[data-log-item]:checked')].map(i=>i.value);
  if (!items.length && form.querySelector('[data-items-required="true"]')) throw Error('請勾選至少一個今日施作子項目。');
  const entries=equipmentEntryValues(form), seen=new Set();
  for (const e of entries) {
    if (!items.includes(e.item)) throw Error('設備進度的工項必須包含在今日施作子項目。');
    const key=JSON.stringify([e.code,e.item]);
    if (seen.has(key)) throw Error('同一設備的同一工項只能填報一次。');
    seen.add(key);
  }
  return {construction_plan_id:form.dataset.constructionPlanId,construction_item_id:items[0]||null,construction_item_ids:items,equipment_progress:entries};
}
function sameEquipmentEntries(left,right) {
  const keys=entries=>entries.map(e=>JSON.stringify([e.code,e.item,e.status])).sort();
  return JSON.stringify(keys(left))===JSON.stringify(keys(right));
}
document.addEventListener('change',event=>{
  const input=event.target;
  if (input.matches('[data-import-points]') && input.files[0]) void appendDrawingPoints(input,input.files[0]);
  const editor=input.closest('[data-construction-selectors]')?.querySelector('[data-equipment-editor]');
  if (!editor || !equipmentDrafts.has(editor)) return;
  if (input.matches('[data-log-item]')) return renderEquipmentChecklist(editor,input.checked?input.value:undefined);
  if (input.matches('[data-equipment-item]')) return renderEquipmentChecklist(editor,input.value);
  const row=input.closest('.equipment-device-row');
  if (!row) return;
  const {allowed,byItem}=equipmentDrafts.get(editor);
  if (!allowed) return;
  const box=row.querySelector('[data-device-code]'),status=row.querySelector('[data-device-status]');
  const records=byItem.get(editor.querySelector('[data-equipment-item]').value);
  status.disabled=!box.checked;
  if (box.checked) records.set(box.value,status.value);
  else records.delete(box.value);
});

async function openConstructionRoster(projectId) {
  const dialog=document.createElement('dialog');
  dialog.className='matrix-import-dialog project-roster';
  dialog.setAttribute('aria-label','施工規劃清冊');
  dialog.innerHTML='<div class="construction-drawing-toolbar"><h2>施工規劃清冊</h2><button type="button" class="outline" data-roster-close>關閉</button></div><label>施工規劃<select data-roster-plan></select></label><div data-roster-body></div><output role="status"></output>';
  document.body.append(dialog);
  dialog.showModal();
  const status=dialog.querySelector('output'),picker=dialog.querySelector('[data-roster-plan]'),body=dialog.querySelector('[data-roster-body]');
  let plans=[],busy=false,editing=null;
  const plan=()=>plans.find(p=>p.id===picker.value);
  function render(){
    editing=null;
    const current=plan();
    if(!current){body.textContent='請先新增施工規劃，再建立設備清冊。';return;}
    const points=current.drawing_points||[],editable=current.can_manage;
    body.innerHTML=(editable?`<form class="roster-editor"><label>設備編號<input name="code" required maxlength="80"></label><label>設備名稱<input name="name" maxlength="160"></label><label>位置<input name="location" maxlength="160"></label><div class="construction-plan-actions"><button class="primary" data-roster-save>新增設備</button><button type="button" class="outline" data-roster-reset hidden>取消修改</button></div></form><p>修改名稱會同步此案各規劃的同編號設備。位置依各規劃保存。</p>
    <details class="roster-import"><summary>批次加入設備</summary><fieldset><label>設備編號、位置、名稱<textarea name="drawingPoints" rows="3"></textarea></label><label>載入 CSV／TSV<input type="file" data-import-points accept=".csv,.tsv,.txt"></label><output></output><button type="button" class="outline" data-roster-import>加入清冊</button></fieldset></details>`:'')+
    `<p>設備共 ${points.length} 筆</p><ul class="roster-list">${points.map((p,index)=>`<li><span><b>${esc(p.code)}</b>　${esc(p.name||'')}<small>${esc(p.location||'')}</small></span>${editable?`<div class="construction-plan-actions"><button type="button" class="outline" data-roster-edit="${index}">修改</button><button type="button" class="outline danger" data-roster-delete="${index}">刪除</button></div>`:''}</li>`).join('')}</ul>`;
  }
  async function load(preferred){
    const data=await apiRequest({method:'GET',scope:'construction_plans',projectId});
    if(!dialog.open)return;
    mergeConstructionContext(data);
    plans=(data.construction_plans||[]).filter(p=>p.project_id===projectId);
    picker.innerHTML=plans.map(p=>`<option value="${esc(p.id)}">${esc(p.content)}</option>`).join('');
    if(plans.some(p=>p.id===preferred))picker.value=preferred;
    render();
  }
  async function save(points){
    if(busy)return;
    busy=true;body.inert=true;picker.disabled=true;
    const current=plan(),versions=Object.fromEntries(plans.map(p=>[p.id,p.row_version]));
    let saved=false;
    try{
      const result=await apiRequest({operation:'save_construction_roster',payload:{plan_id:current.id,versions,points}});
      saved=true;await load(current.id);await refreshConstructionProgressViews();
      status.textContent='已儲存，更新 '+result.result.plan_count+' 筆規劃。';
    }catch(error){status.textContent=saved?'清冊已儲存，請重新開啟以讀取最新資料。':error.message;}
    finally{busy=false;body.inert=false;picker.disabled=false;}
  }
  picker.onchange=()=>{status.textContent='';render();};
  dialog.onsubmit=event=>{
    event.preventDefault();if(busy||!plan()?.can_manage)return;
    const form=event.target,point=Object.fromEntries(['code','name','location'].map(k=>[k,form.elements.namedItem(k).value.trim()]));
    if(!point.code){status.textContent='請輸入設備編號。';return;}
    const points=[...plan().drawing_points];
    if(editing===null){
      if(points.some(p=>p.code.toLowerCase()===point.code.toLowerCase())){status.textContent='設備編號已存在。';return;}
      points.push(point);
    }else points[editing]=point;
    void save(points);
  };
  dialog.onclick=event=>{
    const target=event.target.closest('button');if(!target||busy)return;
    if(target.hasAttribute('data-roster-close')){dialog.close();return;}
    if(!plan()?.can_manage)return;
    if(target.hasAttribute('data-roster-edit')){
      editing=Number(target.dataset.rosterEdit);
      const point=plan().drawing_points[editing],form=body.querySelector('form');
      for(const key of ['code','name','location'])form.elements.namedItem(key).value=point[key]||'';
      form.elements.code.readOnly=true;form.querySelector('[data-roster-save]').textContent='儲存修改';
      form.querySelector('[data-roster-reset]').hidden=false;form.elements.namedItem('name').focus();
    }else if(target.hasAttribute('data-roster-reset'))render();
    else if(target.hasAttribute('data-roster-delete')){
      const index=Number(target.dataset.rosterDelete),points=plan().drawing_points;
      if(confirm('從本規劃清冊刪除 '+points[index].code+'？'))void save(points.filter((_,i)=>i!==index));
    }else if(target.hasAttribute('data-roster-import')){
      try{const rows=parseDrawingPoints(body.querySelector('[name=drawingPoints]').value);if(!rows.length)throw Error('請先輸入或載入清冊。');void save(mergeImportedPoints(plan().drawing_points,rows));}
      catch(error){status.textContent=error.message;}
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
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-open-roster]');
  if(button)openConstructionRoster(button.dataset.openRoster).catch(error=>showToast(error.message));
});
