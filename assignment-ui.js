// Existing assignment RPCs and page permissions remain the source of truth.
const assignmentCompletionDialog=document.querySelector('#assignmentCompletionDialog');
let assignmentCompletionRow=null,assignmentCompletionBusy=false,assignmentCompletionSaved=false;
const assignmentAcknowledgements=new Set();
let assignmentScopeUserId='',assignmentScopeChoice=null;

function assignmentPendingRows(){
  const assignments=state.dashboard.assignments||{pending:[],completed:[]};
  const adminView=canAdmin()&&Array.isArray(assignments.all_pending);
  const select=document.querySelector('#assignmentScope');
  if(assignmentScopeUserId!==state.currentUser?.id){assignmentScopeChoice=null;assignmentScopeUserId=state.currentUser?.id||'';}
  select.value=adminView?(assignmentScopeChoice||'all'):'mine';
  select.closest('label').hidden=!adminView;
  const all=adminView&&select.value==='all';
  document.querySelector('#pendingAssignmentTitle').textContent=all?'所有人的待辦':'我的待辦';
  document.querySelector('#assignmentVisibilityHint').textContent=adminView?'管理員可查看所有人的未完成工作；完成通知保留給原指派人。':'只顯示與目前登入帳號相關的未完成工作與完成通知';
  return all?assignments.all_pending:assignments.pending;
}
function groupPendingAssignments(rows){
  const groups=[],requests=new Map();
  for(const row of rows){
    // Only a persisted multi-person request identifies the same assignment.
    // Legacy rows and independent requests must not collapse by title/notes.
    if(row.assignment_type==='construction'||!row.assignment_request_id||!row.created_by_user_id){groups.push(row);continue;}
    const key=JSON.stringify([row.created_by_user_id,row.assignment_request_id]);
    let group=requests.get(key);
    if(!group){group={...row,assignment_members:[]};requests.set(key,group);groups.push(group);}
    group.assignment_members.push(row);
    group.assignee=group.assignment_members.map(member=>member.assignee||'—').join('、');
  }
  return groups;
}
function assignmentPendingCard(row){
  const ownAssignment=(row.assignment_members||[row]).find(member=>member.assignee_user_id===state.currentUser?.id);
  const mine=row.assignment_type==='construction'
    ?(state.dashboard.assignments?.pending||[]).some(item=>item.id===row.id)
    :Boolean(ownAssignment);
  const people=`<span class="assignment-people">負責人：${esc(row.assignee||'—')}${row.creator?` · 指派人：${esc(row.creator)}`:''}</span>`;
  if(row.assignment_type==='construction')return constructionAssignmentAction(row,{readOnly:!mine,people});
  return `<article class="assignment-card"><div><small>${esc(row.project_code)}｜${esc(row.customer)}</small><strong>${esc(row.project)}</strong>${people}<p>${esc(row.instructions)}</p>${assignmentPlanningSummary(row)}${row.assignment_type==='pickup'?`<span>取貨${row.assignment_members?.length>1?'（每位）':''}：${esc(row.item)} × ${esc(row.pickup_quantity)}</span>`:row.assignment_type==='appointment'?`<span>${esc(appointmentTypeLabel(row.appointment_type))} · ${esc(row.appointment_date||'')}</span>`:'<span>一般工作</span>'}</div>${mine?`<button class="primary" type="button" data-complete-assignment="${esc(ownAssignment.id)}">${row.assignment_members?.length>1?'完成我的指派':'完成'}</button>`:''}</article>`;
}
document.addEventListener('change',event=>{if(event.target.id==='assignmentScope'){assignmentScopeChoice=event.target.value==='all'?'all':'mine';renderDashboard();}});

