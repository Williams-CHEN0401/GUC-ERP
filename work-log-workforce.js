// The existing user directory and project permission checks remain authoritative.
function subcontractorFields(count=0){return `<fieldset class="worker-picker workforce-picker span-2"><legend>代工</legend><label><input type="checkbox" name="useSubcontractors" ${count>0?'checked':''}>代工施工</label><label>代工人數<input name="subcontractorCount" type="number" min="1" max="1000" step="1" value="${esc(count||1)}" ${count>0?'':'disabled'}></label><small>填寫當天實際到場人數；同日多份日誌以最高人數計算人天。</small></fieldset>`;}
function workLogWorkforceFields(log){return `<fieldset class="worker-picker span-2"><legend>填寫人到場情形</legend><label><input name="reporterOffSite" type="checkbox" ${log.reporter_on_site===false?'checked':''}>未至現場施工（填寫人不計入施工人員）</label></fieldset>`+subcontractorFields(log.subcontractor_count||0);}
function collectSubcontractorCount(form){if(!form.elements.useSubcontractors?.checked)return 0;const count=Number(form.elements.subcontractorCount.value);if(!Number.isInteger(count)||count<1||count>1000)throw Error('請填寫 1 至 1000 位代工人數。');return count;}
function collectWorkLogWorkforce(form){return {reporter_on_site:!form.elements.reporterOffSite?.checked,subcontractor_count:collectSubcontractorCount(form),resolved_maintenance_items:collectMaintenancePendingItems(form),resolved_pending_items:[...form.querySelectorAll('[data-pending-log-index]:checked')].map(input=>{const row=form._pendingLogItems[Number(input.dataset.pendingLogIndex)];return {source_log_id:row.source_log_id,row_version:row.row_version,pending_text:row.pending_text};})};}
function syncReporterAttendance(form){const offSite=form.elements.reporterOffSite?.checked;for(const input of form.querySelectorAll('[name="workerIds"]'))if(input.value===state.currentUser?.id&&input.type==='checkbox'){if(offSite)input.checked=false;input.disabled=!!offSite||!!(document.querySelector("#simpleModal").dataset.id&&!canWorkLog("UPDATE",document.querySelector("#simpleModal").dataset.id));}const output=form.querySelector('[data-worker-count="workerIds"]');if(output)output.textContent=`已選 ${form.querySelectorAll('[name="workerIds"]:checked').length} 位`;}
let pendingLogRevision=0,pendingLogTimer;
function removeGeneratedPendingNotes(form){const field=form.elements.completedContent;if(field&&form._pendingGenerated?.size)field.value=field.value.split(/\r?\n/).filter(line=>!form._pendingGenerated.has(line)).join('\n');form._pendingGenerated=new Set();}
function syncPendingNotes(form){removeGeneratedPendingNotes(form);const field=form.elements.completedContent,date=form.elements.logDate?.value;if(!field||!date)return;for(const input of form.querySelectorAll('[data-pending-log-index]:checked')){const row=form._pendingLogItems[Number(input.dataset.pendingLogIndex)],note=`${row.pending_text}(${date.slice(5)}已完成)`;if(!field.value.split(/\r?\n/).includes(note)){field.value=[field.value.trim(),note].filter(Boolean).join('\n');form._pendingGenerated.add(note);}}}
function schedulePendingWorkLogItems(){
 scheduleMaintenancePendingItems();
 clearTimeout(pendingLogTimer);const revision=++pendingLogRevision,modal=document.querySelector('#simpleModal'),form=document.querySelector('#modalForm');if(modal?.dataset.type!=='workLogModal'||!form)return;
 removeGeneratedPendingNotes(form);form._pendingLogItems=[];
 const anchor=form.elements.pendingContent?.closest('label');if(!anchor)return;
 let host=form.querySelector('[data-pending-work-log-items]');if(!host){host=document.createElement('fieldset');host.className='worker-picker span-2';host.dataset.pendingWorkLogItems='';anchor.after(host);}
 host.hidden=true;host.replaceChildren();if(anchor.hidden)return;
 let project;try{project=workLogSaveProject(workLogOriginalProject());}catch{return;}
 const date=form.elements.logDate?.value;if(!project?.id||!date)return;
 host.hidden=false;host.textContent='正在讀取先前日誌的未完成項目…';
 pendingLogTimer=setTimeout(async()=>{const current=()=>revision===pendingLogRevision&&host.isConnected&&modal.dataset.type==='workLogModal'&&modal.classList.contains('open');try{
  const data=await apiRequest({method:'GET',scope:'pending_work_log_items',projectId:project.id,from:date,excludeId:modal.dataset.id||''});if(!current())return;
  form._pendingLogItems=data.items||[];const writable=!modal.dataset.id||canWorkLog('UPDATE',modal.dataset.id);
  host.innerHTML='<legend>先前日誌未完成項目</legend><p>勾選後會填入本日已完成內容；儲存成功後，原日誌的「未完成」會保留事項並標示完成日期，不移入原日誌的「已完成」。原日誌仍有其他待辦時維持未完成。</p>'+form._pendingLogItems.map((row,index)=>`<label><input type="checkbox" data-pending-log-index="${index}" ${row.can_complete&&writable?'':'disabled'}><span>${esc(row.log_date)}｜${esc(row.pending_text)}${row.can_complete?'':'（無修改原日誌權限）'}</span></label>`).join('');host.hidden=!form._pendingLogItems.length;
 }catch(error){if(current())host.textContent='先前日誌待辦讀取失敗：'+error.message;}},200);
}
document.addEventListener('change',event=>{const form=event.target.closest('#modalForm');if(!form)return;
 if(event.target.name==='useSubcontractors')form.elements.subcontractorCount.disabled=!event.target.checked;
 if(event.target.name==='reporterOffSite')syncReporterAttendance(form);
 if(event.target.matches('[data-pending-log-index]'))syncPendingNotes(form);
 if(['customerCategory','customerId','departmentId','projectName','workType','constructionItemId','logDate'].includes(event.target.name)||event.target.id==='workLogProjectChoice')schedulePendingWorkLogItems();
});
document.addEventListener('input',event=>{if(event.target.closest('#modalForm')&&event.target.name==='projectName')schedulePendingWorkLogItems();});
