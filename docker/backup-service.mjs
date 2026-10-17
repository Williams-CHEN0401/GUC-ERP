import {createServer} from 'node:http';
import {createReadStream,createWriteStream,readFileSync,rmSync} from 'node:fs';
import {mkdir,readFile,writeFile,stat,rename,rm,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {pathToFileURL} from 'node:url';
const UUID=/^[0-9a-f-]{36}$/;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export async function createBackupService(config,engine){
 if(!config.gateway||!config.directory||!['isolated','production'].includes(config.mode))throw Error('Explicit backup profile required');
 const dir=resolve(config.directory);await mkdir(dir,{recursive:true,mode:0o700});await engine.prepareDirectory?.(config);
 const lockPath=resolve(dir,'worker.lock'),recoveryPath=resolve(dir,'worker.recovery.lock'),ownership=randomUUID();
 async function acquireLock(){
  try{return await open(lockPath,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;}
  // Serialize stale-lock recovery: a second starter must never remove a freshly acquired lock.
  let recovery;try{recovery=await open(recoveryPath,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Error('Backup lock recovery is active or interrupted; inspect the worker before restarting.');throw e;}
  try{
   let previous;try{previous=JSON.parse(await readFile(lockPath,'utf8'));}catch(e){if(e.code==='ENOENT')return await open(lockPath,'wx',0o600);throw e;}
   if(!Number.isSafeInteger(previous.pid)||previous.pid<=0)throw Error('Invalid worker lock; inspect it before restarting.');
   try{process.kill(previous.pid,0);throw Error('A backup worker already owns this directory.');}catch(error){if(error.code!=='ESRCH')throw error;}
   await rm(lockPath);return await open(lockPath,'wx',0o600);
  }finally{await recovery.close();await rm(recoveryPath,{force:true});}
 }
 const lock=await acquireLock();try{await lock.writeFile(JSON.stringify({pid:process.pid,ownership}));}finally{await lock.close();}let released=false,closing=false;
 function releaseLock(){if(released)return;released=true;try{if(JSON.parse(readFileSync(lockPath,'utf8')).ownership===ownership)rmSync(lockPath);}catch{}process.removeListener('exit',releaseLock);}
 process.once('exit',releaseLock);
 try{await engine.cleanupStaging?.(config);}catch(e){releaseLock();throw e;}
 const jobs=new Map(),uploads=new Map(),tickets=new Map(),plans=new Map();let busy=false;
 // Persistent records contain metadata only, never session tokens or passphrases.
 const recordPath=resolve(dir,'jobs.json');try{for(const j of JSON.parse(await readFile(recordPath,'utf8'))){if(!UUID.test(j.id))continue;if(['running','queued'].includes(j.status)){j.status='failed';j.error='服務中斷，請重新建立備份。';}jobs.set(j.id,j);}}catch(e){if(e.code!=='ENOENT'){releaseLock();throw e;}}
 let saving=Promise.resolve();const save=()=>{const contents=JSON.stringify([...jobs.values()],null,2);saving=saving.catch(()=>{}).then(async()=>{const temporary=recordPath+'.tmp';await writeFile(temporary,contents,{mode:0o600});await rename(temporary,recordPath);});return saving;};
 const errorMessage=e=>e.publicMessage||(e.status?e.message:'備份服務無法完成操作，請檢查服務設定與磁碟容量後重試。');
 const safeJob=j=>({id:j.id,status:j.status,stage:j.stage,createdAt:j.createdAt,finishedAt:j.finishedAt,selection:j.selection,bytes:j.bytes,sha256:j.sha256,filename:j.filename,error:j.error,restore:j.restore,mode:config.mode});
 const authorize=async(req,action)=>{
  const bearer=req.headers.authorization;if(!/^Bearer [^\s]{8,4096}$/.test(bearer||''))throw fail('請先登入。',401);
  const u=new URL(config.gateway);u.search=new URLSearchParams({scope:'system_backup_authorization',action}).toString();
  const r=await fetch(u,{headers:{Authorization:bearer},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw fail(r.status===401?'登入已失效。':'沒有完整系統備份／復原權限。',r.status===401?401:403);
  const data=await r.json();if(!data.authorized||!data.current_user?.id)throw fail('備份授權回應不正確。',403);
  return{user:data.current_user.id,bearer,capabilities:data.capabilities};
 };
 const body=async req=>{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>32768)throw fail('請求內容過大。',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw fail('請求格式不正確。');}};
 const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(data));};
 async function job(kind,selection,actor,execute){
  if(busy)throw fail('已有備份或復原工作正在執行，請稍後再試。',409);busy=true;
  const id=randomUUID(),entry={id,status:'running',stage:'準備中',createdAt:new Date().toISOString(),selection,actor,kind};jobs.set(id,entry);try{await save();}catch(e){busy=false;jobs.delete(id);throw e;}
  const progress=async stage=>{entry.stage=stage;await save();};
  void (async()=>{try{Object.assign(entry,await execute(id,progress));if(kind==='backup'){await stat(resolve(dir,id+'.gucbackup'));entry.filename='guc-system-'+id+'.gucbackup';}entry.status='completed';entry.stage='完成';}catch(e){entry.status='failed';entry.error=errorMessage(e);entry.stage='失敗';}finally{entry.finishedAt=new Date().toISOString();busy=false;try{await save();}finally{if(closing)releaseLock();}}})().catch(()=>{entry.status='failed';entry.error='備份紀錄無法寫入，請檢查服務磁碟。';});
  return safeJob(entry);
 }
 async function cleanup(){for(const[id,u]of uploads)if(u.createdAt+3600000<Date.now()){uploads.delete(id);await rm(u.file,{force:true});}for(const[id,p]of plans)if(p.expires<Date.now()){plans.delete(id);await engine.cleanupPlan?.(config,p.result);}for(const[id,t]of tickets)if(t.expires<Date.now())tickets.delete(id);}
 const cleanupTimer=setInterval(()=>{if(!busy)void cleanup().catch(()=>{});},60000);cleanupTimer.unref();
 const server=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://backup.internal'),path=url.pathname;
   if(req.method==='GET'&&path==='/v1/download'){
    const ticket=tickets.get(url.searchParams.get('ticket'));if(!ticket||ticket.expires<Date.now())throw fail('下載連結已過期，請重新取得。',401);tickets.delete(url.searchParams.get('ticket'));
    await authorize({headers:{authorization:ticket.bearer}},'VIEW');const entry=jobs.get(ticket.id);if(!entry||entry.status!=='completed'||entry.kind!=='backup')throw fail('找不到備份。',404);
    const file=resolve(dir,entry.id+'.gucbackup'),info=await stat(file);
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':info.size,'Content-Disposition':`attachment; filename="${entry.filename}"`,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});return await pipeline(createReadStream(file),res);
   }
   const action=path.startsWith('/v1/restore')?'UPDATE':req.method==='POST'&&path==='/v1/jobs'?'CREATE':'VIEW';
   const auth=await authorize(req,action);
   if(req.method==='GET'&&path==='/v1/catalog')return json(res,200,{...await engine.catalog(config),capabilities:auth.capabilities,mode:config.mode});
   if(req.method==='GET'&&path==='/v1/jobs')return json(res,200,{jobs:[...jobs.values()].reverse().map(safeJob),busy});
   if(req.method==='POST'&&path==='/v1/jobs'){
    const input=await body(req);const selection=await engine.validateSelection(config,input.selection);
    if(typeof input.password!=='string'||input.password.length<12||input.password.length>256)throw fail('備份密碼須為 12–256 個字元。');
    return json(res,202,await job('backup',selection,auth.user,(id,progress)=>engine.capture(config,{id,directory:dir,selection,password:input.password,progress})));
   }
   const ticketMatch=path.match(/^\/v1\/jobs\/([0-9a-f-]{36})\/ticket$/);
   if(req.method==='POST'&&ticketMatch){const entry=jobs.get(ticketMatch[1]);if(!entry||entry.status!=='completed'||entry.kind!=='backup')throw fail('找不到可下載備份。',404);const token=randomBytes(32).toString('base64url');for(const[k,v]of tickets)if(v.expires<Date.now())tickets.delete(k);tickets.set(token,{id:entry.id,bearer:auth.bearer,expires:Date.now()+60000});return json(res,200,{path:'/api/system-backup/download?ticket='+token,filename:entry.filename});}
   if(req.method==='PUT'&&path==='/v1/restore/upload'){
    if(busy)throw fail('已有工作正在執行。',409);await cleanup();if(uploads.size>=10||[...uploads.values()].filter(u=>u.actor===auth.user).length>=2)throw fail('待驗證套件已達上限，請完成驗證或稍後重試。',429);const id=randomUUID(),file=resolve(dir,id+'.upload'),maximum=config.maxUploadBytes||20*1024**3;let size=0;
    if(Number(req.headers['content-length'])>maximum)throw fail('套件超過上傳容量限制。',413);
    const limit=new Transform({transform(chunk,_e,cb){size+=chunk.length;cb(size>maximum?fail('套件超過上傳容量限制。',413):null,chunk);}});
    uploads.set(id,{actor:auth.user,file,createdAt:Date.now()});try{await pipeline(req,limit,createWriteStream(file,{flags:'wx',mode:0o600}));}catch(e){uploads.delete(id);await rm(file,{force:true});throw e;}return json(res,201,{uploadId:id,bytes:size});
   }
   if(req.method==='POST'&&path==='/v1/restore/inspect'){
    if(busy)throw fail('已有工作正在執行。',409);const input=await body(req),upload=uploads.get(input.uploadId);if(!upload||upload.actor!==auth.user)throw fail('找不到此帳號上傳的套件。',404);
    if(typeof input.password!=='string'||input.password.length<12||input.password.length>256)throw fail('解密密碼須為 12–256 個字元。');
    if(busy)throw fail('已有工作正在執行。',409);
    if(plans.size>=10||[...plans.values()].filter(p=>p.actor===auth.user).length>=2)throw fail('待復原計畫已達上限，請完成復原或等候計畫到期。',429);
    busy=true;try{const id=randomUUID(),result=await engine.inspect(config,{id,directory:dir,input:upload.file,password:input.password});plans.set(id,{actor:auth.user,result,expires:Date.now()+15*60000});uploads.delete(input.uploadId);await rm(upload.file,{force:true});return json(res,200,{planId:id,...result.summary});}finally{busy=false;}
   }
   if(req.method==='POST'&&path==='/v1/restore/execute'){
    const input=await body(req),plan=plans.get(input.planId);if(!plan||plan.actor!==auth.user||plan.expires<Date.now())throw fail('復原計畫已失效，請重新驗證套件。',409);
    if(input.confirm!=='RESTORE ISOLATED'||input.target!=='isolated')throw fail('請確認在隔離環境復原；此入口不會覆蓋正式資料庫。');
    if(busy)throw fail('已有備份或復原工作正在執行，請稍後再試。',409);
    plans.delete(input.planId);return json(res,202,await job('restore',plan.result.summary.selection,auth.user,async(id,progress)=>{try{return await engine.restore(config,{id,plan:plan.result,progress});}finally{await engine.cleanupPlan?.(config,plan.result);}}));
   }
   throw fail('找不到操作。',404);
  }catch(e){if(res.headersSent)return res.destroy();json(res,e.status||400,{error:errorMessage(e)});}
 });
 server.on('close',()=>{clearInterval(cleanupTimer);closing=true;if(!busy)releaseLock();});server.on('error',()=>{if(!server.listening&&!busy)releaseLock();});return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const config=JSON.parse(await readFile(process.env.GUC_BACKUP_CONFIG,'utf8'));
 const engine=await import('./backup-engine.mjs');
 const service=await createBackupService(config,engine);service.listen(Number(process.env.PORT||18970),process.env.GUC_BACKUP_HOST||'127.0.0.1');
}
