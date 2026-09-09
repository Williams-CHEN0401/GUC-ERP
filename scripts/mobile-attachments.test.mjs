import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import nasApi, { verifyChunkTicket } from '../api/nas.mjs';
import { createNasMemoryFixture } from './nas-memory-fixture.mjs';

test('手機原檔逐檔分段上傳：平台限制、HEIC、重試、校驗、權限與部分失敗', async () => {
  const env = ['VERCEL_ENV','NAS_WEBDAV_URL','NAS_WEBDAV_USERNAME','NAS_WEBDAV_PASSWORD','NAS_WEBDAV_ROOT'];
  const savedEnv = Object.fromEntries(env.map(key => [key, process.env[key]])), savedFetch = globalThis.fetch;
  Object.assign(process.env, { VERCEL_ENV:'production', NAS_WEBDAV_URL:'https://nas.fixture.test', NAS_WEBDAV_USERNAME:'fixture', NAS_WEBDAV_PASSWORD:'fixture-only', NAS_WEBDAV_ROOT:'/GUC-ERP' });
  const fixture = createNasMemoryFixture();globalThis.fetch = fixture.fetch;
  const sandbox = vm.createContext({ FormData, File, Blob, crypto, Uint8Array });
  vm.runInContext(readFileSync(new URL('../attachment-upload.js',import.meta.url),'utf8'),sandbox);
  let requests = [], registered = [], failChunkOnce = false;
  const request = async (body, _timeout, token = 'fixture-token') => {
    const req = new Request('https://erp.fixture.test/api/nas', { method:'POST',headers:{ Authorization:'Bearer '+token },body });
    const size = (await req.clone().arrayBuffer()).byteLength;
    assert.ok(size < 4.5 * 1024 * 1024, 'Every multipart request fits hosting payload limit');
    requests.push({mode:body.get('mode'),size,body});
    if (body.get('mode') === 'upload_chunk' && failChunkOnce) { failChunkOnce = false; throw new Error('temporary mobile network failure'); }
    const response = await nasApi.fetch(req), data = await response.json();
    if (!response.ok) { const error=new Error(data.error);error.status=response.status;throw error; }
    return data;
  };
  const options = { context:fixture.context,request,progress:()=>{},conflictChoice:()=> 'rename',register:rows=>{registered.push(...rows);} };
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 71, 197);
  try {
    // Original implementation puts all photos in one oversized multipart request.
    const old = new FormData();for(let i=0;i<7;i++)old.append('files',new File([bytes],'photo-'+i+'.jpg'));
    assert.ok((await new Request('https://erp.fixture.test',{method:'POST',body:old}).arrayBuffer()).byteLength > 4.5 * 1024 * 1024);
    for (let round=1;round<=2;round++) {
      failChunkOnce = true;
      const files = [new File([bytes],`iphone-${round}.HEIC`,{type:'application/octet-stream'}),new File([bytes],`android-${round}.jpg`,{type:'image/jpeg'}),new File(['small'],`small-${round}.png`,{type:''}),new File([Buffer.alloc(20*1024*1024,42)],`max-${round}.xlsx`)];
      const result = await sandbox.transferNasFiles({...options,files});
      assert.equal(result.failed.length,0,JSON.stringify(result.failed));assert.equal(result.uploaded.length,4);
      for(const [i,row] of result.uploaded.entries()) assert.deepEqual(fixture.files.get(row.nas_path),Buffer.from(await files[i].arrayBuffer()));
      assert.equal([...fixture.folders].filter(p=>p.includes('.erp-upload-')).length,0,'Temporary chunks removed after completion');
    }
    const result = await sandbox.transferNasFiles({...options,files:[new File(['a'],'success.jpg'),new File(['b'],'index-failure.jpg')],register:rows=>{if(rows[0].original_name==='index-failure.jpg')throw new Error('index unavailable');registered.push(...rows);}});
    assert.equal(result.uploaded.length,1);assert.equal(result.failed.length,1);assert.match(result.failed[0].error,/索引保存失敗/);
    assert.ok(registered.some(row=>row.original_name==='success.jpg'));
    // A signed chunk may not be used by another session or moved to another project.
    const chunkRequest = requests.find(r=>r.mode==='upload_chunk').body;
    await assert.rejects(request(chunkRequest,0,'different-token'),/預檢結果已失效/);
    const tampered=new FormData();for(const [key,value]of chunkRequest.entries())tampered.append(key,value);tampered.set('project_id','other-project');
    await assert.rejects(request(tampered),/預檢結果已失效/);
    const invalid=new FormData();for(const [key,value]of chunkRequest.entries())invalid.append(key,value);invalid.set('chunk_index','999');
    await assert.rejects(request(invalid),/分段大小或順序/);
    assert.throws(()=>verifyChunkTicket({root:'/GUC-ERP',password:'fixture-only'},chunkRequest.get('upload_ticket'),{actor:'fixture',...fixture.context},'Bearer fixture-token',Date.now()+16*60*1000),/預檢結果已失效/);
    const createBody=mode=>{const body=new FormData();body.append('mode',mode);for(const[k,v]of Object.entries(fixture.context))body.append(k,v);return body;};
    const preflight=createBody('preflight');preflight.append('file_names',JSON.stringify(['broken.heic']));const checked=await request(preflight);
    const begin=createBody('begin_file');begin.append('preflight_ticket',checked.preflight_ticket);begin.append('file_name','broken.heic');begin.append('file_size','3');begin.append('sha256','0'.repeat(64));
    const started=await request(begin),complete=createBody('complete_file');complete.append('upload_ticket',started.upload_ticket);
    await assert.rejects(request(complete),/尚未傳送完整/);
    const corrupt=createBody('upload_chunk');corrupt.append('upload_ticket',started.upload_ticket);corrupt.append('chunk_index','0');corrupt.append('chunk',new Blob(['bad']),'chunk.part');await request(corrupt);
    await assert.rejects(request(complete),/照片內容校驗失敗/);assert.ok(![...fixture.files.keys()].some(path=>path.endsWith('/broken.heic')));
    const cancel=createBody('cancel_file');cancel.append('upload_ticket',started.upload_ticket);await request(cancel);assert.equal([...fixture.folders].filter(p=>p.includes('.erp-upload-')).length,0);
    fixture.setRole('operator',[{module:'site',can_view:true},{module:'equipment',can_create:false}]);await assert.rejects(request(chunkRequest),/沒有附件上傳權限/);
    fixture.setRole('custom',[{module:'site',can_view:true},{module:'equipment',can_create:true}]);
    const allowed=await sandbox.transferNasFiles({...options,files:[new File(['custom'],'custom.jpg')]});assert.equal(allowed.uploaded.length,1);
    fixture.setRole('worker',[{module:'site',can_view:true},{module:'equipment',can_create:true}],true);await assert.rejects(request(chunkRequest),/沒有附件上傳權限/);
  } finally {
    globalThis.fetch=savedFetch;for(const key of env)if(savedEnv[key]===undefined)delete process.env[key];else process.env[key]=savedEnv[key];
  }
});
