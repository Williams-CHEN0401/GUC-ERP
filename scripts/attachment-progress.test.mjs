import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../attachment-upload.js',import.meta.url),'utf8');
const sandbox=extra=>{const box=vm.createContext({FormData,File,Blob,crypto,Uint8Array,...extra});vm.runInContext(source,box);return box;};
test('XHR reports real computable transport only and preserves auth, timeout, multipart and HTTP status',async()=>{
 let xhr;class Xhr{constructor(){xhr=this;this.upload={};}open(...args){this.opened=args;}setRequestHeader(...args){this.header=args;}send(body){this.body=body;}}
 const box=sandbox({XMLHttpRequest:Xhr,NAS_API_ENDPOINT:'/api/nas',accessToken:'test-only'}),ratios=[],body=new FormData();
 let pending=box.nasProgressRequest(body,1234,value=>ratios.push(value));
 assert.deepEqual(xhr.opened,['POST','/api/nas',true]);assert.deepEqual(xhr.header,['Authorization','Bearer test-only']);assert.equal(xhr.timeout,1234);assert.equal(xhr.body,body);
 xhr.upload.onprogress({lengthComputable:false,loaded:0,total:0});assert.equal(ratios.length,0);
 xhr.upload.onprogress({lengthComputable:true,loaded:4,total:10});xhr.upload.onload();assert.deepEqual(ratios,[0.4,1]);
 let resolved=false;pending.then(()=>resolved=true);await Promise.resolve();assert.equal(resolved,false,'Transport 100% is not server success');
 xhr.status=201;xhr.responseText='{"uploaded":[{}]}';xhr.onload();assert.equal((await pending).uploaded.length,1);
 for(const status of [401,403,413,500]){pending=box.nasProgressRequest(body);xhr.status=status;xhr.responseText='proxy failure';xhr.onload();await assert.rejects(pending,error=>error.status===status);}
 for(const [event,pattern]of [['ontimeout',/逾時/],['onerror',/連線中斷/],['onabort',/中止/]]){pending=box.nasProgressRequest(body);xhr[event]();await assert.rejects(pending,pattern);}
 pending=box.nasProgressRequest(body);xhr.status=200;xhr.responseText='invalid';xhr.onload();await assert.rejects(pending,/回應異常/);
});
test('parallel direct/chunk progress is byte weighted, retry-safe and complete only after indexing',async()=>{
 const box=sandbox(),snapshots=[],files=[new File([Buffer.alloc(9*1024*1024)],'大照片.heic'),new File([Buffer.alloc(1024*1024)],'文件.pdf')];let retried=false;
 const request=async(body,_timeout,report)=>{
  const mode=body.get('mode');
  if(mode==='prepare_batch')return {file_tickets:['a','b'],files:[{},{}],expires_at:Date.now()+60000};
  if(mode==='begin_file')return {upload_ticket:'u',chunk_bytes:3*1024*1024,tail_bytes:4*1024*1024,chunk_count:2};
  if(report){report(0.5);await Promise.resolve();report(1);}
  if(mode==='upload_chunk'){if(!retried){retried=true;throw Error('retry');}return {};}
  return {uploaded:[{original_name:mode==='upload'?'文件.pdf':'大照片.heic'}]};
 };
 const result=await box.transferNasFiles({files,context:{},request,progress:(stage,message,data)=>snapshots.push({stage,message,...data}),conflictChoice:()=> 'new',register:async()=>{
   assert.ok(snapshots.at(-1).files.some(f=>f.state==='registering'));assert.notEqual(snapshots.at(-1).stage,'complete');
 }});
 assert.equal(result.uploaded.length,2);assert.ok(retried);
 assert.ok(snapshots.some(s=>s.percent>0&&s.percent<100));
 for(let i=1;i<snapshots.length;i++){assert.ok(snapshots[i].percent>=snapshots[i-1].percent);assert.ok(snapshots[i].percent<=100);}
 assert.equal(snapshots.at(-1).stage,'complete');assert.equal(snapshots.at(-1).succeeded,2);assert.equal(snapshots.at(-1).percent,100);
});
test('partial index failure, conflict cancellation and prepare failure never claim all files succeeded',async()=>{
 const box=sandbox(),snapshots=[],files=['ok.jpg','error.pdf','skip.png'].map(name=>new File(['data'],name));
 const result=await box.transferNasFiles({files,context:{},progress:(stage,_message,data)=>snapshots.push({stage,...data}),request:async(body,_timeout,report)=>{
  if(body.get('mode')==='prepare_batch')return {file_tickets:['a','b','c'],files:[{},{},{exists:true}],expires_at:Date.now()+60000};
  report?.(1);return {uploaded:[{original_name:body.get('files').name}]};
 },register:async rows=>{if(rows[0].original_name==='error.pdf')throw Error('index unavailable');},conflictChoice:()=> 'cancel'});
 assert.equal(result.uploaded.length,1);assert.equal(result.failed.length,2);assert.equal(snapshots.at(-1).stage,'error');assert.equal(snapshots.at(-1).succeeded,1);assert.equal(snapshots.at(-1).failed,1);assert.equal(snapshots.at(-1).skipped,1);assert.equal(snapshots.at(-1).percent,66);
 await box.transferNasFiles({files,context:{},progress:(stage,_message,data)=>snapshots.push({stage,...data}),request:async()=>{throw Error('denied');}});
 assert.equal(snapshots.at(-1).percent,0);assert.equal(snapshots.at(-1).failed,3);
});
test('renderer escapes file names/errors, preserves partial results on failure and scrolls only once',()=>{
 const host={hidden:true,dataset:{},scrollIntoView(){this.scrolls=(this.scrolls||0)+1;}},box=sandbox({document:{querySelector:()=>host},esc:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')});
 const snapshot={percent:50,succeeded:0,total:1,failed:0,skipped:0,files:[{name:'<img onerror="bad">.jpg',size:10,loaded:5,state:'uploading'}]};
 box.setAttachmentUploadProgress('uploading','傳送中',snapshot);assert.match(host.innerHTML,/&lt;img/);assert.ok(!host.innerHTML.includes('<img'));assert.match(host.innerHTML,/aria-label=/);
 box.setAttachmentUploadProgress('error','<error>');assert.match(host.innerHTML,/value="50"/);assert.match(host.innerHTML,/&lt;error>/);assert.equal(host.scrolls,1);
 box.setAttachmentUploadProgress('checking','重試');assert.ok(!host.innerHTML.includes('<progress'));
});
