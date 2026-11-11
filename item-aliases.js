/* Name identification reuses existing inventory/supplier masters and session. */
function itemAliasRows(id,supplierId=''){
 if(!id)return [];
 return (state.itemAliases||[]).filter(a=>a.inventory_item_id===id&&a.status!=='inactive'&&(!supplierId||a.supplier_id===supplierId));
}
function itemAliasTerms(id,supplierId=''){
 return itemAliasRows(id,supplierId).flatMap(a=>[a.supplier_name,a.supplier_item_name,a.supplier_sku,a.brand,a.model,a.specification]);
}
function itemAliasSummary(id,supplierId=''){
 const rows=itemAliasRows(id,supplierId);return rows.slice(0,3).map(a=>`<small class="item-alias-summary">${esc(a.supplier_name)}｜${esc(a.supplier_item_name)}${a.supplier_sku?'｜'+esc(a.supplier_sku):''} · ${a.status==='confirmed'?'已確認':'待確認'}${a.specification?'｜'+esc(a.specification):''}</small>`).join('')+(rows.length>3?`<small class="item-alias-summary">另有 ${rows.length-3} 筆名稱對照</small>`:'');
}
function refreshTransactionAliasLabels(){
 const form=document.querySelector('#modalForm');if(!form)return;
 for(const row of form.querySelectorAll('[data-batch-row]')){
  let output=row.querySelector('[data-transaction-alias]');if(!output){output=document.createElement('div');output.dataset.transactionAlias='';output.className='transaction-alias span-2';row.append(output);}
  const itemId=row.querySelector('[data-batch-item]')?.value,item=byId(state.inventory,itemId),supplierId=form.elements.supplierId?.value||'';
  const html=itemAliasSummary(itemId,supplierId)||(item&&supplierId?'此供應商尚未建立品名對照，可直接依 ERP 品項儲存。':'');if(output.innerHTML!==html)output.innerHTML=html;
  output.hidden=!output.innerHTML;
 }
}
(()=>{
 const pane=document.getElementById('itemAliasesPane');if(!pane)return;
 const statusLabels={pending:'待確認',confirmed:'已確認',inactive:'停用'};
 const columns=[['supplier_name','供應商名稱'],['supplier_item_name','供應商專業品名'],['supplier_sku','供應商商品料號'],['brand','商品品牌'],['model','商品型號'],['specification','商品規格'],['inventory_code','ERP商品編號'],['item_name','ERP商品名稱'],['supplier_unit','供應商單位'],['item_unit','ERP商品單位'],['conversion_factor','單位換算參考值'],['notes','備註'],['status','對照狀態'],['created_by_name','建立人員'],['created_at','建立時間'],['updated_by_name','最後修改人員'],['updated_at','修改時間']].map(([key,label])=>({key,label}));
 let data={records:[],permissions:{}},page=1,loadId=0,editor=null,historyDialog=null,importDialog=null;
 const filters=()=>({q:pane.querySelector('[data-alias-search]').value.trim(),supplier_id:pane.querySelector('[data-alias-supplier]').value,status:pane.querySelector('[data-alias-status]').value});
 const notify=(text,error=false)=>{const el=pane.querySelector('[data-alias-message]');el.textContent=text;el.classList.toggle('alias-error',error);};
 const options=(rows,value,label,placeholder)=>`<option value="">${esc(placeholder)}</option>`+rows.map(r=>`<option value="${esc(r.id)}" ${r.id===value?'selected':''}>${esc(label(r))}</option>`).join('');
 pane.innerHTML=`<article class="panel alias-panel"><div class="panel-head"><div><h2>品項名稱對照管理</h2><p>以供應商專業品名或 ERP 品名查詢同一商品。</p></div><div class="panel-head-actions"><button type="button" class="primary" data-alias-new>＋ 新增品項對照</button><button type="button" class="outline" data-alias-import>匯入 Excel</button><button type="button" class="outline" data-alias-export>匯出 Excel</button><button type="button" class="outline" data-alias-template>下載空白範本</button></div></div><div class="alias-filters"><label>關鍵字<input type="search" data-alias-search placeholder="供應商、品名、料號、型號或 ERP 編號"></label><label>供應商<select data-alias-supplier><option value="">全部供應商</option></select></label><label>對照狀態<select data-alias-status><option value="">全部狀態</option><option value="pending">待確認</option><option value="confirmed">已確認</option><option value="inactive">停用</option></select></label><button type="button" class="outline" data-alias-reload>重新讀取</button></div><p data-alias-message role="status" aria-live="polite"></p><div class="table-card"><table><thead><tr><th>供應商</th><th>廠商專業品名</th><th>ERP 品名</th><th>狀態</th><th>操作</th></tr></thead><tbody data-alias-table></tbody></table></div><div class="pagination" data-alias-pages></div></article>`;
 function render(){
  const f=filters(),rows=data.records.filter(a=>(!f.supplier_id||a.supplier_id===f.supplier_id)&&(!f.status||a.status===f.status)&&matches([a.supplier_name,a.supplier_item_name,a.supplier_sku,a.item_name,a.inventory_code,a.brand,a.model,a.specification,a.item_brand,a.item_model],f.q));
  const pages=Math.max(1,Math.ceil(rows.length/10));page=Math.min(page,pages);
  pane.querySelector('[data-alias-table]').innerHTML=rows.slice((page-1)*10,page*10).map(a=>`<tr><td>${esc(a.supplier_name)}</td><td><strong>${esc(a.supplier_item_name)}</strong><small>${esc([a.supplier_sku,a.brand,a.model,a.specification].filter(Boolean).join('｜'))}</small></td><td><strong>${a.inventory_item_id?esc(a.inventory_code)+'｜'+esc(a.item_name):'尚未指定 ERP 商品'}</strong><small>${esc([a.item_brand,a.item_model,a.item_unit].filter(Boolean).join('｜'))}</small></td><td><span class="status ${a.status==='confirmed'?'active':''}">${esc(statusLabels[a.status])}</span></td><td class="actions"><button type="button" data-alias-open="${esc(a.id)}">${data.permissions.update?'查看／編輯':'查看'}</button><button type="button" data-alias-history="${esc(a.id)}">異動紀錄</button>${a.status!=='inactive'&&data.permissions.delete?`<button type="button" data-alias-deactivate="${esc(a.id)}">停用</button>`:''}</td></tr>`).join('')||emptyRow(5,'沒有符合的品項名稱對照');
  pane.querySelector('[data-alias-pages]').innerHTML=`<span>共 ${rows.length} 筆 · 第 ${page}／${pages} 頁</span><button type="button" data-alias-prev ${page<=1?'disabled':''}>上一頁</button><button type="button" data-alias-next ${page>=pages?'disabled':''}>下一頁</button>`;
  pane.querySelector('[data-alias-new]').hidden=!data.permissions.create;pane.querySelector('[data-alias-import]').hidden=!data.permissions.create;
  pane.querySelector('[data-alias-export]').hidden=!data.permissions.export;
 }
 async function load(){
  if(!accessToken||!canModule('inventory'))return;
  const request=++loadId;notify('讀取品項對照…');
  try{const result=await apiRequest({method:'GET',scope:'item_aliases'});if(request!==loadId)return;data=result;state.itemAliases=data.records.filter(a=>a.status!=='inactive');
   const select=pane.querySelector('[data-alias-supplier]'),selected=select.value;select.innerHTML=options(state.suppliers,selected,s=>s.name,'全部供應商');render();renderInventory();refreshTransactionAliasLabels();notify('');
  }catch(error){if(request===loadId)notify(error.message,true);}
 }
 function dialog(title){const d=document.createElement('dialog');d.className='alias-dialog';d.setAttribute('aria-label',title);d.innerHTML=`<header><h2>${esc(title)}</h2><button type="button" data-alias-close>關閉</button></header><div data-alias-body></div>`;document.body.append(d);d.addEventListener('close',()=>d.remove());d.querySelector('[data-alias-close]').onclick=()=>{if(!d.hasAttribute('aria-busy'))d.close();};d.addEventListener('cancel',e=>{if(d.hasAttribute('aria-busy'))e.preventDefault();});return d;}
 const textField=(key,label,value='',max=120)=>`<label>${esc(label)}<input name="${key}" value="${esc(value)}" maxlength="${max}"></label>`;
 function syncItem(){
  const f=editor.querySelector('form'),term=f.elements.item_search.value.trim(),selected=f.elements.inventory_item_id.value;
  const choices=state.inventory.filter(i=>i.id===selected||matches([i.code,i.name,i.brand,i.model],term));
  f.elements.inventory_item_id.innerHTML=options(choices,selected,i=>`${i.code}｜${i.name}｜${i.brand} ${i.model}`,'選填，可稍後選擇 ERP 商品');
  const i=byId(state.inventory,f.elements.inventory_item_id.value);const confirmed=f.elements.status.querySelector('[value=confirmed]');confirmed.disabled=!i||!data.permissions.update;if(!i&&f.elements.status.value==='confirmed')f.elements.status.value='pending';f.querySelector('[data-alias-item-detail]').textContent=i?`${i.code}｜${i.name}｜${i.brand} ${i.model}｜ERP 單位：${i.unit}${i.metersPerUnit?'｜每單位 '+i.metersPerUnit+' 米':''}`:'可先不選商品，以待確認儲存；之後再補上對應的 ERP 商品。';
 }
 function open(id){
  const a=data.records.find(r=>r.id===id)||{},readonly=!!id&&!data.permissions.update;if(!id&&!data.permissions.create)return;
  editor=dialog(id?'品項名稱對照明細':'新增品項名稱對照');const d=editor;
  d.querySelector('[data-alias-body]').innerHTML=`<form class="alias-form"><fieldset class="form-grid" ${readonly?'disabled':''}><label>供應商名稱<select name="supplier_id" required>${options(state.suppliers,a.supplier_id,s=>s.name,'請選擇供應商')}</select></label><label>供應商專業品名<input name="supplier_item_name" required maxlength="300" value="${esc(a.supplier_item_name||'')}"></label>${textField('supplier_sku','供應商商品料號（選填）',a.supplier_sku)}${textField('brand','商品品牌（選填）',a.brand)}${textField('model','商品型號（選填）',a.model)}${textField('specification','商品規格（選填）',a.specification,1000)}${textField('item_search','搜尋 ERP 商品編號／名稱','','200')}<label>公司 ERP 商品（選填）<select name="inventory_item_id">${options(state.inventory,a.inventory_item_id,i=>`${i.code}｜${i.name}｜${i.brand} ${i.model}`,'選填，可稍後選擇 ERP 商品')}</select></label><p data-alias-item-detail class="span-2 form-sync-hint"></p>${textField('supplier_unit','供應商單位（選填）',a.supplier_unit,30)}<label>單位換算參考值（選填）<input name="conversion_factor" type="number" min="0.000001" max="999999999999" step="0.000001" value="${esc(a.conversion_factor??'')}"><small>1 供應商單位＝此數量的 ERP 單位；供核對用。</small></label><label>對照狀態<select name="status">${Object.entries(statusLabels).map(([key,label])=>`<option value="${key}" ${a.status===key?'selected':''} ${key==='confirmed'&&!data.permissions.update||key==='inactive'&&!data.permissions.delete?'disabled':''}>${esc(label)}</option>`).join('')}</select></label><label class="span-2">備註說明<textarea name="notes" maxlength="2000">${esc(a.notes||'')}</textarea></label><div data-alias-conflicts class="span-2" hidden></div><p class="span-2 form-sync-hint">請核對型號、規格及單位後再確認對照。</p></fieldset>${id?`<p>建立：${esc(a.created_by_name)} · ${esc(formatDateTime(a.created_at))}<br>最後修改：${esc(a.updated_by_name)} · ${esc(formatDateTime(a.updated_at))}</p>`:''}<p data-alias-error role="alert" class="alias-error"></p>${!readonly?'<div class="form-submit"><button type="submit" class="primary">儲存對照</button></div>':''}</form>`;
  const f=d.querySelector('form');syncItem();f.elements.item_search.addEventListener('input',syncItem);f.elements.inventory_item_id.addEventListener('change',syncItem);
  let conflictVersions=[];f.addEventListener('input',()=>{if(!f.querySelector('[data-alias-conflicts]').hidden){const conflict=f.querySelector('[data-alias-conflicts]');if(!conflict.contains(document.activeElement)){conflict.hidden=true;conflict.innerHTML='';conflictVersions=[];}}});
  f.onsubmit=async event=>{
   event.preventDefault();if(d.hasAttribute('aria-busy')||readonly)return;const fields=Object.fromEntries(new FormData(f));delete fields.item_search;
   const payload={...fields,...(id?{id,row_version:a.row_version}:{}),allow_conflict:fields.allow_conflict==='on',conflict_versions:conflictVersions};
   d.setAttribute('aria-busy','true');f.querySelector('[type="submit"]').disabled=true;
   try{const result=await apiRequest({operation:'save_item_alias',payload}),saved=result.result;
    if(saved.needs_confirmation){conflictVersions=saved.conflicts.map(c=>({id:c.id,row_version:c.row_version})).sort((a,b)=>a.id.localeCompare(b.id));const c=f.querySelector('[data-alias-conflicts]');c.hidden=false;c.innerHTML=`<p class="alias-error">此供應商品名／料號已對應其他商品，請核對：</p><ul>${saved.conflicts.map(row=>`<li>${esc(row.inventory_code)}｜${esc(row.item_name)}｜${esc(row.supplier_item_name)}</li>`).join('')}</ul><label><input type="checkbox" name="allow_conflict" required>我已核對規格，確認仍需建立此對照</label><label>確認原因<textarea name="conflict_note" required maxlength="1000"></textarea></label>`;return;}
    d.close();loadedScopes.clear();await load();showToast('品項名稱對照已儲存');
   }catch(error){f.querySelector('[data-alias-error]').textContent=error.message;}finally{d.removeAttribute('aria-busy');f.querySelector('[type="submit"]').disabled=false;}
  };d.showModal();
 }
 async function history(id){
  const d=historyDialog=dialog('品項對照異動紀錄'),body=d.querySelector('[data-alias-body]');body.textContent='讀取異動紀錄…';d.showModal();
  try{const result=await apiRequest({method:'GET',scope:'item_aliases',aliasFilters:{history_id:id}}),labels=Object.fromEntries(columns.map(c=>[c.key,c.label]));
   Object.assign(labels,{inventory_item_id:'ERP 商品 ID',supplier_id:'供應商 ID',conflict_note:'衝突確認原因'});
   body.innerHTML=result.history.map(h=>`<article class="alias-history"><h3>${esc(({insert:'新增',update:'修改',delete:'刪除'})[h.action]||h.action)} · ${esc(h.actor||h.after_data?.updated_by_user_id||'—')}</h3><p>${esc(formatDateTime(h.created_at))}</p><dl>${Object.entries(labels).filter(([key])=>JSON.stringify(h.before_data?.[key])!==JSON.stringify(h.after_data?.[key])).map(([key,label])=>`<dt>${esc(label)}</dt><dd>${esc(h.before_data?.[key]??'—')} → ${esc(h.after_data?.[key]??'—')}</dd>`).join('')}</dl></article>`).join('')||'<p>尚無異動紀錄。</p>';
  }catch(error){body.textContent=error.message;}
 }
 async function deactivate(id){
  const a=data.records.find(r=>r.id===id);if(!a||!confirm('停用這筆名稱對照？紀錄將保留，既有商品及進出貨單不變。'))return;
  try{await apiRequest({operation:'save_item_alias',payload:{id,row_version:a.row_version,action:'deactivate'}});loadedScopes.clear();await load();showToast('對照已停用，歷史紀錄保留');}catch(error){notify(error.message,true);}
 }
 function exportRows(rows){return rows.map(a=>({...a,status:statusLabels[a.status]}));}
 async function template(){
  const cols=columns.filter(c=>!['created_by_name','created_at','updated_by_name','updated_at'].includes(c.key));
  await GucExcelExport.saveBytes(GucExcelExport.buildWorkbook(cols,[]),'品項名稱對照_匯入範本.xlsx');
 }
 function exportExcel(){
  GucExcelExport.openDialog({title:'品項名稱對照',columns,canExport:()=>data.permissions.export,
   load:async(scope,keys)=>{const result=await apiRequest({method:'GET',scope:'item_aliases',aliasFilters:{...(scope==='filtered'?filters():{}),export:'1'}});return {columns:keys.map(key=>columns.find(c=>c.key===key)),rows:exportRows(result.records)};}});
 }
 function importExcel(){
  if(!data.permissions.create)return;const d=importDialog=dialog('品項名稱對照 Excel 匯入預覽');let pending=[],fileGeneration=0;
  d.querySelector('[data-alias-body]').innerHTML='<p>選取第一個工作表、第一列為標題的 .xlsx，最多 5 MB／100 筆。供應商名稱須與既有資料相符；ERP 商品編號可留白，先以待確認儲存。僅新增對照。</p><label>Excel 檔案<input type="file" accept=".xlsx" data-alias-file></label><button type="button" class="outline" data-alias-template>下載空白範本</button><p data-alias-import-status role="status"></p><div class="table-card" data-alias-import-preview></div><p class="alias-error" data-alias-import-error role="alert"></p><label><input type="checkbox" data-alias-import-confirm>我已核對供應商、ERP 商品、規格與單位</label><div class="form-submit"><button class="primary" type="button" data-alias-import-save disabled>確認匯入</button></div>';
  const input=d.querySelector('[data-alias-file]'),confirmBox=d.querySelector('[data-alias-import-confirm]'),save=d.querySelector('[data-alias-import-save]'),error=d.querySelector('[data-alias-import-error]');
  const invalidate=()=>{pending=[];confirmBox.checked=false;save.disabled=true;};
  input.onchange=async()=>{
   const generation=++fileGeneration;invalidate();error.textContent='';d.querySelector('[data-alias-import-preview]').innerHTML='';
   const file=input.files[0];if(!file)return;
   try{const matrix=await GucAliasXlsx.read(file);if(generation!==fileGeneration)return;
    const head=matrix.shift()||[],map=Object.fromEntries(head.map((label,i)=>[String(label||'').trim(),i]));
    for(const required of ['供應商名稱','供應商專業品名'])if(map[required]==null)throw Error('範本缺少欄位：'+required);
    if(new Set(head.filter(Boolean)).size!==head.filter(Boolean).length)throw Error('範本有重複標題，請重新下載範本。');
    const rows=matrix.filter(r=>r.some(cell=>String(cell||'').trim()));if(!rows.length||rows.length>100)throw Error('請提供 1–100 筆對照。');
    const seen=new Set(),preview=[];
    for(const [index,row]of rows.entries()){
     const get=key=>String(row[map[columns.find(c=>c.key===key).label]]??'').trim();
     const suppliers=state.suppliers.filter(s=>s.name.trim()===get('supplier_name')),items=get('inventory_code')?state.inventory.filter(i=>i.code.toLowerCase()===get('inventory_code').toLowerCase()):[];
     if(suppliers.length!==1||(get('inventory_code')&&items.length!==1))throw Error(`第 ${index+2} 列的供應商名稱或 ERP 商品編號無法唯一辨識。`);
     const status=Object.keys(statusLabels).find(key=>statusLabels[key]===get('status'))||(!get('status')?'pending':null);
     if(!status)throw Error(`第 ${index+2} 列對照狀態無效。`);
     if(status==='confirmed'&&!items.length)throw Error(`第 ${index+2} 列尚未指定 ERP 商品，請使用「待確認」。`);
     if(status==='confirmed'&&!data.permissions.update)throw Error('目前帳號沒有確認品項對照的權限，請使用「待確認」。');
     const payload={supplier_id:suppliers[0].id,inventory_item_id:items[0]?.id??null,status};
     for(const key of ['supplier_item_name','supplier_sku','brand','model','specification','supplier_unit','conversion_factor','notes'])payload[key]=get(key);
     if(!payload.supplier_item_name)throw Error(`第 ${index+2} 列供應商專業品名為必填。`);
     const key=[payload.supplier_id,payload.supplier_item_name.toLowerCase(),payload.supplier_sku.toLowerCase()].join('|');
     if(seen.has(key))throw Error(`第 ${index+2} 列與本次檔案其他列重複。`);seen.add(key);
     if(get('item_name')&&get('item_name')!==items[0]?.name)throw Error(`第 ${index+2} 列 ERP 商品名稱與主檔不符。`);
     pending.push(payload);preview.push(`<tr><td>${index+2}</td><td>${esc(suppliers[0].name)}</td><td>${esc(payload.supplier_item_name)}</td><td>${items.length?esc(items[0].code)+'｜'+esc(items[0].name):'尚未指定 ERP 商品'}</td><td>${esc(statusLabels[status])}</td></tr>`);
    }
    d.querySelector('[data-alias-import-preview]').innerHTML='<table><thead><tr><th>列</th><th>供應商</th><th>專業品名</th><th>ERP 商品</th><th>狀態</th></tr></thead><tbody>'+preview.join('')+'</tbody></table>';
    d.querySelector('[data-alias-import-status]').textContent=`已預覽 ${pending.length} 筆；重複與衝突會由伺服器再次核對，任一筆失敗整批不寫入。`;
   }catch(e){invalidate();error.textContent=e.message;}
  };
  confirmBox.onchange=()=>save.disabled=!confirmBox.checked||!pending.length;
  d.querySelector('[data-alias-template]').onclick=()=>template().catch(e=>error.textContent=e.message);
  save.onclick=async()=>{if(!pending.length||!confirmBox.checked||d.hasAttribute('aria-busy'))return;d.setAttribute('aria-busy','true');save.disabled=true;input.disabled=true;
   try{const result=await apiRequest({operation:'import_item_aliases',payload:{rows:pending}});d.close();loadedScopes.clear();await load();showToast('已匯入 '+result.result.imported+' 筆對照');}
   catch(e){error.textContent=e.message;}finally{d.removeAttribute('aria-busy');input.disabled=false;save.disabled=!pending.length||!confirmBox.checked;}
  };d.showModal();
 }
 pane.addEventListener('input',e=>{if(e.target.matches('[data-alias-search]')){page=1;render();}});
 pane.addEventListener('change',e=>{if(e.target.matches('[data-alias-supplier],[data-alias-status]')){page=1;render();}});
 pane.addEventListener('click',e=>{
  if(e.target.closest('[data-alias-new]'))open();if(e.target.closest('[data-alias-reload]'))void load();
  if(e.target.closest('[data-alias-prev]')){page--;render();}if(e.target.closest('[data-alias-next]')){page++;render();}
  for(const [attribute,fn]of [['open',open],['history',history],['deactivate',deactivate]]){const b=e.target.closest('[data-alias-'+attribute+']');if(b)void fn(b.dataset['alias'+attribute[0].toUpperCase()+attribute.slice(1)]);}
  if(e.target.closest('[data-alias-import]'))importExcel();if(e.target.closest('[data-alias-export]'))exportExcel();if(e.target.closest('[data-alias-template]'))void template().catch(e=>notify(e.message,true));
 });
 document.addEventListener('click',e=>{if(e.target.closest('[data-tabs="inventory"] [data-tab="aliases"]'))void load();});
 document.addEventListener('change',e=>{if(e.target.matches('#modalForm [data-batch-item],#modalForm [name="supplierId"]'))refreshTransactionAliasLabels();});
 document.addEventListener('guc:form-references-updated',()=>{refreshTransactionAliasLabels();if(pane.classList.contains('active'))void load();});
 // Added rows and reopened documents share the same labels. No form values change.
 const modal=document.getElementById('modalForm');if(modal)new MutationObserver(changes=>{if(changes.some(change=>!change.target.closest?.('[data-transaction-alias]')))queueMicrotask(refreshTransactionAliasLabels);}).observe(modal,{childList:true,subtree:true});
 const interval=setInterval(()=>{if(!state.currentUser||!loadedScopes.has('inventory'))return;clearInterval(interval);if(new URLSearchParams(location.search).get('tab')==='aliases')document.querySelector('[data-tabs="inventory"] [data-tab="aliases"]').click();},250);setTimeout(()=>clearInterval(interval),30000);
})();
