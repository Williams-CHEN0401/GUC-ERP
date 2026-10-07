// Real Gateway + SQL, synthetic identities, loopback and in-memory DB only.
import {accessAppointmentsServer} from './erp-access-fixture.mjs';
import {sql,ids} from './worklog-save-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';
export const assignedDateMigration='20261006235526_customer_appointment_assigned_date.sql';
export async function assignedDateServer(){
 const f=await accessAppointmentsServer();
 // Seed legacy data BEFORE adding the new column to verify upgrade compatibility.
 const legacy=await callAsService(f.db,'upsert_customer_appointment_v2',[null,null,ids.customer,ids.department,'repair','2026-10-12','','','舊預約（隔離測試）',ids.actor,'pending','',3,ids.actor,'fixture-admin']);
 await f.db.query("update work_assignments set created_at='2026-10-01T17:30:00Z' where id=$1",[legacy.id]);
 await f.db.exec(await sql(assignedDateMigration));
 f.additionalRpcs.push('upsert_customer_appointment_v3');
 const read=f.gatewayContext.db;
 f.gatewayContext.db=async(path,init={})=>{
  const response=await read(path,init);
  if((!init.method||init.method==='GET')&&path.startsWith('work_assignments?')){
   const rows=await response.json();
   return Response.json(rows.map(row=>({...row,assigned_date:row.assigned_date?.slice(0,10)||null})),{status:response.status});
  }
  return response;
 };
 return {...f,legacyId:legacy.id};
}
if(process.argv[1]?.endsWith('appointment-assigned-date-fixture.mjs')){
 const f=await assignedDateServer(),port=Number(process.env.APPOINTMENT_DATE_TEST_PORT||4246);
 f.server.listen(port,'127.0.0.1',()=>console.log(`http://127.0.0.1:${port}/?page=appointments — 指派日期：隔離 SQL，不寫入正式資料庫／NAS`));
}
