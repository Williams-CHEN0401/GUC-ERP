import test from 'node:test';
import assert from 'node:assert/strict';
import nasApi from '../api/nas.mjs';
import {createNasMemoryFixture} from './nas-memory-fixture.mjs';
test('worklog limit 30, normal limit 10, signed log identity and basic validation remain enforced',async()=>{
 const fixture=createNasMemoryFixture(),savedFetch=globalThis.fetch,names=['VERCEL_ENV','NAS_WEBDAV_URL','NAS_WEBDAV_USERNAME','NAS_WEBDAV_PASSWORD','NAS_WEBDAV_ROOT'],saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 fixture.context.work_log_id='test-log';globalThis.fetch=fixture.fetch;Object.assign(process.env,{VERCEL_ENV:'production',NAS_WEBDAV_URL:'https://nas.fixture.test',NAS_WEBDAV_USERNAME:'fixture',NAS_WEBDAV_PASSWORD:'fixture-only',NAS_WEBDAV_ROOT:'/GUC-ERP'});
 const post=body=>nasApi.fetch(new Request('http://erp.fixture.test/api/nas',{method:'POST',headers:{Authorization:'Bearer test'},body}));
 const prepare=(count,log='test-log')=>{const f=new FormData();f.set('mode','prepare_batch');for(const[k,v]of Object.entries(fixture.context))if(k!=='work_log_id'||log)f.set(k,k==='work_log_id'?log:v);f.set('file_metadata',JSON.stringify(Array.from({length:count},(_,i)=>({name:i+'.jpg',size:100}))));return f;};
 try{
  let response=await post(prepare(30));assert.equal(response.status,200);const batch=await response.json();assert.equal(batch.file_tickets.length,30);
  assert.equal((await post(prepare(31))).status,400);assert.equal((await post(prepare(11,''))).status,400);assert.equal((await post(prepare(10,''))).status,200);
  assert.equal((await post(prepare(1,'foreign-log'))).status,400);const body=prepare(1,'other-log');body.set('mode','upload');body.set('preflight_ticket',batch.file_tickets[0]);body.set('files',new File([Buffer.alloc(100)],'0.jpg',{type:'image/jpeg'}));assert.equal((await post(body)).status,409);
  const bad=prepare(1);bad.set('file_metadata',JSON.stringify([{name:'bad.exe',size:100}]));assert.equal((await post(bad)).status,415);bad.set('file_metadata',JSON.stringify([{name:'empty.jpg',size:0}]));assert.equal((await post(bad)).status,400);
  fixture.setRole('viewer');assert.equal((await post(prepare(1))).status,403);
 }finally{globalThis.fetch=savedFetch;for(const k of names)saved[k]===undefined?delete process.env[k]:process.env[k]=saved[k];}
});
