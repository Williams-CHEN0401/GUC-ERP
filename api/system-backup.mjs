import http from 'node:http';
import {pipeline} from 'node:stream/promises';
// This BFF forwards the user's existing session. The worker rechecks RBAC on every call.
export async function proxySystemBackup(req,res,{endpoint=process.env.GUC_BACKUP_SERVICE_URL}={}){
 if(!endpoint){res.writeHead(503,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'系統備份服務尚未啟用，請由管理者完成本機部署設定。'}));}
 const base=new URL(endpoint);if(base.protocol!=='http:'||!['127.0.0.1','localhost','host.docker.internal','guc-backup-worker'].includes(base.hostname))throw Error('Backup service must use a configured private endpoint');
 const incoming=new URL(req.url,'http://erp.internal');const suffix=incoming.pathname.slice('/api/system-backup'.length)||'/catalog';
 if(!/^\/(catalog|jobs|jobs\/[0-9a-f-]{36}\/ticket|download|restore\/(upload|inspect|execute))$/.test(suffix)){res.writeHead(404);return res.end();}
 const target=new URL('/v1'+suffix+incoming.search,base);
 const headers={'authorization':req.headers.authorization||'','content-type':req.headers['content-type']||'application/json'};if(req.headers['content-length'])headers['content-length']=req.headers['content-length'];
 await new Promise((resolve,reject)=>{
  const upstream=http.request(target,{method:req.method,headers},async response=>{res.writeHead(response.statusCode,{'Content-Type':response.headers['content-type']||'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer',...(response.headers['content-length']?{'Content-Length':response.headers['content-length']}:{}),...(response.headers['content-disposition']?{'Content-Disposition':response.headers['content-disposition']}:{})});try{await pipeline(response,res);resolve();}catch(e){reject(e);}});
  upstream.setTimeout(suffix==='/restore/upload'?30*60000:120000,()=>upstream.destroy(Error('Backup service timeout')));upstream.on('error',reject);req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
 });
}

// Cloud builds have no access to the local Docker backup worker.
export default function handler(_req,res){res.statusCode=503;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({error:'系統備份僅提供於已設定備份服務的 Docker 網站。'}));}
