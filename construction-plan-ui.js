// Construction schedules extend existing projects, users and work logs.
// Permissions here control affordances only; Gateway + RPC enforce every write.
let activeConstructionLogPlanId="",constructionViewProjectId="";
const CONSTRUCTION_PLAN_STATUSES=[["pending","未開始"],["in_progress","施工中"],["completed","已完成"],["cancelled","取消"]];
function constructionEligible(project){return project?.rawType==="construction"&&["small_purchase","tender"].includes(project.constructionCategory);}
function canManageConstruction(project){return canModule("projects","VIEW")&&canModule("projects","UPDATE")&&(canAdmin()||(state.projectWorkers||[]).some(w=>w.projectId===project?.id&&w.userId===state.currentUser?.id));}
function constructionPlanButton(project){return constructionEligible(project)?`<button type="button" class="outline" data-construction-project="${esc(project.id)}">施工規劃</button>`:"";}
function constructionPlanById(id){return (state.constructionPlans||[]).find(p=>p.id===id);}
function constructionLogDefaults(){const plan=constructionPlanById(activeConstructionLogPlanId);return plan?{projectId:plan.project_id,log_date:plan.construction_date,work_type:"工程施工",status:"in_progress",pending_content:plan.content,completed_content:"",summary:plan.content,workerIds:[state.currentUser.id]}:{};}
function mergeConstructionContext(data){
 if(invalidatePrivateCache(data)===false)throw new Error("權限已變更，請重新載入。");
 const merged={...data},projectIds=new Set((data.projects||[]).map(p=>p.id));
 const replacedLogs=new Set((lastSnapshot?.site_work_logs||[]).filter(l=>l.construction_plan_id&&projectIds.has(l.project_id)).map(l=>l.id));
 for(const key of ["projects","customers","customer_departments","site_workers","project_workers","site_work_logs","site_work_log_workers"]){
  const keyOf=r=>r.id||`${r.project_id||r.work_log_id}:${r.user_id}`;
  let previous=lastSnapshot?.[key]||[];
  if(key==="site_work_logs")previous=previous.filter(l=>!replacedLogs.has(l.id));
  if(key==="site_work_log_workers")previous=previous.filter(w=>!replacedLogs.has(w.work_log_id));
  if(key==="project_workers")previous=previous.filter(w=>!projectIds.has(w.project_id));
  merged[key]=[...new Map([...previous,...(data[key]||[])].map(r=>[keyOf(r),r])).values()];
 }
 hydrateSnapshot(merged);
}
async function openConstructionPlans(projectId){
 const data=await apiRequest({method:"GET",scope:"construction_plans",projectId});
 constructionViewProjectId=projectId;mergeConstructionContext(data);
 openModal("constructionPlanListModal",projectId);
}
function constructionPlanListFields(){
 const project=byId(state.projects,constructionViewProjectId),plans=(state.constructionPlans||[]).filter(p=>p.project_id===constructionViewProjectId).sort((a,b)=>a.construction_date.localeCompare(b.construction_date)||a.id.localeCompare(b.id));
 const customer=byId(state.customers,project?.customerId);
 return `<section class="span-2 construction-plan-section"><div class="panel-head"><div><h3>${esc(project?.code)}｜${esc(project?.name)}</h3><p>${esc(customer?.name)} · 負責人：${esc(project?.owner||"未設定")}</p></div>${canManageConstruction(project)&&constructionEligible(project)?'<button type="button" class="primary" data-new-construction-plan>新增施工規劃</button>':""}</div><div class="construction-plan-list">${plans.map(plan=>{
  const logs=state.siteData.logs.filter(log=>log.construction_plan_id===plan.id&&!log.deleted_at).sort((a,b)=>a.log_date.localeCompare(b.log_date));
  return `<article class="construction-plan-card"><header><strong>${esc(plan.construction_date)}</strong><span class="pill">${esc(CONSTRUCTION_PLAN_STATUSES.find(([value])=>value===plan.status)?.[1]||plan.status)}</span></header><p class="construction-content">${esc(plan.content)}</p><p>施工人員：${esc((plan.assignee_user_ids||[]).map(id=>byId(state.siteWorkers,id)?.displayName||"停用使用者").join("、"))}</p>${plan.notes?`<p class="construction-content">備註：${esc(plan.notes)}</p>`:""}<div class="construction-plan-actions">${plan.can_manage?`<button type="button" class="outline" data-edit-construction-plan="${esc(plan.id)}">修改規劃</button><button type="button" class="outline danger" data-delete-construction-plan="${esc(plan.id)}">刪除規劃</button>`:""}${plan.can_create_log?`<button type="button" class="primary" data-construction-log="${esc(plan.id)}">填寫工作日誌</button>`:""}</div><details class="construction-log-list"><summary>相關工作日誌（${logs.length}）</summary>${logs.map(log=>`<article><div><strong>${esc(log.log_date)} · ${esc(byId(state.siteWorkers,log.access_creator_user_id)?.displayName||"原建立人")}</strong><p class="construction-content">${esc(log.summary||"—")}</p></div><div class="construction-plan-actions"><button type="button" class="outline" data-construction-open-log="${esc(log.id)}">${canWorkLog("UPDATE",log.id)?"修改日誌":"查看日誌"}</button>${canWorkLog("DELETE",log.id)?`<button type="button" class="outline danger" data-construction-delete-log="${esc(log.id)}">刪除日誌</button>`:""}</div></article>`).join("")||'<p>尚無可查看的工作日誌。</p>'}</details></article>`;
 }).join("")||'<p class="dashboard-empty">尚未建立施工規劃。</p>'}</div></section>`;
}
function constructionPlanEditFields(id){
 const plan=constructionPlanById(id)||{},project=byId(state.projects,constructionViewProjectId);
 if(!canManageConstruction(project))throw new Error("沒有管理施工規劃的權限。");
 return `<p class="span-2">${esc(project?.code)}｜${esc(project?.name)}</p>`+inputField("constructionDate","施工日期","date",true,plan.construction_date||today())+selectField("planStatus","施工狀態",CONSTRUCTION_PLAN_STATUSES,plan.status||"pending")+inputField("planContent","施工內容","textarea",true,plan.content||"","span-2")+workerPickerField(plan.assignee_user_ids||[],{name:"constructionAssignees",legend:"指派施工人員",description:"可指派一人或多人；移除人員仍保留其歷史日誌。"})+inputField("planNotes","備註","textarea",false,plan.notes||"","span-2")+`<div class="form-submit"><button type="button" class="outline" data-construction-project="${esc(constructionViewProjectId)}">返回規劃</button><button class="primary" type="submit">儲存施工規劃</button></div>`;
}
async function saveConstructionPlan(form,id){
 if(PREVIEW_MODE)throw new Error("此預覽未連接隔離儲存服務，不能儲存施工規劃。");
 const values=new FormData(form),plan=constructionPlanById(id),assignees=values.getAll("constructionAssignees");
 if(!assignees.length)throw new Error("請至少選擇一位施工人員。");
 const payload={id:plan?.id||form.dataset.planRequestId||uid(),row_version:plan?.row_version??null,project_id:constructionViewProjectId,construction_date:values.get("constructionDate"),content:String(values.get("planContent")||"").trim(),status:values.get("planStatus"),notes:String(values.get("planNotes")||"").trim(),assignee_user_ids:assignees};
 form.dataset.planRequestId=payload.id;
 await apiRequest({operation:"save_construction_plan",payload});
 loadedScopes.delete("dashboard");closeModal(true);await openConstructionPlans(payload.project_id);showToast("施工規劃已儲存並重新讀取");
}
function initializeConstructionLog(){
 const form=document.querySelector("#modalForm"),modal=document.querySelector("#simpleModal");
 if(modal.dataset.type!=="workLogModal"||!activeConstructionLogPlanId)return;
 const plan=constructionPlanById(activeConstructionLogPlanId),project=byId(state.projects,plan?.project_id||byId(state.siteData.logs,modal.dataset.id)?.projectId);
 if(!project)return;
 form.dataset.constructionPlanId=activeConstructionLogPlanId;
 // Preserve submitted values, but prevent accidental changing of plan identity.
 for(const [name,value] of Object.entries({customerId:project.customerId,departmentId:project.departmentId||"",projectName:project.name,workType:"工程施工"})){
  const field=form.elements[name];
  if(field){field.value=value;if(field.tagName==="SELECT")field.disabled=true;else field.readOnly=true;}
  else{const hidden=document.createElement("input");hidden.type="hidden";hidden.name=name;hidden.value=value;form.append(hidden);}
 }
 for(const field of form.querySelectorAll('[name="customerCategory"],[name="customerSelectorSearch"],#workLogProjectChoice'))field.disabled=true;
 const search=form.querySelector('[name="customerSelectorSearch"]');if(search)search.closest("label").hidden=true;
 if(!form.querySelector('[data-construction-context]')){const notice=document.createElement("p");notice.dataset.constructionContext="true";notice.className="span-2 form-sync-hint";notice.textContent=`施工規劃：${plan?.construction_date||""} ${plan?.content||""}。日誌儲存不會自動完成施工規劃。`;form.prepend(notice);}
}
function constructionAssignmentAction(row){return `<span>施工安排 · ${esc(row.construction_date)}</span></div><button class="outline" type="button" data-construction-project="${esc(row.project_id)}">查看施工規劃</button>`;}
document.addEventListener("click",async event=>{
 const target=event.target.closest("[data-construction-project],[data-new-construction-plan],[data-edit-construction-plan],[data-delete-construction-plan],[data-construction-log],[data-construction-open-log],[data-construction-delete-log]");
 if(!target)return;
 event.preventDefault();if(target.disabled)return;target.disabled=true;
 try{
  if(target.hasAttribute("data-construction-project"))await openConstructionPlans(target.dataset.constructionProject);
  if(target.hasAttribute("data-new-construction-plan"))openModal("constructionPlanEditModal");
  if(target.hasAttribute("data-edit-construction-plan"))openModal("constructionPlanEditModal",target.dataset.editConstructionPlan);
  if(target.hasAttribute("data-delete-construction-plan")&&confirm("刪除此施工規劃？已有工作日誌時會保留並拒絕刪除，可改為取消。")){
   const plan=constructionPlanById(target.dataset.deleteConstructionPlan);await apiRequest({operation:"delete_construction_plan",payload:{id:plan.id,row_version:plan.row_version}});loadedScopes.delete("dashboard");await openConstructionPlans(plan.project_id);showToast("施工規劃已刪除");
  }
  if(target.hasAttribute("data-construction-log")){
   const planId=target.dataset.constructionLog;await loadScope("worklogs",{force:true,silent:true});
   const plan=constructionPlanById(planId);if(!plan?.can_create_log)throw new Error("施工指派或權限已變更，請重新查看規劃。");
   closeModal(true);await openWorkLogModal("",planId);
  }
  if(target.hasAttribute("data-construction-open-log"))await openWorkLogModal(target.dataset.constructionOpenLog);
  if(target.hasAttribute("data-construction-delete-log")&&confirm("封存此工作日誌？原施工規劃與歷史紀錄會保留。")){
   const log=byId(state.siteData.logs,target.dataset.constructionDeleteLog);await mutate("delete_standalone_work_log",{id:log.id,row_version:log.row_version,reason:"施工人員封存"},"",{reloadScope:"worklogs"});await openConstructionPlans(log.projectId);showToast("工作日誌已封存");
  }
 }catch(error){showToast(error.message,"操作未完成");}finally{target.disabled=false;}
});
