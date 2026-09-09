import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import nasApi from '../api/nas.mjs';
import {createNasMemoryFixture} from './nas-memory-fixture.mjs';

test('batch uploads reduce NAS bytes, share folder checks and bound parallel transfers without changing originals',async()=>{
 const names=['VERCEL_ENV','NAS_WEBDAV_URL','NAS_WEBDAV_USERNAME','NAS_WEBDAV_PASSWORD','NAS_WEBDAV_ROOT'];
 const saved=Object.fromEntries(names.map(name=>[name,process.env[name]])),savedFetch=globalThis.fetch;
 Object.assign(process.env,{VERCEL_ENV:'production',NAS_WEBDAV_URL:'https://nas.fixture.test',NAS_WEBDAV_USERNAME:'fixture',NAS_WEBDAV_PASSWORD:'fixture-only',NAS_WEBDAV_ROOT:'/GUC-ERP'});
 const sandbox=vm.createContext({FormData,File,Blob,crypto,Uint8Array});vm.runInContext(readFileSync(new URL('../attachment-upload.js',import.meta.url),'utf8'),sandbox);
 const fixture=createNasMemoryFixture();globalThis.fetch=fixture.fetch;
 const modes=[],bodies=[],registered=[];let inFlight=0,peak=0,expired=false,alter;
 const request=async(body)=>{
  if(alter)await alter(body);
  modes.push(body.get('mode'));bodies.push(body);
  const req=new Request('https://erp.fixture.test/api/nas',{method:'POST',headers:{Authorization:'Bearer test'},body});
  assert.ok((await req.clone().arrayBuffer()).byteLength<4_500_000);
  inFlight++;peak=Math.max(peak,inFlight);
  try{
   await new Promise(resolve=>setTimeout(resolve,2));
   const response=await nasApi.fetch(req),data=await response.json();
   if(!response.ok){const error=new Error(data.error);error.status=response.status;throw error;}
   if(expired&&body.get('mode')==='prepare_batch')data.expires_at=0;
   return data;
  }finally{inFlight--;}
 };
 const options={context:fixture.context,request,progress:()=>{},conflictChoice:()=> 'rename',register:async rows=>{registered.push(...rows);}};
 const bodyFor=mode=>{const body=new FormData();body.append('mode',mode);for(const[k,v]of Object.entries(fixture.context))body.append(k,v);return body;};
 try{
  for(let round=0;round<2;round++){
   const files=[new File([Buffer.alloc(6*1024*1024,11)],`large-${round}.heic`),new File([Buffer.alloc(4*1024*1024,22)],`direct-${round}.jpg`),new File([Buffer.alloc(5*1024*1024,33)],`photo-${round}.jpg`)];
   modes.length=0;fixture.calls.length=0;fixture.gatewayCalls.length=0;peak=0;
   const result=await sandbox.transferNasFiles({...options,files});
   assert.equal(result.failed.length,0);assert.equal(result.uploaded.length,3);assert.equal(peak,2);
   assert.equal(modes.filter(mode=>mode==='prepare_batch').length,1);assert.equal(modes.filter(mode=>mode==='preflight').length,0);
   assert.equal(fixture.gatewayCalls.filter(scope=>scope==='sites').length,0);
   const transferred=fixture.calls.reduce((sum,call)=>sum+call.bytes,0);
   assert.equal(transferred,21*1024*1024,'Previous full-chunk path transfers 45 MiB for these same files');
   assert.equal(fixture.calls.filter(call=>call.method==='GET').length,2,'Only prefixes are read back');
   assert.equal(fixture.calls.filter(call=>call.method==='PROPFIND'&&call.path==='/GUC-ERP').length,1);
   for(const [index,row]of result.uploaded.entries())assert.deepEqual(fixture.files.get(row.nas_path),Buffer.from(await files[index].arrayBuffer()));
   assert.equal([...fixture.folders].filter(path=>path.includes('.erp-upload-')).length,0);
  }
  // Same-name choices preserve originals and skipped files have no index.
  const original=new File(['original'],'same.jpg');await sandbox.transferNasFiles({...options,files:[original]});
  let result=await sandbox.transferNasFiles({...options,files:[new File(['replacement'],'same.jpg')],conflictChoice:()=> 'cancel'});
  assert.equal(result.failed[0].skipped,true);
  result=await sandbox.transferNasFiles({...options,files:[new File(['renamed'],'same.jpg')]});assert.equal(result.uploaded[0].stored_name,'same (2).jpg');
  result=await sandbox.transferNasFiles({...options,files:[new File(['replacement'],'same.jpg')],conflictChoice:()=> 'overwrite'});assert.equal(fixture.files.get(result.uploaded[0].nas_path).toString(),'replacement');
  expired=true;modes.length=0;result=await sandbox.transferNasFiles({...options,files:[new File(['a'],'expired.jpg')]});expired=false;
  assert.equal(result.uploaded.length,1);assert.ok(modes.includes('preflight'));
  const putsBefore=fixture.calls.filter(call=>call.method==='PUT').length;
  result=await sandbox.transferNasFiles({...options,files:[new File(['a'],'duplicate.jpg'),new File(['b'],'duplicate.jpg')]});assert.equal(result.failed.length,2);assert.equal(fixture.calls.filter(call=>call.method==='PUT').length,putsBefore);
  // A corrupt/missing inline tail cannot reach the final NAS file; cleanup remains scoped to its stage.
  for(const failure of ['missing','corrupt']){
   alter=async body=>{if(body.get('mode')==='complete_file'){if(failure==='missing')body.delete('tail');else body.set('tail',new Blob([Buffer.alloc(4*1024*1024,99)]),'tail.part');}};
   const filename=`${failure}.jpg`;result=await sandbox.transferNasFiles({...options,files:[new File([Buffer.alloc(5*1024*1024,12)],filename)]});
   assert.equal(result.uploaded.length,0);assert.equal(result.failed.length,1);assert.ok(![...fixture.files.keys()].some(path=>path.endsWith('/'+filename)));
   assert.equal([...fixture.folders].filter(path=>path.includes('.erp-upload-')).length,0);
  }
  alter=undefined;
  // The per-file manifest binds size and filename; a ticket cannot authorize another file.
  const prepare=bodyFor('prepare_batch');prepare.append('file_metadata',JSON.stringify([{name:'bound.jpg',size:5*1024*1024}]));const batch=await request(prepare);
  const begin=bodyFor('begin_file');begin.append('file_name','bound.jpg');begin.append('file_size',String(6*1024*1024));begin.append('sha256',createHash('sha256').update('unused').digest('hex'));begin.append('preflight_ticket',batch.file_tickets[0]);
  await assert.rejects(request(begin),/預檢結果已失效/);
  begin.set('file_size',String(5*1024*1024));begin.set('file_name','other.jpg');await assert.rejects(request(begin),/預檢結果已失效/);
  // Final writes still reject a revoked project/service relationship.
  globalThis.fetch=(url,init)=>String(url).includes('scope=nas_upload_context')?Response.json({customers:[],projects:[],contract_service_types:[],customer_contract_services:[]}):fixture.fetch(url,init);
  const upload=bodyFor('upload');upload.append('preflight_ticket',batch.file_tickets[0]);upload.append('files',new File([Buffer.alloc(5*1024*1024)],'bound.jpg'));
  const denied=await nasApi.fetch(new Request('https://erp.fixture.test/api/nas',{method:'POST',headers:{Authorization:'Bearer test'},body:upload}));assert.equal(denied.status,400);
 }finally{
  globalThis.fetch=savedFetch;for(const name of names)if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];
 }
});
