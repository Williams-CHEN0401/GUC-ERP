const PERMISSION_LABELS = {dashboard:'首頁',worklogs:'工作日誌',purchases:'進貨管理',pickups:'取貨管理',inventory:'商品與庫存',customers:'客戶管理',projects:'專案管理',suppliers:'供應商',repairs:'維修品管理',reports:'專案統計報表',backup:'資料備份／復原',settings:'系統設定',users:'使用者管理',audit:'系統日誌',site:'案場系統入口',phone:'電話設備',monitoring:'監控設備',equipment:'其他案場設備',history:'維修／設定紀錄',credentials:'設備帳密',monitoring_import:'監控 Excel 匯入'};
const PAGE_PERMISSIONS={dashboard:['dashboard'],transactions:['purchases','pickups'],repairs:['repairs'],inventory:['inventory'],crm:['customers','projects','suppliers'],worklogs:['worklogs'],materials:['reports'],backup:['backup'],settings:['settings','users','audit']};
const MODAL_PERMISSIONS={customerModal:'customers',supplierModal:'suppliers',accountModal:'users',categoryModal:'inventory',itemModal:'inventory',projectModal:'projects',pickupModal:'pickups',receiptModal:'purchases',repairModal:'repairs',workLogModal:'worklogs',workLogPickupModal:'pickups',attachmentModal:'equipment'};
function canModule(module,action='VIEW'){
 const user=state.currentUser;if(!user)return false;if(user.role==='admin')return true;
 if(Array.isArray(user.permissions))return user.permissions.some(p=>p.module===module&&p[`can_${action.toLowerCase()}`]===true);
 return ['operator','viewer'].includes(user.role)&&(action==='VIEW'||user.role==='operator'&&['worklogs','purchases','pickups','projects','repairs','site','phone','monitoring','equipment','history'].includes(module)&&action!=='DELETE');
}
function canPage(page){return PAGE_PERMISSIONS[page]?.some(module=>canModule(module))||false;}
function firstAllowedPage(){return Object.keys(PAGE_PERMISSIONS).find(canPage)||'dashboard';}
function canWorkLog(action,id){
 if(!canModule('worklogs',action))return false;
 if(!state.currentUser?.project_scoped)return true;
 const log=byId(state.siteData.logs,id),grants=state.projectAccess||[];
 return grants.some(g=>(!log||g.project_id===log.projectId)&&g.can_view&&(action==='VIEW'||g[`can_${action.toLowerCase()}_work_log`]));
}
function applyPermissionUI(){
 document.querySelectorAll('.nav-item[data-page]').forEach(el=>el.hidden=!canPage(el.dataset.page));
 document.querySelectorAll('[data-goto]').forEach(el=>el.hidden=!canPage(el.dataset.goto));
 document.querySelectorAll('[data-system-choice="sites"]').forEach(el=>el.hidden=!canModule('site'));
 document.querySelectorAll('[data-open]').forEach(el=>{const module=MODAL_PERMISSIONS[el.dataset.open];if(module)el.hidden=module==='worklogs'?!canWorkLog('CREATE'):!canModule(module,'CREATE');});
 document.querySelector('#itemBatchForm button[type=submit]').disabled=!canModule('inventory','CREATE');
 document.querySelector('#adjustForm button').disabled=!canModule('inventory','CREATE');
 for(const pane of ['items','adjust'])document.querySelectorAll('#inventory [data-tab="'+pane+'"],#inventory [data-pane="'+pane+'"]').forEach(el=>el.hidden=!canModule('inventory','CREATE'));
 for(const [tab,module]of [['users','users'],['logs','audit']])document.querySelectorAll('#settings [data-tab="'+tab+'"],#settings [data-pane="'+tab+'"]').forEach(el=>el.hidden=!canModule(module));
 document.querySelectorAll('#settings [data-tab="permissions"]').forEach(el=>el.hidden=!canAdmin());
 const scoped=state.currentUser?.project_scoped;
 if(scoped)document.querySelectorAll('[data-work-log-pickup],[data-work-log-attachment]').forEach(el=>el.hidden=true);
 for(const [scope,tabs] of Object.entries({transactions:{pickups:'pickups',receipts:'purchases'},crm:{customers:'customers',projects:'projects',suppliers:'suppliers'}})){
  const section=document.querySelector(`.page[data-page="${scope}"]`);if(!section)continue;
  for(const [tab,module]of Object.entries(tabs)){section.querySelectorAll(`[data-tab="${tab}"]`).forEach(el=>el.hidden=!canModule(module));section.querySelectorAll(`[data-pane="${tab}"]`).forEach(el=>el.hidden=!canModule(module));}
  const active=section.querySelector('.section-tabs [data-tab].active');if(active?.hidden)section.querySelector('.section-tabs [data-tab]:not([hidden])')?.click();
 }
}
let selectedRoleCode='worker',selectedAccessUser='';
function renderPermissionSettings(){
 const host=document.querySelector('#permissionSettings');if(!host)return;
 host.hidden=!canAdmin();if(!canAdmin()){host.replaceChildren();return;}
 const roles=state.appRoles||[],chosen=roles.find(r=>r.code===selectedRoleCode),perms=state.rolePermissions||[];
 const role=chosen||{code:'',name:'',project_scoped:false};
 host.innerHTML=`<article class="panel"><h2>角色功能權限</h2><div class="permission-toolbar"><label>角色<select id="permissionRoleChoice"><option value="">新增角色</option>${roles.map(r=>`<option value="${esc(r.code)}" ${r.code===selectedRoleCode?'selected':''}>${esc(r.name)} (${esc(r.code)})</option>`).join('')}</select></label><button type="button" class="outline" data-new-role>新增角色</button></div><form id="permissionRoleForm"><div class="permission-toolbar"><label>角色代碼<input name="code" value="${esc(role.code)}" required pattern="[a-z][a-z0-9_]{0,39}" maxlength="40" ${chosen?'readonly':''}></label><label>角色名稱<input name="name" value="${esc(role.name)}" required maxlength="80"></label><label><input type="checkbox" name="projectScoped" ${role.project_scoped?'checked':''} ${role.is_system?'disabled':''}>工作日誌限授權專案</label></div><div class="table-wrap"><table class="permission-matrix"><thead><tr><th>功能模組</th><th>查看</th><th>新增</th><th>修改</th><th>刪除</th></tr></thead><tbody>${Object.entries(PERMISSION_LABELS).map(([module,label])=>{const p=perms.find(p=>p.role_code===role.code&&p.module===module)||{};return `<tr data-permission-module="${module}"><th scope="row">${label}</th>${['view','create','update','delete'].map(action=>`<td><input type="checkbox" name="${module}_${action}" aria-label="${label} ${action}" ${p[`can_${action}`]?'checked':''} ${role.code==='admin'?'disabled':''}></td>`).join('')}</tr>`;}).join('')}</tbody></table></div><button class="primary" ${role.code==='admin'?'disabled':''}>儲存角色權限</button></form></article><article class="panel"><h2>使用者可存取專案</h2><label>使用者<select id="projectAccessUser"><option value="">請選擇使用者</option>${state.accounts.map(u=>`<option value="${u.id}" ${u.id===selectedAccessUser?'selected':''}>${esc(u.displayName)} (${esc(u.username)})</option>`).join('')}</select></label><form id="projectAccessForm"><label>搜尋專案<input id="projectAccessSearch" type="search" placeholder="專案編號或名稱"></label><div class="table-wrap permission-project-list"><table><thead><tr><th>專案</th><th>查看</th><th>新增日誌</th><th>修改日誌</th><th>刪除日誌</th></tr></thead><tbody>${(state.accessProjects||[]).map(p=>{const g=(state.projectAccess||[]).find(g=>g.user_id===selectedAccessUser&&g.project_id===p.id)||{};return `<tr data-access-project="${p.id}" data-search="${esc((p.project_code+' '+p.name).toLowerCase())}"><th scope="row">${esc(p.project_code)}｜${esc(p.name)}</th>${['view','create_work_log','update_work_log','delete_work_log'].map(action=>`<td><input type="checkbox" name="${action}" aria-label="${esc(p.name)} ${action}" ${g[`can_${action}`]?'checked':''} ${selectedAccessUser?'':'disabled'}></td>`).join('')}</tr>`;}).join('')}</tbody></table></div><button class="primary" ${selectedAccessUser?'':'disabled'}>儲存專案授權</button></form></article>`;
}
document.addEventListener('change',event=>{
 if(event.target.id==='permissionRoleChoice'){selectedRoleCode=event.target.value;renderPermissionSettings();}
 if(event.target.id==='projectAccessUser'){selectedAccessUser=event.target.value;renderPermissionSettings();}
 const row=event.target.closest('[data-permission-module],[data-access-project]');
 if(row&&event.target.type==='checkbox'){
  const view=row.querySelector('input');if(event.target===view&&!view.checked)row.querySelectorAll('input').forEach(input=>input.checked=false);else if(event.target.checked)view.checked=true;
 }
});
document.addEventListener('input',event=>{if(event.target.id==='projectAccessSearch'){const q=event.target.value.trim().toLowerCase();document.querySelectorAll('[data-access-project]').forEach(row=>row.hidden=!row.dataset.search.includes(q));}});
document.addEventListener('click',event=>{if(event.target.closest('[data-new-role]')){selectedRoleCode='';renderPermissionSettings();}});
document.addEventListener('submit',async event=>{
 const form=event.target;if(!['permissionRoleForm','projectAccessForm'].includes(form.id))return;
 event.preventDefault();if(!canAdmin())return;
 const submit=form.querySelector('button[type=submit],button.primary');if(submit.disabled)return;submit.disabled=true;
 try{
  if(form.id==='permissionRoleForm'){
   const existing=(state.appRoles||[]).find(r=>r.code===selectedRoleCode),data=new FormData(form);
   const permissions=[...form.querySelectorAll('[data-permission-module]')].map(row=>({module:row.dataset.permissionModule,...Object.fromEntries(['view','create','update','delete'].map(a=>[`can_${a}`,row.querySelector(`[name="${row.dataset.permissionModule}_${a}"]`).checked]))}));
   selectedRoleCode=String(data.get('code'));
   await mutate('save_app_role',{code:selectedRoleCode,name:data.get('name'),project_scoped:existing?.is_system?existing.project_scoped:data.has('projectScoped'),row_version:existing?.row_version??null,permissions},'角色權限已儲存',{reloadScope:'settings'});
  }else{
   const user=byId(state.accounts,selectedAccessUser),grants=[...form.querySelectorAll('[data-access-project]')].filter(row=>row.querySelector('[name=view]').checked).map(row=>({project_id:row.dataset.accessProject,...Object.fromEntries(['create_work_log','update_work_log','delete_work_log'].map(a=>[`can_${a}`,row.querySelector(`[name="${a}"]`).checked]))}));
   await mutate('save_user_project_access',{user_id:user.id,row_version:user.rowVersion,grants},'專案授權已儲存',{reloadScope:'settings'});
  }
 }catch(error){showToast(error.message,'儲存失敗');}finally{submit.disabled=false;}
});
