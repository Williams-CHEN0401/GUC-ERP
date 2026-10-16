// Rendering adapters only. ERP and Accounting both consume work_content_report_v1.
const sharedReportCache=new Map(),sharedReportPending=new Set();
let sharedReportGeneration=0;
function invalidateSharedReports(){
 sharedReportGeneration++;sharedReportCache.clear();sharedReportPending.clear();
 if(currentPage()==='materials')queueMicrotask(renderProjectReport);
}
function reportProjectIncluded(project){
 const selected=document.querySelector("#materialWorkType")?.value||"";
 const keyword=document.querySelector('#materialKeyword')?.value.trim().toLocaleLowerCase()||'';
 const words=[project.code,project.name,byId(state.customers,project.customerId)?.name].join(' ').toLocaleLowerCase();
 const category=document.querySelector("#materialCustomerCategory")?.value||"";
 return (!category||byId(state.customers,project.customerId)?.category===category)&&(!keyword||words.includes(keyword))&&!["clerical","site_survey"].includes(project.rawType)&&(!selected||project.rawType===selected);
}
function sharedProjectReport(projectId,refresh=false){
 const from=document.querySelector("#materialDateFrom")?.value||"",to=document.querySelector("#materialDateTo")?.value||"",workType=document.querySelector("#materialWorkType")?.value||"";
 const key=JSON.stringify([state.currentUser?.id,state.currentUser?.permissions,state.currentUser?.private_access?.visibility_version,projectId,from,to,workType]);
 if(sharedReportCache.has(key)&&!refresh)return sharedReportCache.get(key);
 if(!sharedReportPending.has(key)&&currentPage()==="materials"){
  const generation=sharedReportGeneration;sharedReportPending.add(key);
  apiRequest({method:"GET",scope:"work_report",projectId,from,to,workType}).then(data=>{if(generation===sharedReportGeneration)sharedReportCache.set(key,data.report);}).catch(error=>{if(generation===sharedReportGeneration)sharedReportCache.set(key,{error:error.message});}).finally(()=>{if(generation===sharedReportGeneration){sharedReportPending.delete(key);renderProjectReport();}});
 }
 return sharedReportCache.get(key)||null;
}
function reportVerticalBars(rows){
 if(!rows.length)return reportEmpty("尚無統計資料","此日期區間沒有施工人員紀錄。","▥");
 const maximum=Math.max(...rows.map(r=>Number(r.constructionDays)||0),1);
 return '<p>縱軸：施工天數（天）／橫軸：施工人員</p><div class="report-vertical-bars" role="img" aria-label="人員施工天數直式長條圖">'+rows.map(r=>`<figure><strong>${formatReportNumber(r.constructionDays)} 天</strong><div class="bar-track"><div class="bar" style="height:${100*Number(r.constructionDays)/maximum}%"></div></div><figcaption>${esc(reportWorkerLabel(r))}</figcaption></figure>`).join("")+"</div>";
}
document.addEventListener("DOMContentLoaded",()=>{
 const select=document.querySelector("#materialWorkType");if(!select)return;
 const label=document.createElement('label');label.innerHTML='關鍵字<input id="materialKeyword" type="search" placeholder="工作編號、名稱、客戶">';select.closest('label').before(label);label.querySelector('input').addEventListener('input',()=>updateMaterialProjects(true));
 select.innerHTML='<option value="">所有類型</option>'+PROJECT_WORK_TYPES.filter(([code])=>!["clerical","site_survey"].includes(code)).map(([code,name])=>`<option value="${esc(code)}">${esc(name)}</option>`).join("");
 select.addEventListener("change",()=>updateMaterialProjects(true));
});
// A different browser/tab may update logs or plans. Refresh visible reports on
// focus and every 30 seconds, without touching an open editing form.
function refreshVisibleReport(){const id=document.querySelector('#materialProject')?.value;if(id&&currentPage()==='materials'&&document.visibilityState==='visible'&&!document.querySelector('#simpleModal.open'))sharedProjectReport(id,true);}
window.addEventListener('focus',refreshVisibleReport);
document.addEventListener('visibilitychange',refreshVisibleReport);
setInterval(refreshVisibleReport,30000);

document.addEventListener('click',event=>{
 if(event.target.closest('[data-gr-refresh]'))invalidateSharedReports();
 if(event.target.closest('[data-gr-reset-filters]')){
  document.querySelector('#materialKeyword').value='';document.querySelector('#materialWorkType').value='';document.querySelector('#materialCustomerCategory').value='';
  updateMaterialCustomers(true);projectReportDateContext='';renderProjectReport();
 }
});
