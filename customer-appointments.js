// Uses the existing assignment ID/status, customer master, permissions and table UI.
const APPOINTMENT_TYPES = [['repair','客戶報修'],['site_visit','預約場刊'],['quotation','索取報價'],['construction','預約施工']];
const APPOINTMENT_STATUSES = [['pending','待處理'],['in_progress','處理中'],['completed','已完成'],['cancelled','已取消']];
function appointmentToday(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
function appointmentAssignedDate(row){return row?.assigned_date||(row?.created_at?appointmentToday(new Date(row.created_at)):appointmentToday());}
function appointmentOverdue(row,currentDate=appointmentToday()){
  if(!['pending','in_progress'].includes(row.status)||!row.appointment_date)return false;
  const days=Number(row.reminder_days??3),due=Date.parse(row.appointment_date+'T00:00:00Z')+days*86400000;
  return Number.isInteger(days)&&days>=0&&Date.parse(currentDate+'T00:00:00Z')>=due;
}
function appointmentTypeLabel(value){return APPOINTMENT_TYPES.find(([code])=>code===value)?.[1]||value;}
function previewAppointment(payload){
  if(!canModule('appointments',payload.id?'UPDATE':'CREATE'))throw new Error('您的帳號沒有執行此操作的權限。');
  let row=byId(state.appointments||[],payload.id);
  if(payload.id&&(!row||row.row_version!==payload.row_version))throw new Error('預約事項已被更新，請重新整理。');
  if(!row){row={id:uid(),created_at:new Date().toISOString(),created_by_user_id:state.currentUser.id,row_version:0};(state.appointments||=[]).push(row);}
  Object.assign(row,{...payload,assigned_date:payload.assigned_date||appointmentAssignedDate(row),id:row.id,assignment_type:'appointment',project_id:null,row_version:row.row_version+1,completed_at:payload.status==='completed'?new Date().toISOString():null});
  const assignments=state.dashboard.assignments;assignments.pending=assignments.pending.filter(r=>r.id!==row.id);assignments.completed=assignments.completed.filter(r=>r.id!==row.id);
  const display={...row,customer:byId(state.customers,row.customer_id)?.name||'—',project:appointmentTypeLabel(row.appointment_type),assignee:byId(state.siteWorkers,row.assignee_user_id)?.displayName||'—',creator:state.currentUser.display_name};
  if(['pending','in_progress'].includes(row.status)&&row.assignee_user_id===state.currentUser.id)assignments.pending.push(display);
  if(row.status==='completed'&&row.created_by_user_id===state.currentUser.id)assignments.completed.push(display);
  return row;
}
function refreshFilterOptions(selector,options,placeholder){
  const field=document.querySelector(selector);if(!field)return;
  const value=field.value;
  const html=`<option value="">${esc(placeholder)}</option>`+options.map(([id,label])=>`<option value="${esc(id)}">${esc(label)}</option>`).join('');
  if(field.innerHTML!==html){field.innerHTML=html;field.value=options.some(([id])=>id===value)?value:'';}
}
function syncCustomerFilterGroup(prefix){
  refreshFilterOptions(`#${prefix}Category`,customerCategoryChoices(),'所有客戶分類');
  const category=document.querySelector(`#${prefix}Category`).value;
  refreshFilterOptions(`#${prefix}Customer`,state.customers.filter(c=>!category||c.category===category).map(c=>[c.id,`${c.code}｜${c.name}`]),'所有客戶');
  const customer=document.querySelector(`#${prefix}Customer`).value;
  refreshFilterOptions(`#${prefix}Department`,(state.customerDepartments||[]).filter(d=>d.customerId===customer).map(d=>[d.id,d.name]),'所有科室');
  document.querySelector(`#${prefix}Department`).disabled=!customer;
}
function customerFilterMatches(prefix,customerId,departmentId){
  const category=document.querySelector(`#${prefix}Category`).value,customer=document.querySelector(`#${prefix}Customer`).value,department=document.querySelector(`#${prefix}Department`).value;
  return (!category||byId(state.customers,customerId)?.category===category)&&(!customer||customer===customerId)&&(!department||department===departmentId);
}
function syncProjectFilters(){
  syncCustomerFilterGroup('projectFilter');
  refreshFilterOptions('#projectFilterType',PROJECT_WORK_TYPES.map(([code,label])=>[code,label]),'所有類型');
}
function projectFilterMatches(project){
  const type=document.querySelector('#projectFilterType').value;
  return (!type||project.rawType===type)&&customerFilterMatches('projectFilter',project.customerId,project.departmentId);
}
function renderAppointments(){
  if(!document.querySelector('#appointmentTable'))return;
  syncCustomerFilterGroup('appointmentFilter');
  refreshFilterOptions('#appointmentFilterAssignee',(state.siteWorkers||[]).map(u=>[u.id,u.displayName]),'所有責任人');
  const type=document.querySelector('#appointmentFilterType').value,status=document.querySelector('#appointmentFilterStatus').value,assignee=document.querySelector('#appointmentFilterAssignee').value;
  const from=document.querySelector('#appointmentFilterFrom').value,to=document.querySelector('#appointmentFilterTo').value,c=tableState.appointment;
  const rows=(state.appointments||[]).map(row=>({...row,assigned_date:appointmentAssignedDate(row),customer:byId(state.customers,row.customer_id)?.name||'—',department:customerDepartmentLabel(row.department_id),assignee:byId(state.siteWorkers,row.assignee_user_id)?.displayName||'—',typeLabel:appointmentTypeLabel(row.appointment_type),statusLabel:APPOINTMENT_STATUSES.find(([code])=>code===row.status)?.[1]||row.status})).filter(row=>
    (!type||row.appointment_type===type)&&(!status||row.status===status)&&(!assignee||row.assignee_user_id===assignee)&&(!from||row.appointment_date>=from)&&(!to||row.appointment_date<=to)&&customerFilterMatches('appointmentFilter',row.customer_id,row.department_id)&&matches([row.customer,row.department,row.instructions,row.contact_name,row.contact_phone,row.notes,row.typeLabel,row.statusLabel,row.assignee],c.search));
  const page=tablePage('appointment',sortRows(rows,c.sortKey||'appointment_date',c.direction));
  document.querySelector('#appointmentTable').innerHTML=page.rows.map(row=>`<tr class="${appointmentOverdue(row)?'appointment-overdue':''}" data-appointment-row="${esc(row.id)}"${editableRowAttributes('appointmentModal',row.id,canModule('appointments','UPDATE'))}><td>${esc(row.appointment_date)}${appointmentOverdue(row)?'<span class="badge danger">未完成提醒</span>':''}</td><td>${esc(row.customer)}</td><td>${esc(row.department)}</td><td>${esc(row.typeLabel)}</td><td>${esc(row.instructions)}</td><td>${esc(row.assignee)}</td><td>${esc(row.statusLabel)}</td><td>${esc(row.assigned_date)}</td><td class="actions">${!canModule('appointments','UPDATE')?`<button type="button" data-appointment-open="${esc(row.id)}">檢視</button>`:''}${canModule('appointments','UPDATE')&&row.status!=='cancelled'?`<button type="button" data-appointment-cancel="${esc(row.id)}">取消／停用</button>`:''}</td></tr>`).join('')||emptyRow(9);
  renderPagination('appointment','appointmentPagination',page.total);
  document.querySelector('[data-open="appointmentModal"]').hidden=!canModule('appointments','CREATE');
}
function appointmentFields(id){
  const editable=canModule('appointments',id?'UPDATE':'CREATE');
  const row=byId(state.appointments||[],id),customer=byId(state.customers,row?.customer_id);
  if(id&&!row)throw new Error('預約事項已不存在，請重新整理。');
  const users=(state.siteWorkers||[]).filter(u=>u.active!==false||u.id===row?.assignee_user_id);
  const fields=`<input name="appointmentVersion" type="hidden" value="${row?.row_version||''}">${customerSelectorFields(row?.customer_id||'',customer?.category||'',row?.department_id||'',{legacy:!!row,required:false})}${inputField('contactName','聯絡人','text',false,row?.contact_name||'')}${inputField('contactPhone','聯絡電話','text',false,row?.contact_phone||'')}${inputField('assignedDate','指派日期','date',true,appointmentAssignedDate(row)).replace('type="date"','type="date" min="0001-01-01" max="9999-12-31"')}${selectField('appointmentType','預約類型',APPOINTMENT_TYPES,row?.appointment_type||'repair')}${inputField('appointmentDate','預約日期','date',true,row?.appointment_date||appointmentToday())}${inputField('reminderDays','幾天後未完成提醒','number',true,row?.reminder_days??3).replace('type="number"','type="number" min="0" max="365" step="1"')}${selectField('assigneeUserId','責任人',[['','請選擇責任人'],...users.map(u=>[u.id,u.displayName])],row?.assignee_user_id||'')}${selectField('appointmentStatus','狀態',APPOINTMENT_STATUSES,row?.status||'pending')}${inputField('instructions','預約／報修內容','textarea',true,row?.instructions||'','span-2')}${inputField('appointmentNotes','備註','textarea',false,row?.notes||'','span-2')}${editable?submitField(id?'儲存修改':'建立預約'):''}`;
  return {title:id?(canModule('appointments','UPDATE')?'修改客戶預約事項':'檢視客戶預約事項'):'新增客戶預約事項',fields:editable?fields:`<fieldset class="span-2 form-grid" disabled>${fields}</fieldset>`};
}
async function saveAppointment(id,data){
  if(!canModule('appointments',id?'UPDATE':'CREATE'))throw new Error('您的帳號沒有執行此操作的權限。');
  await mutate('upsert_customer_appointment',{id:id||null,row_version:id?Number(data.appointmentVersion):null,customer_id:data.customerId,department_id:modalDepartmentValue(),assigned_date:data.assignedDate,appointment_type:data.appointmentType,appointment_date:data.appointmentDate,reminder_days:Number(data.reminderDays),contact_name:data.contactName,contact_phone:data.contactPhone,instructions:data.instructions,assignee_user_id:data.assigneeUserId,status:data.appointmentStatus,notes:data.appointmentNotes},id?'預約事項已修改':'預約事項已建立',{reloadScope:'appointments'});
}
document.addEventListener('change',event=>{
  const id=event.target.id;
  if(id.startsWith('projectFilter')){syncProjectFilters();tableState.project.page=1;renderProjects();}
  if(id.startsWith('appointmentFilter')){syncCustomerFilterGroup('appointmentFilter');tableState.appointment.page=1;renderAppointments();}
});
document.addEventListener('input',event=>{if(event.target.id==='appointmentSearch')setSearch('appointment',event.target.value,renderAppointments);});
document.addEventListener('click',async event=>{
  const open=event.target.closest('[data-appointment-open]');if(open)openModal('appointmentModal',open.dataset.appointmentOpen);
  const cancel=event.target.closest('[data-appointment-cancel]');if(!cancel||cancel.disabled||!canModule('appointments','UPDATE'))return;
  const row=byId(state.appointments||[],cancel.dataset.appointmentCancel);
  if(!row||!confirm('確定取消／停用此預約事項？資料保留，首頁不再列入待辦。'))return;
  cancel.disabled=true;
  try{await mutate('upsert_customer_appointment',{...row,assigned_date:appointmentAssignedDate(row),status:'cancelled'},'預約事項已取消',{reloadScope:'appointments'});}
  catch(error){showToast(error.message,'操作失敗');}finally{cancel.disabled=false;}
});
