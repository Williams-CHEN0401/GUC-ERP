import {createServer} from 'node:http';
import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
import {sql,sample,saveLog} from './worklog-save-fixture.mjs';
import {attachQuotationList} from './repair-quotation-fixture.mjs';
const {server,db,calls,failures}=await createWorklogTestServer({formSync:true});
const list=await attachQuotationList(db);
await db.exec(await sql('20260923060629_repair_visit_quotation_rows.sql'));
await saveLog(db,{...sample(),project_name:'電話查修',log_date:'2026-09-01',maintenance_events:[]});
// List-only diagnostic: rows are the same quotation view/RPC consumed by the
// production quote app. No fake quotations, money or statuses are inserted.
const json=(res,value)=>{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const report=createServer(async(req,res)=>{
 try{
  if(req.method!=='GET'){res.writeHead(405);return res.end();}
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/rows')return json(res,await list(Object.fromEntries(url.searchParams)));
  if(url.pathname==='/evidence')return json(res,{saves:calls.filter(x=>x.name==='upsert_customer_project_work_log_department_v1').map(x=>({log:x.result.work_log.id,project:x.result.project.id,name:x.result.project.name})),failures});
  const result=await list(),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  res.end('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>報價管理資料核對（隔離）</title><style>body{font:18px sans-serif;margin:40px;color:#243d36}table{border-collapse:collapse;width:100%}th,td{padding:16px;border-bottom:1px solid #ddd;text-align:left}</style><h1>報價管理資料核對（隔離測試）</h1><p>使用正式程式的報價清單查詢與 ERP 共用同一隔離資料庫。這是資料核對頁，不是正式報價 UI。</p><a href="/">重新讀取</a><table><tr><th>工作內容</th><th>類型</th><th>報價狀態</th></tr>'+result.records.map(r=>'<tr><td>'+esc(r.work_content_name)+'</td><td>'+esc(r.work_content_type)+'</td><td>'+esc(r.quote_status)+'</td></tr>').join('')+'</table></html>');
 }catch(e){res.writeHead(500);res.end(e.message);}
});
server.listen(4217,'127.0.0.1',()=>console.log('ERP isolated http://127.0.0.1:4217/?page=worklogs'));
report.listen(4218,'127.0.0.1',()=>console.log('Quote list readback http://127.0.0.1:4218/'));
