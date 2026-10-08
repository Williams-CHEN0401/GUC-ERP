// Rendering adapters only. ERP and Accounting both consume work_content_report_v1.
const sharedReportCache=new Map(),sharedReportPending=new Set();
function reportProjectIncluded(project){
 const selected=document.querySelector("#materialWorkType")?.value||"";
 return !["clerical","site_survey"].includes(project.rawType)&&(!selected||project.rawType===selected);
}
function sharedProjectReport(projectId){
 const from=document.querySelector("#materialDateFrom")?.value||"",to=document.querySelector("#materialDateTo")?.value||"",workType=document.querySelector("#materialWorkType")?.value||"";
 const key=JSON.stringify([state.currentUser?.id,state.currentUser?.permissions,state.currentUser?.private_access?.visibility_version,projectId,from,to,workType]);
 if(sharedReportCache.has(key))return sharedReportCache.get(key);
 if(!sharedReportPending.has(key)&&currentPage()==="materials"){
  sharedReportPending.add(key);
  apiRequest({method:"GET",scope:"work_report",projectId,from,to,workType}).then(data=>sharedReportCache.set(key,data.report)).catch(error=>sharedReportCache.set(key,{error:error.message})).finally(()=>{sharedReportPending.delete(key);renderProjectReport();});
 }
 return null;
}
function reportVerticalBars(rows){
 if(!rows.length)return reportEmpty("尚無統計資料","此日期區間沒有施工人員紀錄。","▥");
 const maximum=Math.max(...rows.map(r=>Number(r.constructionDays)||0),1);
 return '<p>縱軸：施工天數（天）／橫軸：施工人員</p><div class="report-vertical-bars" role="img" aria-label="人員施工天數直式長條圖">'+rows.map(r=>`<figure><strong>${formatReportNumber(r.constructionDays)} 天</strong><div class="bar-track"><div class="bar" style="height:${100*Number(r.constructionDays)/maximum}%"></div></div><figcaption>${esc(reportWorkerLabel(r))}</figcaption></figure>`).join("")+"</div>";
}
document.addEventListener("DOMContentLoaded",()=>{
 const select=document.querySelector("#materialWorkType");if(!select)return;
 select.innerHTML='<option value="">所有類型</option>'+PROJECT_WORK_TYPES.filter(([code])=>!["clerical","site_survey"].includes(code)).map(([code,name])=>`<option value="${esc(code)}">${esc(name)}</option>`).join("");
 select.addEventListener("change",()=>updateMaterialProjects(true));
});
