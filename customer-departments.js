// One customer/category/department model shared by forms, filters and receipt rows.
function customerDepartmentLabel(id){return id?(byId(state.customerDepartments||[],id)?.name||"科室資料尚未載入，請重新整理"):"尚未設定科室";}
function customerDepartmentRows(customerId,{includeId="",search=""}={}){
 return (state.customerDepartments||[]).filter(row=>row.customerId===customerId&&(row.active||row.id===includeId)&&matches([row.name],search)).sort((a,b)=>a.name.localeCompare(b.name,"zh-Hant"));
}
function customerDepartmentChoice(customerId,departmentId,{legacyCustomerId="",legacyDepartmentId="",required=true}={}){
 if(!state.customerDepartmentsReady)throw new Error("科室資料尚未載入完成，請重新載入後再試。");
 const row=byId(state.customerDepartments||[],departmentId),preserved=customerId===legacyCustomerId&&(departmentId||"")===(legacyDepartmentId||"");
 if(departmentId&&(!row||row.customerId!==customerId||!row.active&&!preserved))throw new Error("所選科室不屬於此客戶或已停用，請重新選擇。");
 if(!departmentId&&required&&!preserved&&customerDepartmentRows(customerId).length)throw new Error("此客戶已有科室，請選擇科室。");
 return departmentId||null;
}
function departmentOptionsMarkup(customerId,value="",{all=false,legacy=false}={}){
 if(!state.customerDepartmentsReady)return '<option value="">科室資料載入中或失敗，請重新載入</option>';
 if(!customerId)return '<option value="">請先選擇客戶</option>';
 const rows=all?(state.customerDepartments||[]).filter(row=>row.customerId===customerId).sort((a,b)=>a.name.localeCompare(b.name,"zh-Hant")):customerDepartmentRows(customerId,{includeId:legacy?value:""});
 const blank=all?"全部科室":legacy?"尚未設定科室":rows.length?"請選擇科室":"此客戶尚未設定科室";
 return `<option value="">${blank}</option>`+rows.map(row=>`<option value="${esc(row.id)}" ${row.id===value?"selected":""}>${esc(row.name)}${row.active?"":"（已停用）"}</option>`).join("");
}
function customerSelectorFields(customerId="",category="",departmentId="",{legacy=false,required=true}={}){
 return `<div class="customer-department-selector span-2" data-customer-selector data-legacy-customer="${legacy?esc(customerId):""}" data-legacy-department="${legacy?esc(departmentId):""}" data-required="${required}"><label class="customer-selector-search">搜尋客戶<input type="search" name="customerSelectorSearch" placeholder="客戶編號或名稱" autocomplete="off"></label>${customerCategoryOptions(category)}${customerOptions(customerId,category)}<label>科室<select name="departmentId">${departmentOptionsMarkup(customerId,departmentId,{legacy})}</select></label><input type="hidden" name="categoryId" value="${esc(state.customerCategories.find(row=>row.code===category)?.id||"")}"></div>`;
}
function syncModalDepartmentOptions(reset=false){
 const form=document.querySelector("#modalForm"),host=form?.querySelector("[data-customer-selector]");if(!host)return;
 const customer=form.elements.customerId?.value||"",select=form.elements.departmentId,value=reset?"":select.value;
 const legacy=host.dataset.legacyCustomer===customer&&host.dataset.legacyDepartment===(value||"");
 select.innerHTML=departmentOptionsMarkup(customer,value,{legacy});
 select.disabled=!customer||!state.customerDepartmentsReady;
 select.required=host.dataset.required==="true"&&!legacy&&customerDepartmentRows(customer).length>0;
 if(form.elements.categoryId)form.elements.categoryId.value=state.customerCategories.find(row=>row.code===form.elements.customerCategory?.value)?.id||"";
 const search=valueText((form.elements.customerSelectorSearch?.value||"").trim());
 [...form.elements.customerId.options].forEach(option=>option.hidden=!!option.value&&option.value!==customer&&!matches([option.text],search));
}
function modalDepartmentValue({project=null}={}){
 const form=document.querySelector("#modalForm"),host=form.querySelector("[data-customer-selector]"),customer=form.elements.customerId?.value||project?.customerId||"",department=form.elements.departmentId?.value??project?.departmentId??"";
 if(project&&(project.customerId!==customer||(project.departmentId||"")!==department))throw new Error("所選工作內容與客戶／科室不一致，請重新選擇。");
 return customerDepartmentChoice(customer,department,{legacyCustomerId:project?.customerId||host?.dataset.legacyCustomer||"",legacyDepartmentId:project?.departmentId||host?.dataset.legacyDepartment||"",required:host?.dataset.required!=="false"});
}
function projectMatchesDepartment(project,value){return value===undefined||value==="*"||(project.departmentId||"")===(value||"");}
function workLogDepartmentValue(existingProject,customerId,projectName){
 if(!existingProject&&typeof isNewRepairWorkLog==="function"&&isNewRepairWorkLog())return modalDepartmentValue();
 const project=existingProject||state.projects.find(row=>row.customerId===customerId&&valueText(row.name.trim())===valueText(projectName.trim()));
 return modalDepartmentValue({project:project||null});
}
function assertProjectCustomerNameUnique(id,customerId,name){
 if(state.projects.some(row=>row.id!==id&&row.customerId===customerId&&valueText(row.name.trim())===valueText(name.trim())))throw new Error("此客戶已有相同名稱的工作內容；不同科室請使用不同工作內容名稱。");
}
function modalDepartmentFilter(){return document.querySelector('#modalForm [name="departmentId"]')?.value;}
function syncDepartmentFilter(customerSelector,departmentSelector,{reset=false}={}){
 const customer=document.querySelector(customerSelector),select=document.querySelector(departmentSelector);if(!customer||!select)return;
 const value=reset?"":select.value;
 select.innerHTML=departmentOptionsMarkup(customer.value,value,{all:true,legacy:true});
 select.disabled=!customer.value||!state.customerDepartmentsReady;
 if([...select.options].some(option=>option.value===value))select.value=value;
}
function renderCustomerDepartments(){
 const host=document.querySelector("#customerDepartmentTable");if(!host)return;
 const category=document.querySelector("#departmentCustomerCategory"),customer=document.querySelector("#departmentCustomer"),oldCategory=category.value,oldCustomer=customer.value;
 category.innerHTML='<option value="">請選擇分類</option>'+customerCategoryChoices().map(([code,name])=>`<option value="${esc(code)}">${esc(name)}</option>`).join("");category.value=oldCategory;
 customer.innerHTML='<option value="">請選擇客戶</option>'+state.customers.filter(row=>row.category===category.value).map(row=>`<option value="${esc(row.id)}">${esc(row.code)}｜${esc(row.name)}</option>`).join("");customer.value=oldCustomer;customer.disabled=!category.value;
 const search=valueText(document.querySelector("#customerDepartmentSearch").value.trim()),status=document.querySelector("#customerDepartmentStatus").value;
 const rows=(state.customerDepartments||[]).filter(row=>row.customerId===customer.value&&matches([row.name],search)&&(!status||String(row.active)===status));
 host.innerHTML=rows.map(row=>`<tr><td><strong>${esc(row.name)}</strong></td><td>${row.active?"啟用":"已停用"}</td><td class="actions">${canModule("customers","UPDATE")?`<button type="button" data-edit-department="${esc(row.id)}">修改</button>${row.active?"":`<button type="button" data-activate-department="${esc(row.id)}">重新啟用</button>`}`:""}${row.active&&canModule("customers","DELETE")?`<button type="button" data-deactivate-department="${esc(row.id)}">停用</button>`:""}</td></tr>`).join("")||emptyRow(3,customer.value?"沒有符合的科室":"請先選擇客戶分類與客戶");
 document.querySelector('[data-open="customerDepartmentModal"]').disabled=!customer.value||!state.customerDepartmentsReady;
 host.querySelectorAll("button").forEach(button=>button.disabled=!state.customerDepartmentsReady);
 document.querySelector("#customerDepartmentHint").textContent=state.customerDepartmentsReady?"同一客戶科室名稱不可重複；停用保留歷史資料，不會刪除關聯。":"科室資料尚未就緒，請重新載入或確認資料庫更新已完成。";
}
function customerDepartmentModalFields(id){
 const row=byId(state.customerDepartments||[],id),customerId=row?.customerId||document.querySelector("#departmentCustomer").value,customer=byId(state.customers,customerId);
 return `<input type="hidden" name="departmentCustomerId" value="${esc(customerId)}"><p class="span-2">${esc(customer?.name||"")}｜科室屬於此客戶，不可轉移至其他客戶。</p>`+inputField("name","科室名稱","text",true,row?.name||"")+submitField(id?"儲存修改":"建立科室");
}
function previewCustomerDepartmentMutation(operation,payload){
 if(!state.customerDepartmentsReady)throw new Error("科室資料尚未就緒。");
 const rows=state.customerDepartments||(state.customerDepartments=[]),old=byId(rows,payload.id),name=String(payload.name||old?.name||"").trim(),customerId=payload.customer_id||old?.customerId;
 if(!byId(state.customers,customerId)||!name||name.length>120)throw new Error("請填寫有效客戶與 1 至 120 字科室名稱。");
 if(payload.id&&(!old||old.rowVersion!==payload.row_version))throw new Error("此科室已被其他使用者修改，請重新載入。");
 if(rows.some(row=>row.id!==payload.id&&row.customerId===customerId&&valueText(row.name)===valueText(name)))throw new Error("此客戶已有相同名稱的科室。");
 if(old){if(old.customerId!==customerId)throw new Error("科室不可轉移至其他客戶。");Object.assign(old,{name,active:operation==="deactivate_customer_department"?false:payload.is_active??old.active,rowVersion:old.rowVersion+1});return old;}
 const row={id:uid(),customerId,name,active:true,rowVersion:1};rows.push(row);return row;
}
document.addEventListener("input",event=>{
 if(event.target.id==="customerDepartmentSearch")renderCustomerDepartments();
 if(event.target.name==="customerSelectorSearch")syncModalDepartmentOptions(false);
});
document.addEventListener("change",event=>{
 if(event.target.id==="departmentCustomerCategory"){document.querySelector("#departmentCustomer").value="";renderCustomerDepartments();}
 if(["departmentCustomer","customerDepartmentStatus"].includes(event.target.id))renderCustomerDepartments();
 if(event.target.name==="departmentId"&&event.target.closest("#modalForm")){syncModalProjectOptions(true);syncWorkLogProjectNames();syncWorkLogProjectDefaults();if(document.querySelector("#simpleModal").dataset.type==="attachmentModal")syncAttachmentOptions({resetProject:true});}
 if(event.target.id==="worklogDepartmentFilter"){document.querySelector("#worklogProjectFilter").value="";renderWorkLogs();}
 if(event.target.id==="materialDepartment"){updateMaterialProjects(true);}
});
document.addEventListener("click",async event=>{
 const edit=event.target.closest("[data-edit-department]");if(edit){if(canModule("customers","UPDATE")&&state.customerDepartmentsReady)openModal("customerDepartmentModal",edit.dataset.editDepartment);return;}
 const button=event.target.closest("[data-deactivate-department],[data-activate-department]");if(!button||button.disabled)return;
 const deactivate=!!button.dataset.deactivateDepartment,id=button.dataset.deactivateDepartment||button.dataset.activateDepartment,row=byId(state.customerDepartments||[],id);
 if(!row||!canModule("customers",deactivate?"DELETE":"UPDATE")||!confirm(`確定${deactivate?"停用":"重新啟用"}「${row.name}」？歷史資料會保留。`))return;
 button.disabled=true;try{await mutate(deactivate?"deactivate_customer_department":"update_customer_department",{id:row.id,row_version:row.rowVersion,customer_id:row.customerId,name:row.name,is_active:!deactivate},deactivate?"科室已停用":"科室已重新啟用",{reloadScope:"crm"});}catch(error){showToast(error.message,"操作失敗");}finally{button.disabled=false;}
});
