// Synthetic PGlite + the real Gateway/RPC chain. No production configuration,
// credentials, database, NAS, mail, or external network calls are used.
import {pathToFileURL} from 'node:url';
import {pendingHistoryServer,pendingPayload,pendingSave,historyPayload} from './pending-history-fixture.mjs';
import {ids,sql,sample,definition} from './worklog-save-fixture.mjs';
import {callAsService,extraIds} from './department-cross-system-fixture.mjs';

export {ids,extraIds,pendingPayload,pendingSave,historyPayload};
export const contextMigration='20261103000617_work_log_pending_context_edits.sql';
export const optionalDepartmentMigration='20261103000619_optional_project_department.sql';
export async function createProject(db,changes={}){
 const p={id:null,row_version:null,name:'未指定科室工作（合成測試）',customer_id:ids.customer,
  project_type:'repair',status:'in_progress',description:'合成驗收資料',estimated_cost:null,note:null,
  worker_user_ids:[ids.actor],actor:'fixture-admin',project_date:'2026-11-03',construction_category:null,
  department_id:null,construction_category_provided:true,...changes};
 return callAsService(db,'upsert_erp_project_department_v1',Object.values(p));
}
export async function pendingContextServer({applyMigration=true,showcase=true}={}){
 const f=await pendingHistoryServer({legacy:false,showcase});
 try{
  // The current form sends contract fields even when blank. Execute its real
  // released wrapper as well, rather than stubbing or skipping that API path.
  const contract=await sql('20261025062408_construction_contract_monitoring.sql');
  for(const name of ['set_project_contract_dates_v1','upsert_erp_project_contract_v1'])await f.db.exec(definition(contract,name));
  await f.db.exec('revoke all on function set_project_contract_dates_v1(uuid,uuid,integer,date,date),upsert_erp_project_contract_v1(uuid,jsonb) from public,anon,authenticated;grant execute on function set_project_contract_dates_v1(uuid,uuid,integer,date,date),upsert_erp_project_contract_v1(uuid,jsonb) to service_role;');
  f.additionalRpcs.push('upsert_erp_project_contract_v1');
  if(applyMigration){await f.db.exec(await sql(contextMigration));await f.db.exec(await sql(optionalDepartmentMigration));}
  // An unlinked sibling proves a single-log move never changes the other visit.
  const sibling=await pendingSave(f.db,pendingPayload({project_id:f.first.work_log.project_id,
   project_name:f.first.work_log.title,log_date:'2026-10-06',maintenance_events:sample().maintenance_events.map(e=>({...e,
    occurred_at:'2026-10-06',inventory_category_id:null,inventory_item_id:null,pending_content:'另一筆日誌的未完成事項（合成）'}))}));
  const destination=await createProject(f.db,{name:'更改科室後工作（合成測試）',department_id:extraIds.secondDepartment});
  return {...f,contextCases:{repairSourceId:f.first.work_log.id,siblingId:sibling.work_log.id,destination:destination.project}};
 }catch(error){f.server.close();await f.db.close();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const port=Number(process.env.WORKLOG_TEST_PORT||4518);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('Choose a valid isolated preview port');
 const f=await pendingContextServer();
 f.server.on('error',async error=>{console.error('Isolated preview failed:',error.code||'SERVER_ERROR');await f.db.close();process.exitCode=1;});
 f.server.listen(port,'127.0.0.1',()=>console.log(`http://localhost:${port}/?page=worklogs — 未完成事項／科室選填隔離測試（全部為合成資料，可儲存，重啟重置）`));
 const close=()=>f.server.close(async()=>{await f.db.close();process.exit(0);});
 process.once('SIGTERM',close);process.once('SIGINT',close);
}
