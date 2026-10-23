/* One return document, one atomic RPC and the existing immutable stock ledger. */
(()=>{
 const pane=document.getElementById('siteReturnsPane');if(!pane)return;
 let data=null,loading=false,saving=false,page=1,editor=null,requestKey='',requestSignature='',generation=0;
 const val=id=>document.getElementById(id)?.value||'',item=id=>data?.items.find(i=>i.id===id),customer=id=>data?.customers.find(c=>c.id===id),project=id=>data?.projects.find(p=>p.id===id);
 const options=(rows,value,label,empty)=>`<option value="">${esc(empty)}</option>`+rows.map(r=>`<option value="${esc(r.id)}" ${r.id===value?'selected':''}>${esc(label(r))}</option>`).join('');
 const message=(text,error=false)=>{const el=pane.querySelector('[data-return-message]');el.textContent=text;el.classList.toggle('return-error',error);};
 function filters(){return {q:val('returnSearch'),category:val('returnCategory'),customer_id:val('returnCustomer'),project_id:val('returnProject'),from:val('returnFrom'),to:val('returnTo'),status:val('returnStatus')};}
 function choices(reset=false){if(!data)return;
  const category=val('returnCategory'),cid=reset?'':val('returnCustomer'),pid=reset?'':val('returnProject');
  document.getElementById('returnCategory').innerHTML=options([...new Set(data.customers.map(c=>c.category))].map(id=>({id})),category,r=>customerCategoryLabel(r.id),'全部客戶分類');
  document.getElementById('returnCustomer').innerHTML=options(data.customers.filter(c=>!category||c.category===category),cid,c=>`${c.code||''}｜${c.name}`,'全部客戶');
  document.getElementById('returnProject').innerHTML=options(data.projects.filter(p=>!val('returnCustomer')||p.customer_id===val('returnCustomer')).filter(p=>!category||customer(p.customer_id)?.category===category),pid,p=>`${p.code||''}｜${p.name}`,'全部工作案名');
 }
 function render(){if(!data)return;const f=filters(),rows=data.documents.filter(d=>{
  const c=customer(d.customer_id),p=project(d.project_id),names=d.lines.map(l=>{const i=item(l.inventory_item_id);return [i?.code,i?.name,i?.brand,i?.model].join(' ');});
  return (!f.category||c?.category===f.category)&&(!f.customer_id||c?.id===f.customer_id)&&(!f.project_id||p?.id===f.project_id)&&(!f.from||d.return_date>=f.from)&&(!f.to||d.return_date<=f.to)&&(!f.status||d.status===f.status)&&matches([d.document_no,d.return_date,c?.name,p?.name,d.account,d.note,...names],f.q);
 });const pages=Math.max(1,Math.ceil(rows.length/10));page=Math.min(page,pages);
 document.getElementById('returnTable').innerHTML=rows.slice((page-1)*10,page*10).map(d=>`<tr tabindex="0" data-return-row="${esc(d.id)}"><td>${esc(d.document_no)}</td><td>${esc(d.return_date)}</td><td>${esc(customerCategoryLabel(customer(d.customer_id)?.category))}</td><td>${esc(customer(d.customer_id)?.name)}</td><td>${esc(project(d.project_id)?.name)}</td><td>${d.lines.length} 筆</td><td>${esc(d.account)}</td><td>${d.status==='active'?'有效':'已取消'}</td><td class="actions"><button type="button" data-return-open="${esc(d.id)}">${d.status==='active'&&data.permissions.update?'查看／修改':'查看明細'}</button>${d.status==='active'&&data.permissions.delete?`<button type="button" data-return-cancel="${esc(d.id)}">取消</button><button type="button" data-return-delete="${esc(d.id)}">刪除</button>`:''}</td></tr>`).join('')||emptyRow(9);
 document.getElementById('returnPagination').innerHTML=`<div class="pagination"><span>共 ${rows.length} 張入庫單 · 第 ${page}／${pages} 頁</span><button type="button" data-return-prev ${page<=1?'disabled':''}>上一頁</button><button type="button" data-return-next ${page>=pages?'disabled':''}>下一頁</button></div>`;
 document.getElementById('newSiteReturn').hidden=!data.permissions.create;
 }
 async function load(){if(loading||!accessToken||!canModule('purchases'))return;const version=++generation;loading=true;try{
  const next=await apiRequest({method:'GET',scope:'site_returns'});if(version!==generation)return;data=next;choices();render();message('');
 }catch(e){if(version===generation)message(e.message,true);}finally{if(version===generation)loading=false;}}
 const dialog=document.getElementById('siteReturnDialog'),form=document.getElementById('siteReturnForm');
 function formChoices(resetCustomer=false,resetProject=false){const category=form.elements.category.value,cid=resetCustomer?'':form.elements.customer.value,pid=resetCustomer||resetProject?'':form.elements.project.value;
  form.elements.customer.innerHTML=options(data.customers.filter(c=>!category||c.category===category),cid,c=>`${c.code||''}｜${c.name}`,'請選擇客戶');
  form.elements.project.innerHTML=options(data.projects.filter(p=>p.customer_id===form.elements.customer.value),pid,p=>`${p.code||''}｜${p.name}`,'請選擇工作案名');form.elements.project.disabled=editor.readonly||!form.elements.customer.value;
 }
 function lineChoices(row){const category=row.querySelector('[data-return-item-category]').value,select=row.querySelector('[data-return-item]'),selected=select.value;
  const rows=data.items.filter(i=>(i.active||i.id===selected)&&(!category||i.category_id===category));select.innerHTML=options(rows,selected,i=>`${i.code}｜${i.name} ${i.brand||''} ${i.model||''}`,'請選擇品項');
  const i=item(select.value),mode=row.querySelector('[data-return-mode]');mode.options[0].textContent=i?.unit||'原單位';mode.options[1].disabled=!i?.meters_per_unit;if(!i?.meters_per_unit)mode.value='package';mode.disabled=editor.readonly||!!row.dataset.originalMode;
  const meter=mode.value==='meter';row.querySelector('[data-return-length-field]').hidden=!meter;
  row.querySelector('[data-return-unit]').textContent=meter?'米（散料）':i?.unit||'—';
  row.querySelector('[data-return-conversion]').textContent=i?.meters_per_unit?'每'+i.unit+' '+i.meters_per_unit+' 米；整包裝與散料庫存分開計算。':'按原單位入庫；線材可先至商品與庫存雙點擊品項設定每箱／捲米數。';
  updateLengths(row);
 }
 function parseLengths(value){if(!value.trim())return [];const parts=value.trim().split(/[、,，\s]+/);if(parts.length>100||parts.some(v=>!/^\d+(?:\.\d{1,2})?$/.test(v)||Number(v)<=0||Number(v)>=1e12))throw Error('每段米數須為正數、最多兩位小數，最多 100 段。');return parts.map(Number);}
 function updateLengths(row){const q=row.querySelector('[data-return-quantity]'),f=row.querySelector('[data-return-lengths]'),meter=row.querySelector('[data-return-mode]').value==='meter';q.readOnly=meter&&!!f.value.trim();f.setCustomValidity('');if(!meter)return;try{const values=parseLengths(f.value);if(values.length)q.value=String(values.reduce((n,v)=>n+Math.round(v*100),0)/100);}catch(e){f.setCustomValidity(e.message);}}
 function addLine(line={}){const row=document.createElement('div');row.className='site-return-line';row.dataset.originalMode=line.id?line.quantity_unit||'package':'';row.innerHTML=`<label>貨品種類<select data-return-item-category>${options([...new Map(data.items.map(i=>[i.category_id,{id:i.category_id,name:i.category}])).values()],item(line.inventory_item_id)?.category_id||'',r=>r.name,'所有種類')}</select></label><label class="return-item-field">品項名稱<select data-return-item required>${options(data.items,line.inventory_item_id||'',i=>`${i.code}｜${i.name} ${i.brand||''} ${i.model||''}`,'請選擇品項')}</select></label><label>入庫單位<select data-return-mode><option value="package">原單位</option><option value="meter" ${line.quantity_unit==='meter'?'selected':''}>散料（米）</option></select></label><label>入庫數量<input type="number" data-return-quantity min="0.01" max="999999999999.99" step="0.01" value="${esc(line.quantity||'')}" required></label><div>計量單位<strong data-return-unit>${esc(item(line.inventory_item_id)?.unit||'—')}</strong></div><label data-return-length-field class="return-lengths" hidden>餘料每段米數（可選填）<input data-return-lengths value="${esc((line.lengths||[]).join('、'))}" placeholder="例如：85、93、32" maxlength="1600"><small>以逗號、頓號或空白分隔，填寫後自動加總。</small></label><p data-return-conversion class="return-lengths"></p><button type="button" class="outline" data-return-remove>移除此項</button>`;
  form.querySelector('[data-return-lines]').append(row);row.querySelectorAll('input,select,button').forEach(el=>el.disabled=editor.readonly);lineChoices(row);return row;
 }
 function renderItemSearch(){const query=val('returnItemSearch').trim(),rows=query?data.items.filter(i=>i.active&&matches([i.name,i.brand,i.model,i.code],query)).sort((a,b)=>a.name.localeCompare(b.name,'zh-Hant')):[],shown=rows.slice(0,50);
  document.getElementById('returnItemSearchResults').innerHTML=shown.map(i=>`<button type="button" class="outline" data-return-search-item="${esc(i.id)}"><strong>${esc(i.name)}</strong><span>${esc(i.brand||'')} ${esc(i.model||'')}｜${esc(i.code)}｜${esc(i.category||'')}</span></button>`).join('');
  document.getElementById('returnItemSearchStatus').textContent=!query?'輸入關鍵字搜尋品項。':!rows.length?'沒有符合的品項。':rows.length>shown.length?`共 ${rows.length} 筆，顯示前 50 筆，請縮小關鍵字。`:`找到 ${rows.length} 筆品項。`;
 }
 function chooseSearchItem(id){if(saving||editor?.readonly)return;const selected=item(id);if(!selected?.active)return;
  const rows=[...form.querySelectorAll('.site-return-line')],existing=rows.find(row=>row.querySelector('[data-return-item]').value===id),status=document.getElementById('returnItemSearchStatus');
  if(existing){existing.querySelector('[data-return-quantity]').focus();status.textContent=`${selected.name} 已在入庫明細，請直接調整數量。`;return;}
  let row=rows.find(row=>!row.querySelector('[data-return-item]').value);if(!row){if(rows.length>=50){status.textContent='每張入庫單最多 50 筆明細。';return;}row=addLine();}
  row.querySelector('[data-return-item-category]').value=selected.category_id||'';lineChoices(row);row.querySelector('[data-return-item]').value=id;lineChoices(row);row.querySelector('[data-return-quantity]').focus();
  status.textContent=`已帶入第 ${[...form.querySelectorAll('.site-return-line')].indexOf(row)+1} 列：${selected.name}。`;
 }
 function open(id=''){if(!data)return;const d=id?data.documents.find(d=>d.id===id):null;if(id&&!d)return;
  editor={id:d?.id||uid(),version:d?.row_version||null,readonly:d?d.status!=='active'||!data.permissions.update:!data.permissions.create};requestKey='';requestSignature='';
  form.reset();form.querySelector('fieldset').disabled=editor.readonly;form.querySelector('[data-return-form-message]').textContent='';
  document.getElementById('siteReturnTitle').textContent=d?'案場餘料入庫單明細':'新增案場餘料入庫單';form.elements.number.value=d?.document_no||'儲存後自動編號';form.elements.date.value=d?.return_date||today();form.elements.account.value=d?.account||state.currentUser?.display_name||'';
  form.elements.category.innerHTML=options([...new Set(data.customers.map(c=>c.category))].map(id=>({id})),customer(d?.customer_id)?.category||'',r=>customerCategoryLabel(r.id),'請選擇客戶分類');
  form.elements.customer.innerHTML=options(data.customers,d?.customer_id||'',c=>c.name,'請選擇客戶');form.elements.project.innerHTML=options(data.projects,d?.project_id||'',p=>p.name,'請選擇工作案名');formChoices();form.elements.note.value=d?.note||'';
  form.querySelector('[data-return-lines]').replaceChildren();for(const l of d?.lines||[{}])addLine(l);
  form.querySelector('[data-return-item-search]').hidden=editor.readonly;renderItemSearch();form.querySelector('[data-return-save]').hidden=editor.readonly;dialog.showModal();
 }
 async function save(action,payload){const signature=JSON.stringify({action,payload});if(signature!==requestSignature){requestSignature=signature;requestKey=uid();}
  const result=await apiRequest({operation:action+'_site_return',payload:{...payload,request_id:requestKey}});
  loadedScopes.clear();invalidateSharedReports();await load();await loadPageData(currentPage(),{force:true,silent:true});return result;
 }
 form.addEventListener('change',e=>{if(e.target.name==='category')formChoices(true,true);if(e.target.name==='customer')formChoices(false,true);const row=e.target.closest('.site-return-line');if(row){if(e.target.hasAttribute('data-return-item-category'))row.querySelector('[data-return-item]').value='';lineChoices(row);}});
 form.addEventListener('input',e=>{if(e.target.id==='returnItemSearch')renderItemSearch();if(e.target.hasAttribute('data-return-lengths'))updateLengths(e.target.closest('.site-return-line'));});
 form.addEventListener('keydown',e=>{if(e.target.id==='returnItemSearch'&&e.key==='Enter'&&!e.isComposing){e.preventDefault();renderItemSearch();}});
 form.addEventListener('click',e=>{if(saving||editor?.readonly)return;const result=e.target.closest('[data-return-search-item]');if(result)chooseSearchItem(result.dataset.returnSearchItem);if(e.target.closest('[data-return-add]')){if(form.querySelectorAll('.site-return-line').length>=50)return;addLine();}if(e.target.closest('[data-return-remove]'))e.target.closest('.site-return-line').remove();});
 form.addEventListener('submit',async e=>{e.preventDefault();if(saving||editor.readonly)return;const output=form.querySelector('[data-return-form-message]');try{
  const rows=[...form.querySelectorAll('.site-return-line')].map(row=>({inventory_item_id:row.querySelector('[data-return-item]').value,quantity:Number(row.querySelector('[data-return-quantity]').value),quantity_unit:row.querySelector('[data-return-mode]').value,lengths:row.querySelector('[data-return-mode]').value==='meter'?parseLengths(row.querySelector('[data-return-lengths]').value):[]}));
  if(!rows.length||rows.some(r=>!r.inventory_item_id||!Number.isFinite(r.quantity)||r.quantity<=0))throw Error('請加入至少一筆有效材料。');if(new Set(rows.map(r=>r.inventory_item_id)).size!==rows.length)throw Error('相同品項請合併數量。');
  saving=true;form.querySelector('fieldset').disabled=true;form.querySelector('[data-return-save]').disabled=true;output.textContent='儲存中…';
  await save(editor.version?'update':'create',{document_id:editor.id,row_version:editor.version,return_date:form.elements.date.value,customer_id:form.elements.customer.value,project_id:form.elements.project.value,rows,note:form.elements.note.value});dialog.close();showToast('案場餘料入庫已儲存，庫存與用料報表已更新。');
 }catch(e){output.textContent=e.message;}finally{saving=false;form.querySelector('fieldset').disabled=false;form.querySelector('[data-return-save]').disabled=false;}});
 dialog.addEventListener('cancel',e=>{if(saving)e.preventDefault();});dialog.querySelector('[data-return-close]').addEventListener('click',()=>{if(!saving)dialog.close();});
 pane.addEventListener('input',e=>{if(e.target.id==='returnSearch'){page=1;render();}});
 pane.addEventListener('change',e=>{page=1;if(e.target.id==='returnCategory')choices(true);if(e.target.id==='returnCustomer'){document.getElementById('returnProject').value='';choices();}render();});
 pane.addEventListener('dblclick',e=>{const row=e.target.closest('[data-return-row]');if(row&&!e.target.closest('button'))open(row.dataset.returnRow);});
 pane.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('[data-return-row]'))open(e.target.dataset.returnRow);});
 pane.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b||saving)return;if(b.id==='newSiteReturn')open();if(b.hasAttribute('data-return-open'))open(b.dataset.returnOpen);
  if(b.hasAttribute('data-return-prev')){page--;render();}if(b.hasAttribute('data-return-next')){page++;render();}if(b.hasAttribute('data-return-refresh'))void load();
  if(b.hasAttribute('data-return-clear')){for(const id of ['returnSearch','returnCategory','returnCustomer','returnProject','returnFrom','returnTo','returnStatus'])document.getElementById(id).value='';page=1;choices();render();}
  const action=b.hasAttribute('data-return-delete')?'delete':b.hasAttribute('data-return-cancel')?'cancel':'';
  if(action){const d=data.documents.find(d=>d.id===(b.dataset.returnDelete||b.dataset.returnCancel));if(!d||!confirm(`確認${action==='delete'?'刪除':'取消'} ${d.document_no}？對應庫存將回沖，歷史紀錄會保留。`))return;saving=true;b.disabled=true;try{await save(action,{document_id:d.id,row_version:d.row_version});showToast('入庫單已回沖，庫存與用料報表已更新。');}catch(e){message(e.message,true);}finally{saving=false;b.disabled=false;}}
 });
 const visible=()=>currentPage()==='transactions'&&pane.classList.contains('active')&&document.visibilityState==='visible';
 const refresh=()=>{if(visible()&&!dialog.open&&!saving)void load();};
 for(const id of ['siteReturnsPane','transactions'])new MutationObserver(refresh).observe(document.getElementById(id),{attributes:true,attributeFilter:['class']});
 window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);setInterval(refresh,30000);
 window.addEventListener('guc:session-changed',()=>{generation++;loading=false;data=null;dialog.close();document.getElementById('returnTable').replaceChildren();refresh();});
 globalThis.GucSiteReturns={filters,refresh};setTimeout(()=>{if(new URLSearchParams(location.search).get('tab')==='returns')document.querySelector('[data-tabs=transaction] [data-tab=returns]')?.click();refresh();},600);
})();
