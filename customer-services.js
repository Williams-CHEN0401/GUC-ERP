// Customer associations use the shared service master and the authenticated gateway.
(() => {
  let dialog, customerId = "", data = null, selected = null, busy = false, loadNumber = 0;
  const format = value => value ? new Date(value).toLocaleDateString("zh-TW") : "—";
  function readonly() { return !canAdmin() || PREVIEW_MODE || data?.preview_readonly; }
  function message(text, error = false) { const target = dialog.querySelector('[data-service-message]'); target.textContent = text; target.setAttribute('role', error ? 'alert' : 'status'); }
  async function load() {
    const number = ++loadNumber;
    dialog.querySelector('[data-service-add]').disabled = true;
    message("正在讀取承攬內容…");
    try {
      const response = await fetch(`${API_ENDPOINT}?entity=customer_service_management&customer_id=${encodeURIComponent(customerId)}`, {headers:{Authorization:`Bearer ${accessToken}`},cache:"no-store"});
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "承攬內容載入失敗。");
      if(number !== loadNumber || !dialog.open) return;
      data = body; selected = null; render(); message(readonly() ? "目前可查詢承攬內容；此帳號或測試環境不允許寫入。" : "承攬名稱沿用共用類型；啟停狀態與備註儲存於此客戶的承攬關聯。");
    } catch(error) { if(number === loadNumber) message(error.message,true); }
  }
  function render() {
    const search = dialog.querySelector('[data-service-search]').value.toLocaleLowerCase();
    const body = dialog.querySelector('tbody');
    body.innerHTML = data.records.filter(record => {
      const service = data.services.find(row => row.id === record.service_type_id);
      return `${service?.name || ""} ${record.notes || ""}`.toLocaleLowerCase().includes(search);
    }).map(record => {const service=data.services.find(row=>row.id===record.service_type_id);return `<tr tabindex="0" data-service-row="${esc(record.service_type_id)}" title="雙擊、手機點一下或 Enter 開啟"><td>${esc(service?.name||"未命名承攬")}</td><td>${record.is_active?"啟用":"停用"}${service?.is_active===false?"（類型已停用）":""}</td><td>${esc(format(record.created_at))}</td><td>${esc(format(record.updated_at))}</td><td>${esc(record.notes||"—")}</td><td>${readonly()?"—":`<button type="button" data-service-remove="${esc(record.service_type_id)}">${record.is_active?"刪除／停用":"刪除"}</button>`}</td></tr>`;}).join('') || '<tr><td colspan="6">沒有符合的承攬內容</td></tr>';
    dialog.querySelector('[data-service-add]').disabled = readonly() || busy;
    dialog.querySelector('[data-service-editor]').hidden = true;
  }
  function edit(id) {
    if (!data || busy) return;
    selected = id ? data.records.find(row => row.service_type_id === id) : null;
    const editor = dialog.querySelector('[data-service-editor]'); editor.hidden=false;
    const options = selected ? data.services.filter(row=>row.id===id) : data.services.filter(row=>row.is_active&&!data.records.some(link=>link.service_type_id===row.id));
    editor.innerHTML=`<h3>${selected?"承攬內容明細":"新增承攬內容"}</h3><label>承攬內容名稱／類型<select name="service_id" required ${selected||readonly()?"disabled":""}>${options.map(row=>`<option value="${esc(row.id)}">${esc(row.name)}</option>`).join('')}</select></label><label>狀態<select name="is_active" ${readonly()?"disabled":""}><option value="true" ${selected?.is_active!==false?"selected":""}>啟用</option><option value="false" ${selected?.is_active===false?"selected":""}>停用</option></select></label><label>備註<textarea aria-label="備註" name="notes" maxlength="2000" ${readonly()?"readonly":""}>${esc(selected?.notes||"")}</textarea></label><div><button type="submit" ${readonly()||!options.length?"disabled":""}>儲存承攬內容</button><button type="button" data-service-cancel>收合</button></div>`;
    editor.querySelector('select').focus();
  }
  async function change(payload) {
    if(busy||readonly())return;busy=true;dialog.querySelectorAll('button').forEach(button=>button.disabled=true);
    try {
      const result = await apiRequest({operation:"manage_customer_service",payload:{customer_id:customerId,...payload}});
      loadedScopes.clear();await loadScope('crm',{force:true});await load();
      const action = result.result?.action; message(action==='deactivated'?"此承攬已有相關資料，已改為停用並保留歷史紀錄。":action==='deleted'?"承攬關聯已刪除。":"承攬內容已儲存，案場系統重新載入後即可讀取。");
    } catch(error) {message(error.message,true);} finally {busy=false;dialog.querySelectorAll('button').forEach(button=>button.disabled=false);dialog.querySelector('[data-service-add]').disabled=readonly();}
  }
  function ensureDialog() {
    if(dialog)return;
    dialog=document.createElement('dialog');dialog.className='customer-services-dialog';dialog.setAttribute('aria-label','客戶承攬內容');
    dialog.innerHTML='<header><div><p>客戶 → 承攬內容</p><h2></h2></div><button type="button" data-service-close>關閉</button></header><div class="customer-service-toolbar"><label>搜尋承攬內容<input data-service-search type="search" /></label><button type="button" data-service-add>＋新增承攬內容</button><button type="button" data-service-reload>重新載入</button></div><p data-service-message role="status"></p><div class="customer-service-table"><table><thead><tr><th>名稱／類型</th><th>狀態</th><th>建立日期</th><th>最後更新</th><th>備註</th><th>操作</th></tr></thead><tbody></tbody></table></div><form data-service-editor hidden></form>';
    document.body.append(dialog);
    dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    dialog.addEventListener('close',()=>{loadNumber++;});
    dialog.addEventListener('input',event=>{if(event.target.matches('[data-service-search]')&&data)render();});
    dialog.addEventListener('dblclick',event=>{const row=event.target.closest('[data-service-row]');if(row&&!event.target.closest('button'))edit(row.dataset.serviceRow);});
    dialog.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.matches('[data-service-row]')){event.preventDefault();edit(event.target.dataset.serviceRow);}});
    dialog.addEventListener('click',event=>{
      if(busy)return;
      if(event.target.closest('[data-service-close]'))dialog.close();
      if(event.target.closest('[data-service-reload]'))void load();
      if(event.target.closest('[data-service-add]'))edit(null);
      if(event.target.closest('[data-service-cancel]'))dialog.querySelector('form').hidden=true;
      const remove=event.target.closest('[data-service-remove]');if(remove){const record=data.records.find(row=>row.service_type_id===remove.dataset.serviceRemove);if(confirm('確認移除此客戶的承攬內容？已有案場或歷史關聯時會改為停用，保留資料。'))void change({service_id:record.service_type_id,action:'delete',row_version:record.row_version,is_active:false,notes:record.notes});}
      const row=event.target.closest('[data-service-row]');if(row&&!event.target.closest('button')&&(event.pointerType==='touch'||matchMedia('(pointer: coarse)').matches))edit(row.dataset.serviceRow);
    });
    dialog.querySelector('form').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;void change({service_id:selected?.service_type_id||form.elements.service_id.value,action:selected?'update':'create',row_version:selected?.row_version||null,is_active:form.elements.is_active.value==='true',notes:form.elements.notes.value});});
  }
  document.addEventListener('click',event=>{const entry=event.target.closest('[data-customer-services]');if(!entry)return;ensureDialog();if(busy)return;closeModal();customerId=entry.dataset.customerServices;data=null;dialog.querySelector('h2').textContent=byId(state.customers,customerId)?.name||'客戶承攬內容';dialog.querySelector('tbody').innerHTML='';dialog.querySelector('form').hidden=true;dialog.querySelector('[data-service-search]').value='';dialog.showModal();void load();});
})();
