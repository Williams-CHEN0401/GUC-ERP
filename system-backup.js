/* Uses the ERP session and dedicated server-side permissions. Passwords stay in memory only. */
(()=>{
 const root=document.querySelector('#systemBackupRoot');if(!root)return;
 let catalog=null,loading=false,poll=null,plan=null,upload=null,lastToken='';
 const html=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const token=()=>sessionStorage.getItem('GUC_ERP_ACCESS_TOKEN')||'';
 function reset(){catalog=null;plan=null;upload=null;clearTimeout(poll);root.replaceChildren();}
 async function api(path,method='GET',data){const requestToken=token(),response=await fetch('/api/system-backup'+path,{method,headers:{Authorization:'Bearer '+requestToken,...(data instanceof File?{'Content-Type':'application/octet-stream'}:data?{'Content-Type':'application/json'}:{})},...(data?{body:data instanceof File?data:JSON.stringify(data)}:{})});const result=await response.json();if(requestToken!==token()){reset();throw Error('登入帳號已變更，請重新載入備份頁面。');}if(!response.ok){if([401,403].includes(response.status))reset();throw Error(result.error||'備份服務無法完成操作。');}return result;}
 const message=(text,error=false)=>{const e=root.querySelector('[data-backup-message]');if(e){e.textContent=text;e.classList.toggle('backup-error',error);}};
 function view(){
  root.innerHTML=`<div class="backup-grid"><article class="panel backup-card"><h2>建立系統備份</h2><p>選擇範圍後產生加密套件，保留版本及完整性資訊。</p><form id="systemBackupForm"><div class="backup-options">${catalog.websites.map(w=>`<label><input type="checkbox" name="websites" value="${html(w.id)}" checked>${html(w.label)}</label>`).join('')}<label><input type="checkbox" name="database" checked>${html(catalog.database.label)}</label><small>三套系統共用資料庫；選取後會包含共用主資料、帳號與跨系統關聯。</small><label><input type="checkbox" name="images">納入所選網站的 Docker 映像（檔案較大）</label><label><input type="checkbox" name="storage" checked>Supabase Storage 持久化附件</label><label><input type="checkbox" name="nas" ${catalog.nas?.available?'':'disabled'}>NAS 附件${catalog.nas?.available?'':'（目前環境未提供）'}</label></div><label>備份加密密碼<input name="password" type="password" minlength="12" maxlength="256" required autocomplete="new-password"></label><small>至少 12 個字元。請自行保管；系統不保存密碼，遺失後無法解密。</small><div class="backup-actions"><button class="primary" type="submit" ${catalog.capabilities.create?'':'disabled'}>確認範圍並備份</button><button type="button" class="secondary" data-backup-refresh>重新讀取</button></div></form></article><article class="panel backup-card"><h2>驗證與復原</h2><p>先驗證加密套件、版本及雜湊，再於獨立環境還原。正式資料不會被覆蓋。</p><form id="systemRestoreForm"><label>備份套件<input name="file" type="file" accept=".gucbackup" required></label><label>解密密碼<input name="password" type="password" minlength="12" maxlength="256" required autocomplete="off"></label><div class="backup-actions"><button type="submit" class="secondary" ${catalog.capabilities.restore?'':'disabled'}>上傳並驗證套件</button></div></form><div data-backup-plan></div></article></div><p class="backup-message" data-backup-message role="status"></p><article class="panel backup-card"><h2>備份及復原紀錄</h2><div class="backup-jobs" data-backup-jobs></div></article>`;
  const storage=root.querySelector('[name=storage]');storage.disabled=!catalog.storage?.available;storage.checked=!!catalog.storage?.available;syncImageOption();
 }
 function syncImageOption(){const images=root.querySelector('[name=images]');if(!images||!catalog)return;const selected=[...root.querySelectorAll('[name=websites]:checked')].map(e=>e.value),available=selected.length>0&&selected.every(id=>catalog.websites.find(w=>w.id===id)?.imageAvailable);images.disabled=!available;if(!available)images.checked=false;images.closest('label').title=available?'':'目前所選網站未提供可備份映像，仍可備份網站原始碼。';}
 root.addEventListener('change',event=>{if(event.target.name==='websites')syncImageOption();});
 async function refresh(){const data=await api('/jobs');const area=root.querySelector('[data-backup-jobs]');if(!area)return;area.innerHTML=`<table><thead><tr><th>建立時間</th><th>範圍</th><th>狀態</th><th>檔案大小</th><th>操作</th></tr></thead><tbody>${data.jobs.map(j=>`<tr><td>${html(new Date(j.createdAt).toLocaleString('zh-TW'))}</td><td>${html((j.selection.websites||[]).map(k=>catalog.websites.find(w=>w.id===k)?.label||k).join('、'))}${j.selection.database?'／共用資料庫':''}${j.restore?'／隔離復原':''}</td><td>${html(j.stage||j.status)}${j.error?`<small class="backup-error">${html(j.error)}</small>`:''}</td><td>${j.bytes?html((j.bytes/1024/1024).toFixed(1)+' MB'):'—'}</td><td>${j.status==='completed'&&j.filename?`<button type="button" data-backup-download="${html(j.id)}">下載加密套件</button>`:'—'}</td></tr>`).join('')||'<tr><td colspan="5">尚無備份紀錄</td></tr>'}</tbody></table>`;clearTimeout(poll);if(data.busy&&(document.querySelector('#settings')?.classList.contains('active')&&document.querySelector('#backup')?.classList.contains('active')))poll=setTimeout(()=>refresh().catch(e=>message(e.message,true)),3000);}
 async function enter(){if(lastToken!==token()){lastToken=token();reset();}if(loading||!(document.querySelector('#settings')?.classList.contains('active')&&document.querySelector('#backup')?.classList.contains('active'))||!token())return;loading=true;try{if(!catalog){catalog=await api('/catalog');view();}await refresh();}catch(e){if(!catalog)root.innerHTML='<article class="panel backup-card"><h2>系統備份</h2><p data-backup-message role="alert"></p><button type="button" data-backup-refresh>重新連線</button></article>';message(e.message,true);}finally{loading=false;}}
 root.addEventListener('submit',async event=>{
  if(!['systemBackupForm','systemRestoreForm'].includes(event.target.id))return;event.preventDefault();const form=event.target,button=event.submitter||form.querySelector('button[type=submit]');button.disabled=true;
  try{
   const data=new FormData(form),password=String(data.get('password')||'');
   if(form.id==='systemBackupForm'){
    const selection={websites:data.getAll('websites'),database:data.has('database'),images:data.has('images'),storage:data.has('storage'),nas:data.has('nas')};
    if(!confirm('確認建立所選範圍的加密備份？資料庫包含三套系統的共用資料。'))return;
    await api('/jobs','POST',{selection,password});form.elements.password.value='';message('備份已開始，完成後可下載加密套件。');await refresh();
   }else{
    const file=data.get('file');if(!(file instanceof File)||!file.size)throw Error('請選擇備份套件。');message('正在上傳與驗證套件，請勿關閉頁面。');
    upload=await api('/restore/upload','PUT',file);plan=await api('/restore/inspect','POST',{uploadId:upload.uploadId,password});form.elements.password.value='';
    root.querySelector('[data-backup-plan]').innerHTML=`<div class="backup-plan">${html(JSON.stringify({備份時間:plan.createdAt,資料範圍:plan.scope||plan.selection,相容性:plan.compatibility},null,2))}</div><p>還原目標：新的隔離測試環境。正式網站與資料庫保持原狀。</p><button type="button" class="primary" data-backup-restore>確認在隔離環境復原</button>`;message('套件完整性驗證通過，請確認資料範圍後復原。');
   }
  }catch(e){message(e.message,true);}finally{button.disabled=false;}
 });
 root.addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button)return;
  try{
   if(button.hasAttribute('data-backup-refresh'))return enter();
   if(button.dataset.backupDownload){button.disabled=true;const ticket=await api('/jobs/'+button.dataset.backupDownload+'/ticket','POST',{});const link=document.createElement('a');link.href=ticket.path;link.download=ticket.filename;link.rel='noreferrer';document.body.append(link);link.click();link.remove();message('下載已交由瀏覽器處理，可依瀏覽器設定選擇儲存位置。');}
   if(button.hasAttribute('data-backup-restore')){if(!plan||!confirm('確認將已驗證套件還原到新的隔離環境？'))return;button.disabled=true;await api('/restore/execute','POST',{planId:plan.planId,target:'isolated',confirm:'RESTORE ISOLATED'});plan=null;root.querySelector('[data-backup-plan]').replaceChildren();message('隔離復原與資料核對已開始。');await refresh();}
  }catch(e){message(e.message,true);}finally{button.disabled=false;}
 });
 for(const id of ['backup','settings'])new MutationObserver(()=>{if(!document.querySelector('#settings')?.classList.contains('active')||!document.querySelector('#backup')?.classList.contains('active'))clearTimeout(poll);else void enter();}).observe(document.getElementById(id),{attributes:true,attributeFilter:['class']});
 window.addEventListener('guc:session-changed',()=>{reset();void enter();});
 window.addEventListener('beforeunload',()=>clearTimeout(poll));setTimeout(enter,500);
})();
