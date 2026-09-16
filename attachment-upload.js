const NAS_BROWSER_CHUNK_BYTES = 3 * 1024 * 1024;
const NAS_BROWSER_DIRECT_BYTES = 4 * 1024 * 1024;
const NAS_BROWSER_FILE_CONCURRENCY = 2;

// Upload progress measures browser -> server transport, not NAS persistence.
function setAttachmentFormUploading(form, active) {
  if (active) {
    form.classList.add('attachment-transfer-active');
    form.querySelectorAll('input,select,textarea,button').forEach(field=>{if(!field.inert){field.inert=true;field.dataset.uploadInert='true';}});
  } else {
    form.classList.remove('attachment-transfer-active');
    form.querySelectorAll('[data-upload-inert]').forEach(field=>{field.inert=false;delete field.dataset.uploadInert;});
  }
}
function nasProgressRequest(body, timeout = 120_000, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = event => { if (event.lengthComputable && event.total > 0) onProgress?.(Math.min(1, event.loaded / event.total)); };
    xhr.upload.onload = () => onProgress?.(1);
    xhr.onload = () => {
      let result;try { result = JSON.parse(xhr.responseText); } catch { /* Preserve HTTP error status even for a non-JSON proxy error. */ }
      if (xhr.status >= 200 && xhr.status < 300) { if(result&&typeof result==='object')resolve(result);else reject(new Error('附件伺服器回應異常，請重新整理後確認檔案狀態。')); }
      else { const error = new Error(result?.error || (xhr.status === 413 ? '附件傳輸超過主機單次限制，請重新整理後再試。' : '附件無法上傳至 NAS。'));error.status = xhr.status;reject(error); }
    };
    xhr.onerror = () => reject(new Error('附件上傳連線中斷，請檢查網路後確認檔案狀態。'));
    xhr.ontimeout = () => reject(new Error('附件上傳逾時，請檢查網路後再試。'));
    xhr.onabort = () => reject(new Error('附件上傳已中止。'));
    xhr.open('POST', NAS_API_ENDPOINT, true);xhr.timeout = timeout;
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);xhr.send(body);
  });
}

function setAttachmentUploadProgress(stage, message, snapshot) {
  const host = document.querySelector('#attachmentUploadProgress');if (!host) return;
  const first = host.hidden;host.hidden = false;host.dataset.stage = stage;
  if (snapshot) host._uploadSnapshot = snapshot;
  else if (stage === 'checking') delete host._uploadSnapshot;
  const data = host._uploadSnapshot;
  const labels = {waiting:'等待上傳',preparing:'準備／檢查檔案',uploading:'傳送中',verifying:'等待 NAS 寫入與校驗',registering:'儲存附件紀錄',done:'已完成',error:'失敗',skipped:'已取消'};
  host.innerHTML = `<strong>${esc(message)}</strong>` + (data ? `<div class="attachment-progress-total"><span>傳送進度 ${data.percent}%</span><span>成功 ${data.succeeded}／${data.total} 個 · 失敗 ${data.failed} 個 · 取消 ${data.skipped} 個</span></div><progress max="100" value="${data.percent}" aria-label="附件整體傳送進度">${data.percent}%</progress><small>傳送 100% 後仍須等待 NAS 校驗及附件紀錄儲存；「已完成」才表示成功。</small><ul class="attachment-progress-files">${data.files.map(file=>`<li data-upload-state="${file.state}"><div><span>${esc(file.name)}</span><b>${labels[file.state]} · ${Math.floor(file.loaded / (file.size || 1) * 100)}%</b></div><progress max="${file.size || 1}" value="${file.loaded}" aria-label="${esc(file.name)} 傳送進度"></progress>${file.error?`<small>${esc(file.error)}</small>`:''}</li>`).join('')}</ul>` : '');
  if (first) host.scrollIntoView?.({behavior:'smooth',block:'nearest'});
}

