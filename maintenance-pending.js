// Maintenance follow-ups share the work-log picker, session and save transaction.
function maintenancePendingFields(event={}){
 const history=[...(event.pendingCompletions||[]).map(row=>`已完成 ${row.completed_date}｜${row.pending_text}`),...(event.pendingSources||[]).map(row=>`本次承接 ${row.completed_date}｜${row.pending_text}`)];
 return `<label data-maintenance-notes><span data-notes-label>備註（選填）</span><textarea name="eventNotes" maxlength="2000">${esc(event.notes||'')}</textarea></label><label data-maintenance-pending>未完成（選填）<textarea name="eventPendingContent" maxlength="2000" placeholder="一行一項，供下次維修勾選延續">${esc(event.pendingContent||'')}</textarea><small>只有此處的新未完成內容會列入待辦，歷史備註不會自動列入。</small></label>${history.length?`<details class="span-2"><summary>未完成事項處理紀錄（${history.length}）</summary>${history.map(line=>`<p>${esc(line)}</p>`).join('')}</details>`:''}`;
}
function syncMaintenancePendingFields(){
 const form=document.querySelector('#modalForm');if(!form)return;
 const repair=form.elements.workType?.value==='維修紀錄';
 for(const card of form.querySelectorAll('[data-maintenance-event]')){
  const notes=card.querySelector('[name="eventNotes"]'),pending=card.querySelector('[name="eventPendingContent"]');
  if(!notes||!pending)continue;
  notes.closest('label').hidden=repair&&!notes.value;notes.readOnly=repair;
  card.querySelector('[data-notes-label]').textContent=repair?'歷史備註（保留原文）':'備註（選填）';
  pending.closest('label').hidden=!repair;pending.disabled=!repair||!canWrite()||form.querySelector('#maintenanceEditor')?.hidden;
 }
 for(const input of form.querySelectorAll('[data-maintenance-pending-index]')){
  const row=form._maintenancePendingItems?.[Number(input.dataset.maintenancePendingIndex)],id=document.querySelector('#simpleModal')?.dataset.id;
  input.disabled=!repair||!row?.can_complete||!canWrite()||!!(id&&!canWorkLog('UPDATE',id));
 }
 const editor=form.querySelector('#maintenanceEditor');
 if(editor){
  const logId=document.querySelector('#simpleModal')?.dataset.id;
  if(logId&&!canWorkLog('UPDATE',logId))for(const input of editor.querySelectorAll('input,select,textarea,button'))input.disabled=true;
  let summary=editor.querySelector('[data-maintenance-pending-summary]');
  if(!summary){summary=document.createElement('p');summary.dataset.maintenancePendingSummary='';editor.querySelector('#maintenanceEventList').before(summary);}
  const count=[...form.querySelectorAll('[name="eventPendingContent"]')].reduce((sum,field)=>sum+new Set(field.value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean)).size,0);
  summary.hidden=!repair;summary.textContent=`本次事件未完成：${count} 項${count?'；儲存時請使用「進行中」狀態。':''}`;
 }
}
function maintenancePendingNote(row,date){return `[${row.pending_text}](${date.slice(5)}已完成)`;}
function detachMaintenancePendingGroup(group){
 const field=group.card.querySelector('[name="eventHandlingProcess"]');
 if(field)field.value=field.value.split(/\r?\n/).filter(line=>!group.notes.has(line)).join('\n');
 if(!group.touched)group.card.remove();
}
function clearMaintenancePendingSelection(form){
 for(const group of form._maintenancePendingGroups?.values()||[])detachMaintenancePendingGroup(group);
 form._maintenancePendingGroups=new Map();form._maintenancePendingItems=[];
}
function ensureMaintenanceEventPlaceholder(form){
 const list=form.querySelector('#maintenanceEventList');
 if(list&&!list.querySelector('[data-maintenance-event]'))list.insertAdjacentHTML('beforeend',maintenanceEventCard({occurredAt:form.elements.logDate?.value||today()},workLogFormCustomerId()));
 syncMaintenanceVisibility();
}
function syncMaintenancePendingSelection(form){
 const selected=[...form.querySelectorAll('[data-maintenance-pending-index]:checked')].map(input=>form._maintenancePendingItems[Number(input.dataset.maintenancePendingIndex)]);
 const groups=form._maintenancePendingGroups||(form._maintenancePendingGroups=new Map()),list=form.querySelector('#maintenanceEventList');
 for(const [id,group] of groups){
  if(!selected.some(row=>row.source_event_id===id)){detachMaintenancePendingGroup(group);groups.delete(id);}
 }
 for(const row of selected){
  let group=groups.get(row.source_event_id);
  if(!group){
   if(list.querySelectorAll('[data-maintenance-event]').length>=20){showToast('最多 20 筆維修事件，請先減少本次事件。');for(const input of form.querySelectorAll('[data-maintenance-pending-index]:checked'))if(form._maintenancePendingItems[Number(input.dataset.maintenancePendingIndex)].source_event_id===row.source_event_id)input.checked=false;continue;}
   list.insertAdjacentHTML('beforeend',maintenanceEventCard({serviceId:row.service_id,eventType:row.event_type,occurredAt:form.elements.logDate.value},workLogFormCustomerId()));
   group={card:list.lastElementChild,notes:new Set(),touched:false};groups.set(row.source_event_id,group);
   // Replace only untouched blank placeholders. Never copy equipment IDs from another visit.
   for(const card of list.querySelectorAll('[data-maintenance-event]'))if(card!==group.card&&!card.dataset.eventId&&!card.dataset.pendingManualEdit&&!card.querySelector('[name="eventServiceId"]').value&&!['eventCause','eventHandlingProcess','eventNotes','eventPendingContent'].some(name=>card.querySelector(`[name="${name}"]`)?.value)&&card.dataset.equipmentIds==='[]')card.remove();
  }
 }
 for(const [id,group] of groups){
  const field=group.card.querySelector('[name="eventHandlingProcess"]'),wanted=new Set(selected.filter(row=>row.source_event_id===id).map(row=>maintenancePendingNote(row,form.elements.logDate.value)));
  field.value=field.value.split(/\r?\n/).filter(line=>!group.notes.has(line)||wanted.has(line)).join('\n');
  for(const note of wanted)if(!field.value.split(/\r?\n/).includes(note))field.value=[field.value.trim(),note].filter(Boolean).join('\n');
  group.notes=wanted;
 }
 ensureMaintenanceEventPlaceholder(form);
}
function collectMaintenancePendingItems(form){
 if(form.elements.workType?.value!=='維修紀錄')return [];
 return [...form.querySelectorAll('[data-maintenance-pending-index]:checked')].map(input=>{
  const row=form._maintenancePendingItems[Number(input.dataset.maintenancePendingIndex)],group=form._maintenancePendingGroups.get(row.source_event_id);
  if(!group?.card.isConnected)throw Error('承接事件已移除，請重新勾選未完成事項。');
  if(group.card.querySelector('[name="eventServiceId"]').value!==row.service_id||group.card.querySelector('[name="eventType"]').value!==row.event_type)throw Error('承接事件的承攬項目及事件類型需與來源相同；如需其他事件，請取消勾選後另建。');
  return {source_event_id:row.source_event_id,source_log_id:row.source_log_id,row_version:row.row_version,log_row_version:row.log_row_version,pending_text:row.pending_text,target_client_key:group.card.dataset.eventKey};
 });
}
let maintenancePendingRevision=0,maintenancePendingTimer;
function scheduleMaintenancePendingItems(){
 clearTimeout(maintenancePendingTimer);const revision=++maintenancePendingRevision,modal=document.querySelector('#simpleModal'),form=document.querySelector('#modalForm');
 if(modal?.dataset.type!=='workLogModal'||!form)return;
 clearMaintenancePendingSelection(form);ensureMaintenanceEventPlaceholder(form);
 const editor=form.querySelector('#maintenanceEditor');if(!editor)return;
 let host=editor.querySelector('[data-maintenance-pending-items]');
 if(!host){host=document.createElement('fieldset');host.className='worker-picker span-2';host.dataset.maintenancePendingItems='';host.setAttribute('aria-live','polite');editor.querySelector('#maintenanceEventList').before(host);}
 host.replaceChildren();host.hidden=true;if(form.elements.workType?.value!=='維修紀錄')return;
 let project;try{project=workLogSaveProject(workLogOriginalProject());}catch{return;}
 const date=form.elements.logDate?.value;if(!project?.id||!date)return;
 host.hidden=false;host.textContent='正在讀取先前維修未完成事項…';
 maintenancePendingTimer=setTimeout(async()=>{const current=()=>revision===maintenancePendingRevision&&host.isConnected&&modal.dataset.type==='workLogModal'&&modal.classList.contains('open');try{
  const data=await apiRequest({method:'GET',scope:'pending_work_log_items',workType:'維修紀錄',projectId:project.id,from:date,excludeId:modal.dataset.id||''});if(!current())return;
  form._maintenancePendingItems=data.items||[];const writable=!modal.dataset.id||canWorkLog('UPDATE',modal.dataset.id);
  host.innerHTML='<legend>先前維修未完成事項</legend><p>勾選後帶入本次事件；儲存成功才結清原項目。仍需處理的事項請填入本次「未完成」。</p>'+(!data.items?.length?'<p>目前沒有可延續的維修未完成事項。</p>':data.items.map((row,index)=>`<label><input type="checkbox" data-maintenance-pending-index="${index}" ${row.can_complete&&writable?'':'disabled'}><span>${esc(row.log_date)}｜${esc(row.service_name)}｜${esc(MAINTENANCE_EVENT_TYPES.find(([code])=>code===row.event_type)?.[1]||row.event_type)}<br>${esc(row.pending_text)}<small>${esc(row.project_code||'')} ${esc(row.project_name)}${row.reason?'｜'+esc(row.reason):''}</small></span></label>`).join(''));
 }catch(error){if(current())host.textContent='先前維修待辦讀取失敗：'+error.message;}},200);
}
for(const name of ['input','change'])document.addEventListener(name,event=>{
 const form=event.target.closest('#modalForm');if(!form)return;
 if(event.target.matches('[data-maintenance-pending-index]')){if(name==='change')syncMaintenancePendingSelection(form);return;}
 const card=event.target.closest('[data-maintenance-event]');
 if(card){card.dataset.pendingManualEdit='true';for(const group of form._maintenancePendingGroups?.values()||[])if(group.card===card)group.touched=true;if(event.target.name==='eventPendingContent')syncMaintenancePendingFields();}
});
document.addEventListener('click',event=>{
 if(!event.target.closest('[data-remove-maintenance-event]'))return;
 const form=document.querySelector('#modalForm');if(!form?._maintenancePendingGroups)return;
 for(const [id,group] of form._maintenancePendingGroups)if(!group.card.isConnected){
  form._maintenancePendingGroups.delete(id);
  for(const input of form.querySelectorAll('[data-maintenance-pending-index]'))if(form._maintenancePendingItems[Number(input.dataset.maintenancePendingIndex)].source_event_id===id)input.checked=false;
 }
});