function renderAssignmentCompletion(){
  const pickup=assignmentCompletionRow?.assignment_type==='pickup';
  document.querySelector('#assignmentCompletionTitle').textContent=assignmentCompletionSaved?'工作指派已完成':'確認完成工作指派';
  document.querySelector('#assignmentCompletionProject').textContent=assignmentCompletionRow?.project||'';
  document.querySelector('#assignmentCompletionMessage').textContent=assignmentCompletionSaved
    ?(PREVIEW_MODE?'預覽完成（僅暫存，不寫入正式資料）。請選擇後續工作頁面。':pickup?'取貨紀錄已自動建立，請勿重複登錄。是否要新增工作日誌或查看取貨？':'是否要新增工作日誌或登錄取貨？也可以稍後再處理。')
    :(pickup?'完成時會同步建立一次取貨紀錄，確定完成此工作？':'確定將此工作指派標記為完成？');
  const canLog=canPage('worklogs')&&canModule('worklogs','CREATE');
  const canPickup=canModule('pickups')&&(pickup||canModule('pickups','CREATE'));
  document.querySelector('#assignmentCompletionActions').innerHTML=assignmentCompletionSaved
    ?`<button type="button" class="primary" data-assignment-action="worklog" ${canLog?'':'disabled title="目前帳號沒有新增工作日誌權限"'}>新增工作日誌</button><button type="button" class="outline" data-assignment-action="pickup" ${canPickup?'':'disabled title="目前帳號沒有此取貨權限"'}>${pickup?'查看取貨':'登錄取貨'}</button><button type="button" class="outline" data-assignment-action="close">稍後</button>`
    :'<button type="button" class="primary" data-assignment-action="complete">確認完成</button><button type="button" class="outline" data-assignment-action="close">取消</button>';
}
function openAssignmentCompletion(row){
  if(assignmentCompletionBusy||assignmentCompletionDialog.open)return;
  assignmentCompletionRow=row;assignmentCompletionSaved=false;
  document.querySelector('#assignmentCompletionError').textContent='';
  renderAssignmentCompletion();assignmentCompletionDialog.showModal();
}
function setAssignmentCompletionBusy(busy){
  assignmentCompletionBusy=busy;
  assignmentCompletionDialog.setAttribute('aria-busy',String(busy));
  document.querySelector('#assignmentCompletionStatus').textContent=busy?'正在處理，請稍候…':'';
  if(busy)assignmentCompletionDialog.querySelectorAll('button').forEach(button=>button.disabled=true);
  else{renderAssignmentCompletion();if(assignmentCompletionDialog.open)assignmentCompletionDialog.querySelector('button:not(:disabled)')?.focus();}
}
async function refreshAssignmentsAfterWrite(){
  // A pre-write GET may already be running; do not mistake it for a fresh reread.
  await scopeRequests.get('dashboard')?.catch(()=>{});
  loadedScopes.clear();
  const snapshot=await loadScope('dashboard',{force:true,silent:true});
  if(snapshot?.errors?.length)throw Error('首頁部分資料尚未載入');
}
async function saveAssignmentCompletion(){
  if(assignmentCompletionBusy||assignmentCompletionSaved||!assignmentCompletionRow)return;
  const row=assignmentCompletionRow,payload={id:row.id,row_version:row.row_version};
  setAssignmentCompletionBusy(true);
  document.querySelector('#assignmentCompletionError').textContent='';
  try{
    const result=PREVIEW_MODE?{assignment:applyPreviewMutation('complete_work_assignment',payload)}:(await apiRequest({operation:'complete_work_assignment',payload})).result;
    if(result?.assignment?.id!==row.id||result.assignment.status!=='completed'||!result.assignment.completed_at)throw Error('尚未確認完成結果，請重新整理首頁確認狀態後再試。');
    assignmentCompletionSaved=true;
    const assignments=state.dashboard.assignments;
    assignments.pending=assignments.pending.filter(item=>item.id!==row.id);
    if(Array.isArray(assignments.all_pending))assignments.all_pending=assignments.all_pending.filter(item=>item.id!==row.id);
    if(row.created_by_user_id===state.currentUser?.id&&!assignments.completed.some(item=>item.id===row.id))assignments.completed.push({...row,...result.assignment});
    renderDashboard();renderAssignmentCompletion();setAssignmentCompletionBusy(true);
    // A failed reread must not turn a committed save into an apparent save failure.
    if(!PREVIEW_MODE)try{await refreshAssignmentsAfterWrite();}catch{
      document.querySelector('#assignmentCompletionError').textContent='工作已完成，但首頁更新失敗；請稍後重新整理，無需再次完成。';
    }
  }catch(error){
    const message=error.status===504||error.name==='TypeError'?'連線中斷或逾時，尚未確認儲存結果；請重新整理首頁確認完成狀態後再操作。':error.message||'完成失敗，請重新整理後再試。';
    document.querySelector('#assignmentCompletionError').textContent=message;
    showToast(message,'完成結果未確認');
  }finally{setAssignmentCompletionBusy(false);}
}
async function followUpAssignment(action){
  if(assignmentCompletionBusy||!assignmentCompletionSaved)return;
  const allowed=action==='worklog'?canPage('worklogs')&&canModule('worklogs','CREATE'):action==='pickup'&&canModule('pickups')&&(assignmentCompletionRow?.assignment_type==='pickup'||canModule('pickups','CREATE'));
  if(!allowed)return;
  setAssignmentCompletionBusy(true);
  try{
    // Reuse the existing pages, forms and permission checks; do not create data here.
    await switchPage(action==='worklog'?'worklogs':'transactions');
    if(action==='pickup')document.querySelector('[data-tabs="transaction"] [data-tab="pickups"]')?.click();
    assignmentCompletionDialog.close();
  }catch(error){document.querySelector('#assignmentCompletionError').textContent=`工作已完成，但頁面載入失敗：${error.message}。可以重試前往頁面。`;}
  finally{setAssignmentCompletionBusy(false);}
}
assignmentCompletionDialog.addEventListener('click',async event=>{
  const action=event.target.closest('[data-assignment-action]')?.dataset.assignmentAction;
  if(!action||assignmentCompletionBusy)return;
  if(action==='close')assignmentCompletionDialog.close();
  else if(action==='complete')await saveAssignmentCompletion();
  else await followUpAssignment(action);
});
assignmentCompletionDialog.addEventListener('cancel',event=>{if(assignmentCompletionBusy)event.preventDefault();});

