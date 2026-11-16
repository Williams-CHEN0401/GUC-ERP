// Rendering adapters only. ERP and Accounting both consume work_content_report_v1.
const sharedReportCache=new Map(),sharedReportPending=new Set();

let sharedReportGeneration=0;
function invalidateSharedReports(){
 sharedReportGeneration++;sharedReportCache.clear();sharedReportPending.clear();

 if(currentPage()==='materials')queueMicrotask(renderProjectReport);
}
function reportProjectIncluded(project){
 const selected=document.querySelector("#materialWorkType")?.value||"";
 const keyword=searchValue(document.querySelector('#materialKeyword'));
 const words=[project.code,project.name,byId(state.customers,project.customerId)?.name];
 const category=document.querySelector("#materialCustomerCategory")?.value||"";
 return (!category||byId(state.customers,project.customerId)?.category===category)&&matches(words,keyword)&&["construction","repair"].includes(project.rawType)&&(!selected||project.rawType===selected);
}
function sharedProjectReport(projectId,refresh=false){
 const from=document.querySelector("#materialDateFrom")?.value||"",to=document.querySelector("#materialDateTo")?.value||"",workType=document.querySelector("#materialWorkType")?.value||"construction";
 const key=JSON.stringify([state.currentUser?.id,state.currentUser?.permissions,state.currentUser?.private_access?.visibility_version,projectId,from,to,workType]);
 if(sharedReportCache.has(key)&&!refresh)return sharedReportCache.get(key);
 if(!sharedReportPending.has(key)&&currentPage()==="materials"){
  const generation=sharedReportGeneration;sharedReportPending.add(key);
  apiRequest({method:"GET",scope:"work_report",projectId,from,to,workType}).then(data=>{if(!data?.report)throw new Error("統計資料未完整回傳，請重新讀取。");if(generation===sharedReportGeneration)sharedReportCache.set(key,data.report);}).catch(error=>{if(generation===sharedReportGeneration)sharedReportCache.set(key,{error:error.message});}).finally(()=>{if(generation===sharedReportGeneration){sharedReportPending.delete(key);renderProjectReport();}});
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
 const label=document.createElement('label');label.innerHTML='關鍵字<input id="materialKeyword" type="search" placeholder="工作內容編號、名稱、客戶">';select.closest('label').before(label);label.querySelector('input').addEventListener('input',()=>updateMaterialProjects(true));
 select.innerHTML='<option value="construction">工程施工</option><option value="repair">維修/查修</option>';
 select.addEventListener("change",()=>updateMaterialProjects(true));
});
// A different browser/tab may update logs or plans. Refresh visible reports on
// focus and every 30 seconds, without touching an open editing form.
function refreshVisibleReport(){const id=document.querySelector('#materialProject')?.value;if(currentPage()==='materials'&&document.visibilityState==='visible'&&!document.querySelector('#simpleModal.open,dialog[open]')){if(id)sharedProjectReport(id,true);}}
window.addEventListener('focus',refreshVisibleReport);
document.addEventListener('visibilitychange',refreshVisibleReport);
setInterval(refreshVisibleReport,30000);

document.addEventListener('click',event=>{
 if(event.target.closest('[data-gr-edit-estimates]'))void openMaterialEstimates();
 if(event.target.closest('[data-gr-refresh]'))invalidateSharedReports();
 if(event.target.closest('[data-gr-reset-filters]')){
  document.querySelector('#materialKeyword').value='';document.querySelector('#materialWorkType').value='construction';document.querySelector('#materialCustomerCategory').value='';
  updateMaterialCustomers(true);projectReportDateContext='';renderProjectReport();
 }
});

