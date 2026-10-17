// Streaming, authenticated backup container. No password or derived key is persisted.
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,stat,open,rm} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {createHash,createCipheriv,createDecipheriv,randomBytes,scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
const MAGIC=Buffer.from('GUCBKP01'),MAX_META=16*1024*1024;
export function safeRelative(value){if(typeof value!=='string'||!value||value.length>1000||value.includes('\\')||/[\x00-\x1f]/.test(value)||value.startsWith('/')||value.split('/').some(x=>!x||x==='.'||x==='..'||/[<>:"|?*]/.test(x)||/[. ]$/.test(x)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x))||value.toLowerCase()==='.verified-payload')throw Error('備份檔案路徑不安全。');return value;}
export async function fileHash(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
function meta(value){const body=Buffer.from(JSON.stringify(value));if(body.length>MAX_META)throw Error('備份資訊過大。');const head=Buffer.alloc(4);head.writeUInt32BE(body.length);return Buffer.concat([head,body]);}
async function key(password,salt){if(typeof password!=='string'||password.length<12||password.length>256)throw Error('備份密碼須為 12–256 個字元。');return promisify(scrypt)(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});}
async function writeAll(file,buffer){let offset=0;while(offset<buffer.length){const {bytesWritten}=await file.write(buffer,offset,buffer.length-offset);if(!bytesWritten)throw Error('備份寫入中斷。');offset+=bytesWritten;}}
export async function packBackup({manifest,files,output,password}){
 const entries=[];for(const file of files){safeRelative(file.name);const s=await stat(file.path);if(!s.isFile())throw Error('備份來源不是一般檔案。');entries.push({name:file.name,size:s.size,sha256:await fileHash(file.path)});}
 if(new Set(entries.map(e=>e.name.toLowerCase())).size!==entries.length)throw Error('備份檔名重複。');
 const full={...manifest,format:'GUCBKP01',entries},salt=randomBytes(16),iv=randomBytes(12),derived=await key(password,salt),header=Buffer.concat([MAGIC,salt,iv]);
 const cipher=createCipheriv('aes-256-gcm',derived,iv);cipher.setAAD(header);let created=false;
 async function* contents(){yield meta(full);for(let i=0;i<entries.length;i++){yield meta(entries[i]);const hash=createHash('sha256');let size=0;for await(const chunk of createReadStream(files[i].path)){hash.update(chunk);size+=chunk.length;yield chunk;}if(size!==entries[i].size||hash.digest('hex')!==entries[i].sha256)throw Error('來源檔案於備份期間變更，請重新建立備份。');}yield Buffer.alloc(4);}
 try{const out=await open(output,'wx',0o600);created=true;try{await writeAll(out,header);}finally{await out.close();}await pipeline(Readable.from(contents()),createGzip(),cipher,createWriteStream(output,{flags:'a',mode:0o600}));const f=await open(output,'a');try{await writeAll(f,cipher.getAuthTag());}finally{await f.close();}return{manifest:full,bytes:(await stat(output)).size,sha256:await fileHash(output)};}
 catch(e){if(created)await rm(output,{force:true});throw e;}finally{derived.fill(0);}
}
class Reader{
 constructor(stream){this.stream=stream;this.iterator=stream[Symbol.asyncIterator]();this.pending=Buffer.alloc(0);}
 async take(n,consume){let left=n;const chunks=[];while(left){if(!this.pending.length){const next=await this.iterator.next();if(next.done)throw Error('備份資料不完整。');this.pending=next.value;}const part=this.pending.subarray(0,Math.min(left,this.pending.length));this.pending=this.pending.subarray(part.length);left-=part.length;if(consume)await consume(part);else chunks.push(part);}return consume?undefined:Buffer.concat(chunks);}
 async metadata(){const n=(await this.take(4)).readUInt32BE();if(n===0)return null;if(n>MAX_META)throw Error('備份資訊格式不正確。');return JSON.parse((await this.take(n)).toString('utf8'));}
 async assertEnd(){if(this.pending.length||!(await this.iterator.next()).done)throw Error('備份尾端有未列入資訊的內容。');}
}
export async function unpackBackup({input,password,destination,maxBytes=1024**4}){
 const s=await stat(input);if(s.size<52)throw Error('不是有效備份套件。');const f=await open(input,'r'),header=Buffer.alloc(36),tag=Buffer.alloc(16);try{await f.read(header,0,36,0);await f.read(tag,0,16,s.size-16);}finally{await f.close();}
 if(!header.subarray(0,8).equals(MAGIC))throw Error('不支援的備份格式。');
 const targetRoot=resolve(destination),staging=resolve(targetRoot,'.verified-payload'),derived=await key(password,header.subarray(8,24)),decipher=createDecipheriv('aes-256-gcm',derived,header.subarray(24));decipher.setAAD(header);decipher.setAuthTag(tag);let created=false,stream,done;
 try{
  await mkdir(targetRoot,{recursive:false,mode:0o700});created=true;
  // Authenticate the complete ciphertext before parsing any untrusted paths or restoring data.
  await pipeline(createReadStream(input,{start:36,end:s.size-17}),decipher,createWriteStream(staging,{flags:'wx',mode:0o600}));
  let inflated=0;const limit=new Transform({transform(chunk,_encoding,cb){inflated+=chunk.length;cb(inflated>maxBytes?Error('備份解壓資料超過允許容量。'):null,chunk);}});
  stream=limit;done=pipeline(createReadStream(staging),createGunzip(),limit).then(()=>null,error=>error);const reader=new Reader(stream),manifest=await reader.metadata();
  if(manifest?.format!=='GUCBKP01'||!Array.isArray(manifest.entries)||manifest.entries.length>250000)throw Error('備份 Manifest 不正確。');
  const seen=new Set();for(const expected of manifest.entries){safeRelative(expected.name);if(seen.has(expected.name.toLowerCase())||!Number.isSafeInteger(expected.size)||expected.size<0||expected.size>maxBytes||!/^[a-f0-9]{64}$/.test(expected.sha256))throw Error('備份檔案資訊不正確。');seen.add(expected.name.toLowerCase());}
  for(const expected of manifest.entries){const entry=await reader.metadata();if(JSON.stringify(entry)!==JSON.stringify(expected))throw Error('備份檔案與 Manifest 不符。');const target=resolve(targetRoot,entry.name);if(!target.startsWith(targetRoot+sep))throw Error('備份路徑越界。');await mkdir(dirname(target),{recursive:true,mode:0o700});const output=await open(target,'wx',0o600),hash=createHash('sha256');try{await reader.take(entry.size,async chunk=>{hash.update(chunk);await writeAll(output,chunk);});}finally{await output.close();}if(hash.digest('hex')!==entry.sha256)throw Error('備份檔案雜湊不符。');}
  if(await reader.metadata()!==null)throw Error('備份含有未宣告的檔案。');await reader.assertEnd();const streamError=await done;if(streamError)throw streamError;await rm(staging);return manifest;
 }catch(error){stream?.destroy();if(done)await done;if(created&&resolve(destination)===targetRoot)await rm(targetRoot,{recursive:true,force:true});throw new Error('備份驗證失敗：密碼不符、內容損壞或格式無效。',{cause:error});}finally{derived.fill(0);}
}
