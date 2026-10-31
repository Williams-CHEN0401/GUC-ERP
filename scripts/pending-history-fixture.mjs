// Synthetic in-memory PGlite only. No .env, Docker, network database, or production data.
import {pathToFileURL} from 'node:url';
import {workflowIdentityServer} from './workflow-identity-fixture.mjs';
import {pendingPayload,pendingSave} from './maintenance-pending-fixture.mjs';
import {callAsService,extraIds} from './department-cross-system-fixture.mjs';
import {ids,sql} from './worklog-save-fixture.mjs';

export {ids,pendingPayload,pendingSave};
export const pendingHistoryMigration='20261031125641_work_log_pending_history.sql';
export const historyText='教官室辦公室線路在弱電箱還沒拉到機櫃';
export const otherPendingText='其他線路仍待整理（合成未完成事項）';
export const historyDisplay=(text=historyText,date='2026-10-28')=>`${text}(${date.slice(5)}已完成)`;
export const pendingList=(db,project,date='2026-10-28',exclude=null,actor=ids.actor)=>callAsService(db,'pending_work_log_items_v1',[actor,project,date,exclude]);
export const historyPayload=(changes={})=>pendingPayload({work_type:'工程施工',project_name:'線路接續作業（合成測試）',log_date:'2026-10-16',summary:'合成工作日誌履歷驗收',completed_content:'10/16原有完成事項（合成）',pending_content:`${historyText}\n${otherPendingText}`,maintenance_events:[],...changes});

async function seedLegacy(db,{name,removeTargetLine=false}){
 const source=await pendingSave(db,historyPayload({project_name:name,pending_content:historyText}));
 const item=(await pendingList(db,source.project.id)).items.find(item=>item.pending_text===historyText);
 if(!item)throw new Error('Synthetic legacy source was not offered as pending');
 const target=await pendingSave(db,historyPayload({project_id:source.project.id,project_name:source.project.name,log_date:'2026-10-28',completed_content:'10/28原有完成事項（合成）',pending_content:'',resolved_pending_items:[item]}));
 if(removeTargetLine){
  // Simulates a later user edit through the old writer; requests/audit retain the earlier resolution.
  await pendingSave(db,historyPayload({id:target.work_log.id,row_version:target.work_log.row_version,project_id:source.project.id,project_name:source.project.name,log_date:'2026-10-28',completed_content:'10/28原有完成事項（合成；已手動移除結清行）',pending_content:''}));
 }
 const before=(await db.query('select * from site_work_logs where id=any($1::uuid[]) order by id',[[source.work_log.id,target.work_log.id]])).rows;
 return {sourceId:source.work_log.id,targetId:target.work_log.id,projectId:source.project.id,projectName:source.project.name,before,removeTargetLine};
}

export async function pendingHistoryServer({applyMigration=true,legacy=true,showcase=false}={}){
 const f=await workflowIdentityServer();
 try{
  await f.db.query('update customers set name=$1 where id=$2',['工作日誌履歷驗收客戶（合成測試）',ids.customer]);
  await f.db.query('update customer_departments set name=$1 where id=$2',['履歷驗收科室（合成測試）',ids.department]);
  await f.db.query('update customers set name=$1,customer_category=$2 where id=$3',['同名工作隔離客戶（合成測試）','cleaning_team',extraIds.otherCustomer]);
  const legacyCase=legacy?await seedLegacy(f.db,{name:'可回填舊履歷（合成測試）'}):null;
  const ambiguousCase=legacy?await seedLegacy(f.db,{name:'手刪結清行需略過（合成測試）',removeTargetLine:true}):null;
  if(applyMigration){
   const migration=await sql(pendingHistoryMigration);
   if(migration.trim().length<100)throw new Error('Pending-history migration is not ready');
   await f.db.exec(migration);
  }
  const source=await pendingSave(f.db,historyPayload());
  const sameName=await pendingSave(f.db,historyPayload({customer_id:extraIds.otherCustomer,department_id:extraIds.otherDepartment,pending_content:historyText,completed_content:'不同客戶原有完成事項（合成）'}));
  if(source.project.name!==sameName.project.name||source.project.id===sameName.project.id)throw new Error('Synthetic same-name isolation precondition failed');
  const fallback=f.server.listeners('request')[0];f.server.removeAllListeners('request');
  f.server.on('request',(req,res)=>{
   if(req.url.split('?')[0]==='/'){
    const end=res.end.bind(res);res.end=(body,...args)=>end(typeof body==='string'?body.replace('隔離測試：鳥松清潔隊／攝影機、電話查修（合成範例）','工作日誌未完成履歷驗收｜全部客戶、工作與日誌均為合成資料'):body,...args);
   }
   return fallback(req,res);
  });
  const cases={fresh:{sourceId:source.work_log.id,projectId:source.project.id,projectName:source.project.name},sameName:{sourceId:sameName.work_log.id,projectId:sameName.project.id,projectName:sameName.project.name,customerId:extraIds.otherCustomer,departmentId:extraIds.otherDepartment},legacy:legacyCase,ambiguous:ambiguousCase};
  if(showcase){
   const demoSource=await pendingSave(f.db,historyPayload({project_name:'已結清展示（合成測試）'}));
   const item=(await pendingList(f.db,demoSource.project.id)).items.find(item=>item.pending_text===historyText);
   const demoTarget=await pendingSave(f.db,historyPayload({project_id:demoSource.project.id,project_name:demoSource.project.name,log_date:'2026-10-28',completed_content:'10/28原有完成事項（合成）',pending_content:'10/28新增待辦（合成）',resolved_pending_items:[item]}));
   cases.showcase={sourceId:demoSource.work_log.id,targetId:demoTarget.work_log.id,projectId:demoSource.project.id,projectName:demoSource.project.name};
  }
  // The real construction RPC only accepts classified construction projects or projects with plans.
  // These synthetic construction cases are explicitly small purchases with no plans; do not fake an API response.
  const projectIds=Object.values(cases).filter(Boolean).map(item=>item.projectId);
  await f.db.query("update projects set construction_category='small_purchase' where id=any($1::uuid[]) and project_type='construction'",[projectIds]);
  return {...f,source,sameName,cases};
 }catch(error){f.server.close();await f.db.close();throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const port=Number(process.env.WORKLOG_TEST_PORT||4498);
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Choose an explicit valid isolated preview port');
 const f=await pendingHistoryServer({showcase:true});
 f.server.on('error',async error=>{console.error(`Isolated preview failed: ${error.code||'SERVER_ERROR'}`);await f.db.close();process.exitCode=1;});
 f.server.listen(port,'127.0.0.1',()=>console.log(`http://127.0.0.1:${f.server.address().port}/?page=worklogs — 工作日誌未完成履歷（合成資料，重啟重置）`));
 const close=()=>f.server.close(async()=>{await f.db.close();process.exit(0);});
 process.once('SIGTERM',close);process.once('SIGINT',close);
}
