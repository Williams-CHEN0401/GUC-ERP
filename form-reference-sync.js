// Refresh authorized reference lists, never replace a form or its draft values.
const FORM_REFERENCE_INTERVAL_MS = 15_000;
const formReferenceRequests = new Map(), formReferenceTimes = new Map(), formReferenceFingerprints = new Map();
let formReferenceGeneration = 0;
function invalidateFormReferences(){formReferenceGeneration++;formReferenceTimes.clear();formReferenceFingerprints.clear();}
function formReferenceScopes(){
  const modal=document.querySelector('#simpleModal.open');
  const scopes={customerModal:['crm'],customerCategoryModal:['crm'],customerDepartmentModal:['crm'],contractServiceModal:['crm'],projectModal:['crm'],supplierModal:['crm'],categoryModal:['inventory'],itemModal:['inventory'],pickupModal:['transactions'],receiptModal:['transactions'],repairModal:['repairs'],workLogModal:['worklogs'],workLogPickupModal:['transactions'],workAssignmentModal:['crm','inventory'],accountModal:['settings'],attachmentModal:['worklogs']};
  if(modal)return scopes[modal.dataset.type]||[];
  const page=currentPage();return ['inventory','transactions','repairs','crm','worklogs','materials','settings'].includes(page)?[PAGE_SCOPES[page]]:[];
}
function formReferencesBusy(){return !!document.querySelector('#modalForm.busy,form[aria-busy="true"],#assignmentCompletionDialog[open]');}
function referenceSyncMessage(message){
  const form=document.querySelector('#simpleModal.open #modalForm');if(!form)return;
  let node=form.querySelector('[data-reference-status]');
  if(!node&&message){node=document.createElement('p');node.className='span-2 form-sync-hint';node.dataset.referenceStatus='';node.setAttribute('role','status');form.append(node);}
  if(node){node.textContent=message;node.hidden=!message;}
}
async function refreshVisibleFormReferences({force=false}={}){
  if(!accessToken||!state.currentUser||document.hidden||!loadedScopes.size||formReferencesBusy()||document.querySelector('.login-gate.open,.system-gate.open'))return;
  // Browser-only Preview edits must not be overwritten by production reads.
  if(PREVIEW_MODE){refreshFormReferenceChoices();return;}
  const token=accessToken,generation=formReferenceGeneration;
  await Promise.all(formReferenceScopes().map(async scope=>{
    const key=token+':'+generation+':'+scope;
    if(formReferenceRequests.has(key))return formReferenceRequests.get(key);
    if(!force&&Date.now()-(formReferenceTimes.get(scope)||0)<3000)return;
    const request=(async()=>{
      try{
        const snapshot=await apiRequest({method:'GET',scope,optionsOnly:true});
        if(token!==accessToken||generation!==formReferenceGeneration||formReferencesBusy()||!formReferenceScopes().includes(scope))return;
        const fingerprint=JSON.stringify(Object.fromEntries(Object.entries(snapshot).filter(([name])=>name!=='refreshed_at')));
        if(formReferenceFingerprints.get(key)!==fingerprint){hydrateSnapshot(snapshot,{referencesOnly:true});formReferenceFingerprints.set(key,fingerprint);}
        formReferenceTimes.set(scope,Date.now());
        referenceSyncMessage(snapshot.errors?.length?'部分選單更新失敗，已保留輸入內容；稍後會再嘗試。':'');
      }catch(error){
        if(token!==accessToken||generation!==formReferenceGeneration)return;
        if(error.status===401){logout({preservePage:true});return;}
        referenceSyncMessage('選單暫時無法更新，已保留輸入內容；請確認連線，稍後會再嘗試。');
      }finally{if(formReferenceRequests.get(key)===request)formReferenceRequests.delete(key);}
    })();formReferenceRequests.set(key,request);return request;
  }));
}
function beginFormReferenceSync(){
  const modal=document.querySelector('#simpleModal'),id=modal.dataset.id;
  const collections={customerModal:state.customers,supplierModal:state.suppliers,projectModal:state.projects,receiptModal:state.receipts,pickupModal:state.pickups,itemModal:state.inventory,categoryModal:state.categories,repairModal:state.repairItems,accountModal:state.accounts,customerCategoryModal:state.customerCategories,customerDepartmentModal:state.customerDepartments,contractServiceModal:state.contractServiceTypes,workLogModal:state.siteData.logs};
  const row=byId(collections[modal.dataset.type]||[],id);
  modal.dataset.editVersion=String(row?.rowVersion??row?.row_version??'');
  void refreshVisibleFormReferences({force:true});
}
function pinOpenFormVersion(payload){
  const modal=document.querySelector('#simpleModal.open');
  if(payload?.id&&payload.id===modal?.dataset.id&&modal.dataset.editVersion&&Object.hasOwn(payload,'row_version'))return {...payload,row_version:Number(modal.dataset.editVersion)};
  return payload;
}
// Keep the same select node, selected ID, blank choice and focus. Removed choices
// remain visible as draft values; the existing save validation stays authoritative.
function replaceReferenceOptions(select,options,{placeholder='請選擇',disabled}={}){
  if(!select)return;
  const value=select.value,prior=select.selectedOptions?.[0]?.textContent||value;
  const choices=[...(placeholder===null?[]:[['',placeholder]]),...options];
  if(value&&!choices.some(([id])=>String(id)===value))choices.push([value,prior]);
  const html=choices.map(([id,label])=>`<option value="${esc(id)}">${esc(label)}</option>`).join('');
  if(select.innerHTML!==html){select.innerHTML=html;select.value=value;}
  if(disabled!==undefined)select.disabled=disabled;
}
function refreshReferenceCheckboxes(host,name,rows){
  if(!host)return;
  for(const [value,label,active] of rows){
    let input=[...host.querySelectorAll('input[type="checkbox"]')].find(node=>node.name===name&&node.value===value);
    if(!input){const wrapper=document.createElement('label');wrapper.innerHTML=`<input type="checkbox" name="${esc(name)}" value="${esc(value)}"><span></span>`;host.append(wrapper);input=wrapper.querySelector('input');}
    input.closest('label').querySelector('span').textContent=label;
    input.disabled=active===false&&!input.checked;
  }
}
function refreshReceiptReferenceChoices(){
  const form=document.querySelector('#modalForm'),list=form?.querySelector('.receipt-customer-list');if(!list)return;
  replaceReferenceOptions(form.querySelector('#receiptCustomerCategory'),customerCategoryChoices(),{placeholder:'請選擇分類'});
  const template=document.createElement('template');template.innerHTML=receiptCustomerPicker();
  for(const fresh of template.content.querySelectorAll('[data-receipt-customer]')){
    const id=fresh.querySelector('input').value;
    const existing=[...list.querySelectorAll('[data-receipt-customer]')].find(row=>row.querySelector('input').value===id);
    if(!existing){list.append(fresh);continue;}
    existing.dataset.category=fresh.dataset.category;existing.dataset.search=fresh.dataset.search;
    existing.querySelector('label span').textContent=fresh.querySelector('label span').textContent;
    const select=existing.querySelector('select');
    replaceReferenceOptions(select,customerDepartmentRows(id,{includeId:select.value}).map(row=>[row.id,row.name]),{placeholder:customerDepartmentRows(id).length?'請選擇科室':'此客戶尚未設定科室'});
  }
  refreshReceiptCustomerPicker();
}
function refreshFormReferenceChoices(snapshot={}){
  if(formReferencesBusy())return;
  const form=document.querySelector('#modalForm'),modal=document.querySelector('#simpleModal.open'),type=modal?.dataset.type;
  const categories=state.categories.filter(row=>row.active).map(row=>[row.id,row.name]);
  document.querySelectorAll('#itemBatchRows select[name="category"]').forEach(select=>replaceReferenceOptions(select,categories));
  replaceReferenceOptions(document.querySelector('#adjustCategory'),categories,{placeholder:'請先選擇貨品種類'});
  const adjustment=document.querySelector('#adjustItem'),adjustCategory=document.querySelector('#adjustCategory')?.value;
  replaceReferenceOptions(adjustment,sortRows(state.inventory.filter(row=>row.categoryId===adjustCategory),'name','asc').map(row=>[row.id,`${row.name}｜${row.brand} ${row.model}｜${row.code}`]),{disabled:!adjustCategory});
  replaceReferenceOptions(document.querySelector('#worklogTypeFilter'),WORK_LOG_TYPES,{placeholder:'所有工作類型'});
  replaceReferenceOptions(document.querySelector('#permissionRoleChoice'),(state.appRoles||[]).map(row=>[row.code,`${row.name} (${row.code})`]),{placeholder:'新增角色'});
  replaceReferenceOptions(document.querySelector('#projectAccessUser'),state.accounts.map(row=>[row.id,`${row.displayName} (${row.username})`]),{placeholder:'請選擇使用者'});
  refreshReferenceFilters();
  const accessBody=document.querySelector('#projectAccessForm tbody'),accessUser=document.querySelector('#projectAccessUser')?.value;
  if(accessBody)for(const project of state.accessProjects||[]){
    let row=[...accessBody.querySelectorAll('[data-access-project]')].find(node=>node.dataset.accessProject===project.id);
    if(!row){row=document.createElement('tr');row.dataset.accessProject=project.id;row.innerHTML='<th scope="row"></th>'+['view','create_work_log','update_work_log','delete_work_log'].map(action=>`<td><input type="checkbox" name="${action}" aria-label="${esc(project.name)} ${action}" ${accessUser?'':'disabled'}></td>`).join('');accessBody.append(row);}
    row.querySelector('th').textContent=project.project_code+'｜'+project.name;
    row.dataset.search=(project.project_code+' '+project.name).toLowerCase();
    row.hidden=!row.dataset.search.includes((document.querySelector('#projectAccessSearch')?.value||'').trim().toLowerCase());
  }
  document.dispatchEvent(new CustomEvent('guc:form-references-updated',{detail:{datasets:Object.keys(snapshot)}}));
  if(!modal||!form)return;
  const fields=form.elements,readonly=type==='workLogModal'&&modal.dataset.id&&!canWorkLog('UPDATE',modal.dataset.id);
  if(readonly)return;
  replaceReferenceOptions(fields.customerCategory,customerCategoryChoices(),{placeholder:'請選擇分類'});
  if(type==='customerModal')replaceReferenceOptions(fields.category,customerCategoryChoices(),{placeholder:'請選擇分類'});
  if(type==='itemModal')replaceReferenceOptions(fields.category,categories);
  if(fields.customerId){
    const category=fields.customerCategory?.value,customerId=fields.customerId.value;
    replaceReferenceOptions(fields.customerId,sortRows(state.customers.filter(row=>row.category===category),'code','asc').map(row=>[row.id,`${row.code}｜${row.name}`]),{placeholder:category?'請選擇客戶':'請先選擇客戶分類',disabled:!category});
    const search=valueText((fields.customerSelectorSearch?.value||'').trim());
    [...fields.customerId.options].forEach(option=>option.hidden=!!option.value&&option.value!==customerId&&!matches([option.text],search));
    replaceReferenceOptions(fields.departmentId,customerDepartmentRows(customerId,{includeId:fields.departmentId?.value}).map(row=>[row.id,row.name]),{placeholder:customerDepartmentRows(customerId).length?'請選擇科室':'此客戶尚未設定科室',disabled:!customerId||!state.customerDepartmentsReady});
    const host=form.querySelector('[data-customer-selector]');
    if(host&&fields.departmentId)fields.departmentId.required=host.dataset.required==='true'&&!(host.dataset.legacyCustomer===customerId&&host.dataset.legacyDepartment===fields.departmentId.value)&&customerDepartmentRows(customerId).length>0;
    const original=byId(state.pickups,modal.dataset.id)?.projectId;
    replaceReferenceOptions(fields.projectId,sortRows(state.projects.filter(row=>row.customerId===customerId&&projectMatchesDepartment(row,modalDepartmentFilter())&&(type==='attachmentModal'||row.status!=='completed'||row.id===original)),'code','asc').map(row=>[row.id,`${row.code}｜${row.name}`]),{placeholder:'請選擇工作內容',disabled:!customerId});
    replaceReferenceOptions(fields.contractServiceTypeId,customerMaintenanceServices(customerId).map(row=>[row.id,row.name]),{placeholder:'請選擇承攬內容',disabled:!customerId});
  }
  if(type==='projectModal')replaceReferenceOptions(fields.type,PROJECT_WORK_TYPES.map(([code,label])=>[code,label]));
  replaceReferenceOptions(fields.workType,WORK_LOG_TYPES);
  replaceReferenceOptions(fields.assignmentProjectType,PROJECT_WORK_TYPES.map(([code,label])=>[code,label]),{placeholder:'請選擇工作類型'});
  replaceReferenceOptions(fields.assignmentProjectId,sortRows(state.projects.filter(row=>row.status!=='completed'),'code','asc').map(row=>[row.id,`${row.code}｜${row.name}`]),{placeholder:'請選擇工作內容'});
  replaceReferenceOptions(fields.assigneeUserId,sortRows(state.siteWorkers.filter(row=>row.active),'displayName','asc').map(row=>[row.id,row.displayName]),{placeholder:'請選擇人員'});
  replaceReferenceOptions(fields.supplierId,state.suppliers.map(row=>[row.id,row.name]),{placeholder:'尚未指定'});
  replaceReferenceOptions(fields.itemCategory,categories);
  replaceReferenceOptions(fields.pickupCategoryId,categories);
  if(fields.inventoryItemId)replaceReferenceOptions(fields.inventoryItemId,sortRows(state.inventory.filter(row=>row.categoryId===fields.pickupCategoryId?.value),'name','asc').map(row=>[row.id,`${row.name}｜${row.brand} ${row.model}｜${row.code}`]),{disabled:fields.assignmentType?.value!=='pickup'||!fields.pickupCategoryId?.value});
  if(fields.itemId){const category=fields.itemCategory?.value,query=valueText((fields.itemSearch?.value||'').trim()),selected=fields.itemId.value;replaceReferenceOptions(fields.itemId,sortRows(state.inventory.filter(row=>(category===undefined||row.categoryId===category)&&(row.id===selected||matches([row.name,row.brand,row.model,row.code],query))),'name','asc').map(row=>[row.id,`${row.name}｜${row.brand} ${row.model}｜${row.code}`]),{disabled:category!==undefined&&!category});}
  form.querySelectorAll('[data-batch-row]').forEach(row=>{
    const category=row.querySelector('[data-batch-category]'),item=row.querySelector('[data-batch-item]');replaceReferenceOptions(category,categories);
    const query=valueText((row.querySelector('[data-batch-item-search]')?.value||'').trim()),selected=item.value;
    replaceReferenceOptions(item,sortRows(state.inventory.filter(i=>i.categoryId===category.value&&(i.id===selected||matches([i.name,i.brand,i.model,i.code],query))),'name','asc').map(i=>[i.id,`${i.name}｜${i.brand} ${i.model}｜${i.code}`]),{placeholder:'請選擇品項',disabled:!category.value});
  });
  for(const name of ['workerIds','projectWorkerIds']){const picker=form.querySelector(`.worker-picker:has([name="${name}"]) > div`)||[...form.querySelectorAll('.worker-picker')].find(node=>node.querySelector(`[data-worker-count="${name}"]`))?.querySelector('div');refreshReferenceCheckboxes(picker,name,sortRows(state.siteWorkers,'displayName','asc').map(row=>[row.id,row.displayName,row.active]));}
  refreshReferenceCheckboxes(form.querySelector('.contract-service-picker > div'),'contractServiceCodes',state.contractServiceTypes.filter(row=>row.active).map(row=>[row.code,row.name,true]));
  if(type==='workLogModal'){
    const projects=workLogSelectableProjects(workLogFormCustomerId()),list=form.querySelector('#workLogProjectNames');
    if(list?.tagName==='SELECT')replaceReferenceOptions(list,projects.map(row=>[row.name,`${row.code}｜${row.name}`]),{placeholder:'請選擇授權工作內容'});
    else if(list)list.innerHTML=projects.map(row=>`<option value="${esc(row.name)}">${esc(row.code)}</option>`).join('');
    replaceReferenceOptions(form.querySelector('#workLogProjectChoice'),projects.map(row=>[row.id,`${row.code}｜${row.name}`]),{placeholder:'手動輸入新名稱／選擇既有工作內容'});
    form.querySelectorAll('[name="eventServiceId"]').forEach(select=>replaceReferenceOptions(select,customerMaintenanceServices(workLogFormCustomerId()).map(row=>[row.id,row.name]),{placeholder:'請選擇承攬內容'}));
    refreshMaintenanceInventoryChoices();renderEquipmentDrawer();
  }
  if(type==='receiptModal')refreshReceiptReferenceChoices();
  if(type==='accountModal')replaceReferenceOptions(fields.role,(state.appRoles||[]).map(row=>[row.code,row.name]),{placeholder:'請選擇角色'});
}
function refreshReferenceFilters(){
  for(const [categoryId,customerId,departmentId,projectId,all] of [
    ['materialCustomerCategory','materialCustomer','materialDepartment','materialProject',false],
    ['worklogCustomerCategoryFilter','worklogCustomerFilter','worklogDepartmentFilter','worklogProjectFilter',true],
    ['departmentCustomerCategory','departmentCustomer',null,null,false]
  ]){
    const category=document.getElementById(categoryId),customer=document.getElementById(customerId);
    replaceReferenceOptions(category,customerCategoryChoices(),{placeholder:all?'所有客戶分類':'請選擇分類'});
    if(!customer)continue;
    replaceReferenceOptions(customer,sortRows(state.customers.filter(row=>category.value&&row.category===category.value),'code','asc').map(row=>[row.id,row.code+'｜'+row.name]),{placeholder:!category.value?'請先選擇客戶分類':all?'此分類全部客戶':'請選擇客戶',disabled:!category.value});
    const department=departmentId&&document.getElementById(departmentId),project=projectId&&document.getElementById(projectId);
    replaceReferenceOptions(department,(state.customerDepartments||[]).filter(row=>row.customerId===customer.value).map(row=>[row.id,row.name]),{placeholder:'全部科室',disabled:!customer.value});
    replaceReferenceOptions(project,sortRows(state.projects.filter(row=>(all&&!customer.value||row.customerId===customer.value)&&(!all||!category.value||byId(state.customers,row.customerId)?.category===category.value)&&projectMatchesDepartment(row,department?.value||'*')),'code','asc').map(row=>[row.id,row.code+'｜'+row.name]),{placeholder:all?'所有工作內容':'請選擇工作內容',disabled:!all&&!customer.value});
  }
  replaceReferenceOptions(document.querySelector('#customerCategoryFilter'),customerCategoryChoices(),{placeholder:'所有客戶分類'});
  replaceReferenceOptions(document.querySelector('#categoryFilter'),state.categories.filter(row=>row.active).map(row=>[row.name,row.name]),{placeholder:'所有貨品種類'});
}
document.addEventListener('input',event=>{
  if(event.target.matches('[data-batch-item-search]'))syncBatchItemOptions(event.target.closest('[data-batch-row]'));
  if(event.target.name==='itemSearch')refreshFormReferenceChoices();
});
document.addEventListener('focusin',event=>{if(event.target.matches('select,input[type="search"]'))void refreshVisibleFormReferences();});
window.addEventListener('focus',()=>void refreshVisibleFormReferences());
document.addEventListener('visibilitychange',()=>void refreshVisibleFormReferences());
setInterval(()=>void refreshVisibleFormReferences(),FORM_REFERENCE_INTERVAL_MS);
