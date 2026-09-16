// Loopback-only demo: actual NAS API runs against an in-memory WebDAV adapter.
// No production credentials, database writes, or external network requests.
import {setTimeout as delay} from 'node:timers/promises';
import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
import {sample,saveLog,ids} from './worklog-save-fixture.mjs';
import {createNasMemoryFixture} from './nas-memory-fixture.mjs';
import nasApi from '../api/nas.mjs';
export async function createAttachmentProgressServer(){
 const {server,db}=await createWorklogTestServer({contractCatalog:true});
 const work=sample();work.project_name='附件進度隔離測試';const saved=await saveLog(db,work);
 const fixture=createNasMemoryFixture();Object.assign(fixture.context,{customer_id:ids.customer,contract_service_type_id:ids.service,project_id:saved.work_log.project_id});
 Object.assign(process.env,{VERCEL_ENV:'production',NAS_WEBDAV_URL:'https://nas.fixture.test',NAS_WEBDAV_USERNAME:'fixture',NAS_WEBDAV_PASSWORD:'fixture-only',NAS_WEBDAV_ROOT:'/GUC-ERP'});
 globalThis.fetch=fixture.fetch;
 const fallback=server.listeners('request')[0],indexed=[];server.removeAllListeners('request');
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 server.on('request',async(req,res)=>{
  try{
   const pathname=new URL(req.url,'http://127.0.0.1').pathname;
   if(pathname==='/api/nas'){
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4500000)throw Error('Local test request exceeds hosting limit');chunks.push(chunk);await delay(12);}
    const request=new Request('http://127.0.0.1/api/nas',{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});
    const response=await nasApi.fetch(request);await delay(650);res.writeHead(response.status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(await response.text());return;
   }
   if(pathname==='/api/inventory'&&req.method==='POST'){
    let body='';for await(const chunk of req){body+=chunk;if(body.length>1000000)throw Error('Too large');}const data=JSON.parse(body);
    if(data.operation!=='create_contract_site_attachment_batch'){json(res,403,{error:'此隔離頁僅測試附件，不修改其他資料'});return;}
    await delay(900);
    if(data.payload.rows.some(row=>row.original_name.includes('失敗'))){json(res,500,{error:'隔離測試：附件索引儲存失敗'});return;}
    indexed.push(...data.payload.rows);json(res,201,{result:data.payload.rows});return;
   }
   if(pathname==='/__attachment_test'){json(res,200,{indexed:indexed.map(row=>row.original_name),files:fixture.files.size});return;}
   return fallback(req,res);
  }catch(error){json(res,500,{error:error.message});}
 });
 return {server,db};
}
if(process.argv[1]?.endsWith('attachment-progress-preview-server.mjs')){
 const {server}=await createAttachmentProgressServer();server.listen(4214,'127.0.0.1',()=>console.log('http://127.0.0.1:4214/?page=worklogs — 附件進度隔離測試；不連線正式資料庫或 NAS；檔名含「失敗」可測試索引錯誤。'));
}