async function openMaterialEstimates(){
 const projectId=document.querySelector('#materialProject')?.value,userId=state.currentUser?.id;
 if(!projectId||document.querySelector('#materialEstimateDialog'))return;
 const dialog=document.createElement('dialog');dialog.id='materialEstimateDialog';dialog.className='alias-dialog gr-estimate-dialog';
 dialog.setAttribute('aria-labelledby','materialEstimateTitle');
 dialog.innerHTML='<header><h2 id="materialEstimateTitle">初始預計用料</h2><button type="button" data-estimate-close aria-label="關閉預計用料">關閉</button></header><p data-estimate-error role="status" aria-live="polite">載入中…</p><div data-estimate-body></div>';
 document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.querySelector('[data-estimate-close]').onclick=()=>dialog.close();dialog.showModal();
 const error=dialog.querySelector('[data-estimate-error]'),body=dialog.querySelector('[data-estimate-body]');let data,busy=false;
 const sameUser=()=>{if(state.currentUser?.id!==userId)throw Error('登入帳號已變更，請重新開啟設定。');};
 const record=(item,unit)=>data.records.find(r=>r.inventory_item_id===item&&r.unit===unit);
 async function load(){
  sameUser();const result=await apiRequest({method:'GET',scope:'material_estimates',projectId});sameUser();if(!dialog.isConnected)return;
  data=result;if(!data.can_write)throw Error('沒有修改預計用料的權限。');
  body.innerHTML=`<p>只設定本工作內容的預計量，不影響庫存或取貨紀錄。未填寫的品項維持原用量圖表。</p><form data-estimate-form class="form-grid"><label class="span-2">搜尋品項<input type="search" name="search" placeholder="品項編號、名稱、品牌或型號"></label><label class="span-2">品項名稱<select name="item" required></select></label><label>計量單位<select name="unit" required></select></label><label>初始預計數量<input name="quantity" type="number" min="0" max="999999999999.99" step="0.01" required></label><div class="form-submit"><button class="primary" type="submit">儲存預計用料</button></div></form><h3>已設定的預計用料</h3><div class="table-card"><table><thead><tr><th>品項名稱</th><th>單位</th><th>預計數量</th><th>操作</th></tr></thead><tbody>${data.records.filter(r=>r.planned_quantity!=null).map(r=>`<tr><td>${esc(r.code)}｜${esc(r.name)}</td><td>${esc(r.unit)}</td><td>${formatReportNumber(r.planned_quantity)}</td><td><button type="button" data-estimate-edit="${esc(r.id)}">修改</button><button type="button" data-estimate-clear="${esc(r.id)}">清除預計量</button></td></tr>`).join('')||emptyRow(4,'尚未設定')}</tbody></table></div>`;
  const form=body.querySelector('form'),f=Object.fromEntries(['search','item','unit','quantity'].map(name=>[name,form.elements.namedItem(name)]));
  function fillItems(){const value=f.item.value,term=f.search.value.trim();f.item.innerHTML='<option value="">請選擇品項</option>'+data.items.filter(i=>i.id===value||matches([i.code,i.name,i.brand,i.model],term)).map(i=>`<option value="${esc(i.id)}">${esc([i.code,i.name,i.brand,i.model].filter(Boolean).join('｜'))}</option>`).join('');f.item.value=value;}
  function fillQuantity(){const r=record(f.item.value,f.unit.value);f.quantity.value=r?.planned_quantity??'';}
  function fillUnits(){const i=data.items.find(i=>i.id===f.item.value);const units=i?[...new Set([i.unit,...(i.allow_meters?['米']:[]),...data.records.filter(r=>r.inventory_item_id===i.id).map(r=>r.unit)])].filter(Boolean):[];f.unit.innerHTML=units.map(u=>`<option value="${esc(u)}">${esc(u)}</option>`).join('');fillQuantity();}
  f.search.oninput=fillItems;f.item.onchange=fillUnits;f.unit.onchange=fillQuantity;fillItems();fillUnits();
  form.onsubmit=async e=>{e.preventDefault();if(!form.reportValidity()||busy)return;const r=record(f.item.value,f.unit.value);await save({project_id:projectId,inventory_item_id:f.item.value,unit:f.unit.value,planned_quantity:Number(f.quantity.value),row_version:r?.row_version||0});};
  body.onclick=async e=>{
   const edit=e.target.closest('[data-estimate-edit]'),clear=e.target.closest('[data-estimate-clear]');if(busy||!edit&&!clear)return;
   const r=data.records.find(r=>r.id===(edit?.dataset.estimateEdit||clear?.dataset.estimateClear));if(!r)return;
   if(edit){f.search.value='';fillItems();f.item.value=r.inventory_item_id;fillUnits();f.unit.value=r.unit;fillQuantity();f.quantity.focus();}
   else if(confirm('清除此品項的預計量？實際用料與修改紀錄會保留。'))await save({project_id:projectId,inventory_item_id:r.inventory_item_id,unit:r.unit,planned_quantity:null,row_version:r.row_version});
  };
  error.textContent='';
 }
 async function save(payload){
  if(busy)return;busy=true;dialog.setAttribute('aria-busy','true');dialog.querySelectorAll('button,input,select').forEach(el=>el.disabled=true);let saved=false;
  try{sameUser();await apiRequest({operation:'save_project_material_estimate',payload});saved=true;await load();invalidateSharedReports();showToast('預計用料已儲存');}
  catch(e){error.textContent=saved?'已儲存，但重新讀取失敗；請關閉後重新開啟，勿重複儲存。':e.message;}
  finally{busy=false;dialog.removeAttribute('aria-busy');dialog.querySelectorAll('button,input,select').forEach(el=>el.disabled=false);}
 }
 dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 try{await load();}catch(e){error.textContent=e.message;}
}
