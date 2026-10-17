import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm,writeFile,stat,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {captureNas,validateSelection,inspect,cleanupStaging} from './backup-engine.mjs';
import {packBackup} from './backup-archive.mjs';

test('WebDAV backup reads authorized Chinese nested attachments and rejects unsafe server responses',async()=>{
 const base=resolve(process.env.GUC_BACKUP_TEST_ROOT||'F:/GUC-Docker/previews/project-dashboard'),dir=await mkdtemp(join(base,'backup-webdav-test-'));let mode='valid',requests=[];
 const server=createServer((req,res)=>{
  requests.push({method:req.method,url:req.url,auth:req.headers.authorization});
  if(mode==='redirect'){res.writeHead(302,{Location:'http://example.invalid/steal'});res.end();return;}
  if(req.method==='GET'){res.writeHead(200,{'Content-Type':'application/octet-stream',ETag:mode==='changed'?'"changed"':'"fixture"'});res.end('QA1017 中文 NAS 檔案');return;}
  const item=(href,collection=false)=>`<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${collection?'<d:collection/>':''}</d:resourcetype><d:getetag>"fixture"</d:getetag></d:prop></d:propstat></d:response>`;
  const path=mode==='escape'?'https://example.invalid/GUC-ERP/steal':mode==='colon'?'/GUC-ERP/C%3Asecret':mode==='dots'?'/GUC-ERP/file.':req.url==='/GUC-ERP/'?'/GUC-ERP/folder/':'/GUC-ERP/folder/%E4%B8%AD%E6%96%87.txt';
  const xml=mode==='entity'?'<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///secret">]>':mode==='large'?'x'.repeat(8*1024**2+1):`<d:multistatus xmlns:d="DAV:">${item(req.url,true)}${item(path,mode==='valid'&&req.url==='/GUC-ERP/')}</d:multistatus>`;
  res.writeHead(207,{'Content-Type':'application/xml'});res.end(xml);
 });
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 const config={nas:{url:`http://127.0.0.1:${server.address().port}`,root:'/GUC-ERP',username:'fixture',password:'not-a-real-password'}};
 try{
  const target=join(dir,'valid');await captureNas(config,target,{bytes:0,limit:1024});assert.equal(await readFile(join(target,'folder/中文.txt'),'utf8'),'QA1017 中文 NAS 檔案');assert.ok(requests.every(r=>r.auth==='Basic '+Buffer.from('fixture:not-a-real-password').toString('base64')));assert.ok(requests.every(r=>['GET','PROPFIND'].includes(r.method)));
  for(const unsafe of ['escape','colon','dots','entity','large','redirect','changed']){mode=unsafe;requests=[];await assert.rejects(captureNas(config,join(dir,unsafe),{bytes:0,limit:1024}));assert.ok(requests.every(r=>!r.url.includes('example.invalid')));}
  mode='valid';await assert.rejects(captureNas(config,join(dir,'limited'),{bytes:0,limit:1}));
 }finally{await new Promise(ok=>server.close(ok));assert.ok(dir.startsWith(base+'\\')||dir.startsWith(base+'/'));await rm(dir,{recursive:true,force:true});}
});

test('backup profile rejects production targets in preview and attachments without database',async()=>{
 const config={mode:'isolated',directory:'test',database:{container:'supabase-db',name:'guc_dashboard_preview_20261012',admin:'supabase_admin'},websites:{erp:{}},nas:{path:'fixture'}};
 await assert.rejects(validateSelection({...config,database:{...config.database,name:'postgres'}},{websites:['erp']}));
 await assert.rejects(validateSelection(config,{websites:[],nas:true}));
 await assert.rejects(validateSelection(config,{websites:['unknown']}));
 await assert.rejects(validateSelection(config,{websites:['erp'],images:true}));
 assert.deepEqual(await validateSelection(config,{websites:['erp'],database:true}),{websites:['erp'],database:true,images:false,storage:false,nas:false});
});

