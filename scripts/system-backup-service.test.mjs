import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBackupService} from '../docker/backup-service.mjs';
const password='unit-test-only-backup-password';
const start=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
test('backup API checks dedicated permissions, owner scope, confirmation, single-use download and safe persisted metadata',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'guc-backup-service-')),actions=[];
 const gateway=createServer((req,res)=>{const token=req.headers.authorization;actions.push({token,action:new URL(req.url,'http://gateway').searchParams.get('action')});res.setHeader('Content-Type','application/json');if(!['Bearer fixture-admin-one','Bearer fixture-admin-two'].includes(token)){res.statusCode=403;return res.end('{}');}res.end(JSON.stringify({authorized:true,current_user:{id:token.slice(-3)},capabilities:{view:true,create:true,restore:true}}));});
 const gatewayUrl=await start(gateway);const engine={
  catalog:async()=>({websites:[{id:'erp'}],database:{id:'shared'}}),
  validateSelection:async(_c,s)=>s,
  capture:async(_c,{id,directory,progress})=>{await progress('capture');await writeFile(join(directory,id+'.gucbackup'),'encrypted-fixture');return{filename:'backup.gucbackup',bytes:17,sha256:'0'.repeat(64)};},
  inspect:async(_c,{input,password:pw})=>{if(pw!==password)throw Error('NEVER_EXPOSE_SERVER_SECRET');assert.equal(await readFile(input,'utf8'),'encrypted-fixture');return{summary:{selection:{database:true},compatibility:'verified'}};},
  restore:async()=>({restore:{status:'verified'}})
 };
 const service=await createBackupService({mode:'isolated',gateway:gatewayUrl,directory,maxUploadBytes:100},engine),base=await start(service);
 t.after(async()=>{await Promise.all([new Promise(r=>service.close(r)),new Promise(r=>gateway.close(r))]);await rm(directory,{recursive:true,force:true});});
 const call=(path,{token='fixture-admin-one',method='GET',body}={})=>fetch(base+'/v1'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':typeof body==='string'?'application/octet-stream':'application/json'}:{})},...(body?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
 assert.equal((await call('/catalog',{token:null})).status,401);assert.equal((await call('/catalog',{token:'fixture-viewer'})).status,403);assert.equal((await call('/catalog')).status,200);
 assert.equal((await call('/jobs',{method:'POST',token:'fixture-viewer',body:{selection:{},password}})).status,403);
 const created=await(await call('/jobs',{method:'POST',body:{selection:{websites:['erp'],database:true},password}})).json();
 for(let i=0;i<30;i++){const list=await(await call('/jobs')).json();if(list.jobs[0].status==='completed')break;await new Promise(r=>setTimeout(r,10));}
 const jobs=await(await call('/jobs')).json();assert.equal(jobs.jobs[0].status,'completed');assert.ok(!JSON.stringify(jobs).includes(password));assert.ok(!(await readFile(join(directory,'jobs.json'),'utf8')).includes(password));
 const ticket=await(await call('/jobs/'+created.id+'/ticket',{method:'POST',body:{}})).json();const downloadPath=ticket.path.replace('/api/system-backup','');
 const download=await call(downloadPath,{token:null});assert.equal(download.status,200);assert.equal(await download.text(),'encrypted-fixture');assert.equal((await call(downloadPath,{token:null})).status,401);assert.ok(actions.filter(a=>a.action==='VIEW').length>=4);
 assert.equal((await call('/restore/upload',{method:'PUT',body:'x'.repeat(101)})).status,413);
 const upload=await(await call('/restore/upload',{method:'PUT',body:'encrypted-fixture'})).json();
 assert.equal((await call('/restore/inspect',{method:'POST',token:'fixture-admin-two',body:{uploadId:upload.uploadId,password}})).status,404);
 const wrong=await call('/restore/inspect',{method:'POST',body:{uploadId:upload.uploadId,password:'incorrect-password'}});assert.equal(wrong.status,400);assert.ok(!(await wrong.text()).includes('NEVER_EXPOSE'));
 const plan=await(await call('/restore/inspect',{method:'POST',body:{uploadId:upload.uploadId,password}})).json();
 assert.equal((await call('/restore/execute',{method:'POST',token:'fixture-admin-two',body:{planId:plan.planId,target:'isolated',confirm:'RESTORE ISOLATED'}})).status,409);
 assert.equal((await call('/restore/execute',{method:'POST',body:{planId:plan.planId,target:'production',confirm:'RESTORE ISOLATED'}})).status,400);
 assert.equal((await call('/restore/execute',{method:'POST',body:{planId:plan.planId,target:'isolated',confirm:'RESTORE ISOLATED'}})).status,202);
 for(let i=0;i<30;i++){if(!(await(await call('/jobs')).json()).busy)break;await new Promise(r=>setTimeout(r,10));}
 assert.equal((await(await call('/jobs')).json()).jobs[0].restore.status,'verified');assert.ok(actions.some(a=>a.action==='CREATE'));assert.ok(actions.some(a=>a.action==='UPDATE'));
});

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const waitUntil=async predicate=>{for(let i=0;i<150;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out waiting for service state');};
const closeServer=server=>new Promise(resolve=>server.close(()=>resolve()));
const safeRemoveTestDirectory=async directory=>{assert(directory.startsWith(join(tmpdir(),'guc-backup-service-')));await rm(directory,{recursive:true,force:true});};

test('exclusive worker lock rejects a second live worker and releases after clean shutdown',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'guc-backup-service-'));let cleaning=0;const config={mode:'isolated',gateway:'http://127.0.0.1:1',directory},engine={cleanupStaging:async()=>{cleaning++;}};let first,second;
 t.after(async()=>{if(first)await closeServer(first);if(second)await closeServer(second);await safeRemoveTestDirectory(directory);});
 first=await createBackupService(config,engine);await start(first);assert.equal(cleaning,1);
 await assert.rejects(createBackupService(config,engine),/already owns|worker.*lock|worker.*running/i);assert.equal(cleaning,1,'duplicate never cleans another worker staging');
 await closeServer(first);first=null;second=await createBackupService(config,engine);await start(second);assert.equal(cleaning,2);
});