async function acknowledgeAssignmentCompletion(row,button){
  if(assignmentAcknowledgements.has(row.id))return;
  assignmentAcknowledgements.add(row.id);button.disabled=true;
  let saved=false;
  try{
    const payload={id:row.id,row_version:row.row_version};
    if(PREVIEW_MODE)applyPreviewMutation('acknowledge_work_assignment',payload);
    else await apiRequest({operation:'acknowledge_work_assignment',payload});
    saved=true;
    state.dashboard.assignments.completed=state.dashboard.assignments.completed.filter(item=>item.id!==row.id);
    renderDashboard();
    if(!PREVIEW_MODE)await refreshAssignmentsAfterWrite();
    showToast('完成通知已確認');
  }catch(error){showToast(saved?'通知已確認，但首頁更新失敗；請稍後重新整理。':error.message,saved?'首頁尚未更新':'確認通知失敗');}
  finally{assignmentAcknowledgements.delete(row.id);button.disabled=false;}
}
function assignmentDashboardVisible(){
  return Boolean(accessToken&&state.currentUser&&canPage('dashboard')&&currentPage()==='dashboard'&&requestedPageFromUrl()==='dashboard'&&!document.hidden&&!assignmentCompletionDialog.open&&!assignmentAcknowledgements.size&&!document.querySelector('.login-gate.open,.system-gate.open,.modal.open,dialog[open]'));
}
async function refreshVisibleAssignments(){
  if(!assignmentDashboardVisible())return;
  try{await loadScope('dashboard',{force:true,silent:true});}catch{/* Existing load state reports the failure; the next visible refresh retries. */}
}
window.addEventListener('focus',refreshVisibleAssignments);
document.addEventListener('visibilitychange',refreshVisibleAssignments);
setInterval(refreshVisibleAssignments,30000);

