// Isolated SQL only; never reads credentials or writes production.
import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
import {applyEditContext} from './worklog-edit-context-fixture.mjs';
import {applyMaintenanceDepartment,applyIndependentStatus,seedMeetingRooms} from './maintenance-department-fixture.mjs';
import {sql,ids} from './worklog-save-fixture.mjs';
export const pickupNotesMigration='20260924082425_pickup_row_notes.sql';
export const secondItem='20000000-0000-4000-8000-000000000094';
export async function pickupNotesServer(){
 const fixture=await createWorklogTestServer({formSync:true});
 const {db}=fixture;
 await applyEditContext(db);await applyMaintenanceDepartment(db);await applyIndependentStatus(db);
 const seed=await seedMeetingRooms(db);
 await db.query("insert into pickup_records(project_id,pickup_date,inventory_item_id,quantity) values($1,'2026-09-23',$2,1)",[seed.project.id,ids.item]);
 const oldRows=(await db.query('select * from pickup_records order by id')).rows;
 await db.exec(await sql(pickupNotesMigration));
 await db.query("insert into inventory_items(id,category_id,item_name,item_type,inventory_code,brand,model,opening_quantity) values($1,$2,'取貨測試網路線','電腦設備','T002','測試品牌','LAN',100)",[secondItem,ids.category]);
 return {...fixture,seed,oldRows};
}
if(process.argv[1]?.endsWith('pickup-notes-fixture.mjs')){
 const {server}=await pickupNotesServer(),port=Number(process.env.PICKUP_TEST_PORT||4223);
 server.listen(port,'127.0.0.1',()=>console.log('Isolated pickup notes: http://127.0.0.1:'+port+'/?page=transactions'));
}
