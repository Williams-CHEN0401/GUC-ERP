import {maintenancePendingServer} from './maintenance-pending-fixture.mjs';
import {sql} from './worklog-save-fixture.mjs';
export const identityMigration='20261031075228_worklog_explicit_project_identity.sql';
export async function workflowIdentityServer(){
 const f=await maintenancePendingServer();
 await f.db.exec(await sql(identityMigration));
 return f;
}
if(process.argv[1]?.endsWith('workflow-identity-fixture.mjs')){
 const {server}=await workflowIdentityServer(),port=Number(process.env.WORKLOG_TEST_PORT||4396);
 server.listen(port,'127.0.0.1',()=>console.log(`http://localhost:${port}/?page=worklogs — 工作流程整合隔離測試（合成資料）`));
}
