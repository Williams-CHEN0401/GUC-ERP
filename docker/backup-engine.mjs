import {spawn} from 'node:child_process';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile,copyFile,readdir,lstat,stat,realpath,rm,rmdir} from 'node:fs/promises';
import {resolve,relative,join,sep,dirname,isAbsolute} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {packBackup,unpackBackup,fileHash,safeRelative} from './backup-archive.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENT=/^[a-zA-Z_][a-zA-Z0-9_]*$/;
const safeError=message=>Object.assign(new Error(message),{publicMessage:message});
const excluded=new Set(['.git','node_modules','.next','.vercel','.codex','backups','private-keys','private-templates','驗收報告']);
const maxBytes=config=>config.maxBytes||100*1024**3;
function profile(config){
 if(!['isolated','production'].includes(config.mode)||!config.directory||!config.database?.container||!IDENT.test(config.database.name)||!IDENT.test(config.database.admin))throw safeError('備份服務設定不完整。');
 if(config.mode==='isolated'&&!/^guc_.*preview/.test(config.database.name))throw safeError('測試模式只能使用隔離資料庫。');
 if(config.mode==='production'&&config.database.name!=='postgres')throw safeError('正式備份資料庫設定不符。');
}
async function command(binary,args,{input,output,timeout=600000,maxOutput=16*1024**2}={}){
 const child=spawn(binary,args,{windowsHide:true,stdio:['pipe',output?'pipe':'pipe','pipe']});let stderr='',stdout='',size=0;
 child.stdin.on('error',()=>{});
 child.stderr.on('data',chunk=>{if(stderr.length<8192)stderr+=chunk;});
 const copied=output?pipeline(child.stdout,createWriteStream(output,{flags:'wx',mode:0o600})):null;
 if(!output)child.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxOutput)child.kill();else stdout+=chunk;});
 const timer=setTimeout(()=>child.kill(),timeout);timer.unref();
 if(input!==undefined)child.stdin.end(input);else child.stdin.end();
 try{await new Promise((ok,no)=>{child.once('error',no);child.once('close',code=>code===0?ok():no(Object.assign(Error('Backup command failed'),{details:stderr,code})));});if(copied)await copied;return stdout.trim();}
 finally{clearTimeout(timer);if(copied)await copied.catch(()=>{});}
}
const docker=(args,options)=>command('docker',args,options);
async function metadata(name){return JSON.parse(await docker(['inspect',name,'--format','{{json .}}']));}
async function websiteImage(config,source){
 if(source.image){const image=await metadata(source.image);return {id:image.Id,labels:image.Config?.Labels||{},digests:image.RepoDigests||[],binding:'explicit-candidate'};}
 if(config.mode==='production'&&source.container){const container=await metadata(source.container),image=await metadata(container.Image);return {id:container.Image,labels:container.Config?.Labels||{},digests:image.RepoDigests||[],binding:'running-production-container'};}
 return null;
}
async function sourceRevision(source){return command('git',['-C',source,'rev-parse','HEAD']).catch(()=>null);}
async function treeHash(path){const h=createHash('sha256');for(const file of await entries(path)){h.update(file.name);h.update('\0');h.update(await fileHash(file.path));h.update('\n');}return h.digest('hex');}
async function secureDirectory(path){await mkdir(path,{recursive:true,mode:0o700});if(process.platform==='win32'){const identity=await command('whoami',[]);await command('icacls',[path,'/inheritance:r','/grant:r',`${identity}:(OI)(CI)F`,'SYSTEM:(OI)(CI)F']);}}
export async function prepareDirectory(config){profile(config);await secureDirectory(resolve(config.directory));}
// The service must hold its exclusive directory lock before invoking this.
const profileHash=config=>createHash('sha256').update(resolve(config.directory)).digest('hex');
export async function cleanupStaging(config,{dockerCommand=docker}={}){
 profile(config);let removed=0;
 const expectedProfile=profileHash(config),ids=(await dockerCommand(['ps','-aq','--filter','label=com.guc.backup.profile='+expectedProfile])).split(/\s+/).filter(Boolean);
 for(const id of ids){
  if(!/^[0-9a-f]{12,64}$/.test(id))throw Error('Invalid orphan container identity');
  const info=JSON.parse(await dockerCommand(['inspect',id,'--format','{{json .}}'])),labels=info.Config?.Labels||{},name=String(info.Name||'').replace(/^\//,'');
  if(labels['com.guc.backup.profile']!==expectedProfile||!UUID.test(labels['com.guc.backup.job']||'')||!new RegExp('^guc-restore-(?:api-)?'+labels['com.guc.backup.job']+'$').test(name))throw safeError('備份容器標記不符，請先檢查服務設定。');
  await dockerCommand(['stop',id]);
 }
 for(const entry of await readdir(resolve(config.directory),{withFileTypes:true})){
  if(/^(capture|verify|inspect)-[0-9a-f-]{36}$/.test(entry.name)&&UUID.test(entry.name.replace(/^(capture|verify|inspect)-/,''))&&entry.isDirectory()&&!entry.isSymbolicLink()){
   await removeTemporary(config,join(config.directory,entry.name));removed++;
  }else if(entry.isFile()&&/^[0-9a-f-]{36}\.upload$/.test(entry.name)&&UUID.test(entry.name.slice(0,-7))){await rm(join(config.directory,entry.name));removed++;}
 }
 return {removed,containersStopped:ids.length};
}
function childPath(base,name){const root=resolve(base),path=resolve(root,name),rel=relative(root,path);if(!rel||isAbsolute(rel)||rel.startsWith('..')||!UUID.test(name.replace(/^(capture|verify|inspect)-/,'')))throw Error('Unsafe temporary backup directory');return path;}
async function removeTemporary(config,path){const root=await realpath(resolve(config.directory)),target=resolve(path);if(!target.startsWith(root+sep)||!/^((capture|verify|inspect)-)[0-9a-f-]{36}$/.test(relative(root,target))||(await lstat(target).catch(()=>null))?.isSymbolicLink())throw Error('Unsafe temporary cleanup');await rm(target,{recursive:true,force:true});}
async function addTree(source,destination,{filter=true,budget}={}){
 const root=await realpath(source);await mkdir(destination,{recursive:true,mode:0o700});
 async function visit(from,to){for(const entry of await readdir(from,{withFileTypes:true})){
   if(filter&&(excluded.has(entry.name)||entry.name.startsWith('.env')||/^\.next-|\.(key|pem|pfx|p12)$/i.test(entry.name)))continue;
   if(entry.isSymbolicLink())continue;
   const origin=join(from,entry.name),target=join(to,entry.name);const info=await lstat(origin);
   if(info.isDirectory()){await mkdir(target,{recursive:true,mode:0o700});await visit(origin,target);}else if(info.isFile()){
     if(budget){budget.bytes+=info.size;if(budget.bytes>budget.limit)throw safeError('備份資料超過服務容量上限。');}
     await copyFile(origin,target);const after=await stat(origin);if(after.size!==info.size||after.mtimeMs!==info.mtimeMs)throw safeError('備份期間來源檔案已變動，請重新執行。');
   }
 }}await visit(root,destination);
}
async function entries(root){const result=[];async function visit(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isSymbolicLink())throw safeError('備份來源含有不允許的連結。');if(entry.isDirectory())await visit(path);else if(entry.isFile())result.push({name:relative(root,path).split(sep).join('/'),path});}}await visit(root);return result.sort((a,b)=>a.name.localeCompare(b.name));}
const sqlLiteral=s=>"'"+String(s).replaceAll("'","''")+"'";
const psqlArgs=config=>['exec','-i',config.database.container,'psql','-U',config.database.admin,'-d',config.database.name,'-X','-qAt','-v','ON_ERROR_STOP=1'];
const fingerprintSql=`SET TIME ZONE 'UTC';
SELECT format('SELECT ''ROW|'' || json_build_object(''table'',%L,''rows'',count(*),''hash'',md5(coalesce(string_agg(md5(row_to_json(t)::text),'''' ORDER BY md5(row_to_json(t)::text)),'''')))::text FROM %I.%I t;',n.nspname||'.'||c.relname,n.nspname,c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname
\\gexec
SELECT 'SCHEMA|' || md5(string_agg(proname||pg_get_functiondef(p.oid)||coalesce(proacl::text,'')||prosecdef::text,'' ORDER BY proname,pg_get_function_identity_arguments(p.oid))) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace;
SELECT 'RLS|' || md5(string_agg(n.nspname||'.'||c.relname||pg_get_userbyid(c.relowner)||c.relrowsecurity::text||c.relforcerowsecurity::text||coalesce((SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable) ORDER BY pg_get_userbyid(a.grantor),pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable)::text FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a),''),'' ORDER BY n.nspname,c.relname)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema';
SELECT 'POLICY|' || md5(coalesce(string_agg(row_to_json(p)::text,'' ORDER BY schemaname,tablename,policyname),'')) FROM pg_policies p;
SELECT 'VAULT|' || md5(coalesce(string_agg(id::text||decrypted_secret,'' ORDER BY id),'')) FROM vault.decrypted_secrets;
SELECT format('SELECT ''SEQUENCE|'' || json_build_object(''name'',%L,''last_value'',last_value,''is_called'',is_called)::text FROM %I.%I;',n.nspname||'.'||c.relname,n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname
\\gexec
SELECT 'DONE';
`;
const volatileSql=`SELECT 'ROLES|'||md5(string_agg(row_to_json(r)::text,'' ORDER BY rolname)) FROM pg_authid r;
SELECT format('SELECT ''SEQUENCE|'' || %L || ''|'' || last_value || ''|'' || is_called FROM %I.%I;',n.nspname||'.'||c.relname,n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname
\\gexec
`;
async function captureDatabase(config,dir,id){
 const child=spawn('docker',psqlArgs(config),{windowsHide:true,stdio:['pipe','pipe','pipe']});let snapshotResolve,doneResolve,ended=false;
 child.stdin.on('error',()=>{});
 const snapshotReady=new Promise(r=>snapshotResolve=r),done=new Promise(r=>doneResolve=r),lines=[];
 const closed=new Promise((ok,no)=>{child.once('error',no);child.once('close',code=>{ended=true;code===0?ok():no(Error('Snapshot session failed'));});});closed.catch(()=>{});
 child.stderr.resume();createInterface({input:child.stdout}).on('line',line=>{if(line.startsWith('SNAPSHOT|'))snapshotResolve(line.slice(9));else if(line==='DONE')doneResolve();else if(line)lines.push(line);});
 const timeout=()=>new Promise((_,reject)=>{const t=setTimeout(()=>reject(safeError('資料庫備份逾時，請重新執行。')),600000);t.unref();});
 const remote=`/tmp/guc-backup-${id}`;
 try{
   const before=await docker(psqlArgs(config),{input:volatileSql});
   child.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT 'SNAPSHOT|'||pg_export_snapshot();\n");
   const snapshot=await Promise.race([snapshotReady,timeout(),closed.then(()=>{throw Error('Snapshot session closed');})]);if(!/^[0-9A-F-]+$/i.test(snapshot))throw Error('Invalid snapshot');
   child.stdin.write(fingerprintSql);await Promise.race([done,timeout(),closed.then(()=>{throw Error('Snapshot session closed');})]);
   await docker(['exec',config.database.container,'pg_dump','-U',config.database.admin,'-d',config.database.name,'-Fc','--snapshot',snapshot,'-f',remote+'.dump']);
   await docker(['exec',config.database.container,'pg_restore','--list',remote+'.dump']);
   await docker(['cp',config.database.container+':'+remote+'.dump',join(dir,'database.dump')]);
   child.stdin.end('ROLLBACK;\n');await closed;
   await docker(['exec',config.database.container,'pg_dumpall','-U',config.database.admin,'--roles-only',...(config.mode==='isolated'?['--no-role-passwords']:[])],{output:join(dir,'roles.sql')});
   if(await docker(psqlArgs(config),{input:volatileSql})!==before)throw safeError('備份期間角色或流水號已變動，請於較少操作時重試。');
   await writeFile(join(dir,'fingerprint.sql'),fingerprintSql);await writeFile(join(dir,'source-fingerprint.txt'),lines.join('\n')+'\n');
   const tables=lines.filter(line=>line.startsWith('ROW|')).map(line=>JSON.parse(line.slice(4)));
   const version=await docker(psqlArgs(config),{input:'show server_version_num;'});
   return {snapshot,version:Number(version),tables:tables.length,rows:tables.reduce((n,t)=>n+t.rows,0),authUsers:tables.find(t=>t.table==='auth.users')?.rows||0,authIdentities:tables.find(t=>t.table==='auth.identities')?.rows||0};
 }finally{if(!ended&&!child.stdin.destroyed)child.stdin.end('ROLLBACK;\n');const kill=setTimeout(()=>child.kill(),10000);kill.unref();await closed.catch(()=>{});clearTimeout(kill);await docker(['exec',config.database.container,'rm','-f',remote+'.dump']).catch(()=>{});}
}
async function volumeTar(container,path,filename,dir,image){await docker(['run','--rm','--network','none','--read-only','--user','root','--volumes-from',container+':ro','--mount',`type=bind,source=${dir},target=/backup`,'--entrypoint','tar',image,'-czf','/backup/'+filename,'-C',path,'.']);}
async function databaseConfig(config,dir,image){
 if(config.mode==='production')return volumeTar(config.database.container,'/etc/postgresql-custom','db-config.tar.gz',dir,image);
 if(Number(await docker(psqlArgs(config),{input:'select count(*) from vault.secrets;'}))!==0)throw safeError('隔離預覽備份不可包含正式 Vault 資料。');
 const fixture=join(dir,'.fixture-config');await mkdir(fixture);await writeFile(join(fixture,'pgsodium_root.key'),randomBytes(32).toString('hex'),{mode:0o600});
 try{await docker(['run','--rm','--network','none','--read-only','--mount',`type=bind,source=${fixture},target=/fixture,readonly`,'--mount',`type=bind,source=${dir},target=/backup`,'--entrypoint','tar',image,'-czf','/backup/db-config.tar.gz','-C','/fixture','.']);}finally{await rm(join(fixture,'pgsodium_root.key'));await rmdir(fixture);}
}
async function boundedText(response,limit){let size=0;const parts=[];if(!response.body)throw safeError('NAS 回應為空。');for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw safeError('NAS 目錄回應超過容量上限。');parts.push(chunk);}return Buffer.concat(parts).toString('utf8');}
function decodeXml(text){if(/<!DOCTYPE|<!ENTITY/i.test(text))throw safeError('NAS 回應包含不允許的 XML 宣告。');return text.replace(/&#x([0-9a-f]+);|&#([0-9]+);|&(amp|lt|gt|quot|apos);/gi,(_,hex,num,named)=>hex?String.fromCodePoint(parseInt(hex,16)):num?String.fromCodePoint(Number(num)):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[named.toLowerCase()]));}
export async function captureNas(config,dir,budget){
 if(config.nas?.path){await addTree(config.nas.path,dir,{filter:false,budget});return;}
 const nas=config.nas;if(!nas?.url||!nas.username||!nas.password)throw safeError('尚未設定可讀取的 NAS 備份來源。');
 const base=new URL(nas.url);if(base.username||base.password||base.search||base.hash||!['https:','http:'].includes(base.protocol)||base.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(base.hostname))throw safeError('NAS 備份連線必須使用 HTTPS。');
 if(nas.root)base.pathname=base.pathname.replace(/\/$/,'')+'/'+nas.root.replace(/^\//,'');if(!base.pathname.endsWith('/'))base.pathname+='/';
 const headers={Authorization:'Basic '+Buffer.from(nas.username+':'+nas.password).toString('base64')};const seen=new Set();let count=0;
 const safe=url=>{if(url.origin!==base.origin||!decodeURIComponent(url.pathname).startsWith(decodeURIComponent(base.pathname))||url.username||url.password)throw safeError('NAS 回應路徑超出設定範圍。');};
 async function visit(url){safe(url);if(seen.has(url.href))return;seen.add(url.href);if(++count>100000)throw safeError('NAS 檔案過多，請縮小備份根目錄。');
   const r=await fetch(url,{method:'PROPFIND',headers:{...headers,Depth:'1','Content-Type':'application/xml'},body:'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getetag/></d:prop></d:propfind>',redirect:'error',signal:AbortSignal.timeout(60000)});
   if(r.status!==207)throw safeError('NAS 目錄讀取失敗，請確認備份帳號權限。');const xml=await boundedText(r,8*1024**2);decodeXml(xml);
   for(const block of xml.matchAll(/<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi)){
     const href=block[1].match(/<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/i)?.[1];if(!href)continue;const target=new URL(decodeXml(href),url);safe(target);if(target.href.replace(/\/$/,'')===url.href.replace(/\/$/,''))continue;
     if(/<(?:[\w.-]+:)?collection\b/i.test(block[1])){await visit(target);continue;}
     const name=decodeURIComponent(target.pathname).slice(decodeURIComponent(base.pathname).length);safeRelative(name);const path=resolve(dir,name);if(!path.startsWith(resolve(dir)+sep))throw safeError('NAS 檔案路徑不安全。');
     const response=await fetch(target,{headers,redirect:'error',signal:AbortSignal.timeout(600000)});if(response.status!==200||!response.body)throw safeError('NAS 附件下載失敗。');
     const etag=block[1].match(/<(?:[\w.-]+:)?getetag[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?getetag>/i)?.[1];if(etag&&response.headers.get('etag')&&decodeXml(etag)!==response.headers.get('etag'))throw safeError('備份期間 NAS 附件已變動，請重試。');
     await mkdir(dirname(path),{recursive:true,mode:0o700});const limit=new Transform({transform(chunk,_encoding,callback){budget.bytes+=chunk.length;callback(budget.bytes>budget.limit?safeError('NAS 備份超過容量上限。'):null,chunk);}});await pipeline(response.body,limit,createWriteStream(path,{flags:'wx',mode:0o600}));
   }
 }await visit(base);
}
export async function catalog(config){profile(config);return {websites:await Promise.all(Object.entries(config.websites||{}).map(async([id,value])=>({id,label:value.label||id,imageAvailable:!!await websiteImage(config,value).catch(()=>null)}))),database:{id:config.database.name,label:'共用 Supabase 資料庫（含 ERP、會計、案場及帳號）',sharedSystems:Object.keys(config.websites||{}),shared:true},nas:{available:!!(config.nas?.path||config.nas?.url&&config.nas?.username&&config.nas?.password)},storage:{available:!!config.storage},notes:['共用資料庫必須整套備份，不能拆開跨系統關聯。','Docker 映像不包含資料庫及附件內容；所選內容以密碼加密成套件。','復原入口只建立隔離驗證環境，不覆蓋正式資料。']};}
export async function validateSelection(config,input,{forRestore=false}={}){profile(config);if(!input||typeof input!=='object'||!Array.isArray(input.websites)||input.websites.some(id=>typeof id!=='string'||!Object.hasOwn(config.websites||{},id))||new Set(input.websites).size!==input.websites.length)throw safeError('請選擇有效的網站。');const selection={websites:[...input.websites],database:input.database===true,images:input.images===true,storage:input.storage===true,nas:input.nas===true};if(!selection.websites.length&&!selection.database&&!selection.storage&&!selection.nas)throw safeError('請至少選擇一項備份內容。');if(selection.storage&&!config.storage)throw safeError('尚未設定持久化附件來源。');if(selection.nas&&!(config.nas?.path||config.nas?.url&&config.nas?.username&&config.nas?.password))throw safeError('尚未設定 NAS 備份來源。');if((selection.storage||selection.nas)&&!selection.database)throw safeError('附件備份需同時包含共用資料庫，才能保留檔案關聯。');if(selection.images&&!forRestore)for(const id of selection.websites)if(!await websiteImage(config,config.websites[id]).catch(()=>null))throw safeError('所選網站尚未建立對應版本映像；請先取消 Docker 映像選項。');return selection;}
export async function capture(config,{id,directory,selection,password,progress=async()=>{}}){profile(config);if(!UUID.test(id)||resolve(directory)!==resolve(config.directory))throw Error('Invalid backup job');selection=await validateSelection(config,selection);const staging=childPath(directory,'capture-'+id),verification=childPath(directory,'verify-'+id),output=resolve(directory,id+'.gucbackup');await secureDirectory(staging);const budget={bytes:0,limit:maxBytes(config)};
 try{
   const db=await metadata(config.database.container);const manifest={createdAt:new Date().toISOString(),selection,mode:config.mode,websites:{},database:{name:config.database.name,image:db.Image,version:null},restoration:'isolated-only',deployment:{},attachmentConsistency:'Database uses a single PostgreSQL snapshot; copied attachments must remain unchanged during capture.'};
   const images=new Set(selection.database?[db.Image]:[]);
   for(const name of selection.websites){await progress('備份網站：'+(config.websites[name].label||name));const source=config.websites[name],info=await websiteImage(config,source),target=join(staging,'websites',name);if(selection.images&&!info)throw safeError('所選網站尚未建立對應版本映像；請先取消 Docker 映像選項。');if(info)images.add(info.id);await addTree(source.source,target,{budget});manifest.websites[name]={image:info?.id||null,imageBinding:info?.binding||'source-only',imageDigests:info?.digests||[],imageRevision:info?.labels?.['org.opencontainers.image.revision']||null,sourceRevision:await sourceRevision(source.source),sourceSha256:await treeHash(target),rebuild:true};}
   if(config.deploymentRoot){await progress('備份部署設定');const root=resolve(config.deploymentRoot),target=join(staging,'deployment');await mkdir(target,{recursive:true});for(const name of [...(await readdir(root)).filter(name=>/^compose(?:\.[a-z-]+)?\.ya?ml$/.test(name)),'deployment-mode.json','domain-endpoints.json','https-endpoints.json','.env.production']){const file=join(root,name);if((await stat(file).catch(()=>null))?.isFile())await copyFile(file,join(target,name));}for(const name of ['.env','.env.functions','docker-compose.yml','docker-compose.override.yml']){const file=join(root,'supabase',name);if((await stat(file).catch(()=>null))?.isFile()){await mkdir(join(target,'supabase'),{recursive:true});await copyFile(file,join(target,'supabase',name));}}if((await stat(join(root,'supabase','volumes','functions')).catch(()=>null))?.isDirectory())await addTree(join(root,'supabase','volumes','functions'),join(target,'functions'),{budget});manifest.deployment.encryptedSecrets=true;}
   if(selection.database){await progress('建立一致性資料庫快照');const dir=join(staging,'database');await mkdir(dir);Object.assign(manifest.database,await captureDatabase(config,dir,id));await databaseConfig(config,dir,db.Image);manifest.database.keyScope=config.mode==='isolated'?'synthetic-empty-vault':'encrypted-production-key';}
   if(selection.storage){await progress('備份持久化附件');const dir=join(staging,'storage');await mkdir(dir);if(config.storage.path)await addTree(config.storage.path,dir,{filter:false,budget});else await volumeTar(config.storage.container,config.storage.containerPath,'storage.tar.gz',dir,db.Image);}
   if(selection.nas){await progress('備份 NAS 附件');await captureNas(config,join(staging,'nas'),budget);}
   if(selection.images){await progress('保存對應 Docker 映像');const dir=join(staging,'images');await mkdir(dir);await docker(['image','save','-o',join(dir,'images.tar'),...images],{timeout:1800000});manifest.images=[...images];}
   const files=await entries(staging);let total=0;for(const file of files)total+=(await stat(file.path)).size;if(total>maxBytes(config))throw safeError('備份資料超過服務容量上限。');await progress('加密套件並驗證完整性');const result=await packBackup({manifest,files,output,password});await unpackBackup({input:output,password,destination:verification,maxBytes:maxBytes(config)});
   return {filename:`GUC-${new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Taipei'})}-${id}.gucbackup`,bytes:result.bytes,sha256:result.sha256};
 }catch(error){await rm(output,{force:true});throw error.publicMessage?error:safeError('備份未完成；原系統與資料未被更動。請查看服務端診斷後重試。');}
 finally{await removeTemporary(config,staging).catch(()=>{});if(await stat(verification).catch(()=>null))await removeTemporary(config,verification).catch(()=>{});}
}
export async function inspect(config,{id,directory,input,password}){profile(config);if(!UUID.test(id)||resolve(directory)!==resolve(config.directory)||!resolve(input).startsWith(resolve(directory)+sep))throw safeError('備份驗證參數不正確。');const destination=childPath(directory,'inspect-'+id);
 try{const manifest=await unpackBackup({input,password,destination,maxBytes:maxBytes(config)});const selection=await validateSelection(config,manifest.selection,{forRestore:true});const siteKeys=Object.keys(manifest.websites||{});if(JSON.stringify(siteKeys.sort())!==JSON.stringify([...selection.websites].sort())||siteKeys.some(key=>!Object.hasOwn(config.websites||{},key)||!/^[a-z][a-z0-9_-]*$/.test(key)||!/^[0-9a-f]{64}$/.test(manifest.websites[key]?.sourceSha256||"")))throw safeError("套件網站清單或原始碼雜湊不符。");if(!manifest.createdAt||!manifest.database?.image||!Array.isArray(manifest.entries))throw safeError('套件缺少還原資訊。');const current=await metadata(config.database.container);let compatible=true;if(selection.database){const version=Number(await docker(psqlArgs(config),{input:'show server_version_num;'}));compatible=Math.floor(version/10000)===Math.floor(Number(manifest.database.version)/10000);for(const name of ['database/database.dump','database/roles.sql','database/db-config.tar.gz','database/source-fingerprint.txt','database/fingerprint.sql'])if(!manifest.entries.some(e=>e.name===name))throw safeError('套件缺少必要資料庫還原檔案。');}return {summary:{selection,createdAt:manifest.createdAt,format:manifest.format,compatibility:{compatible,databaseMajorCompatible:compatible,restoreTarget:'全新、無網路的隔離容器'},scope:'所選網站與整套共用資料庫；不覆蓋正式系統'},destination,manifest,trustedImage:current.Image};
 }catch(error){if(await stat(destination).catch(()=>null))await removeTemporary(config,destination).catch(()=>{});throw error.publicMessage?error:safeError('套件驗證失敗：密碼不符、內容損壞或版本不相容。');}
}
export async function cleanupPlan(config,plan){if(plan?.destination)await removeTemporary(config,plan.destination);}
export async function restore(config,{id,plan,progress=async()=>{}}){profile(config);if(!UUID.test(id)||!plan?.summary?.compatibility?.compatible)throw safeError('此套件與目前資料庫版本不相容。');const name='guc-restore-'+id,restName='guc-restore-api-'+id,dir=plan.destination,dbdir=join(dir,'database');let created=false,restCreated=false;
 try{
   if(Object.keys(plan.manifest.websites||{}).some(key=>!Object.hasOwn(config.websites||{},key)||!/^[a-z][a-z0-9_-]*$/.test(key)))throw safeError('套件網站範圍不正確。');
   for(const file of plan.manifest.entries){const path=resolve(dir,file.name);if(!path.startsWith(resolve(dir)+sep)||await fileHash(path)!==file.sha256)throw safeError('套件驗證後檔案曾被修改，已停止復原。');}
   for(const [website,value] of Object.entries(plan.manifest.websites||{}))if(await treeHash(join(dir,'websites',website))!==value.sourceSha256)throw safeError('網站原始碼與備份版本不一致。');
   if(!plan.manifest.selection.database)return {restore:{status:'verified',filesVerified:plan.manifest.entries.length,scope:'網站／附件檔案完整性；未選擇資料庫',databaseRestored:false}};
   await progress('建立無網路的隔離資料庫');const current=await metadata(config.database.container);if(current.Image!==plan.trustedImage)throw safeError('資料庫映像已更新，請重新驗證套件。');
   await docker(['run','-d','--rm','--name',name,'--label','com.guc.backup.profile='+profileHash(config),'--label','com.guc.backup.job='+id,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--memory',String(config.restoreMemoryBytes||2*1024**3),'--tmpfs','/etc/postgresql-custom:rw,mode=0755,size=16777216','--tmpfs','/tmp:rw,mode=1777,size='+String(config.restoreTmpfsBytes||4*1024**3),'--mount',`type=bind,source=${dbdir},target=/backup,readonly`,'--entrypoint','sh',current.Image,'-c','tar -xzf /backup/db-config.tar.gz -C /etc/postgresql-custom && exec sleep infinity']);created=true;
   await docker(['exec','--user','postgres',name,'initdb','-D','/tmp/guc-restore-data','-U',config.database.admin,'-A','trust','--encoding=UTF8','--no-locale']);
   await docker(['exec','--user','postgres',name,'pg_ctl','-D','/tmp/guc-restore-data','-l','/tmp/restore-postgres.log','-o',"-c listen_addresses='' -c unix_socket_directories=/tmp -c shared_preload_libraries=supabase_vault,pg_net -c vault.getkey_script=/usr/lib/postgresql/bin/pgsodium_getkey.sh",'-w','start']);
   const sql=query=>docker(['exec','-i',name,'psql','-h','/tmp','-U',config.database.admin,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'],{input:query});
   const roles=await readFile(join(dbdir,'roles.sql'),'utf8');const escape=config.database.admin.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');await sql(roles.replace(new RegExp('^CREATE ROLE '+escape+';$','m'),'-- Bootstrap role already exists.'));
   await progress('復原共用資料庫與登入帳號');await docker(['exec',name,'pg_restore','-h','/tmp','-U',config.database.admin,'-d','postgres','--single-transaction','--exit-on-error','/backup/database.dump']);
   await progress('核對全部資料表、函式、RLS 與權限');const actual=(await sql(fingerprintSql)).split(/\r?\n/).filter(line=>line&&line!=='DONE'),expected=(await readFile(join(dbdir,'source-fingerprint.txt'),'utf8')).trim().split(/\r?\n/);if(JSON.stringify(actual)!==JSON.stringify(expected))throw safeError('隔離復原資料與來源快照不一致，未通過驗證。');
   await progress('驗證還原後報價與施工資料流程');const actor=await sql("SELECT id FROM public.app_users WHERE role='admin' AND is_active ORDER BY id LIMIT 1;");if(!UUID.test(actor))throw safeError('還原資料缺少可用管理者，無法驗證程式流程。');
   const rpcResult=await sql(`BEGIN READ ONLY; SELECT jsonb_typeof(public.quotation_options_v1(${sqlLiteral(actor)}::uuid)::jsonb); SELECT jsonb_typeof(public.construction_scope_v1(${sqlLiteral(actor)}::uuid,null)::jsonb); ROLLBACK;`);if(rpcResult!=='object\nobject')throw safeError('還原後報價或施工資料流程驗證失敗。');
   let applicationHttpApiVerified=false;
   if(config.rest?.image||config.rest?.container){
     await progress('啟動隔離資料 API 並實測 HTTP 流程');
     const restInfo=await metadata(config.rest.image||config.rest.container),restImage=config.rest.image?restInfo.Id:restInfo.Image;
     await docker(['exec','--user','postgres',name,'pg_ctl','-D','/tmp/guc-restore-data','-l','/tmp/restore-postgres.log','-o',"-c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp -c shared_preload_libraries=supabase_vault,pg_net -c vault.getkey_script=/usr/lib/postgresql/bin/pgsodium_getkey.sh",'-w','restart']);
     await docker(['run','-d','--rm','--name',restName,'--label','com.guc.backup.profile='+profileHash(config),'--label','com.guc.backup.job='+id,'--network','container:'+name,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','268435456','-e',`PGRST_DB_URI=postgresql://${config.database.admin}@127.0.0.1:5432/postgres`,'-e','PGRST_DB_ANON_ROLE=service_role','-e','PGRST_DB_SCHEMAS=public','-e','PGRST_SERVER_HOST=127.0.0.1',restImage]);restCreated=true;
     const http=async(path,body)=>JSON.parse(await docker(['exec','-i',name,'curl','-fsS','--max-time','10',...(body?['-H','Content-Type: application/json','-X','POST','--data-binary','@-']:[]),'http://127.0.0.1:3000/'+path],body?{input:JSON.stringify(body)}:undefined));
     let ready=false;for(let retry=0;retry<30;retry++){try{const customers=await http('customers?select=id&limit=1');if(!Array.isArray(customers))throw Error('Invalid API response');ready=true;break;}catch{await new Promise(ok=>setTimeout(ok,250));}}if(!ready)throw safeError('隔離資料 API 無法啟動，已停止復原驗證。');
     for(const rpc of ['quotation_options_v1','construction_scope_v1']){const result=await http('rpc/'+rpc,{p_actor_user_id:actor,...(rpc==='construction_scope_v1'?{p_project_id:null}:{})});if(!result||typeof result!=='object'||Array.isArray(result))throw safeError('隔離 HTTP API 回傳資料不正確。');}
     applicationHttpApiVerified=true;
   }
   return {restore:{status:'verified',tablesVerified:plan.manifest.database.tables,rowsVerified:plan.manifest.database.rows,authUsers:plan.manifest.database.authUsers,authIdentities:plan.manifest.database.authIdentities,functionsPermissionsRlsPoliciesVerified:true,sequencesAndVaultVerified:true,applicationReadRpcsVerified:['quotation_options_v1','construction_scope_v1'],applicationHttpApiVerified,filesVerified:plan.manifest.entries.length,sourceHashesVerified:true,network:'none',productionVolumesMounted:false,applicationRuntimeVerified:false}};
 }catch(error){throw error.publicMessage?error:safeError('隔離復原未通過驗證；正式資料庫與容器未被更動。');}
 finally{if(restCreated)await docker(['stop',restName]).catch(()=>{});if(created)await docker(['stop',name]).catch(()=>{});await cleanupPlan(config,plan).catch(()=>{});}
}
