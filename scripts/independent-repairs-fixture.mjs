// Synthetic local records only. No credentials or production connections.
import {worklogFlowServer} from './worklog-flow-fixture.mjs';
import {sql,ids} from './worklog-save-fixture.mjs';
import {extraIds} from './department-cross-system-fixture.mjs';
export const independentRepairsMigration='20260929150841_independent_worklog_repair_edits.sql';
export async function independentRepairsServer({fixed=true}={}){
  const fixture=await worklogFlowServer({historicalRepair:true});
  await fixture.db.query('insert into customer_contract_services(customer_id,service_type_id) values($1,$2)',[extraIds.otherCustomer,ids.service]);
  if(fixed)await fixture.db.exec(await sql(independentRepairsMigration));
  return fixture;
}
if(process.argv[1]?.endsWith('independent-repairs-fixture.mjs')){
  const {server}=await independentRepairsServer();
  const port=Number(process.env.INDEPENDENT_REPAIRS_PORT||4232);
  server.listen(port,'127.0.0.1',()=>console.log('Isolated independent repair edits: http://127.0.0.1:'+port+'/?page=worklogs'));
}
