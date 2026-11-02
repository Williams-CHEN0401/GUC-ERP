const WEBSITE_PERMISSION_GROUPS=[
 {code:'erp',label:'ERP 系統',modules:['dashboard','appointments','customers','suppliers','purchases','pickups','inventory','projects','worklogs','repairs','reports','purchase_prices','data_export','backup','system_backups','settings','users','audit']},
 {code:'accounting',label:'會計系統',modules:['quotation_dashboard','quotations','quotation_billing','quotation_invoices','accounting_payables','accounting_payroll','accounting_tax','accounting_reports','accounting_prices','performance','quotation_warranty']},
 {code:'site',label:'案場承攬系統',modules:['site','phone','monitoring','equipment','history','credentials','monitoring_import']}
];
const OPTIONAL_ROLE_MODULES=new Set(['quotation_dashboard','quotations','quotation_billing','quotation_warranty']);
function renderWebsitePermissionGroups(role,permissions){
 const expanded=new Set([...document.querySelectorAll('[data-website-group][open]')].map(el=>el.dataset.websiteGroup));
 return `<p class="permission-help">依角色設定三站入口、登入及功能操作。管理員保留完整權限；網站停用時保留原功能勾選。Excel 匯出及主資料沿用共用權限。</p>${WEBSITE_PERMISSION_GROUPS.map(group=>{
  const module='website_'+group.code,entry=permissions.find(p=>p.role_code===role.code&&p.module===module),inherited=!!role.code&&!entry&&role.code!=='admin',fixed=role.code==='admin';
  const visible=fixed||entry?.can_view===true||inherited&&group.code==='erp'||inherited&&group.code==='site'&&permissions.some(p=>p.role_code===role.code&&p.module==='site'&&p.can_view);
  const login=fixed||entry?.can_create===true||visible&&inherited;
  return `<details class="permission-website" data-website-group="${group.code}" ${expanded.has(group.code)?'open':''}><summary><span>${group.label}</span><small>${inherited?'沿用既有授權':login?'允許登入':visible?'顯示入口':'未開放'}</small></summary><div class="permission-website-body"><label class="permission-inline"><input type="checkbox" data-website-override ${inherited?'':'checked'} ${fixed?'disabled':''}>依此角色設定網站存取</label><p class="permission-help" data-website-inherited ${inherited?'':'hidden'}>${group.code==='accounting'?'目前保留既有的個別帳號授權，不會自動授權同角色的其他人。勾選「依此角色設定」後，才改由下方開關決定此角色的存取。':'目前沿用既有網站權限。勾選後可獨立控制入口與登入。'}</p><fieldset class="permission-entry" data-website-entry ${inherited||fixed?'disabled':''}><legend>網站存取</legend><div data-permission-module="${module}" data-website-permission><label class="permission-inline"><input type="checkbox" name="${module}_view" ${visible?'checked':''}>顯示入口</label><label class="permission-inline"><input type="checkbox" name="${module}_create" ${login?'checked':''}>允許登入</label><input type="hidden" name="${module}_update" value="false"><input type="hidden" name="${module}_delete" value="false"></div></fieldset><div class="table-wrap"><table class="permission-matrix"><thead><tr><th>功能</th><th>查看</th><th>新增</th><th>修改</th><th>刪除</th></tr></thead><tbody>${group.modules.map(module=>{
   const p=permissions.find(p=>p.role_code===role.code&&p.module===module)||{},legacy=OPTIONAL_ROLE_MODULES.has(module)&&inherited&&!Object.hasOwn(p,'module');
   return `<tr data-permission-module="${module}" ${legacy?'data-permission-inherited':''}><th scope="row">${PERMISSION_LABELS[module]}${legacy?'<small class="permission-legacy">沿用個別帳號授權</small>':''}</th>${['view','create','update','delete'].map(action=>`<td><input type="checkbox" name="${module}_${action}" aria-label="${PERMISSION_LABELS[module]} ${({view:'查看',create:'新增',update:'修改',delete:'刪除'})[action]}" ${fixed||p['can_'+action]?'checked':''} ${fixed||legacy?'disabled':''}></td>`).join('')}</tr>`;
  }).join('')}</tbody></table></div></div></details>`;
 }).join('')}`;
}
function collectRolePermissions(form){
 return [...form.querySelectorAll('[data-permission-module]')].filter(row=>{
  const group=row.closest('[data-website-group]'),override=group?.querySelector('[data-website-override]')?.checked;
  return !(row.hasAttribute('data-website-permission')&&!override||row.hasAttribute('data-permission-inherited')&&!override);
 }).map(row=>({module:row.dataset.permissionModule,...Object.fromEntries(['view','create','update','delete'].map(action=>['can_'+action,row.querySelector(`[name="${row.dataset.permissionModule}_${action}"]`).type==='checkbox'&&row.querySelector(`[name="${row.dataset.permissionModule}_${action}"]`).checked]))}));
}

