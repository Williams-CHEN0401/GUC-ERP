import {pickupNotesServer} from './pickup-notes-fixture.mjs';
import {sql,ids,sample,saveLog} from './worklog-save-fixture.mjs';
export const flowMigration='20260924110845_work_log_content_sections_manual_repairs.sql';
export async function worklogFlowServer({historicalRepair=false}={}){
 const fixture=await pickupNotesServer(),{db,snapshot}=fixture;
 const historicalPayload=historicalRepair?{...sample(),project_name:'歷史自動維修品保留測試'}:null;
 const historical=historicalPayload?await saveLog(db,historicalPayload):null;
 const legacy=(await db.query('select * from site_work_logs order by id')).rows;
 await db.exec(await sql(flowMigration));
 return {...fixture,legacy,historical,historicalPayload};
}
if(process.argv[1]?.endsWith('worklog-flow-fixture.mjs')){
 const {server}=await worklogFlowServer(),port=Number(process.env.WORKLOG_FLOW_PORT||4224);
 server.listen(port,'127.0.0.1',()=>console.log('Isolated worklog flow: http://127.0.0.1:'+port+'/?page=worklogs'));
}
