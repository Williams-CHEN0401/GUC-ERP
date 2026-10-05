// Private visibility is enforced by the Gateway. This file only renders decisions.
function invalidatePrivateCache(snapshot){
 const next=snapshot.current_user,previous=state.currentUser;
 if(!next||!previous)return true;
 // A slower response issued before a privacy change must not restore old data.
 if(next.id===previous.id&&Number(next.private_access?.visibility_version||0)<Number(previous.private_access?.visibility_version||0))return false;
 const key=user=>JSON.stringify([user.id,user.permissions,user.private_access?.visibility_version,user.private_access?.direct]);
 if(key(next)===key(previous))return true;
 loadedScopes.clear();lastSnapshot=null;
 for(const name of ['customers','customerDepartments','customerContractServices','projects','projectWorkers','repairItems','pickups','receipts','appointments','maintenanceEvents','maintenanceEventEquipment','maintenanceEventWorkers','siteWorkLogWorkers','equipmentRegistry'])if(Array.isArray(state[name]))state[name]=[];
 for(const name of Object.keys(state.siteData||{}))if(Array.isArray(state.siteData[name]))state.siteData[name]=[];
 state.dashboard={previous_business_date:'',projects:[],repairs:[],worklogs:[],assignments:{pending:[],completed:[]}};
 return true;
}
const accessStatusLabel=value=>({pending:'待審核',approved:'已同意',rejected:'已拒絕'}[value]||'尚未申請');
function renderPrivateAccessUI(){
 const access=state.currentUser?.private_access||{},host=document.querySelector('#privateAccessSettings');
 if(host){
  host.hidden=!access.can_configure;
  // Do not erase unsaved form values when a background snapshot refreshes.
  if(access.can_configure&&(!host.contains(document.activeElement)||host.dataset.version!==String(access.visibility_version||0))){
   host.dataset.version=String(access.visibility_version||0);
   const config=access.configuration||{},users=access.configuration_users?.map(u=>({...u,displayName:u.display_name,active:true}))||state.accounts||[];
   host.innerHTML='<article class="panel"><h2>私人資料查看名單</h2><p>以既有使用者 ID 授權；一般管理員不自動取得私人資料查看權。</p><form id="privateAccessForm"><label>私人資料擁有者<select name="owner" required><option value="">請選擇既有帳號</option>'+users.filter(u=>u.active).map(u=>'<option value="'+esc(u.id)+'" '+(u.id===config.owner_user_id?'selected':'')+'>'+esc(u.displayName)+'（'+esc(u.username)+'）</option>').join('')+'</select></label><fieldset><legend>可直接查看及審核</legend><div class="private-viewer-list">'+users.filter(u=>u.active).map(u=>'<label><input type="checkbox" name="viewer" value="'+esc(u.id)+'" '+((config.viewer_user_ids||[]).includes(u.id)?'checked':'')+'><span>'+esc(u.displayName)+'（'+esc(u.username)+'）</span></label>').join('')+'</div></fieldset><input type="hidden" name="version" value="'+esc(config.row_version||'')+'"><button class="primary">儲存私人資料名單</button></form></article>';
  }
 }
 let logs=document.querySelector('#restrictedWorkLogs');
 if(!logs){logs=document.createElement('article');logs.id='restrictedWorkLogs';logs.className='panel';document.querySelector('#worklogs')?.append(logs);}
 const restricted=access.restricted_logs||[];
 if(logs){logs.hidden=!restricted.length||!canModule('worklogs');logs.innerHTML='<h2>需申請查看的工作日誌</h2><p>核准僅開放該筆日誌，不能修改，也不授予客戶或預約的存取權。</p>'+restricted.map((r,index)=>'<div class="private-access-row"><span>私人工作日誌 '+(index+1)+' · '+esc(accessStatusLabel(r.status))+'</span>'+(r.status==='approved'?'<button type="button" class="outline" data-shared-log="'+esc(r.id)+'">查看已核准日誌</button>':'<button type="button" class="outline" data-request-log="'+esc(r.id)+'" '+(r.status==='pending'?'disabled':'')+'>申請查看</button>')+'</div>').join('');}
 let notices=document.querySelector('#privateAccessNotifications');
 if(!notices){notices=document.createElement('article');notices.id='privateAccessNotifications';notices.className='panel';document.querySelector('#dashboard')?.append(notices);}
 const requests=access.requests||[];
 if(notices){notices.hidden=!requests.length;notices.innerHTML='<h2>工作日誌查看通知</h2>'+requests.map(r=>'<div class="private-access-row"><span>'+esc(r.applicant)+' · '+esc(accessStatusLabel(r.status))+'<small>'+esc(formatDateTime(r.requested_at))+'</small>'+(access.direct?'<small>'+esc(r.log_date)+' · '+esc(r.log_title)+'</small>':'')+'</span>'+(access.direct&&r.status==='pending'?'<div>'+(canModule('worklogs')?'<button class="outline" data-shared-log="'+esc(r.work_log_id)+'">檢視日誌</button>':'')+'<button class="outline" data-review-access="'+esc(r.id)+'" data-approved="true">同意</button><button class="outline" data-review-access="'+esc(r.id)+'" data-approved="false">拒絕</button></div>':'<button class="outline" data-ack-access="'+esc(r.id)+'">確認</button>')+'</div>').join('');}
 renderPrivateCustomerActions();
}
function renderPrivateCustomerActions(){
 const access=state.currentUser?.private_access||{};
 if(canAdmin()&&access.configured)document.querySelectorAll('#customerTable tr[data-row-id]').forEach(row=>{
  if(row.querySelector('[data-private-customer]'))return;
  const customer=byId(state.customers,row.dataset.rowId);if(!customer)return;
  const button=document.createElement('button');button.type='button';button.dataset.privateCustomer=customer.id;button.textContent=customer.isPrivate?'取消私人標記':'標記私人客戶';row.querySelector('.actions')?.append(button);
 });
}
async function privateMutation(operation,payload,message,scope){
 if(PREVIEW_MODE)throw new Error('唯讀預覽不會變更私人資料或授權。');
 await mutate(operation,payload,message,{reloadScope:scope});
}
document.addEventListener('submit',async event=>{
 if(event.target.id!=='privateAccessForm')return;
 event.preventDefault();const form=event.target,submit=form.querySelector('button'),data=new FormData(form);
 if(submit.disabled)return;submit.disabled=true;
 try{await privateMutation('configure_erp_private_access',{owner_user_id:data.get('owner'),viewer_user_ids:data.getAll('viewer'),row_version:data.get('version')?Number(data.get('version')):null},'私人資料名單已儲存','settings');}
 catch(error){showToast(error.message,'設定失敗');}finally{submit.disabled=false;}
});
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-request-log],[data-shared-log],[data-review-access],[data-ack-access],[data-private-customer]');
 if(!button||button.disabled)return;event.stopPropagation();button.disabled=true;
 try{
  if(button.dataset.requestLog)await privateMutation('request_work_log_access',{work_log_id:button.dataset.requestLog},'查看申請已送出','worklogs');
  if(button.dataset.reviewAccess){
   const request=state.currentUser.private_access.requests.find(r=>r.id===button.dataset.reviewAccess);
   await privateMutation('review_work_log_access',{request_id:request.id,row_version:request.row_version,approved:button.dataset.approved==='true'},'審核結果已儲存','dashboard');
  }
  if(button.dataset.ackAccess)await privateMutation('acknowledge_work_log_access',{request_id:button.dataset.ackAccess},'已確認通知','dashboard');
  if(button.dataset.privateCustomer){
   const customer=byId(state.customers,button.dataset.privateCustomer);
   if(confirm((customer.isPrivate?'取消':'設定')+'「'+customer.name+'」的私人客戶標記？'))
    await privateMutation('set_customer_private',{customer_id:customer.id,row_version:customer.rowVersion,is_private:!customer.isPrivate},'私人客戶標記已儲存','crm');
  }
  if(button.dataset.sharedLog){
   const response=await fetch(`${API_ENDPOINT}?entity=shared_work_log&id=${encodeURIComponent(button.dataset.sharedLog)}`,{headers:{Authorization:`Bearer ${accessToken}`},cache:'no-store',signal:AbortSignal.timeout(API_TIMEOUT_MS)});
   const result=await response.json();if(!response.ok)throw new Error(result.error||'無法讀取工作日誌。');
   let dialog=document.querySelector('#sharedWorkLogDialog');
   if(!dialog){dialog=document.createElement('dialog');dialog.id='sharedWorkLogDialog';dialog.className='audit-dialog';document.body.append(dialog);}
   const log=result.record;
   dialog.innerHTML='<header class="modal-head"><h2>'+esc(state.currentUser.private_access.direct?'審核日誌（唯讀）':'核准工作日誌（唯讀）')+'</h2><form method="dialog"><button aria-label="關閉">×</button></form></header><div class="audit-detail-body"><h3>'+esc(log.title)+'</h3><p>'+esc(log.log_date)+' · '+esc(log.work_type)+'</p><p class="private-log-content">'+esc(log.summary||'')+'</p>'+(log.maintenance_events||[]).map(e=>'<section><h4>'+esc(e.event_type)+'</h4><p>故障內容：'+esc(e.cause||'—')+'</p><p>處理流程：'+esc(e.handling_process||e.result||'—')+'</p><p>'+esc(e.notes||'')+'</p></section>').join('')+'</div>';
   dialog.showModal();
  }
 }catch(error){showToast(error.message,'操作失敗');}finally{button.disabled=false;}
});