test('concurrent starters recover a dead worker lock exactly once without deleting the new owner lock',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'guc-backup-service-'));let service,cleaning=0;const lockPath=join(directory,'worker.lock'),config={mode:'isolated',gateway:'http://127.0.0.1:1',directory};
 t.after(async()=>{if(service)await closeServer(service);await safeRemoveTestDirectory(directory);});
 const deadPid=2147483647;assert.throws(()=>process.kill(deadPid,0),{code:'ESRCH'});await writeFile(lockPath,JSON.stringify({pid:deadPid,ownership:'dead-worker'}));
 const attempts=await Promise.allSettled(Array.from({length:12},()=>createBackupService(config,{cleanupStaging:async()=>{cleaning++;}})));
 const winners=attempts.filter(result=>result.status==='fulfilled');assert.equal(winners.length,1);assert.equal(attempts.filter(result=>result.status==='rejected').length,11);assert.equal(cleaning,1,'only the lock owner may clean staging');service=winners[0].value;await start(service);
 const active=JSON.parse(await readFile(lockPath,'utf8'));assert.equal(active.pid,process.pid);assert.match(active.ownership,/^[0-9a-f-]{36}$/);assert.notEqual(active.ownership,'dead-worker');await assert.rejects(readFile(join(directory,'worker.recovery.lock')),{code:'ENOENT'});
 await assert.rejects(createBackupService(config,{}),/already owns/);assert.deepEqual(JSON.parse(await readFile(lockPath,'utf8')),active);
});

test('interrupted stale-lock recovery fails closed without changing worker files or staging',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'guc-backup-service-')),lockPath=join(directory,'worker.lock'),recoveryPath=join(directory,'worker.recovery.lock');let cleaning=0;
 t.after(()=>safeRemoveTestDirectory(directory));const deadPid=2147483647;assert.throws(()=>process.kill(deadPid,0),{code:'ESRCH'});const original=JSON.stringify({pid:deadPid,ownership:'interrupted-worker'});await writeFile(lockPath,original);await writeFile(recoveryPath,'interrupted recovery marker');
 await assert.rejects(createBackupService({mode:'isolated',gateway:'http://127.0.0.1:1',directory},{cleanupStaging:async()=>{cleaning++;}}),/recovery is active or interrupted/);assert.equal(cleaning,0);assert.equal(await readFile(lockPath,'utf8'),original);assert.equal(await readFile(recoveryPath,'utf8'),'interrupted recovery marker');
});

test('shutdown releases only its ownership token and malformed existing locks are not removed',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'guc-backup-service-')),lockPath=join(directory,'worker.lock'),config={mode:'isolated',gateway:'http://127.0.0.1:1',directory};let service;
 t.after(async()=>{if(service)await closeServer(service);await safeRemoveTestDirectory(directory);});service=await createBackupService(config,{});await start(service);
 const foreign=JSON.stringify({pid:process.pid,ownership:'another-worker-token'});await writeFile(lockPath,foreign);await closeServer(service);service=null;assert.equal(await readFile(lockPath,'utf8'),foreign,'shutdown must not remove a lock that it no longer owns');
 await writeFile(lockPath,'incomplete lock');await assert.rejects(createBackupService(config,{}));assert.equal(await readFile(lockPath,'utf8'),'incomplete lock');await assert.rejects(readFile(join(directory,'worker.recovery.lock')),{code:'ENOENT'});
});

