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
      const match = raw.match(/^\s*("(?:[^"]|"")*"|[^",]*)(?:,\s*("(?:[^"]|"")*"|[^",]*))?\s*$/);
      if (!match) throw Error(`第 ${index+1} 列格式錯誤，請使用「設備編號,位置」。`);
      columns = match.slice(1).map(s=>(s||'').trim().replace(/^"(.*)"$/,'$1').replace(/""/g,'"'));
    }
    const [code, location=''] = columns;
    if (!points.length && code==='設備編號' && (!location||location==='位置')) continue;
    if (!code || code.length>80 || location.length>160 || columns.length>2 || seen.has(code.toLowerCase()))
      throw Error(`第 ${index+1} 列的設備編號重複、空白或欄位格式錯誤。`);
    seen.add(code.toLowerCase());
    points.push({code,location});
  }
  if (points.length>1000) throw Error('每筆施工規劃最多 1000 個點位。');
  return points;
}
function pointsText(points) {
  return points.map(p=>[p.code,p.location].map(s=>'"'+s.replaceAll('"','""')+'"').join(',')).join('\n');
}
function drawingPointEditor(plan) {
  return `<fieldset class="span-2"><legend>設備施工進度表</legend>
    <p>施工子項目會成為表格的工項欄。貼上設備編號與位置，或匯入 UTF-8 CSV、TSV。儲存規劃後生效。</p>
    <label>設備清冊（每列一台）<textarea name="drawingPoints" rows="5" placeholder="設備編號,位置">${esc(pointsText(plan.drawing_points||[]))}</textarea></label>
    <label>加入清冊檔案<input type="file" data-import-points accept=".csv,.tsv,.txt"></label>
    <output data-point-import-status aria-live="polite"></output></fieldset>`;
}
async function appendDrawingPoints(target, file) {
  const field = target.closest('fieldset'), editor = field.querySelector('[name=drawingPoints]'), message = field.querySelector('output');
  try {
    if (file?.size>1024*1024) throw Error('清冊檔案請小於 1 MB。');
    const imported = parseDrawingPoints(await file.text());
    const merged = new Map(parseDrawingPoints(editor.value).map(p=>[p.code.toLowerCase(),p]));
    for (const point of imported) {
      const key=point.code.toLowerCase(), existing=merged.get(key);
      if (existing && (existing.location!==point.location || existing.code!==point.code)) throw Error(`編號 ${point.code} 已存在，請核對兩筆資料。`);
      merged.set(key,point);
    }
    if (merged.size>1000) throw Error('每筆施工規劃最多 1000 個點位。');
    editor.value=pointsText([...merged.values()]);
    message.textContent=`清冊共 ${merged.size} 個點位，請核對後儲存。`;
  } catch (error) { message.textContent=error.message; }
  finally { if (file) target.value=''; }
}
function equipmentMatrix(plan) {
  if (!plan.drawing_points?.length || !plan.items?.length) return '';
  const cells=new Map((plan.equipment_state||[]).map(e=>[JSON.stringify([e.code,e.item]),e]));
  const totals=plan.items.map(()=>({done:0,applicable:0}));
  const rows=plan.drawing_points.map(p=>`<tr><th scope="row">${esc(p.code)}</th><td>${esc(p.location)}</td>${plan.items.map((item,index)=>{
    const record=cells.get(JSON.stringify([p.code,item.id]));
    const status=record?.status||'pending';
    if (status!=='na') totals[index].applicable++;
    if (status==='done') totals[index].done++;
    return `<td data-cell-status="${status}">${record?.log_id?`<button type="button" class="outline" data-construction-open-log="${esc(record.log_id)}" aria-label="${esc([p.code,item.title,record.log_date,equipmentStates[status]].join(' · '))}">${equipmentStates[status]}</button>`:equipmentStates[status]}</td>`;
  }).join('')}</tr>`).join('');
  return `<details class="construction-matrix"><summary>設備施工進度表（${plan.drawing_points.length} 個點位）</summary><div class="construction-gantt-scroll" tabindex="0"><table><thead><tr><th>設備編號</th><th>位置</th>${plan.items.map(i=>`<th>${esc(i.title)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody><tfoot><tr><th colspan="2">已完成／適用</th>${totals.map(t=>`<td>${t.done}／${t.applicable}</td>`).join('')}</tr></tfoot></table></div></details>`;
}
function equipmentEntryRow(plan, entry={}, editable=true) {
  const options=(choices,selected)=>choices.map(([key,text])=>`<option value="${esc(key)}"${selected===key?' selected':''}>${esc(text)}</option>`).join('');
  return `<fieldset data-equipment-entry ${editable?'':'disabled'}><legend>點位施工紀錄</legend>
    <label>設備編號<select data-entry-code required><option value="">請選擇</option>${options(plan.drawing_points.map(p=>[p.code,[p.code,p.location].filter(Boolean).join(' · ')]),entry.code)}</select></label>
    <label>工項<select data-entry-item required><option value="">請選擇</option>${options(plan.items.map(i=>[i.id,i.title]),entry.item)}</select></label>
    <label>本次進度<select data-entry-status>${options(Object.entries(equipmentStates),entry.status||'working')}</select></label>
    ${editable?'<button type="button" class="outline" data-remove-entry>移除此列</button>':''}</fieldset>`;
}
function equipmentEntryValues(form) {
  return [...form.querySelectorAll('[data-equipment-entry]')].map(row=>({
    code:row.querySelector('[data-entry-code]').value,item:row.querySelector('[data-entry-item]').value,status:row.querySelector('[data-entry-status]').value
  }));
}
function equipmentEntriesEditor(plan, entries, editable) {
  if (!plan?.drawing_points?.length || !plan.items?.length) return '';
  const allowed=editable && plan.can_complete_items;
  return `<div class="span-2" data-equipment-editor><h3>本篇日誌的設備施工進度</h3>${entries.map(e=>equipmentEntryRow(plan,e,allowed)).join('')}
    ${allowed?'<button type="button" class="outline" data-add-entry>＋ 填報設備進度</button>': '<small>設備進度依施工子項目更新權限開放。</small>'}</div>`;
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
document.addEventListener('click',event=>{
  const target=event.target.closest('[data-add-entry],[data-remove-entry]');
  if (!target) return;
  if (target.hasAttribute('data-remove-entry')) return target.closest('fieldset').remove();
  const plan=constructionPlanById(target.closest('form').dataset.constructionPlanId);
  if (plan?.can_complete_items) target.insertAdjacentHTML('beforebegin',equipmentEntryRow(plan));
});
document.addEventListener('change',event=>{
  const input=event.target;
  if (input.matches('[data-import-points]') && input.files[0]) void appendDrawingPoints(input,input.files[0]);
  if (input.matches('[data-entry-item]')) {
    const box=[...input.closest('form').querySelectorAll('[data-log-item]')].find(b=>b.value===input.value);
    if (box) box.checked=true;
  }
});