const PERMISSION_LABELS = {quotation_dashboard:'營運總覽',quotations:'報價單管理',quotation_billing:'請款進度',quotation_warranty:'保固售後服務',accounting_tax:'年度稅費及費用分攤',accounting_payables:'貨款管理',accounting_payroll:'薪資管理',performance:'績效管理',data_export:'Excel 資料匯出（三站共用）',quotation_invoices:'發票管理',system_backups:'系統備份專用權限',purchase_prices:'進貨價格',accounting_reports:'會計工作統計',accounting_prices:'會計用料價格',appointments:'客戶預約事項',dashboard:'首頁',worklogs:'工作日誌',purchases:'進貨管理',pickups:'取貨管理',inventory:'商品與庫存',customers:'客戶管理',projects:'工作內容管理',suppliers:'供應商',repairs:'維修品管理',reports:'工作內容統計報表',backup:'資料備份／復原',settings:'系統設定',users:'使用者管理',audit:'系統日誌',site:'承攬總覽與案場管理',phone:'電話設備',monitoring:'監控設備',equipment:'其他案場設備',history:'維修／設定紀錄',credentials:'設備帳密',monitoring_import:'監控 Excel 匯入'};
const PAGE_PERMISSIONS={performance:['performance'],appointments:['appointments'],dashboard:['dashboard'],transactions:['purchases','pickups'],repairs:['repairs'],inventory:['inventory'],crm:['customers','suppliers'],projects:['projects'],worklogs:['worklogs'],materials:['reports'],backup:['system_backups'],settings:['settings','users','audit','system_backups']};
const MODAL_PERMISSIONS={workAssignmentModal:'projects',appointmentModal:'appointments',customerModal:'customers',contractServiceModal:'customers',customerCategoryModal:'customers',customerDepartmentModal:'customers',supplierModal:'suppliers',accountModal:'users',categoryModal:'inventory',itemModal:'inventory',projectModal:'projects',pickupModal:'pickups',receiptModal:'purchases',supplierReturnModal:'purchases',repairModal:'repairs',workLogModal:'worklogs',workLogPickupModal:'pickups',attachmentModal:'equipment'};
function canModule(module,action='VIEW'){
 const user=state.currentUser;if(!user)return false;if(user.role==='admin')return true;
 if(Array.isArray(user.permissions))return user.permissions.some(p=>p.module===module&&p[`can_${action.toLowerCase()}`]===true);
 if(['accounting_tax','accounting_payables','accounting_payroll','performance','purchase_prices','accounting_reports','accounting_prices','data_export','quotation_invoices','system_backups'].includes(module))return false; return ['operator','viewer'].includes(user.role)&&(action==='VIEW'||user.role==='operator'&&['worklogs','purchases','pickups','projects','repairs','site','phone','monitoring','equipment','history'].includes(module)&&action!=='DELETE');
}
function canWebsite(website,action='login'){return state.currentUser?.role==='admin'||state.currentUser?.website_access?.[website]?.[action]===true;}
function canPage(page){if(state.currentUser?.website_access&&!canWebsite('erp'))return false;if(page==="performance"&&globalThis.GUC_PUBLIC_CONFIG?.performanceEnabled!==true)return false;return page==='settings'&&state.currentUser?.private_access?.can_configure===true||PAGE_PERMISSIONS[page]?.some(module=>canModule(module))||false;}
function canManagePrivateIdentity(id){const access=state.currentUser?.private_access;if(!access?.configured||access.direct)return true;const config=access.configuration;return !config||![config.owner_user_id,...(config.viewer_user_ids||[])].includes(id);}
function firstAllowedPage(){return Object.keys(PAGE_PERMISSIONS).find(canPage)||'dashboard';}
function canWorkLog(action,id){
 if(!canModule('worklogs',action))return false;
 const plannedLog=byId(state.siteData.logs,id);
 if(plannedLog?.construction_plan_id){
  if(action==='VIEW')return true; // All rows have passed the server-side read boundary.
  return canAdmin()||plannedLog.access_creator_user_id===state.currentUser?.id;
 }
 if(!id&&typeof activeConstructionLogPlanId!=='undefined'&&activeConstructionLogPlanId)return constructionPlanById(activeConstructionLogPlanId)?.can_create_log===true;
 if(!state.currentUser?.project_scoped)return true;
 const log=byId(state.siteData.logs,id),grants=state.projectAccess||[];
 return grants.some(g=>(!log||g.project_id===log.projectId)&&g.can_view&&(action==='VIEW'||g[`can_${action.toLowerCase()}_work_log`]));
}
function applyPermissionUI(){
 document.querySelectorAll('.nav-item[data-page]').forEach(el=>el.hidden=el.hasAttribute('data-work-group')?!WORK_MANAGEMENT_PAGES.some(canPage):!canPage(el.dataset.page));
 preparePageLinks();
 document.querySelectorAll('[data-goto]').forEach(el=>el.hidden=!canPage(el.dataset.goto));
 for(const [target,website]of [['erp','erp'],['quotations','accounting'],['sites','site']])document.querySelectorAll('[data-system-choice="'+target+'"]').forEach(el=>el.hidden=!canWebsite(website,'visible'));
 document.querySelectorAll('[data-open]').forEach(el=>{const module=MODAL_PERMISSIONS[el.dataset.open];if(module)el.hidden=el.dataset.open==='workAssignmentModal'?!canAssignmentManage('CREATE'):module==='worklogs'?!canWorkLog('CREATE'):!canModule(module,'CREATE');});
 document.querySelector('#itemBatchForm button[type=submit]').disabled=!canModule('inventory','CREATE');
 document.querySelector('#adjustForm button').disabled=!canModule('inventory','CREATE');
 for(const pane of ['items','adjust'])document.querySelectorAll('#inventory [data-tab="'+pane+'"],#inventory [data-pane="'+pane+'"]').forEach(el=>el.hidden=!canModule('inventory','CREATE'));
 for(const [tab,module]of [['users','users'],['logs','audit'],['backup','system_backups']])document.querySelectorAll('#settings [data-tab="'+tab+'"],#settings [data-pane="'+tab+'"]').forEach(el=>el.hidden=!canModule(module));
 document.querySelectorAll('#settings [data-tab="permissions"]').forEach(el=>el.hidden=!canAdmin()&&!state.currentUser?.private_access?.can_configure);
 document.querySelectorAll('[data-delete-account]').forEach(el=>el.hidden=!canModule('users','DELETE')||!canManagePrivateIdentity(el.dataset.deleteAccount));
 if(typeof renderPrivateAccessUI==='function')renderPrivateAccessUI();
 const scoped=state.currentUser?.project_scoped;
 if(scoped)document.querySelectorAll('[data-work-log-pickup],[data-work-log-attachment]').forEach(el=>el.hidden=true);
 for(const [scope,tabs] of Object.entries({transactions:{pickups:'pickups',receipts:'purchases','supplier-returns':'purchases',returns:'purchases'},crm:{customers:'customers',suppliers:'suppliers'}})){
  const section=document.querySelector(`.page[data-page="${scope}"]`);if(!section)continue;
  for(const [tab,module]of Object.entries(tabs)){section.querySelectorAll(`[data-tab="${tab}"]`).forEach(el=>el.hidden=!canModule(module));section.querySelectorAll(`[data-pane="${tab}"]`).forEach(el=>el.hidden=!canModule(module));}
  const active=section.querySelector('.section-tabs [data-tab].active');if(active?.hidden)section.querySelector('.section-tabs [data-tab]:not([hidden])')?.click();
 }
}
let selectedRoleCode='worker',selectedAccessUser='',permissionRoleEditVersion=null,projectAccessEditVersion=null;
function renderPermissionSettings(){
 const host=document.querySelector('#permissionSettings');if(!host)return;
 host.hidden=!canAdmin();if(!canAdmin()){host.replaceChildren();return;}
 const roles=state.appRoles||[],chosen=roles.find(r=>r.code===selectedRoleCode),perms=state.rolePermissions||[];
 const role=chosen||{code:'',name:'',project_scoped:false};
 permissionRoleEditVersion=chosen?.row_version??null;
 projectAccessEditVersion=byId(state.accounts,selectedAccessUser)?.rowVersion??null;
 host.innerHTML=`<article class="panel"><h2>角色功能權限</h2><div class="permission-toolbar"><label>角色<select id="permissionRoleChoice"><option value="">新增角色</option>${roles.map(r=>`<option value="${esc(r.code)}" ${r.code===selectedRoleCode?'selected':''}>${esc(r.name)} (${esc(r.code)})</option>`).join('')}</select></label><button type="button" class="outline" data-new-role>新增角色</button>${chosen&&!chosen.is_system?'<button type="button" class="outline danger" data-delete-role>刪除角色</button>':''}</div><form id="permissionRoleForm"><div class="permission-toolbar"><label>角色代碼<input name="code" value="${esc(role.code)}" required pattern="[a-z][a-z0-9_]{0,39}" maxlength="40" ${chosen?'readonly':''}></label><label>角色名稱<input name="name" value="${esc(role.name)}" required maxlength="80"></label><label><input type="checkbox" name="projectScoped" ${role.project_scoped?'checked':''} ${role.is_system?'disabled':''}>工作日誌限授權工作內容</label></div>${renderWebsitePermissionGroups(role,perms)}<button class="primary" ${role.code==='admin'?'disabled':''}>儲存角色權限</button></form></article><article class="panel"><h2>使用者可存取工作內容</h2><label>使用者<select id="projectAccessUser"><option value="">請選擇使用者</option>${state.accounts.map(u=>`<option value="${u.id}" ${u.id===selectedAccessUser?'selected':''}>${esc(u.displayName)} (${esc(u.username)})</option>`).join('')}</select></label><form id="projectAccessForm"><label>搜尋工作內容<input id="projectAccessSearch" type="search" placeholder="工作內容編號或名稱"></label><div class="table-wrap permission-project-list"><table><thead><tr><th>工作內容名稱</th><th>查看</th><th>新增日誌</th><th>修改日誌</th><th>刪除日誌</th></tr></thead><tbody>${(state.accessProjects||[]).map(p=>{const g=(state.projectAccess||[]).find(g=>g.user_id===selectedAccessUser&&g.project_id===p.id)||{};return `<tr data-access-project="${p.id}" data-search="${esc((p.project_code+' '+p.name).toLowerCase())}"><th scope="row">${esc(p.project_code)}｜${esc(p.name)}</th>${['view','create_work_log','update_work_log','delete_work_log'].map(action=>`<td><input type="checkbox" name="${action}" aria-label="${esc(p.name)} ${action}" ${g[`can_${action}`]?'checked':''} ${selectedAccessUser?'':'disabled'}></td>`).join('')}</tr>`;}).join('')}</tbody></table></div><button class="primary" ${selectedAccessUser?'':'disabled'}>儲存工作內容授權</button></form></article>`;
}
document.addEventListener('change',event=>{
 const override=event.target.closest('[data-website-override]');
 if(override){const group=override.closest('[data-website-group]');group.querySelector('[data-website-entry]').disabled=!override.checked;group.querySelector('[data-website-inherited]').hidden=override.checked;group.querySelectorAll('[data-permission-inherited] input').forEach(input=>input.disabled=!override.checked);}
 if(event.target.id==='permissionRoleChoice'){selectedRoleCode=event.target.value;renderPermissionSettings();}
 if(event.target.id==='projectAccessUser'){selectedAccessUser=event.target.value;renderPermissionSettings();}
 const row=event.target.closest('[data-permission-module],[data-access-project]');
 if(row&&event.target.type==='checkbox'){
  const view=row.querySelector('input');if(event.target===view&&!view.checked)row.querySelectorAll('input').forEach(input=>input.checked=false);else if(event.target.checked)view.checked=true;
 }
});
document.addEventListener('input',event=>{if(event.target.id==='projectAccessSearch'){const q=event.target.value.trim().toLowerCase();document.querySelectorAll('[data-access-project]').forEach(row=>row.hidden=!matches([row.dataset.search],q));}});
document.addEventListener('click',async event=>{
 const remove=event.target.closest('[data-delete-role]');
 if(remove&&canAdmin()){
  const role=(state.appRoles||[]).find(r=>r.code===selectedRoleCode);
  if(!role||role.is_system||!confirm('確定刪除此角色？仍有使用者使用時將拒絕刪除。'))return;
  remove.disabled=true;
  try{await mutate('delete_app_role',{code:role.code,row_version:role.row_version},'角色已刪除',{reloadScope:'settings'});selectedRoleCode='';renderPermissionSettings();}catch(error){showToast(error.message,'刪除失敗');}finally{remove.disabled=false;}
 }
 if(event.target.closest('[data-new-role]')){selectedRoleCode='';renderPermissionSettings();}});