test('authenticated archive cannot inject a website path outside the configured selection',async()=>{
 const base=resolve(process.env.GUC_BACKUP_TEST_ROOT||'F:/GUC-Docker/previews/project-dashboard'),dir=await mkdtemp(join(base,'backup-manifest-test-'));
 const config={mode:'isolated',directory:dir,database:{container:'supabase-db',name:'guc_dashboard_preview_20261012',admin:'supabase_admin'},websites:{erp:{}}};
 try{
  const input=join(dir,'forged.gucbackup'),payload=join(dir,'payload.txt'),id=randomUUID();await writeFile(payload,'not secret');
  await packBackup({manifest:{selection:{websites:['erp'],database:false},websites:{'../escape':{sourceSha256:'a'.repeat(64)}}},files:[{name:'websites/erp/payload.txt',path:payload}],output:input,password:'synthetic-test-password'});
  await assert.rejects(inspect(config,{id,directory:dir,input,password:'synthetic-test-password'}),/網站清單/);
  assert.equal(await stat(join(dir,'inspect-'+id)).catch(()=>null),null);
 }finally{assert.ok(dir.startsWith(base+'\\')||dir.startsWith(base+'/'));await rm(dir,{recursive:true,force:true});}
});

test('startup cleanup removes only owned staging patterns and retains completed backups',async()=>{
 const base=resolve(process.env.GUC_BACKUP_TEST_ROOT||'F:/GUC-Docker/previews/project-dashboard'),dir=await mkdtemp(join(base,'backup-cleanup-test-'));
 const config={mode:'isolated',directory:dir,database:{container:'supabase-db',name:'guc_dashboard_preview_20261012',admin:'supabase_admin'}};
 try{const id=randomUUID();for(const prefix of ['capture','verify','inspect']){await mkdir(join(dir,prefix+'-'+id));await writeFile(join(dir,prefix+'-'+id,'plain.txt'),'fixture');}await writeFile(join(dir,id+'.upload'),'encrypted fixture');await writeFile(join(dir,id+'.gucbackup'),'completed backup');await mkdir(join(dir,'other-folder'));assert.equal((await cleanupStaging(config,{dockerCommand:async()=>""})).removed,4);assert.ok(await stat(join(dir,id+'.gucbackup')));assert.ok(await stat(join(dir,'other-folder')));}finally{assert.ok(dir.startsWith(base+'\\')||dir.startsWith(base+'/'));await rm(dir,{recursive:true,force:true});}
});

test('orphan cleanup stops only exact labelled restore containers and refuses production names',async()=>{
 const base=resolve(process.env.GUC_BACKUP_TEST_ROOT||'F:/GUC-Docker/previews/project-dashboard'),dir=await mkdtemp(join(base,'backup-orphan-test-'));
 const config={mode:'isolated',directory:dir,database:{container:'supabase-db',name:'guc_dashboard_preview_20261012',admin:'supabase_admin'}},id=randomUUID(),hash=createHash('sha256').update(resolve(dir)).digest('hex'),calls=[];
 const dockerCommand=async args=>{calls.push(args);if(args[0]==='ps')return '123456abcdef';if(args[0]==='inspect')return JSON.stringify({Name:'/guc-restore-'+id,Config:{Labels:{'com.guc.backup.profile':hash,'com.guc.backup.job':id}}});return '';};
 try{assert.equal((await cleanupStaging(config,{dockerCommand})).containersStopped,1);assert.ok(calls.some(args=>args[0]==='stop'&&args[1]==='123456abcdef'));await assert.rejects(cleanupStaging(config,{dockerCommand:async args=>args[0]==='inspect'?JSON.stringify({Name:'/supabase-db',Config:{Labels:{'com.guc.backup.profile':hash,'com.guc.backup.job':id}}}):args[0]==='ps'?'123456abcdef':assert.fail('must not stop unrelated container')}),/標記不符/);}finally{assert.ok(dir.startsWith(base+'\\')||dir.startsWith(base+'/'));await rm(dir,{recursive:true,force:true});}
});
