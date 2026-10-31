// Management uses work_assignments; the Dashboard remains the assignee's inbox.
let assignmentManagementRows=[],assignmentManagementLoading=false,assignmentManagementGeneration=0,assignmentManagementUser='';
function canAssignmentManage(action='VIEW'){return canModule('appointments')&&canModule('projects')&&canModule('projects',action);}
function renderAssignmentManagement(){
 const host=document.querySelector('#assignmentManagementTable');if(!host)return;
 if(assignmentManagementUser!==(state.currentUser?.id||'')){assignmentManagementUser=state.currentUser?.id||'';assignmentManagementRows=[];assignmentManagementGeneration++;assignmentManagementLoading=false;}
 if(!canAssignmentManage())assignmentManagementRows=[];
 document.querySelector('#assignmentManagementPane [data-open="workAssignmentModal"]').hidden=!canAssignmentManage('CREATE');
 const status=document.querySelector('#assignmentManagementStatus').value,search=document.querySelector('#assignmentManagementSearch').value;
 const rows=assignmentManagementRows.filter(row=>(!status||(status==='active'?['pending','in_progress'].includes(row.status):row.status===status))&&matches([row.project,row.project_code,row.customer,row.assignee,row.creator,row.instructions],search));
 host.innerHTML=rows.map(row=>`<tr><td><strong>${esc(row.project_code)}｜${esc(row.project)}</strong><small>${esc(row.customer)}</small></td><td><strong>${esc(row.assignee)}</strong><small>指派人：${esc(row.creator)}</small></td><td>${row.assignment_type==='pickup'?'取貨工作':'一般工作'}<small>${esc(row.instructions)}</small>${assignmentPlanningSummary(row)}</td><td>${esc(APPOINTMENT_STATUSES.find(([key])=>key===row.status)?.[1]||row.status)}${row.completed_at?`<small>${esc(formatDateTime(row.completed_at))}</small>`:''}</td><td class="actions">${['pending','in_progress'].includes(row.status)?`${canAssignmentManage('UPDATE')?`<button type="button" data-assignment-edit="${esc(row.id)}">修改</button>`:''}${canAssignmentManage('DELETE')?`<button type="button" data-assignment-cancel="${esc(row.id)}">刪除／取消指派</button>`:''}`:'歷史紀錄保留'}</td></tr>`).join('')||emptyRow(5,assignmentManagementLoading?'載入中…':canAssignmentManage()?'沒有符合條件的工作指派':'沒有工作指派查看權限');
}
async function loadAssignmentManagement(){
 renderAssignmentManagement();const generation=++assignmentManagementGeneration;assignmentManagementRows=[];assignmentManagementLoading=true;renderAssignmentManagement();
 const notice=document.querySelector('#assignmentManagementNotice');notice.textContent='';
 try{
  if(!canAssignmentManage())return;
  const data=PREVIEW_MODE?{records:(state.dashboard.assignments?.pending||[]).filter(row=>['general','pickup'].includes(row.assignment_type))}:await apiRequest({method:'GET',scope:'assignment_management'});
  if(generation!==assignmentManagementGeneration)return;
  assignmentManagementRows=data.records||[];
 }catch(error){if(generation===assignmentManagementGeneration)notice.textContent=error.message;}
 finally{if(generation===assignmentManagementGeneration){assignmentManagementLoading=false;renderAssignmentManagement();}}
}
function populateAssignmentEdit(id){
 const row=byId(assignmentManagementRows,id),form=document.querySelector('#modalForm');if(!row||!['pending','in_progress'].includes(row.status))throw Error('此指派已變更，請重新整理。');
 form.elements.assignmentProjectMode.value='existing';form.elements.assignmentProjectMode.disabled=true;
 form.elements.customerId.value='';form.elements.customerCategory.value='';syncWorkAssignmentFields();
 form.elements.assignmentProjectId.value=row.project_id;syncAssignmentPlanningFields();
 form.elements.assignmentPlanId.value=row.construction_plan_id||'';syncAssignmentPlanningFields();form.elements.assignmentPlanItemId.value=row.construction_item_id||'';
 form.querySelectorAll('[name="assigneeUserIds"]').forEach(input=>{input.checked=input.value===row.assignee_user_id;});
 form.elements.instructions.value=row.instructions;form.elements.assignmentType.value=row.assignment_type;form.elements.assignmentType.disabled=true;
 if(row.assignment_type==='pickup'){form.elements.pickupCategoryId.value=byId(state.inventory,row.inventory_item_id)?.categoryId||'';syncWorkAssignmentFields();form.elements.inventoryItemId.value=row.inventory_item_id;form.elements.pickupQuantity.value=row.pickup_quantity;}
 form.querySelector('#workAssignmentPickupFields').disabled=true;
 form.querySelector('[type="submit"]').textContent='儲存修改';
 form.querySelector('.form-submit').insertAdjacentHTML('beforebegin',selectField('assignmentStatus','工作狀態',[['pending','待處理'],['in_progress','處理中']],row.status));
 const picker=form.querySelector('[name="assigneeUserIds"]')?.closest('fieldset');if(picker){const hint=picker.querySelector('p');if(hint)hint.textContent='修改此筆指派請選擇一位責任人；其他人的指派與完成歷史不變。';}
}
async function saveAssignmentEdit(id,form){
 if(!canAssignmentManage('UPDATE'))throw Error('沒有修改工作指派權限。');
 const row=byId(assignmentManagementRows,id),users=[...new FormData(form).getAll('assigneeUserIds')];if(!row||users.length!==1)throw Error('請選擇一位責任人。');
 const payload={id,row_version:row.row_version,project_id:form.elements.assignmentProjectId.value,assignee_user_id:users[0],instructions:form.elements.instructions.value.trim(),status:form.elements.assignmentStatus.value,construction_plan_id:form.elements.assignmentPlanId.value||null,construction_item_id:form.elements.assignmentPlanItemId.value||null};
 if(PREVIEW_MODE)throw Error('此功能請使用隔離資料庫測試網站。');
 await apiRequest({operation:'update_work_assignment',payload});loadedScopes.clear();await loadAssignmentManagement();showToast('工作指派已修改');
}
document.addEventListener('click',async event=>{
 const tab=event.target.closest('[data-appointment-tab]');if(tab){const assignments=tab.dataset.appointmentTab==='assignments';document.querySelector('#appointmentListPane').hidden=assignments;document.querySelector('#assignmentManagementPane').hidden=!assignments;document.querySelectorAll('[data-appointment-tab]').forEach(button=>button.classList.toggle('active',button===tab));if(assignments)await loadAssignmentManagement();return;}
 const edit=event.target.closest('[data-assignment-edit]');if(edit){await openWorkAssignmentModal(edit.dataset.assignmentEdit);return;}
 const cancel=event.target.closest('[data-assignment-cancel]');if(!cancel||!canAssignmentManage('DELETE')||cancel.disabled)return;
 const row=byId(assignmentManagementRows,cancel.dataset.assignmentCancel);if(!row||!confirm('確定刪除／取消這筆工作指派？只取消指派關係，工作內容、客戶、工作日誌、施工規劃及取貨紀錄都會保留。'))return;
 cancel.disabled=true;
 try{if(PREVIEW_MODE)throw Error('此功能請使用隔離資料庫測試網站。');await apiRequest({operation:'cancel_work_assignment',payload:{id:row.id,row_version:row.row_version}});loadedScopes.clear();await loadAssignmentManagement();showToast('工作指派已取消，原工作資料保留');}catch(error){showToast(error.message,'取消失敗');}finally{cancel.disabled=false;}
});
document.querySelector('#assignmentManagementReload').addEventListener('click',loadAssignmentManagement);
document.querySelector('#assignmentManagementStatus').addEventListener('change',renderAssignmentManagement);
document.querySelector('#assignmentManagementSearch').addEventListener('input',renderAssignmentManagement);
