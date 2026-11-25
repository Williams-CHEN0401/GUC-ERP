// Shared catalog only; customer-services.js retains per-customer assignments.
function contractServiceDeleteReason(row){
 if(["phone_system","surveillance"].includes(row.code))return "系統必要承攬，可改名但不能刪除";
 if(!row.active)return "已停用";
 return "";
}
function applyContractServiceCatalogSnapshot(snapshot){
 if(Object.prototype.hasOwnProperty.call(snapshot,"contract_service_types")){
  const rows=snapshot.contract_service_types||[];
  state.contractServiceTypes=rows.map(r=>({id:r.id,code:r.code,name:r.name,active:r.is_active!==false,sortOrder:r.sort_order||0,rowVersion:r.row_version}));
  state.contractServicesReady=rows.every(r=>Number.isInteger(r.row_version)&&r.row_version>0);
 }
 if((snapshot.errors||[]).some(e=>e.dataset==="contract_service_types"))state.contractServicesReady=false;
}
function renderContractServiceCatalog(){
 const host=document.querySelector("#contractServiceTable");if(!host)return;
 const search=searchValue(document.querySelector("#contractServiceSearch"));
 const rows=state.contractServiceTypes.filter(r=>matches([r.name],search)).sort((a,b)=>a.sortOrder-b.sortOrder||a.name.localeCompare(b.name,"zh-Hant"));
 host.innerHTML=rows.map(row=>{
  const count=state.customers.filter(c=>(c.contractServiceCodes||[]).includes(row.code)).length,reason=contractServiceDeleteReason(row),ready=state.contractServicesReady;
  return `<tr><td><strong>${esc(row.name)}</strong>${row.active?"":"<small>已停用</small>"}</td><td>${count}</td><td class="actions">${canModule("customers","UPDATE")?`<button type="button" data-edit-contract-service="${esc(row.id)}" ${ready?"":"disabled"}>修改</button>`:""}${canModule("customers","DELETE")?`<button type="button" data-delete-contract-service="${esc(row.id)}" ${reason||!ready?`disabled title="${esc(reason||"資料尚未就緒")}"`:""}>刪除</button>`:""}${reason?`<small>${esc(reason)}</small>`:""}</td></tr>`;
 }).join("")||emptyRow(3,"沒有符合的承攬內容");
 document.querySelector('[data-open="contractServiceModal"]').disabled=!state.contractServicesReady;
 document.querySelector("#contractServiceHint").textContent=state.contractServicesReady?"名稱同步至共用承攬表單；新增項目須先在客戶資料勾選才會出現在該客戶的日誌與附件選單。刪除自訂承攬會停用選單項目並保留既有關聯。":"承攬內容管理尚未就緒，請重新載入或確認資料庫更新已完成。";
}
function contractServiceCatalogFields(id){
 const r=byId(state.contractServiceTypes,id)||{};
 return '<p class="span-2">修改共用名稱不會變更客戶承攬、設備及歷史資料的關聯；已存在的 NAS 檔案路徑保持不變。</p>'+inputField("name","承攬內容名稱","text",true,r.name)+submitField(id?"儲存修改":"建立承攬內容");
}
async function saveContractServiceCatalog(id,data){
 if(!state.contractServicesReady||!canModule("customers",id?"UPDATE":"CREATE"))throw new Error("目前無法管理承攬內容，請確認權限與資料載入狀態。");
 const name=String(data.name||"").trim(),row=byId(state.contractServiceTypes,id),sortOrder=row?.sortOrder??Math.min(100000,Math.max(0,...state.contractServiceTypes.map(item=>Number(item.sortOrder)||0))+1);
 if(!name||name.length>80||!Number.isInteger(sortOrder)||sortOrder<0||sortOrder>100000)throw new Error("承攬名稱須為 1–80 個字。");
 if(id&&!row)throw new Error("承攬內容已刪除，請重新載入。");
 if(state.contractServiceTypes.some(r=>r.id!==id&&r.name.trim().toLowerCase()===name.toLowerCase()))throw new Error("此承攬內容名稱已存在。");
 await mutate(id?"update_contract_service_type":"create_contract_service_type",{name,sort_order:sortOrder,...(id?{id,row_version:row.rowVersion}:{})},id?"承攬內容已修改並同步共用選單":"承攬內容已新增",{reloadScope:"crm"});
}
function previewContractServiceCatalog(operation,payload){
 const action=operation.split("_")[0].toUpperCase(),row=byId(state.contractServiceTypes,payload.id),name=String(payload.name||"").trim();
 if(!canModule("customers",action))throw new Error("您的帳號沒有執行此操作的權限。");
 if(action!=="CREATE"&&(!row||row.rowVersion!==payload.row_version))throw new Error("此承攬內容已被更新或刪除，請重新載入後再操作。");
 if(action!=="DELETE"){
  if(!name||name.length>80||!Number.isInteger(payload.sort_order)||payload.sort_order<0||payload.sort_order>100000)throw new Error("承攬內容名稱或排序不正確。");
  if(state.contractServiceTypes.some(r=>r.id!==payload.id&&r.name.trim().toLowerCase()===name.toLowerCase()))throw new Error("此承攬內容名稱已存在。");
 }
 if(action==="CREATE"){const id=uid(),r={id,code:"custom_"+id.replaceAll("-",""),name,sortOrder:payload.sort_order,active:true,rowVersion:1};state.contractServiceTypes.push(r);return r;}
 if(action==="UPDATE"){Object.assign(row,{name,sortOrder:payload.sort_order,rowVersion:row.rowVersion+1});return row;}
 const reason=contractServiceDeleteReason(row);
 if(reason)throw new Error(reason);
 row.active=false;
 row.rowVersion++;
 return row;
}
document.addEventListener("input",event=>{if(event.target.id==="contractServiceSearch")renderContractServiceCatalog();});
document.addEventListener("click",async event=>{
 const edit=event.target.closest("[data-edit-contract-service]");
 if(edit){if(!edit.disabled&&state.contractServicesReady&&canModule("customers","UPDATE"))openModal("contractServiceModal",edit.dataset.editContractService);return;}
 const button=event.target.closest("[data-delete-contract-service]");if(!button||button.disabled||!state.contractServicesReady||!canModule("customers","DELETE"))return;
 const row=byId(state.contractServiceTypes,button.dataset.deleteContractService);if(!row||!confirm(`確定刪除「${row.name}」？此承攬將從可用選單移除，既有客戶、設備及歷史關聯會保留。`))return;
 button.disabled=true;
 try{await mutate("delete_contract_service_type",{id:row.id,row_version:row.rowVersion},"承攬內容已停用並移出共用選單",{reloadScope:"crm"});}catch(error){showToast(error.message,"刪除失敗");}finally{button.disabled=false;}
});
