// Navigation-only, synthetic fixtures. No credentials, database, NAS or writes.
import {createPreviewServer,fixture} from './customer-departments-preview-server.mjs';

const server=createPreviewServer(),original=server.listeners('request')[0],requests=[];
server.removeListener('request',original);
server.on('request',(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(req.method!=='GET'){json(403,{error:'導覽驗證僅使用模擬資料，不接受寫入。'});return;}
  if(url.pathname==='/__navigation_test'){json(200,{requests});return;}
  if(url.pathname==='/api/public-config'){
    res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store'});
    res.end('globalThis.GUC_PUBLIC_CONFIG={};sessionStorage.setItem("GUC_ERP_ACCESS_TOKEN","navigation-fixture-"+(["worklogs","projects","reports","customers"].includes(new URLSearchParams(location.search).get("test_role"))?new URLSearchParams(location.search).get("test_role"):"admin"));');return;
  }
  if(url.pathname==='/api/inventory'){
    const module=String(req.headers.authorization||'').replace('Bearer navigation-fixture-','');
    const user=['worklogs','projects','reports','customers'].includes(module)?{...fixture.current_user,role:'navigation-test',display_name:'僅 '+module+' 檢視（模擬）',permissions:[{module,can_view:true,can_create:false,can_update:false,can_delete:false}]}:fixture.current_user;
    const scope=url.searchParams.get('scope')||'session';requests.push({scope,role:module});
    json(200,{...fixture,scope,current_user:user});return;
  }
  original(req,res);
});
const port=Number(process.env.WORK_MANAGEMENT_TEST_PORT||4243);
server.listen(port,'127.0.0.1',()=>console.log(`Navigation fixture: http://127.0.0.1:${port}/?page=worklogs — synthetic browser data only`));
