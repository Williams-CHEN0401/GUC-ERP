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
 function formChoices(resetCustomer=false,resetProject=false){const category=form.elements.category.value,cid=resetCustomer?'':form.elements.customer.value,pid=resetCustomer||resetProject?'':form.elements.project.value,query=form.elements.customerSearch.value.trim();
  const rows=data.customers.filter(c=>(!category||c.category===category)&&(c.id===cid||matches([c.code,c.name],query)));
  const available=!!category||!!query||!!cid;
  form.elements.customer.innerHTML=options(available?rows:[],cid,c=>String(c.code||'')+'｜'+c.name,available?'請選擇客戶':'請選擇分類或搜尋客戶');form.elements.customer.disabled=editor.readonly||!available||!rows.length;
  form.elements.project.innerHTML=options(data.projects.filter(p=>p.customer_id===form.elements.customer.value),pid,p=>String(p.code||'')+'｜'+p.name,'請選擇工作內容');form.elements.project.disabled=editor.readonly||!form.elements.customer.value;
  document.getElementById('returnCustomerSearchStatus').textContent=query?(rows.length?'找到 '+rows.length+' 位客戶'+(cid?'（包含目前選取）':''):'沒有符合的客戶。'):'';
 }
 function lineChoices(row){const category=row.querySelector('[data-return-item-category]').value,select=row.querySelector('[data-return-item]'),selected=select.value;
  const rows=data.items.filter(i=>(i.active||i.id===selected)&&(!category||i.category_id===category));select.innerHTML=options(rows,selected,i=>String(i.code)+'｜'+i.name+' '+(i.brand||'')+' '+(i.model||''),'請選擇品項');
  const i=item(select.value),mode=row.querySelector('[data-return-mode]'),originalItem=!!i&&row.dataset.originalItem===i.id,packageUnit=originalItem&&row.dataset.originalMode==='package'?(row.dataset.originalPackageUnit||i.legacy_unit||i.unit):i?.unit;mode.options[0].textContent=packageUnit||'原單位';const eligible=inventoryAllowsLooseMeters(i),legacy=originalItem&&row.dataset.originalMode==='meter';mode.options[1].textContent=eligible?'散料（米）':'米（既有紀錄）';mode.options[1].hidden=!eligible&&!legacy;mode.options[1].disabled=!eligible&&!legacy;if(!eligible&&!legacy)mode.value='package';mode.disabled=editor.readonly;
  const meter=mode.value==='meter',quantity=row.querySelector('[data-return-quantity]');quantity.step=meter?'0.01':'1';quantity.min=meter?'0.01':'1';
  row.querySelector('[data-return-label]').closest('label').hidden=!meter;
  row.querySelector('[data-return-legacy]').hidden=!(meter&&legacy&&row.dataset.wasBox!=='true');
 }
 function addLine(line={}){const row=document.createElement('div');row.className='batch-row transaction-batch-row site-return-line';row.dataset.lineId=line.id||uid();row.dataset.originalMode=line.id?line.quantity_unit||'package':'';row.dataset.originalItem=line.id?line.inventory_item_id||'':'';row.dataset.originalPackageUnit=line.package_unit_snapshot||'';row.dataset.wasBox=String(!!line.is_remnant_box);row._lengths=line.lengths||[];row._originalQuantity=Number(line.quantity||0);
  const label=(name,body,cls='')=>'<label'+(cls?' class="'+cls+'"':'')+'>'+name+body+'</label>';
  row.innerHTML='<span class="batch-sequence" aria-label="序號"></span>'+
  label('貨品種類','<select data-return-item-category>'+options([...new Map(data.items.map(i=>[i.category_id,{id:i.category_id,name:i.category}])).values()],item(line.inventory_item_id)?.category_id||'',r=>r.name,'所有種類')+'</select>')+
  label('品項名稱','<select data-return-item required>'+options(data.items,line.inventory_item_id||'',i=>String(i.code)+'｜'+i.name+' '+(i.brand||'')+' '+(i.model||''),'請選擇品項')+'</select>','inventory-search-choice')+
  label('數量／米數','<input type="number" data-return-quantity min="0.01" max="999999999999.99" step="0.01" value="'+esc(line.quantity??'')+'" required>')+
  label('入庫單位','<select data-return-mode><option value="package">原單位</option><option value="meter" '+(line.quantity_unit==='meter'?'selected':'')+'>散料（米）</option></select>')+
  label('箱號／備註','<input data-return-label maxlength="80" value="'+esc(line.box_label||'')+'" placeholder="選填；每列一箱">')+
  '<button type="button" class="row-remove" data-return-remove aria-label="刪除此列">刪除</button><small data-return-legacy class="return-legacy-hint" hidden>歷史未分箱散料</small>';
  form.querySelector('[data-return-lines]').append(row);row.querySelectorAll('input,select,button').forEach(el=>el.disabled=editor.readonly);lineChoices(row);return row;
 }
 function renderItemSearch(){const query=val('returnItemSearch').trim(),rows=query?data.items.filter(i=>i.active&&matches([i.name,i.brand,i.model,i.code],query)).sort((a,b)=>a.name.localeCompare(b.name,'zh-Hant')):[],shown=rows.slice(0,50);
  document.getElementById('returnItemSearchResults').innerHTML=shown.map(i=>`<button type="button" class="outline" data-return-search-item="${esc(i.id)}"><strong>${esc(i.name)}</strong><span>${esc(i.brand||'')} ${esc(i.model||'')}｜${esc(i.code)}｜${esc(i.category||'')}</span></button>`).join('');
  document.getElementById('returnItemSearchStatus').textContent=!query?'輸入關鍵字搜尋品項。':!rows.length?'沒有符合的品項。':rows.length>shown.length?`共 ${rows.length} 筆，顯示前 50 筆，請縮小關鍵字。`:`找到 ${rows.length} 筆品項。`;
 }
 function chooseSearchItem(id){if(saving||editor?.readonly)return;const selected=item(id);if(!selected?.active)return;
  const rows=[...form.querySelectorAll('.site-return-line')],status=document.getElementById('returnItemSearchStatus');
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
 form.addEventListener('change',e=>{if(e.target.name==='category')formChoices(true,true);if(e.target.name==='customer'){const selected=customer(form.elements.customer.value);if(selected)form.elements.category.value=selected.category;formChoices(false,true);}const row=e.target.closest('.site-return-line');if(row){if(e.target.hasAttribute('data-return-item-category'))row.querySelector('[data-return-item]').value='';lineChoices(row);}});
 form.addEventListener('input',e=>{if(e.target.id==='returnItemSearch')renderItemSearch();if(e.target.name==='customerSearch')formChoices();});
 form.addEventListener('keydown',e=>{if(e.target.id==='returnItemSearch'&&e.key==='Enter'&&!e.isComposing){e.preventDefault();renderItemSearch();}});
 form.addEventListener('click',e=>{if(saving||editor?.readonly)return;const result=e.target.closest('[data-return-search-item]');if(result)chooseSearchItem(result.dataset.returnSearchItem);if(e.target.closest('[data-return-add]')){if(form.querySelectorAll('.site-return-line').length>=50)return;addLine();}if(e.target.closest('[data-return-remove]'))e.target.closest('.site-return-line').remove();});
 form.addEventListener('submit',async e=>{e.preventDefault();if(saving||editor.readonly)return;const output=form.querySelector('[data-return-form-message]');try{
  const rows=[...form.querySelectorAll('.site-return-line')].map(row=>{const inventory_item_id=row.querySelector('[data-return-item]').value,quantity=Number(row.querySelector('[data-return-quantity]').value),quantity_unit=row.querySelector('[data-return-mode]').value,legacy=quantity_unit==='meter'&&row.dataset.originalMode==='meter'&&row.dataset.originalItem===inventory_item_id&&row.dataset.wasBox!=='true';return {id:row.dataset.lineId,inventory_item_id,quantity,quantity_unit,is_remnant_box:quantity_unit==='meter'&&!legacy,box_label:row.querySelector('[data-return-label]').value.trim(),lengths:legacy&&quantity===row._originalQuantity?row._lengths:[]};});
  if(!rows.length||rows.some(r=>!r.inventory_item_id||!Number.isFinite(r.quantity)||r.quantity<=0))throw Error('請加入至少一筆有效材料。');
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