// Share the same customer/category/department controls with manual creation.
function assignmentProjectMatches(project,form){
 const category=form.elements.customerCategory?.value||'',customer=form.elements.customerId?.value||'',department=form.elements.departmentId?.value||'';
 return (!category||byId(state.customers,project.customerId)?.category===category)&&(!customer||project.customerId===customer)&&(!department||project.departmentId===department);
}
function syncAssignmentProjectOptions(reset=true){
 const form=document.querySelector('#modalForm');if(document.querySelector('#simpleModal')?.dataset.type!=='workAssignmentModal'||form.elements.assignmentProjectMode.value!=='existing')return;
 const select=form.elements.assignmentProjectId,current=reset?'':select.value;
 const projects=sortRows(state.projects.filter(p=>p.status!=='completed'&&assignmentProjectMatches(p,form)),'code','asc');
 select.innerHTML='<option value="">'+(projects.length?'請選擇工作內容':'沒有符合條件的既有工作')+'</option>'+projects.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.code)+'｜'+esc(p.name)+'</option>').join('');
 select.value=projects.some(p=>p.id===current)?current:'';
 syncAssignmentPlanningFields();
 const department=form.elements.departmentId;if(department&&!department.value&&department.options.length)department.options[0].textContent='全部科室';
}
document.addEventListener('change',event=>{if(event.target.closest('#modalForm')&&['customerCategory','customerId','departmentId'].includes(event.target.name))queueMicrotask(()=>syncAssignmentProjectOptions(true));});
// Reference refresh rebuilds shared selects synchronously; reapply this form's
// filter afterward while preserving any still-valid project selection.
document.addEventListener('guc:form-references-updated',()=>queueMicrotask(()=>syncAssignmentProjectOptions(false)));

function syncAssignmentPlanningFields(){
 const form=document.querySelector('#modalForm');
 if(document.querySelector('#simpleModal')?.dataset.type!=='workAssignmentModal')return;
 const planSelect=form.elements.assignmentPlanId,itemSelect=form.elements.assignmentPlanItemId;
 if(!planSelect||!itemSelect)return;
 const projectId=form.elements.assignmentProjectMode.value==='existing'?form.elements.assignmentProjectId.value:'';
 const plans=(state.constructionPlans||[]).filter(plan=>plan.project_id===projectId&&!plan.deleted_at&&['pending','in_progress'].includes(plan.status));
 const currentPlan=planSelect.value,currentItem=itemSelect.value;
 planSelect.innerHTML=`<option value="">${!projectId?'請先選擇既有工作內容':plans.length?'不關聯施工規劃':'此工作沒有未完成的施工規劃'}</option>`+plans.map(plan=>`<option value="${esc(plan.id)}">${esc(plan.construction_date)}｜${esc(plan.content)}</option>`).join('');
 planSelect.disabled=!projectId||!plans.length;
 planSelect.value=plans.some(plan=>plan.id===currentPlan)?currentPlan:'';
 const items=(plans.find(plan=>plan.id===planSelect.value)?.items||[]).filter(item=>!item.deleted_at&&!item.is_completed);
 itemSelect.innerHTML=`<option value="">${!planSelect.value?'請先選擇施工規劃':items.length?'整筆規劃（不指定子項目）':'此規劃沒有未完成子項目'}</option>`+items.map(item=>`<option value="${esc(item.id)}">${esc(item.title)}</option>`).join('');
 itemSelect.disabled=!planSelect.value||!items.length;
 itemSelect.value=items.some(item=>item.id===currentItem)?currentItem:'';
 syncAssignmentPickupSummary();
}
function syncAssignmentPickupSummary(){
 const form=document.querySelector('#modalForm'),hint=form.querySelector('#assignmentPickupSummary');if(!hint)return;
 const count=form.querySelectorAll('[name="assigneeUserIds"]:checked').length,quantity=Number(form.elements.pickupQuantity.value)||0;
 const unit=byId(state.inventory,form.elements.inventoryItemId.value)?.unit||'';
 hint.textContent=`每位人員完成取貨指派時，各扣減 ${quantity} ${unit}；已選 ${count} 位，合計 ${quantity*count} ${unit}。若只需一人取貨，請另外建立單人取貨指派。`;
}
function assignmentPlanningSummary(row){
 return row.construction_plan_title?`<p class="form-sync-hint">施工規劃：${esc(row.construction_plan_title)}${row.construction_item_title?` ／ ${esc(row.construction_item_title)}`:''}</p>`:'';
}
document.addEventListener('change',event=>{
 if(!event.target.closest('#modalForm')||document.querySelector('#simpleModal')?.dataset.type!=='workAssignmentModal')return;
 if(['assignmentProjectId','assignmentProjectMode','assignmentPlanId'].includes(event.target.name))syncAssignmentPlanningFields();
 if(['assigneeUserIds','pickupQuantity','inventoryItemId','assignmentType'].includes(event.target.name))syncAssignmentPickupSummary();
});
document.addEventListener('input',event=>{if(event.target.name==='pickupQuantity')syncAssignmentPickupSummary();});
