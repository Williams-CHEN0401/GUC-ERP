const NAS_BROWSER_CHUNK_BYTES = 3 * 1024 * 1024;

async function transferNasFiles({ files, context, description = '', attachmentType = 'photo', request, progress, conflictChoice, register }) {
  const uploaded = [], failed = [];
  let uploadFolder = '';
  const bodyFor = mode => {
    const body = new FormData();
    body.append('mode', mode);
    for (const [key, value] of Object.entries(context)) body.append(key, value);
    return body;
  };
  for (const [fileIndex, file] of files.entries()) {
    let uploadTicket = '', result;
    try {
      progress('checking', `正在檢查第 ${fileIndex + 1}／${files.length} 個檔案：${file.name}`);
      const preflightBody = bodyFor('preflight');
      preflightBody.append('file_names', JSON.stringify([file.name]));
      const preflight = await request(preflightBody, 45000);
      if (!preflight.preflight_ticket) throw new Error('NAS 預檢票證未建立，請重試。');
      const conflict = preflight.conflicts?.[0];
      const action = conflict ? await conflictChoice(conflict) : 'new';
      if (action === 'cancel') { failed.push({ name: file.name, error: '已取消此檔案', skipped: true }); continue; }
      const body = bodyFor(file.size > NAS_BROWSER_CHUNK_BYTES ? 'begin_file' : 'upload');
      body.append("preflight_ticket",preflight.preflight_ticket);
      body.append('description', description);
      body.append('attachment_type', attachmentType);
      if (file.size > NAS_BROWSER_CHUNK_BYTES) {
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        body.append('sha256', [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join(''));
        body.append('file_name', file.name);
        body.append('file_size', String(file.size));
        body.append('mime_type', file.type || 'application/octet-stream');
        body.append('conflict_action', action);
        const started = await request(body);
        if (!started.upload_ticket || started.chunk_bytes !== NAS_BROWSER_CHUNK_BYTES) throw new Error('照片傳輸初始化失敗，請重試。');
        uploadTicket = started.upload_ticket;
        const count = Math.ceil(file.size / NAS_BROWSER_CHUNK_BYTES);
        for (let index = 0; index < count; index++) {
          progress('uploading', `正在傳送第 ${fileIndex + 1}／${files.length} 個檔案，${Math.round(index / count * 100)}%：${file.name}`);
          const chunk = bodyFor('upload_chunk');
          chunk.append('upload_ticket', uploadTicket);
          chunk.append('chunk_index', String(index));
          chunk.append('chunk', file.slice(index * NAS_BROWSER_CHUNK_BYTES, (index + 1) * NAS_BROWSER_CHUNK_BYTES), 'chunk.part');
          // Replacing the same signed chunk is idempotent. Never auto-retry final writes.
          try { await request(chunk); }
          catch (error) { if (error.status && error.status < 500) throw error; await request(chunk); }
        }
        progress('uploading', `第 ${fileIndex + 1}／${files.length} 個檔案已傳送，正在校驗原檔：${file.name}`);
        const complete = bodyFor('complete_file');
        complete.append('upload_ticket', uploadTicket);
        result = await request(complete);
        uploadTicket = '';
      } else {
        body.append('conflict_actions', JSON.stringify({ [conflict?.name || file.name]: action }));
        body.append('files', file, file.name);
        progress('uploading', `正在傳送第 ${fileIndex + 1}／${files.length} 個檔案：${file.name}`);
        result = await request(body);
      }
      uploadFolder = result.upload_folder || uploadFolder;
      if (!result.uploaded?.length) throw new Error(result.failed?.[0]?.error || '附件未能完成寫入，請重試。');
      progress('indexing', 'NAS 已完成寫入與檔案大小驗證，正在建立 ERP 附件索引…');
      // Register each successful file immediately so a later failure does not hide prior uploads.
      try { await register(result.uploaded); }
      catch (error) { throw new Error(`檔案已寫入 NAS，但 ERP 附件索引保存失敗：${file.name}。${error.message}`); }
      uploaded.push(...result.uploaded);
    } catch (error) {
      if (uploadTicket) {
        const cancel = bodyFor('cancel_file');cancel.append('upload_ticket', uploadTicket);
        try { await request(cancel, 30000); } catch { /* An interrupted staging folder never becomes an attachment. */ }
      }
      failed.push({ name: file.name, error: error.message });
    }
  }
  return { uploaded, failed, upload_folder: uploadFolder };
}
