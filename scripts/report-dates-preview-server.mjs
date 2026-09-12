// Loopback-only synthetic report fixture. No external API or production data.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
export const fixture={
  current_user:{id:'u1',username:'fixture',role:'admin',display_name:'本機測試員'},
  customers:[{id:'c1',customer_code:'TEST',customer_category:'school',name:'日期驗證學校（模擬資料）'}],
  projects:[
    {id:'p1',name:'已完成測試專案',project_code:'TEST001',customer_id:'c1',project_type:'construction',status:'completed',created_at:'2026-09-01T16:30:00Z',project_date:'2026-08-01',completed_on:'2026-09-10',row_version:1},
    {id:'p2',name:'進行中測試專案',project_code:'TEST002',customer_id:'c1',project_type:'construction',status:'in_progress',created_at:'2026-09-04T00:00:00Z',row_version:1},
    {id:'p3',name:'無完成紀錄的舊專案',project_code:'TEST003',customer_id:'c1',project_type:'construction',status:'completed',created_at:'2026-08-01T00:00:00Z',row_version:1}
  ],
  items:[],pickups:[],site_workers:[],site_work_log_workers:[],
  site_work_logs:[{id:'l1',project_id:'p1',log_date:'2026-09-02',title:'第一天施工',summary:'建立當天',work_type:'工程施工',status:'completed'},{id:'l2',project_id:'p1',log_date:'2026-09-10',title:'完工',summary:'完成當天',work_type:'工程施工',status:'completed'},{id:'l3',project_id:'p1',log_date:'2026-09-11',title:'區間以外',summary:'不納入預設區間',work_type:'工程施工',status:'completed'}],
  errors:[]
};
export function createPreviewServer(){return createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  res.setHeader('Cache-Control','no-store');
  if(url.pathname==='/api/public-config'){res.setHeader('Content-Type','application/javascript');res.end('globalThis.GUC_PUBLIC_CONFIG={};sessionStorage.setItem("GUC_ERP_ACCESS_TOKEN","local-fixture-only");');return;}
  if(url.pathname==='/api/inventory'&&req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...fixture,scope:url.searchParams.get('scope')||'session'}));return;}
  if(url.pathname.startsWith('/api/')){res.writeHead(403,{'Content-Type':'application/json'});res.end('{"error":"本機模擬，不連線正式系統"}');return;}
  const relative=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname),file=path.resolve(root,'.'+relative);
  if(!file.startsWith(root)||!(relative==='/index.html'||/^\/[\w-]+\.(js|css)$/.test(relative)||relative.startsWith('/assets/'))){res.writeHead(404);res.end();return;}
  try{
    let content=await readFile(file);
    if(relative==='/index.html')content=content.toString().replace('</body>','<div style="position:fixed;bottom:0;left:0;right:0;text-align:center;background:#fff3cd;z-index:9999">本機測試：僅模擬資料，不寫入正式資料庫</div></body>');
    res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':'text/html');
    res.end(content);
  }catch{res.writeHead(404);res.end();}
});}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const server=createPreviewServer();server.listen(4192,'127.0.0.1',()=>console.log('Local fixture preview: http://127.0.0.1:4192/?page=materials&work_content_id=p1'));
}