async function transferNasFiles({ files, context, description = '', attachmentType = 'photo', request, progress, conflictChoice, register }) {
  const outcomes = new Array(files.length);
  let uploadFolder = '', cursor = 0, completed = 0;
  const fileProgress = files.map(file=>({name:file.name,size:file.size,loaded:0,state:'waiting'}));
  const emit = (stage, message) => {
    const totalBytes = fileProgress.reduce((sum,file)=>sum+file.size,0);
    progress(stage,message,{total:files.length,completed,percent:Math.floor(fileProgress.reduce((sum,file)=>sum+file.loaded,0)/(totalBytes||1)*100),succeeded:fileProgress.filter(f=>f.state==='done').length,failed:fileProgress.filter(f=>f.state==='error').length,skipped:fileProgress.filter(f=>f.state==='skipped').length,files:fileProgress.map(f=>({...f}))});
  };
  const bodyFor = mode => {
    const body = new FormData();body.append('mode', mode);
    for (const [key, value] of Object.entries(context)) body.append(key, value);
    return body;
  };
  // Prepare the shared folder once; each file receives its own short-lived signed ticket.
  emit('checking', `正在檢查 ${files.length} 個檔案…`);
  const prepare = bodyFor('prepare_batch');
  prepare.append('file_metadata', JSON.stringify(files.map(file => ({ name: file.name, size: file.size }))));
  let batch;
  try { batch = await request(prepare, 45000); }
  catch (error) { fileProgress.forEach(file=>Object.assign(file,{state:'error',error:error.message}));emit('error','檔案檢查失敗，尚未上傳。');return { uploaded: [], failed: files.map(file => ({ name: file.name, error: error.message })), upload_folder: '' }; }
  const choices = new Map();
  // Conflict dialogs are sequential, even though transfers run in parallel.
  for (const [index] of files.entries()) {
    const conflict = batch.files?.[index];
    if (conflict?.exists) choices.set(index, await conflictChoice(conflict));
  }
  const transfer = async (file, fileIndex) => {
    let uploadTicket = '';
    const item = fileProgress[fileIndex];
    const notify = message => emit('uploading', `已處理 ${completed}／${files.length} 個檔案。${message}`);
    const send = async (body, offset, bytes, final = false) => {
      item.state = 'uploading';notify(`正在傳送 ${file.name}`);
      const report = fraction => { item.loaded = Math.max(item.loaded, Math.min(file.size, offset + Math.floor(bytes * fraction)));if(final && fraction===1)item.state='verifying';notify(final && fraction===1?'正在等待 NAS 寫入與校驗…':`正在傳送 ${file.name}`); };
      const result = await request(body,120_000,report);report(1);return result;
    };
    try {
      item.state = 'preparing';notify(`正在準備 ${file.name}`);
      let preflight = { preflight_ticket: batch.file_tickets?.[fileIndex], conflicts: batch.files?.[fileIndex]?.exists ? [batch.files[fileIndex]] : [] };
      // Refresh expired tickets after a slow transfer or a long conflict dialog.
      if (!preflight.preflight_ticket || Date.now() + 5000 >= batch.expires_at) {
        const check = bodyFor('preflight');check.append('file_names', JSON.stringify([file.name]));
        preflight = await request(check, 45000);
      }
      if (!preflight.preflight_ticket) throw new Error('NAS 預檢票證未建立，請重試。');
      const conflict = preflight.conflicts?.[0];
      const action = choices.has(fileIndex) ? choices.get(fileIndex) : conflict ? await conflictChoice(conflict) : 'new';
      if (action === 'cancel') { item.state='skipped';return { failed: { name: file.name, error: '已取消此檔案', skipped: true } }; }
      const large = file.size > NAS_BROWSER_DIRECT_BYTES;
      const body = bodyFor(large ? 'begin_file' : 'upload');
      body.append("preflight_ticket",preflight.preflight_ticket);
      body.append('description', description);body.append('attachment_type', attachmentType);
      let result;
      if (large) {
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        body.append('sha256', [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join(''));
        body.append('file_name', file.name);body.append('file_size', String(file.size));
        body.append('mime_type', file.type || 'application/octet-stream');body.append('conflict_action', action);
        body.append('inline_tail', 'true');
        const started = await request(body);
        uploadTicket = started.upload_ticket || '';
        const prefixBytes = file.size - NAS_BROWSER_DIRECT_BYTES, count = Math.ceil(prefixBytes / NAS_BROWSER_CHUNK_BYTES);
        if (!started.upload_ticket || started.chunk_bytes !== NAS_BROWSER_CHUNK_BYTES || started.tail_bytes !== NAS_BROWSER_DIRECT_BYTES || started.chunk_count !== count) throw new Error('照片傳輸初始化失敗，請重試。');
        for (let index = 0; index < count; index++) {
          notify(`正在傳送 ${file.name}（${Math.round(index * NAS_BROWSER_CHUNK_BYTES / file.size * 100)}%）`);
          const chunk = bodyFor('upload_chunk');chunk.append('upload_ticket', uploadTicket);chunk.append('chunk_index', String(index));
          chunk.append('chunk', file.slice(index * NAS_BROWSER_CHUNK_BYTES, Math.min((index + 1) * NAS_BROWSER_CHUNK_BYTES, prefixBytes)), 'chunk.part');
          // Signed chunk replacements are idempotent; never retry final NAS writes automatically.
          const offset=index * NAS_BROWSER_CHUNK_BYTES, bytes=Math.min(NAS_BROWSER_CHUNK_BYTES,prefixBytes-offset);
          try { await send(chunk,offset,bytes); }
          catch (error) { if (error.status && error.status < 500) throw error; await send(chunk,offset,bytes); }
        }
        notify(`正在傳送 ${file.name} 的最後一段並校驗原檔…`);
        const complete = bodyFor('complete_file');complete.append('upload_ticket', uploadTicket);
        complete.append('tail', file.slice(prefixBytes), 'tail.part');
        result = await send(complete,prefixBytes,NAS_BROWSER_DIRECT_BYTES,true);uploadTicket = '';
      } else {
        body.append('conflict_actions', JSON.stringify({ [conflict?.name || file.name]: action }));
        body.append('files', file, file.name);notify(`正在傳送 ${file.name}`);
        result = await send(body,0,file.size,true);
      }
      uploadFolder = result.upload_folder || uploadFolder;
      if (!result.uploaded?.length) throw new Error(result.failed?.[0]?.error || '附件未能完成寫入，請重試。');
      item.state='registering';notify(`${file.name}：NAS 已完成寫入與檔案大小驗證，正在儲存附件紀錄…`);
      try { await register(result.uploaded); }
      catch (error) { throw new Error(`檔案已寫入 NAS，但 ERP 附件索引保存失敗：${file.name}。${error.message}`); }
      item.state='done';return { uploaded: result.uploaded };
    } catch (error) {
      item.state='error';item.error=error.message;
      if (uploadTicket) {
        const cancel = bodyFor('cancel_file');cancel.append('upload_ticket', uploadTicket);
        try { await request(cancel, 30000); } catch { /* Interrupted staging folders are never indexed as attachments. */ }
      }
      return { failed: { name: file.name, error: error.message } };
    } finally { completed++;notify('請等待所有附件處理完成。'); }
  };
  await Promise.all(Array.from({ length: Math.min(files.length, NAS_BROWSER_FILE_CONCURRENCY) }, async () => {
    while (cursor < files.length) { const index = cursor++;outcomes[index] = await transfer(files[index], index); }
  }));
  emit(fileProgress.every(file=>file.state==='done')?'complete':'error',fileProgress.every(file=>file.state==='done')?'全部附件已上傳、校驗並儲存完成。':'附件處理結束，請查看各檔案結果。');
  return { uploaded: outcomes.flatMap(result => result.uploaded || []), failed: outcomes.flatMap(result => result.failed ? [result.failed] : []), upload_folder: uploadFolder };
}
