import http from 'node:http';
import fs from 'node:fs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';

export function serveFieldRehearsal(db,snapshot,customerId,serviceId) {
  let edgeHandler;
  const user={id:'10000000-0000-4000-8000-000000000001',username:'local-test',display_name:'本機測試',role:'admin',is_active:true};
  const context=vm.createContext({AsyncLocalStorage,performance,Deno:{env:{get:()=>''},serve:fn=>edgeHandler=fn},URL,Request,Response,Headers,AbortController,setTimeout,clearTimeout,console,crypto});
  const source=fs.readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8');
  vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'}),context);
  context.currentUser=async()=>user;
  context.ensurePhoneContract=async()=>{};
  context.rpc=async(name,args)=>{
    if(name!=='import_phone_field_rows_v1')throw Error('本機測試僅接受現場端匯入');
    return (await db.query('select import_phone_field_rows_v1($1,$2,$3,$4::jsonb,$5) as result',[args.p_customer_id,args.p_contract_service_type_id,args.p_file_name,JSON.stringify(args.p_rows),args.p_actor])).rows[0].result;
  };
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://127.0.0.1:4191');
      if(url.pathname==='/rehearsal') {
        res.setHeader('Content-Type','text/html; charset=utf-8');
        res.end(`<html lang="zh-Hant"><meta charset="utf-8"><title>現場端本機測試</title><body><p>此為隔離測試，操作不會寫入正式資料庫。</p><script>sessionStorage.setItem('GUC_SITE_DATA_ACCESS_TOKEN','local-rehearsal-only');location.replace('/phone-devices?customer_id=${customerId}');</script></body></html>`);return;
      }
      if(url.pathname.startsWith('/api/')) {
        res.setHeader('Content-Type','application/json');res.setHeader('X-Site-Data-Mode','production');
        if(req.method==='POST') {
          let body='';for await(const chunk of req)body+=chunk;
          if(JSON.parse(body).operation!=='import_phone_terminal_rows'){res.writeHead(403);res.end(JSON.stringify({error:'本機測試僅接受現場端匯入'}));return;}
          const response=await edgeHandler(new Request('https://test.local/functions/v1/inventory-gateway',{method:'POST',headers:{'Content-Type':'application/json'},body}));
          res.statusCode=response.status;res.end(await response.text());return;
        }
        if(url.searchParams.get('entity')==='phone_terminal_versions'){res.end(JSON.stringify({records:[]}));return;}
        const points=(await db.query('select * from phone_terminal_points')).rows;
        res.end(JSON.stringify({current_user:user,errors:[],preview_readonly:false,scope:url.searchParams.get('scope'),
          customers:[{id:customerId,name:'高雄市政府環境保護局',customer_category:'government'}],
          contract_service_types:[{id:serviceId,code:'phone_system',name:'電話系統',is_active:true}],
          customer_contract_services:[{customer_id:customerId,service_type_id:serviceId}],
          phone_systems:[],phone_extensions:snapshot.extensions,phone_terminal_points:points,phone_credential_access_logs:[],sites:[]}));return;
      }
      const upstream=await fetch('http://127.0.0.1:3191'+req.url);
      const contentType=upstream.headers.get('content-type')||'application/octet-stream';
      res.statusCode=upstream.status;res.setHeader('Content-Type',contentType);
      if(contentType.includes('text/html')) {
        const html=await upstream.text();
        res.end(html.replace('</body>','<div style="position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#fff0cd;color:#563d00;text-align:center;padding:6px;font-size:13px">本機隔離測試：只寫入測試資料庫，不影響正式資料。請選擇現場端 → A棟 → 2樓。</div></body>'));
      } else res.end(Buffer.from(await upstream.arrayBuffer()));
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
  });
  server.listen(4191,'127.0.0.1',()=>console.log('Field rehearsal ready: http://127.0.0.1:4191/phone-devices?customer_id='+customerId));
  return server;
}
