// Synthetic in-memory PGlite only. Reuse existing Gateway/RPC test adapters.
// No production credentials, external API or NAS requests.
import {pickupNotesServer} from './pickup-notes-fixture.mjs';
import {seedIndependent,createPickups} from './independent-work-fixture.mjs';
import {sample,saveLog} from './worklog-save-fixture.mjs';
import {extraIds} from './department-cross-system-fixture.mjs';

export async function pickupDefaultServer(){
  const fixture=await pickupNotesServer();
  const independent=await seedIndependent(fixture.db);
  await createPickups(fixture.db,independent.b,[1]);
  const legacy=await saveLog(fixture.db,{...sample(),customer_id:extraIds.emptyCustomer,
    department_id:null,project_name:'無科室原工作',work_type:'工程施工',maintenance_events:[]});
  await createPickups(fixture.db,legacy,[1]);
  await fixture.db.query("update projects set status='completed' where id in ($1,$2,$3)",
    [independent.a.project.id,fixture.seed.project.id,legacy.project.id]);
  return {...fixture,independent,legacy};
}
if(process.argv[1]?.endsWith('pickup-default-preview-server.mjs')){
  const {server}=await pickupDefaultServer();
  const port=Number(process.env.PICKUP_DEFAULT_PORT||4231);
  server.listen(port,'127.0.0.1',()=>console.log(`取貨預設工作內容隔離預覽：http://127.0.0.1:${port}/?page=transactions`));
}
