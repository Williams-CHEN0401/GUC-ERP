// Actual application UI, NAS API, Gateway and PostgreSQL functions. Only the
// WebDAV storage boundary and authenticated test identities are synthetic.
// This process never reads .env files or contacts production services.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {constructionPlanServer,planUsers} from './construction-plan-fixture.mjs';
import {ids,sql} from './worklog-save-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';
import {createNasMemoryFixture} from './nas-memory-fixture.mjs';
import nasApi from '../api/nas.mjs';

export const drawingMigration='20261101061126_construction_plan_nas_drawings.sql';
export async function constructionDrawingsServer(){
 const fixture=await constructionPlanServer(),{db,server,gatewayHandler,additionalRpcs}=fixture;
 // Released read/audit columns absent from the older construction test schema.
 await db.exec(`alter table customers add column if not exists deleted_at timestamptz;
  alter table projects add column if not exists contract_start_date date,add column if not exists contract_end_date date;
  alter table app_users add column if not exists can_work_on_site boolean not null default true;
  alter table audit_logs alter column entity_id drop not null;
  alter table audit_logs add column if not exists event_kind text default 'legacy',add column if not exists outcome text default 'recorded';
  create or replace view erp_private_customers with(security_invoker=true) as select r.* from customers r where erp_private_json_visible_v1(to_jsonb(r));
  create or replace view erp_private_projects with(security_invoker=true) as select r.* from projects r where erp_private_json_visible_v1(to_jsonb(r));`);
 await db.exec(`alter table site_assets
  add column if not exists site_id uuid references sites,
  add column if not exists asset_type text,
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists original_name text,
  add column if not exists mime_type text,
  add column if not exists file_size bigint,
  add column if not exists nas_path text unique,
  add column if not exists upload_status text,
  add column if not exists uploaded_by text,
  add column if not exists uploaded_at timestamptz,
  add column if not exists sha256 text,
  add column if not exists source text,
  add column if not exists updated_by text,
  add column if not exists updated_at timestamptz default now(),
  add column if not exists row_version integer not null default 1;
  grant select,insert,update on site_assets to service_role;`);
 await db.exec(await sql(drawingMigration));
 additionalRpcs.push('construction_drawings_v1','construction_drawing_file_v1','construction_drawing_upload_context_v1','register_construction_drawings_v1');
 const plans=[];
 for(const [index,projectId]of [fixture.planProjects.small,fixture.planProjects.tender].entries()){
  plans.push(await callAsService(db,'save_construction_plan_v1',[planUsers.owner,JSON.stringify({id:randomUUID(),project_id:projectId,construction_date:'2026-11-01',content:index?'二樓網路設備配置':'一樓監控配管與工程圖',status:'pending',planned_days:7,notes:'隔離測試：工程圖保存在記憶體 NAS，重新啟動即清除。',assignee_user_ids:[planUsers.A,planUsers.B]}),false]));
 }
 const originalUser=fixture.gatewayContext.currentUser;
 fixture.gatewayContext.currentUser=async request=>{
  const key=(request.headers.get('authorization')||'').replace(/^Bearer isolated-plan-/,'');
  if(!Object.hasOwn(planUsers,key))return null;
  return originalUser(request);
 };
 const nas=createNasMemoryFixture(),originalFetch=globalThis.fetch;
 // The existing work-log share remains available; construction drawings use
 // their own pre-existing share and never move or recreate the old root.
 nas.folders.add('/施工規劃圖');
 const envNames=['VERCEL_ENV','GUC_LOCAL_SUPABASE','GUC_LOCAL_DOCKER','SUPABASE_FUNCTIONS_URL','NAS_WEBDAV_URL','NAS_WEBDAV_USERNAME','NAS_WEBDAV_PASSWORD','NAS_WEBDAV_ROOT'];
 const originalEnv=Object.fromEntries(envNames.map(key=>[key,process.env[key]]));
 Object.assign(process.env,{VERCEL_ENV:'production',GUC_LOCAL_SUPABASE:'false',GUC_LOCAL_DOCKER:'false',SUPABASE_FUNCTIONS_URL:'',NAS_WEBDAV_URL:'https://nas.fixture.test',NAS_WEBDAV_USERNAME:'fixture',NAS_WEBDAV_PASSWORD:'fixture-only',NAS_WEBDAV_ROOT:'/GUC-ERP'});
 const failedNames=new Set(),metadataFailures=new Set(),modes=[],external=[];
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input));
  if(url.hostname==='nas.fixture.test'){
   const name=decodeURIComponent(url.pathname).split('/').at(-1);
   if(init.method==='PUT'&&failedNames.has(name))return new Response(null,{status:503});
   return nas.fetch(input,init);
  }
  if(url.hostname.endsWith('.supabase.co')&&url.pathname.includes('/inventory-gateway')){
   return gatewayHandler(new Request('http://127.0.0.1/inventory-gateway'+url.search,{method:init.method||'GET',headers:init.headers,...(init.body?{body:init.body}:{})}));
  }
  external.push(url.origin+url.pathname);throw Error('Isolated drawing fixture blocked external network request');
 };
 const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
 const securityHeaders=config.headers.find(rule=>rule.source==='/(.*)').headers;
 const fallback=server.listeners('request')[0];server.removeAllListeners('request');
 const respond=async(res,response)=>{res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));};
 const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 server.on('request',async(req,res)=>{
  for(const header of securityHeaders)res.setHeader(header.key,header.value);
  const url=new URL(req.url,'http://127.0.0.1');
  try{
   if(url.pathname==='/api/public-config'){
    res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store'});
    res.end('globalThis.GUC_PUBLIC_CONFIG={localProduction:true,productionOrigin:location.origin,constructionDrawingsIsolated:true};globalThis.GUC_ISOLATED_PREVIEW_WRITES=true;sessionStorage.setItem("GUC_ERP_ACCESS_TOKEN","isolated-plan-"+(new URLSearchParams(location.search).get("test_user")||"owner"));');return;
   }
   if(url.pathname==='/api/nas'){
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>82*1024*1024)throw Error('Isolated request exceeds upload limit');chunks.push(chunk);}
    const request=new Request(url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});
    if(req.method==='POST'){const form=await request.clone().formData();modes.push({mode:form.get('mode'),name:form.get('files')?.name,plan:form.get('construction_plan_id')});}
    await respond(res,await nasApi.fetch(request));return;
   }
   if(url.pathname==='/api/inventory'&&req.method==='POST'){
    let body='';for await(const chunk of req){body+=chunk;if(body.length>2_000_000)throw Error('Isolated request too large');}
    const data=JSON.parse(body);
    if(data.operation==='create_construction_drawing_batch'&&data.payload.rows.some(row=>metadataFailures.has(row.original_name))){json(res,503,{error:'隔離測試：附件索引儲存失敗'});return;}
    await respond(res,await gatewayHandler(new Request('http://127.0.0.1/inventory-gateway',{method:'POST',headers:req.headers,body})));return;
   }
   if(url.pathname==='/__drawing_test'){
    json(res,200,{isolated:true,plans:plans.map(plan=>({id:plan.id,project_id:plan.project_id,content:plan.content})),customer_id:ids.customer});return;
   }
   return fallback(req,res);
  }catch(error){json(res,500,{error:error.message});}
 });
 return {...fixture,plans,nas,failedNames,metadataFailures,modes,external,originalFetch,restore(){
  globalThis.fetch=originalFetch;for(const key of envNames)originalEnv[key]===undefined?delete process.env[key]:process.env[key]=originalEnv[key];
 }};
}
if(process.argv[1]?.endsWith('construction-drawings-fixture.mjs')){
 const {server}=await constructionDrawingsServer();
 const port=Number(process.env.DRAWING_TEST_PORT||4500);
 server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port+'/?page=projects — 工程圖隔離測試：記憶體資料庫與 NAS，重啟即清除；test_user=owner/A/C/admin。'));
}
