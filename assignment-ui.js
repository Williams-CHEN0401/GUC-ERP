// Existing assignment RPCs and page permissions remain the source of truth.
const assignmentCompletionDialog=document.querySelector('#assignmentCompletionDialog');
let assignmentCompletionRow=null,assignmentCompletionBusy=false,assignmentCompletionSaved=false;
const assignmentAcknowledgements=new Set();

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
