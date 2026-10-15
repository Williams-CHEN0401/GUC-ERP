// Reuse the work-log's existing project resolver and authorized construction API.
// Reminders never alter submitted daily notes, status or completion checkboxes.
let constructionReminderRevision=0,constructionReminderTimer;
function workLogPendingConstructionGroups(plans,projectId){
 return plans.filter(plan=>plan.project_id===projectId&&plan.status!=="cancelled").flatMap(plan=>{
  const items=(plan.items||[]).filter(item=>!item.is_completed);
  if(plan.items?.length)return items.length?[{id:plan.id,title:plan.content,items:items.map(item=>({id:item.id,title:item.title}))}]:[];
  return plan.status!=="completed"?[{id:plan.id,title:plan.content,items:[]}]:[];
 });
}
function scheduleWorkLogConstructionReminder(){
 clearTimeout(constructionReminderTimer);
 const revision=++constructionReminderRevision,modal=document.querySelector('#simpleModal'),form=document.querySelector('#modalForm');
 if(modal?.dataset.type!=="workLogModal"||!form)return;
 const pending=form.elements.pendingContent,anchor=pending?.closest('label');
 if(!anchor)return;
 let host=form.querySelector('[data-work-log-construction-reminder]');
 if(!host){host=document.createElement('aside');host.className='span-2 construction-pending-reminder';host.dataset.workLogConstructionReminder='';host.setAttribute('role','status');host.setAttribute('aria-live','polite');anchor.after(host);}
 host.hidden=true;host.replaceChildren();
 if(anchor.hidden)return;
 let project;
 try{project=workLogSaveProject(workLogOriginalProject());}catch{return;}
 if(!project?.id)return;
 host.hidden=false;host.textContent='正在確認此工作內容的未完成施工項目…';
 constructionReminderTimer=setTimeout(async()=>{
  const current=()=>revision===constructionReminderRevision&&host.isConnected&&modal.dataset.type==='workLogModal'&&modal.classList.contains('open');
  try{
   const data=await apiRequest({method:'GET',scope:'construction_plans',projectId:project.id});
   if(!current())return;
   if(invalidatePrivateCache(data)===false)throw new Error('權限已變更');
   const groups=workLogPendingConstructionGroups(data.construction_plans||[],project.id);
   if(!groups.length){host.hidden=true;host.replaceChildren();return;}
   host.innerHTML=`<strong>此工作內容仍有未完成的施工項目</strong><p>${esc(project.name)}：請確認下列項目，並在「未完成」欄位補充今天的後續工作。</p><ul>${groups.map(group=>`<li><b>${esc(group.title)}</b>${group.items.length?`<ul>${group.items.map(item=>`<li>${esc(item.title)}（尚未勾選完成）</li>`).join('')}</ul>`:'（尚未完成）'}</li>`).join('')}</ul><p>日誌標示「已完成」只代表當天工作完成；施工子項目仍須另外勾選完成。</p>`;
  }catch{
   if(current()){host.hidden=false;host.textContent='未完成施工項目暫時無法確認，請稍後重試。日誌仍可依原流程填寫。';}
  }
 },200);
}
document.addEventListener('change',event=>{
 if(event.target.closest('#modalForm')&&(['customerCategory','customerId','departmentId','projectName','workType','constructionItemId'].includes(event.target.name)||event.target.id==='workLogProjectChoice'))scheduleWorkLogConstructionReminder();
});
document.addEventListener('input',event=>{
 if(event.target.closest('#modalForm')&&event.target.name==='projectName')scheduleWorkLogConstructionReminder();
});
