// Real Gateway validation -> real RPCs -> isolated PGlite; loopback only.
// Auth uses an explicitly synthetic test user. Never loads production secrets.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import vm from 'node:vm';
import {ids,sql} from './worklog-save-fixture.mjs';
import {departmentDatabase} from './department-cross-system-fixture.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function createWorklogTestServer({workflow=false}={}){
 const db=await departmentDatabase(),calls=[];
 if(workflow){await db.exec('drop trigger project_sync on projects');await db.exec(await sql('20260915150407_shared_work_types_and_worklog_rename.sql'));}
 let handler;
 const currentUser={id:ids.actor,username:'fixture-admin',role:'admin',display_name:'隔離測試員',is_active:true};
 const source=stripTypeScriptTypes((await readFile(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8')).replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
 const context=vm.createContext({AsyncLocalStorage,performance,URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,crypto,console,Deno:{env:{get:()=>''},serve:fn=>handler=fn}});
 vm.runInContext(source,context);
 context.currentUser=async()=>currentUser;
 context.rpc=async(name,args)=>{
  if(!['upsert_customer_project_work_log_department_v1','upsert_erp_project_department_v1','upsert_repair_item_department_v1','manage_customer_department_v1','create_stock_receipts_department_v1','update_stock_receipt_department_v1'].includes(name))throw Error('Test denies unrelated RPC: '+name);
  const payload=Object.fromEntries(Object.entries(args).map(([k,v])=>[k.slice(2),v]));
  const keys=Object.keys(args);if(keys.some(key=>!/^p_[a-z_]+$/.test(key)))throw Error('Invalid test argument');
  await db.exec('set role service_role');
  let result;try{result=(await db.query('select to_jsonb('+name+'('+keys.map((key,i)=>key+'=>$'+(i+1)).join(',')+')) result',keys.map(key=>Array.isArray(args[key])&&['p_maintenance_events','p_rows','p_customer_departments'].includes(key)?JSON.stringify(args[key]):args[key]))).rows[0].result;}finally{await db.exec('reset role');}
  calls.push({name,payload,result});return result;
 };
 // PostgREST emits SQL date columns as YYYY-MM-DD; PGlite returns JS Dates.
 const all=async table=>(await db.query('select * from '+table)).rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date&&['log_date','occurred_at','received_on','project_date','receipt_date'].includes(key)?value.toISOString().slice(0,10):value])));
 const snapshot=async scope=>({scope,current_user:currentUser,customers:await all('customers'),customer_departments:await all('customer_departments'),customer_categories:[{id:'school',code:'school',name:'學校機關'}],projects:await all('projects'),sites:await all('sites'),site_workers:[currentUser],site_work_logs:await all('site_work_logs'),site_work_log_workers:await all('site_work_log_workers'),maintenance_events:await all('maintenance_events'),maintenance_event_equipment:await all('maintenance_event_equipment'),maintenance_event_workers:await all('maintenance_event_workers'),repair_items:await all('repair_items'),equipment_registry:[],contract_service_types:[{id:ids.service,code:'computer',name:'電腦設備（測試承攬）',is_active:true,sort_order:1}],customer_contract_services:await all('customer_contract_services'),categories:[{id:ids.category,name:'電腦設備',is_active:true}],items:[{id:ids.item,category_id:ids.category,item_name:'查修測試電腦',inventory_code:'TEST-001',unit:'台'}],pickups:[],errors:[]});
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Cache-Control','no-store');
  try{
   if(url.pathname==='/api/public-config'){res.setHeader('Content-Type','application/javascript');res.end('globalThis.GUC_PUBLIC_CONFIG={};sessionStorage.setItem("GUC_ERP_ACCESS_TOKEN","isolated-fixture-only");');return;}
   if(url.pathname==='/api/inventory'){
    res.setHeader('Content-Type','application/json');
    if(req.method==='GET'){const data=await snapshot(url.searchParams.get('scope')||'session'),links=await all('stock_receipt_customers');data.suppliers=await all('suppliers');data.receipts=(await all('stock_receipts')).map(row=>({...row,stock_receipt_customers:links.filter(link=>link.stock_receipt_id===row.id)}));res.end(JSON.stringify(data));return;}
    let body='';for await(const chunk of req){body+=chunk;if(body.length>1000000)throw Error('Too large');}
    if(!['upsert_customer_project_work_log','create_erp_project','update_erp_project','upsert_repair_item','create_stock_receipt_batch','update_stock_receipt','create_customer_department','update_customer_department','deactivate_customer_department'].includes(JSON.parse(body).operation)){res.writeHead(403);res.end('{"error":"隔離環境僅允許科室相關測試"}');return;}
    const result=await handler(new Request('http://127.0.0.1/inventory-gateway',{method:'POST',body}));res.writeHead(result.status);res.end(await result.text());return;
   }
   if(url.pathname.startsWith('/api/')){res.writeHead(403,{'Content-Type':'application/json'});res.end('{"error":"隔離環境不提供正式 API 或 NAS"}');return;}
   const relative=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname),file=path.resolve(root,'.'+relative);
   if(!file.startsWith(root)||!(relative==='/index.html'||/^\/[\w-]+\.(js|css)$/.test(relative)||relative.startsWith('/assets/'))){res.writeHead(404);res.end();return;}
   let content=await readFile(file);
   if(relative==='/app.js')content=content.toString().replace('const PREVIEW_MODE = location.hostname !== PRODUCTION_HOST;','const PREVIEW_MODE = false; // Isolated local DB, never production').replace('儲存後會寫入正式資料庫並留下修改歷程','本機隔離資料庫：可測試新增與重新讀取，不影響正式資料');
   if(relative==='/index.html')content=content.toString().replace('</body>','<div style="position:fixed;bottom:0;left:0;right:0;text-align:center;background:#fff3cd;z-index:99999;pointer-events:none;font-size:12px;line-height:1.3">隔離測試：國立高雄大學／應用數學系｜不寫入正式資料庫</div></body>');
   res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(content);
  }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
 });
 return{server,db,calls,snapshot};
}
if(process.argv[1]?.endsWith('worklog-save-preview-server.mjs')){
 const {server}=await createWorklogTestServer(),port=Number(process.env.WORKLOG_TEST_PORT||4199);server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port+'/?page=worklogs — cross-system isolated DB only'));
}