test('active asynchronous backup retains worker lock across HTTP shutdown until capture settles',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'guc-backup-service-')),gate=deferred(),started=deferred();let service,replacement;
 const gateway=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authorized:true,current_user:{id:'admin'},capabilities:{view:true,create:true,restore:true}}));});
 const gatewayUrl=await start(gateway),config={mode:'isolated',gateway:gatewayUrl,directory};const engine={validateSelection:async(_c,s)=>s,capture:async(_c,{id,directory})=>{started.resolve();await gate.promise;await writeFile(join(directory,id+'.gucbackup'),'encrypted');return{bytes:9};}};
 t.after(async()=>{gate.resolve();if(service)await closeServer(service);if(replacement)await closeServer(replacement);await closeServer(gateway);await safeRemoveTestDirectory(directory);});
 service=await createBackupService(config,engine);const base=await start(service);const response=await fetch(base+'/v1/jobs',{method:'POST',headers:{Authorization:'Bearer fixture-admin','Content-Type':'application/json'},body:JSON.stringify({selection:{websites:[],database:true},password})});assert.equal(response.status,202);await started.promise;await closeServer(service);service=null;
 await assert.rejects(createBackupService(config,engine),/already owns|worker.*lock|worker.*running/i);gate.resolve();await waitUntil(async()=>{try{await readFile(join(directory,'worker.lock'));return false;}catch(e){return e.code==='ENOENT';}});
 const jobs=JSON.parse(await readFile(join(directory,'jobs.json'),'utf8'));assert.equal(jobs[0].status,'completed');replacement=await createBackupService(config,engine);await start(replacement);
});

test('concurrent slow-body inspections cannot bypass busy lock and temporary plan limits are enforced',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'guc-backup-service-')),gate=deferred(),entered=deferred();let calls=0;
 const gateway=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authorized:true,current_user:{id:'admin'},capabilities:{view:true,create:true,restore:true}}));});const config={mode:'isolated',gateway:await start(gateway),directory,maxUploadBytes:100};
 const engine={inspect:async()=>{calls++;entered.resolve();if(calls===1)await gate.promise;return{summary:{selection:{websites:[],database:true},compatibility:{compatible:true}}};}};const service=await createBackupService(config,engine),base=await start(service);
 t.after(async()=>{gate.resolve();await closeServer(service);await closeServer(gateway);await safeRemoveTestDirectory(directory);});
 const call=(path,method,body)=>fetch(base+'/v1'+path,{method,headers:{Authorization:'Bearer fixture-admin','Content-Type':typeof body==='string'?'application/octet-stream':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)});
 const upload=async()=>{const r=await call('/restore/upload','PUT','fixture');assert.equal(r.status,201);return (await r.json()).uploadId;};const a=await upload(),b=await upload();
 const slow=id=>{const payload=JSON.stringify({uploadId:id,password});let req;const response=new Promise((resolve,reject)=>{req=httpRequest(base+'/v1/restore/inspect',{method:'POST',headers:{Authorization:'Bearer fixture-admin','Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});req.on('error',reject);req.write(payload.slice(0,1));});return{finish:()=>req.end(payload.slice(1)),response};};
 const one=slow(a),two=slow(b);await new Promise(r=>setTimeout(r,75));one.finish();await entered.promise;two.finish();assert.equal(await two.response,409);assert.equal(calls,1);gate.resolve();assert.equal(await one.response,200);
 const second=await call('/restore/inspect','POST',{uploadId:b,password});assert.equal(second.status,200);const c=await upload();assert.equal((await call('/restore/inspect','POST',{uploadId:c,password})).status,429);assert.equal(calls,2);
});

test('cloud backup handler fails closed without exposing worker configuration or forwarding requests',async()=>{
 const {default:handler}=await import('../api/system-backup.mjs');const headers={};let body;const response={statusCode:0,setHeader:(k,v)=>{headers[k]=v;},end:value=>{body=value;}};handler({url:'/api/system-backup/jobs',method:'POST'},response);assert.equal(response.statusCode,503);assert.equal(headers['Cache-Control'],'no-store');assert.match(JSON.parse(body).error,/Docker/);assert(!body.includes('18970'));assert(!body.includes('GUC_BACKUP'));
});
