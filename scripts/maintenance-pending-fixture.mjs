// Synthetic, loopback-only acceptance environment. No production configuration is read.
import {dailyTypeSelectionServer} from './daily-type-selection-fixture.mjs';
import {sql,ids,sample} from './worklog-save-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';
import {randomUUID} from 'node:crypto';
export const pendingMigration='20261030102049_maintenance_pending_followups.sql';
export const pendingPayload=(changes={})=>({...sample(),request_id:randomUUID(),reporter_on_site:true,subcontractor_count:0,completed_content:null,pending_content:null,resolved_pending_items:[],resolved_maintenance_items:[],...changes});
export const pendingSave=(db,payload,actor=ids.actor)=>callAsService(db,'save_work_log_workforce_v1',[actor,JSON.stringify(payload)]);
export const pendingList=(db,project,date='2026-10-30',exclude=null,actor=ids.actor)=>callAsService(db,'pending_maintenance_items_v1',[actor,project,date,exclude]);
export async function maintenancePendingServer(){
 const f=await dailyTypeSelectionServer();
 await f.db.exec(await sql(pendingMigration));
 f.additionalRpcs.push('pending_maintenance_items_v1');
 const original=(await f.db.query('select * from maintenance_events where work_log_id=$1',[f.first.work_log.id])).rows[0];
 const seed=pendingPayload({id:f.first.work_log.id,row_version:f.first.work_log.row_version,project_id:f.first.work_log.project_id,project_name:f.first.work_log.title,log_date:'2026-10-05',maintenance_events:[{...sample().maintenance_events[0],id:original.id,row_version:original.row_version,occurred_at:'2026-10-05',notes:'原備註：大門側設備，保留一般說明。',pending_content:'攝影機待更換電源\n電話仍有雜音\n等待送回測試機',client_key:randomUUID()}]});
 f.seed=await pendingSave(f.db,seed);return f;
}
if(process.argv[1]?.endsWith('maintenance-pending-fixture.mjs')){
 const {server}=await maintenancePendingServer(),port=Number(process.env.WORKLOG_TEST_PORT||4390);
 server.listen(port,'127.0.0.1',()=>console.log(`http://localhost:${port}/?page=worklogs — 維修未完成事項隔離測試（合成資料，可儲存）`));
}
