// Actual UI/API/Gateway/SQL with only an in-memory WebDAV boundary replaced.
import {receiptDocumentServer} from './receipt-document-fixture.mjs';
import {sql,definition,ids} from './worklog-save-fixture.mjs';
import {createNasMemoryFixture} from './nas-memory-fixture.mjs';
import nasApi from '../api/nas.mjs';
export async function worklogAttachmentsServer(){
 const fixture=await receiptDocumentServer(),{db,server,gatewayHandler,historical,additionalRpcs}=fixture;
 await db.exec(`create table if not exists contract_service_types(id uuid primary key,code text,name text,is_active boolean default true,sort_order integer default 1);
 alter table customer_contract_services add column if not exists is_active boolean default true;
 grant select on contract_service_types to service_role;`);
 await db.query("insert into contract_service_types(id,code,name) values($1,'computer','電腦設備（測試承攬）') on conflict(id) do update set name=excluded.name",[ids.service]);
 await db.exec(`alter table sites add column if not exists customer_id uuid,add column if not exists contract_service_type_id uuid,add column if not exists updated_by text;
 alter table site_assets add column if not exists site_id uuid,add column if not exists asset_type text,add column if not exists title text,
 add column if not exists description text,add column if not exists original_name text,add column if not exists mime_type text,
 add column if not exists file_size bigint,add column if not exists nas_path text unique,add column if not exists upload_status text,
 add column if not exists uploaded_by text,add column if not exists uploaded_at timestamptz,add column if not exists sha256 text,
 add column if not exists source text,add column if not exists updated_by text;
 grant select,insert,update on site_assets to service_role;`);
 await db.query('update sites set customer_id=$1,contract_service_type_id=$2 where id=$3',[ids.customer,ids.service,historical.work_log.site_id]);
 await db.exec(definition(await sql('20260828000300_contract_centric_sites.sql'),'ensure_customer_contract_site_v1'));
 await db.exec(await sql('20260829000100_contract_attachment_project_path.sql'));
 additionalRpcs.push('register_work_log_attachments_v1','register_contract_site_attachments_v2');
 const nas=createNasMemoryFixture(),originalFetch=globalThis.fetch,envNames=['VERCEL_ENV','NAS_WEBDAV_URL','NAS_WEBDAV_USERNAME','NAS_WEBDAV_PASSWORD','NAS_WEBDAV_ROOT'],originalEnv=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{VERCEL_ENV:'production',NAS_WEBDAV_URL:'https://nas.fixture.test',NAS_WEBDAV_USERNAME:'fixture',NAS_WEBDAV_PASSWORD:'fixture-only',NAS_WEBDAV_ROOT:'/GUC-ERP'});
 const failedNames=new Set(),metadataFailures=new Set(),modes=[];
 globalThis.fetch=async(url,init={})=>{
   if(new URL(String(url)).hostname==='nas.fixture.test'){
     const name=decodeURIComponent(new URL(String(url)).pathname).split('/').at(-1);
     if(init.method==='PUT'&&failedNames.has(name))return new Response(null,{status:503});
     return nas.fetch(url,init);
   }
   if(String(url).includes('scope='))return gatewayHandler(new Request('http://127.0.0.1/inventory-gateway'+new URL(String(url)).search,{headers:init.headers}));
   throw Error('Unexpected external request blocked');
 };
 const fallback=server.listeners('request')[0];server.removeAllListeners('request');
 server.on('request',async(req,res)=>{
   const url=new URL(req.url,'http://127.0.0.1');
   const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
   try{
     if(url.pathname==='/api/nas'){
       let bytes=0,chunks=[];for await(const part of req){bytes+=part.length;if(bytes>4500000)throw Error('Hosting payload limit');chunks.push(part);}
       const request=new Request(url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});
       if(req.method==='POST'){const form=await request.clone().formData();modes.push({mode:form.get('mode'),name:form.get('files')?.name});}
       const response=await nasApi.fetch(request);res.writeHead(response.status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(await response.text());return;
     }
     if(url.pathname==='/api/inventory'&&req.method==='POST'){
       let body='';for await(const chunk of req){body+=chunk;if(body.length>1000000)throw Error('Too large');}
       const data=JSON.parse(body);if(data.operation==='create_contract_site_attachment_batch'&&data.payload.rows.some(r=>metadataFailures.has(r.original_name))){json(503,{error:'隔離索引失敗'});return;}
       const response=await gatewayHandler(new Request('http://127.0.0.1/inventory-gateway',{method:'POST',headers:req.headers,body}));res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());return;
     }
     if(url.pathname==='/__attachment_rows'){json(200,(await db.query('select * from site_assets')).rows);return;}
     if(url.pathname==='/api/inventory'&&req.method==='GET'&&['worklogs','sites'].includes(url.searchParams.get('scope'))){const data=await fixture.snapshot(url.searchParams.get('scope'));data.site_assets=(await db.query('select * from site_assets')).rows;json(200,data);return;}
     return fallback(req,res);
   }catch(error){json(500,{error:error.message});}
 });
  return {...fixture,nas,failedNames,metadataFailures,modes,restore(){globalThis.fetch=originalFetch;for(const k of envNames)originalEnv[k]===undefined?delete process.env[k]:process.env[k]=originalEnv[k];}};
}
if(process.argv[1]?.endsWith('worklog-attachments-fixture.mjs')){
  const {server}=await worklogAttachmentsServer();server.listen(4235,'127.0.0.1',()=>console.log('http://127.0.0.1:4235/?page=transactions — 隔離 DB / 記憶體 NAS，重啟會清除測試資料，不寫入正式環境'));
}
