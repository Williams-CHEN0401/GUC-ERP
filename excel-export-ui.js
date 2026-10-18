/* Each list contributes only its authorized resource and current filters. */
(function(){
 'use strict';
 const value=id=>document.getElementById(id)?.value||'';
 const projectFilters=prefix=>({type:value(prefix+'Type'),category:value(prefix+'Category'),customer_id:value(prefix+'Customer'),department_id:value(prefix+'Department')});
 const reportFilters=()=>({q:value('materialKeyword'),category:value('materialCustomerCategory'),customer_id:value('materialCustomer'),department_id:value('materialDepartment'),project_id:value('materialProject'),type:value('materialWorkType'),from:value('materialDateFrom'),to:value('materialDateTo'),category_id:document.querySelector('[data-gr-material-category]')?.value||''});
 const definitions=[
  ['customers','customerTable','customers',()=>({q:value('customerSearch'),category:value('customerCategoryFilter')})],
  ['customer_departments','customerDepartmentTable','customers',()=>({q:value('customerDepartmentSearch'),category:value('departmentCustomerCategory'),customer_id:value('departmentCustomer'),status:value('customerDepartmentStatus'),require_customer:true})],
  ['customer_categories','customerCategoryTable','customers',()=>({q:value('customerCategorySearch')})],
  ['contract_services','contractServiceTable','customers',()=>({q:value('contractServiceSearch')})],
  ['suppliers','supplierTable','suppliers',()=>({q:value('supplierSearch')})],
  ['inventory','inventoryTable','inventory',()=>({q:value('inventorySearch'),category_name:value('categoryFilter')})],
  ['product_categories','productCategoryTable','inventory',()=>({q:value('productCategorySearch'),status:value('productCategoryStatus')})],
  ['projects','projectTable','projects',()=>({q:value('projectSearch'),...projectFilters('projectFilter')})],
  ['construction_projects','constructionProjectTable','projects',()=>({q:value('constructionSearch'),construction_category:value('constructionCategoryFilter')})],
  ['construction_plans','constructionPlanningList','projects',()=>({q:value('planningSearch'),...projectFilters('planningFilter')})],
  ['worklogs','worklogTable','worklogs',()=>({q:value('worklogSearch'),category:value('worklogCustomerCategoryFilter'),customer_id:value('worklogCustomerFilter'),department_id:value('worklogDepartmentFilter'),project_id:value('worklogProjectFilter'),type:value('worklogTypeFilter')})],
  ['receipts','receiptTable','purchases',()=>({q:value('receiptSearch'),from:value('receiptDateFrom'),to:value('receiptDateTo'),supplier_id:value('receiptScopeFilter')})],
  ['pickups','pickupTable','pickups',()=>({q:value('pickupSearch'),from:value('pickupDateFrom'),to:value('pickupDateTo'),project_id:value('pickupScopeFilter')})],
  ['repairs','repairTable','repairs',()=>({q:value('repairSearch'),status:value('repairStatusFilter')})],
  ['appointments','appointmentTable','appointments',()=>({q:value('appointmentSearch'),...projectFilters('appointmentFilter'),status:value('appointmentFilterStatus'),assignee:value('appointmentFilterAssignee'),from:value('appointmentFilterFrom'),to:value('appointmentFilterTo')})],
  ['users','userTable','users',()=>({q:value('userSearch')})],
  ['assignments','pendingAssignmentList','dashboard',()=>({})],
  ['dashboard_projects','activeProjectList','projects',()=>({}),'匯出全部待辦 Excel'],
  ['dashboard_worklogs','dashboardWorklogTable','worklogs',()=>({}),'匯出前日日誌 Excel'],
  ['dashboard_repairs','dashboardRepairTable','repairs',()=>({}),'匯出維修品 Excel'],
  ['dashboard_construction','constructionProgressDashboard','dashboard',()=>({}),'匯出負責的施工規劃 Excel'],
  ['audit','logTable','audit',()=>Object.fromEntries(new URLSearchParams(auditPage.filters))],
  ['report_materials','materialSummary','reports',reportFilters,'匯出用料 Excel'],
  ['report_material_rows','materialSummary','reports',reportFilters,'匯出領用明細 Excel'],
  ['report_construction_plans','materialSummary','reports',reportFilters,'匯出施工規劃 Excel'],
  ['report_plan_items','materialSummary','reports',reportFilters,'匯出施工子項目 Excel'],
  ['report_personnel','materialSummary','reports',reportFilters,'匯出人員 Excel'],
  ['report_logs','materialSummary','reports',reportFilters,'匯出日誌 Excel']
 ];
 async function request(payload){const response=await fetch(API_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${accessToken}`},body:JSON.stringify({operation:'export_data',payload}),cache:'no-store'});const body=await response.json();if(!response.ok)throw Error(body.error||'匯出資料讀取失敗。');return body.result||body;}
 function closeReportMenu(restoreFocus=false){const menu=document.getElementById('reportExportMenu');if(!menu?.open)return;menu.open=false;if(restoreFocus)menu.querySelector('summary').focus();}
 function install(){for(const[resource,id,module,filters,label]of definitions){const host=document.getElementById(id);if(!host||document.querySelector(`[data-export-resource="${resource}"]`))continue;const container=host.closest('.table-card')||host;let toolbar=id==='materialSummary'?document.querySelector('#reportExportMenu .gr-export-options'):null;if(!toolbar){toolbar=container.previousElementSibling;if(!toolbar?.classList.contains('guc-export-toolbar')){toolbar=document.createElement('div');toolbar.className='guc-export-toolbar';container.before(toolbar);}}const button=document.createElement('button');button.type='button';button.className='outline';button.dataset.exportResource=resource;button.textContent=label||'匯出 Excel';button.hidden=true;toolbar.append(button);button.onclick=async()=>{if(!canModule('data_export')||!canModule(module))return;if(id==='materialSummary')closeReportMenu(true);button.disabled=true;try{const currentFilters=structuredClone(filters()),description=await request({resource,describe:true});GucExcelExport.openDialog({title:description.title,columns:description.columns,canExport:()=>canModule('data_export')&&canModule(module),load:(scope,columns)=>request({resource,scope,columns,filters:scope==='filtered'?currentFilters:{}})});}catch(error){showToast(error.message,'匯出失敗');}finally{button.disabled=false;}};}update();}
 function update(){for(const[resource,,module]of definitions){const button=document.querySelector(`[data-export-resource="${resource}"]`),hidden=!canModule('data_export')||!canModule(module);if(button&&button.hidden!==hidden)button.hidden=hidden;}const menu=document.getElementById('reportExportMenu');if(menu){menu.hidden=![...menu.querySelectorAll('[data-export-resource]')].some(button=>!button.hidden);if(menu.hidden)closeReportMenu();}}
 async function open(resource,module,filters){if(!canModule('data_export')||!canModule(module))return;try{const description=await request({resource,describe:true}),currentFilters=structuredClone(filters);GucExcelExport.openDialog({title:description.title,columns:description.columns,canExport:()=>canModule('data_export')&&canModule(module),load:(scope,columns)=>request({resource,scope,columns,filters:scope==='filtered'?currentFilters:{}})});}catch(error){showToast(error.message,'匯出失敗');}}
 globalThis.GucErpExportUI={definitions,update,open};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
 document.addEventListener('click',event=>{const menu=document.getElementById('reportExportMenu');if(menu&&!menu.contains(event.target))closeReportMenu();});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.getElementById('reportExportMenu')?.open){event.preventDefault();closeReportMenu(true);}});
 document.addEventListener('guc:form-references-updated',update);
 const observer=new MutationObserver(update);observer.observe(document.getElementById('userDisplayName'),{childList:true,subtree:true});
 // The existing construction progress card is created after the dashboard fetch.
 const dashboard=document.getElementById('dashboard');if(dashboard){const dynamic=new MutationObserver(()=>{if(document.getElementById('constructionProgressDashboard')){install();dynamic.disconnect();}});dynamic.observe(dashboard,{childList:true});}
})();
