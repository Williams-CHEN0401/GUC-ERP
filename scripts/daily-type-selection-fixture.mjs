// Synthetic loopback fixture. Uses the existing Gateway, permissions and SQL
// writers. No production credentials, real records or NAS requests are loaded.
import {accessAppointmentsServer} from './erp-access-fixture.mjs';
import {sql,ids,sample,saveLog} from './worklog-save-fixture.mjs';
export async function dailyTypeSelectionServer(){
 const f=await accessAppointmentsServer();
 // Already deployed optional columns referenced by the current read projection.
 await f.db.exec(`alter table customers add column if not exists deleted_at timestamptz;
 alter table contract_service_types add column if not exists equipment_import_template jsonb;
 alter table projects add column if not exists contract_start_date date,add column if not exists contract_end_date date;
 alter table inventory_items add column if not exists meters_per_unit numeric;
 alter table pickup_records add column if not exists quantity_unit text,add column if not exists source_receipt_line_id uuid,add column if not exists work_assignment_id uuid;`);
 const audit=await sql('20261029084350_system_audit_coverage.sql');
 await f.db.exec(audit.slice(0,audit.indexOf('create or replace function audit_internal.enrich()'))+'commit;');
 // The fixture's REST adapter predates request-outcome writes. Persist only
 // the actual Gateway audit insert; all business writes still go through RPCs.
 const rest=f.gatewayContext.db;
 f.gatewayContext.db=async(path,init={})=>{
  if(init.method==='POST'&&path.split('?')[0]==='audit_logs'){
   const row=JSON.parse(init.body),keys=Object.keys(row);
   if(keys.some(k=>!['entity_type','entity_id','action','event_kind','outcome','source','actor','after_data'].includes(k)))throw Error('Unexpected test audit field');
   const result=await f.db.query('insert into audit_logs('+keys.join(',')+') values('+keys.map((_,i)=>'$'+(i+1)).join(',')+') returning *',keys.map(k=>k==='after_data'?JSON.stringify(row[k]):row[k]));
   return Response.json(result.rows,{status:201});
  }
  return rest(path,init);
 };
 const workforce=await sql('20261015153853_worklog_workforce_pending_costs.sql');
 // The work-log portion of the existing migration; accounting is unrelated.
 await f.db.exec(workforce.slice(0,workforce.indexOf('-- Wages are project-specific')));
 await f.db.exec(`grant select,update on work_log_save_requests to service_role;
 revoke all on function work_log_pending_lines_v1(site_work_logs),pending_work_log_items_v1(uuid,uuid,date,uuid),save_work_log_workforce_v1(uuid,jsonb) from public,anon,authenticated;
 grant execute on function work_log_pending_lines_v1(site_work_logs),pending_work_log_items_v1(uuid,uuid,date,uuid),save_work_log_workforce_v1(uuid,jsonb) to service_role;`);
 f.additionalRpcs.push('save_work_log_workforce_v1','pending_work_log_items_v1');
 await f.db.exec("insert into customer_categories(code,name) values('cleaning_team','清潔隊')");
 await f.db.query("update customers set name='鳥松清潔隊（隔離範例）',customer_code='TEST-CLEAN',customer_category='cleaning_team' where id=$1",[ids.customer]);
 const first=await saveLog(f.db,{...sample(),project_name:'攝影機、電話查修（隔離範例）',log_date:'2026-10-05',maintenance_events:sample().maintenance_events.map(e=>({...e,occurred_at:'2026-10-05'}))});
 const fallback=f.server.listeners('request')[0];f.server.removeAllListeners('request');
 f.server.on('request',(req,res)=>{
  if(req.url.split('?')[0]==='/api/public-config'){
   res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store'});
   res.end('globalThis.GUC_PUBLIC_CONFIG={localProduction:true,productionOrigin:location.origin};sessionStorage.setItem("GUC_ERP_ACCESS_TOKEN","isolated-fixture-only");');return;
  }
  if(req.url.split('?')[0]==='/'){
   const end=res.end.bind(res);res.end=(body,...args)=>end(typeof body==='string'?body.replace('隔離測試：國立高雄大學／應用數學系','隔離測試：鳥松清潔隊／攝影機、電話查修（合成範例）'):body,...args);
  }
  return fallback(req,res);
 });
 return {...f,first};
}
if(process.argv[1]?.endsWith('daily-type-selection-fixture.mjs')){
 const {server}=await dailyTypeSelectionServer(),port=Number(process.env.WORKLOG_TEST_PORT||4385);
 server.listen(port,'127.0.0.1',()=>console.log(`http://localhost:${port}/?page=worklogs — 隔離範例，可測試儲存；不影響正式資料。`));
}