document.addEventListener('submit',async event=>{
 const form=event.target;if(!['permissionRoleForm','projectAccessForm'].includes(form.id))return;
 event.preventDefault();if(!canAdmin())return;
 const submit=form.querySelector('button[type=submit],button.primary');if(submit.disabled)return;submit.disabled=true;form.setAttribute('aria-busy','true');
 try{
  if(form.id==='permissionRoleForm'){
   const existing=(state.appRoles||[]).find(r=>r.code===selectedRoleCode),data=new FormData(form);
   const permissions=collectRolePermissions(form);
   selectedRoleCode=String(data.get('code'));
   await mutate('save_app_role',{code:selectedRoleCode,name:data.get('name'),project_scoped:existing?.is_system?existing.project_scoped:data.has('projectScoped'),row_version:permissionRoleEditVersion,permissions},'角色權限已儲存',{reloadScope:'settings'});
  }else{
   const user=byId(state.accounts,selectedAccessUser),grants=[...form.querySelectorAll('[data-access-project]')].filter(row=>row.querySelector('[name=view]').checked).map(row=>({project_id:row.dataset.accessProject,...Object.fromEntries(['create_work_log','update_work_log','delete_work_log'].map(a=>[`can_${a}`,row.querySelector(`[name="${a}"]`).checked]))}));
   await mutate('save_user_project_access',{user_id:user.id,row_version:projectAccessEditVersion,grants},'工作內容授權已儲存',{reloadScope:'settings'});
  }
 }catch(error){showToast(error.message,'儲存失敗');}finally{submit.disabled=false;form.removeAttribute('aria-busy');}
});
