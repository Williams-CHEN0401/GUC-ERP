import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createCipheriv,scryptSync,createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {packBackup,unpackBackup,safeRelative,fileHash} from '../docker/backup-archive.mjs';
const password='fixture-only-passphrase-1017';
async function workspace(t){const dir=await mkdtemp(join(tmpdir(),'guc-backup-codec-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('encrypted archive restores exact binary, Chinese paths, empty files and manifest',async t=>{
 const dir=await workspace(t),input=join(dir,'source'),empty=join(dir,'empty'),output=join(dir,'bundle.gucbackup');
 await writeFile(input,randomBytes(12*1024*1024));await writeFile(empty,'');
 const result=await packBackup({manifest:{createdAt:'2026-10-17',selection:{database:true}},files:[{name:'資料/database.dump',path:input},{name:'empty.txt',path:empty}],output,password});
 assert.equal(result.sha256,await fileHash(output));assert.ok(result.bytes>12*1024*1024);
 const manifest=await unpackBackup({input:output,password,destination:join(dir,'restored')});
 assert.equal(manifest.selection.database,true);assert.equal(await fileHash(join(dir,'restored/資料/database.dump')),await fileHash(input));assert.equal((await stat(join(dir,'restored/empty.txt'))).size,0);
 assert.ok(!(await readFile(output)).includes(Buffer.from('database.dump')));
});
test('wrong password, corrupt ciphertext, truncation and decompression limit fail without extracted residue',async t=>{
 const dir=await workspace(t),source=join(dir,'source'),bundle=join(dir,'backup');await writeFile(source,'fixture-secret'.repeat(10000));
 await packBackup({manifest:{},files:[{name:'data',path:source}],output:bundle,password});
 const bytes=await readFile(bundle);const corrupt=Buffer.from(bytes);corrupt[45]^=1;await writeFile(join(dir,'corrupt'),corrupt);await writeFile(join(dir,'truncated'),bytes.subarray(0,bytes.length-8));
 for(const [name,input,pw,limit]of [['password',bundle,'incorrect-password-1017'],['corrupt',join(dir,'corrupt'),password],['truncated',join(dir,'truncated'),password],['limit',bundle,password,1024]]){
  const destination=join(dir,'extract-'+name);await assert.rejects(unpackBackup({input,password:pw,destination,...(limit?{maxBytes:limit}:{})}));await assert.rejects(stat(destination),{code:'ENOENT'});
 }
});
test('unsafe archive names, duplicate case names and existing outputs cannot overwrite files',async t=>{
 const dir=await workspace(t),source=join(dir,'input'),output=join(dir,'protected');await writeFile(source,'source');await writeFile(output,'keep-original');
 for(const name of ['../secret','/absolute','x\\y','C:/data','safe/../../data','NUL','data.','x:stream','.verified-payload'])assert.throws(()=>safeRelative(name));
 await assert.rejects(packBackup({manifest:{},files:[{name:'a',path:source},{name:'A',path:source}],output,password}));
 await assert.rejects(packBackup({manifest:{},files:[{name:'a',path:source}],output,password}));assert.equal(await readFile(output,'utf8'),'keep-original');
});
test('authenticated but malicious archive manifest cannot escape destination',async t=>{
 const dir=await workspace(t),salt=randomBytes(16),iv=randomBytes(12),header=Buffer.concat([Buffer.from('GUCBKP01'),salt,iv]);
 const entry={name:'../escaped',size:3,sha256:createHash('sha256').update('bad').digest('hex')};
 const meta=value=>{const content=Buffer.from(JSON.stringify(value)),length=Buffer.alloc(4);length.writeUInt32BE(content.length);return Buffer.concat([length,content]);};
 const cipher=createCipheriv('aes-256-gcm',scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024}),iv);cipher.setAAD(header);
 const payload=gzipSync(Buffer.concat([meta({format:'GUCBKP01',entries:[entry]}),meta(entry),Buffer.from('bad'),Buffer.alloc(4)]));
 const file=join(dir,'evil');await writeFile(file,Buffer.concat([header,cipher.update(payload),cipher.final(),cipher.getAuthTag()]));
 await assert.rejects(unpackBackup({input:file,password,destination:join(dir,'extract')}));await assert.rejects(stat(join(dir,'escaped')),{code:'ENOENT'});
});
