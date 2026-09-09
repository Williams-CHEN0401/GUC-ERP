const NAS_BROWSER_CHUNK_BYTES = 3 * 1024 * 1024;
const NAS_BROWSER_DIRECT_BYTES = 4 * 1024 * 1024;
const NAS_BROWSER_FILE_CONCURRENCY = 2;

async function transferNasFiles({ files, context, description = '', attachmentType = 'photo', request, progress, conflictChoice, register }) {
  const outcomes = new Array(files.length);
  let uploadFolder = '', cursor = 0, completed = 0;
  const bodyFor = mode => {
    const body = new FormData();body.append('mode', mode);
    for (const [key, value] of Object.entries(context)) body.append(key, value);
    return body;
  };
  // Prepare the shared folder once; each file receives its own short-lived signed ticket.
  progress('checking', `正在檢查 ${files.length} 個檔案…`);
  const prepare = bodyFor('prepare_batch');
  prepare.append('file_metadata', JSON.stringify(files.map(file => ({ name: file.name, size: file.size }))));
  let batch;
  try { batch = await request(prepare, 45000); }
  catch (error) { return { uploaded: [], failed: files.map(file => ({ name: file.name, error: error.message })), upload_folder: '' }; }
  const choices = new Map();
  // Conflict dialogs are sequential, even though transfers run in parallel.
  for (const [index] of files.entries()) {
    const conflict = batch.files?.[index];
    if (conflict?.exists) choices.set(index, await conflictChoice(conflict));
  }
  const transfer = async (file, fileIndex) => {
    let uploadTicket = '';
    const notify = message => progress('uploading', `已處理 ${completed}／${files.length} 個檔案。${message}`);
    try {
      let preflight = { preflight_ticket: batch.file_tickets?.[fileIndex], conflicts: batch.files?.[fileIndex]?.exists ? [batch.files[fileIndex]] : [] };
      // Refresh expired tickets after a slow transfer or a long conflict dialog.
      if (!preflight.preflight_ticket || Date.now() + 5000 >= batch.expires_at) {
        const check = bodyFor('preflight');check.append('file_names', JSON.stringify([file.name]));
        preflight = await request(check, 45000);
      }
      if (!preflight.preflight_ticket) throw new Error('NAS 預檢票證未建立，請重試。');
      const conflict = preflight.conflicts?.[0];
      const action = choices.has(fileIndex) ? choices.get(fileIndex) : conflict ? await conflictChoice(conflict) : 'new';
      if (action === 'cancel') return { failed: { name: file.name, error: '已取消此檔案', skipped: true } };
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
          try { await request(chunk); }
          catch (error) { if (error.status && error.status < 500) throw error; await request(chunk); }
        }
        notify(`正在傳送 ${file.name} 的最後一段並校驗原檔…`);
        const complete = bodyFor('complete_file');complete.append('upload_ticket', uploadTicket);
        complete.append('tail', file.slice(prefixBytes), 'tail.part');
        result = await request(complete);uploadTicket = '';
      } else {
        body.append('conflict_actions', JSON.stringify({ [conflict?.name || file.name]: action }));
        body.append('files', file, file.name);notify(`正在傳送 ${file.name}`);
        result = await request(body);
      }
      uploadFolder = result.upload_folder || uploadFolder;
      if (!result.uploaded?.length) throw new Error(result.failed?.[0]?.error || '附件未能完成寫入，請重試。');
      notify(`${file.name}：NAS 已完成寫入與檔案大小驗證，正在儲存附件紀錄…`);
      try { await register(result.uploaded); }
      catch (error) { throw new Error(`檔案已寫入 NAS，但 ERP 附件索引保存失敗：${file.name}。${error.message}`); }
      return { uploaded: result.uploaded };
    } catch (error) {
      if (uploadTicket) {
        const cancel = bodyFor('cancel_file');cancel.append('upload_ticket', uploadTicket);
        try { await request(cancel, 30000); } catch { /* Interrupted staging folders are never indexed as attachments. */ }
      }
      return { failed: { name: file.name, error: error.message } };
    } finally { completed++; }
  };
  await Promise.all(Array.from({ length: Math.min(files.length, NAS_BROWSER_FILE_CONCURRENCY) }, async () => {
    while (cursor < files.length) { const index = cursor++;outcomes[index] = await transfer(files[index], index); }
  }));
  return { uploaded: outcomes.flatMap(result => result.uploaded || []), failed: outcomes.flatMap(result => result.failed ? [result.failed] : []), upload_folder: uploadFolder };
}
