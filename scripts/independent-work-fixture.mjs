// No network/production credentials: real SQL entrypoints, synthetic isolated rows.
import {dailyTypeDatabase} from './daily-work-type-fixture.mjs';
import {sql,definition,ids,saveLog,sample} from './worklog-save-fixture.mjs';
import {randomUUID} from 'node:crypto';
export const independentMigration='20260923003902_independent_work_log_pickup_project.sql';
export async function independentDatabase({fixed=true}={}){
 const db=await dailyTypeDatabase();
 await db.exec(`
 alter table pickup_records add pickup_date date,add inventory_item_id uuid references inventory_items,
 add quantity numeric,add source text,add updated_by text,add row_version integer default 1,
 add created_by_user_id uuid,add created_by_username text,add request_id uuid,add request_row integer,
 add work_assignment_id uuid;
 create unique index fixture_pickup_request on pickup_records(request_id,request_row);
 create trigger pickup_version before update on pickup_records for each row execute function test_version();
 create trigger pickup_audit after insert or update on pickup_records for each row execute function audit_internal.capture_links();
 `);
 const legacy=await sql('20260828000100_work_log_workers_pickups_and_nas_folders.sql');
 for(const name of ['update_pickup_record','create_pickup_records_batch_v2'])await db.exec(definition(legacy,name));
 const signatures=(await db.query("select oid::regprocedure::text signature from pg_proc where pronamespace='public'::regnamespace and proname in ('update_pickup_record','create_pickup_records_batch_v2')")).rows;
 for(const {signature} of signatures)await db.exec(`revoke all on function ${signature} from public,anon,authenticated;grant execute on function ${signature} to service_role`);
 await db.exec(await sql('20260916232954_work_assignments_dashboard.sql'));
 await db.exec(`alter table audit_logs add constraint audit_logs_action_check check(action in
 ('insert','update','delete','import','export','UPDATE_CREDENTIAL','IMPORT_DEVICES',
 'BATCH_UPDATE','BATCH_DELETE','CREATE_REPAIR_ITEM','UPDATE_REPAIR_ITEM',
 'DELETE_REPAIR_ITEM','LOGIN','LOGOUT'))`);
 if(fixed)await db.exec(await sql(independentMigration));
 return db;
}
export async function createPickups(db,log,quantities=[2],request=randomUUID()){
 await db.exec('set role service_role');
 try{return(await db.query("select create_pickup_records_batch_v2($1::jsonb,$2,'fixture-admin',$3,$4,'fixture-admin') n",
 [JSON.stringify(quantities.map((quantity,i)=>({pickup_date:'2026-09-'+String(20+i),project_id:log.project.id,inventory_item_id:ids.item,quantity}))),ids.actor,log.work_log.id,request])).rows[0].n;}
 finally{await db.exec('reset role');}
}
export async function updatePickup(db,row,projectId=row.project_id,overrides={}){
 const p={...row,project_id:projectId,...overrides};
 await db.exec('set role service_role');
 try{return(await db.query("select to_jsonb(update_pickup_record($1,$2,$3,$4,$5,$6,'fixture-admin')) data",
 [p.id,p.row_version,p.pickup_date,p.project_id,p.inventory_item_id,p.quantity])).rows[0].data;}
 finally{await db.exec('reset role');}
}
export async function seedIndependent(db){
 const base={...sample(),log_date:'2026-09-23',maintenance_events:[],work_type:'工程施工'};
 const a=await saveLog(db,{...base,project_name:'原工作 A'}),
 b=await saveLog(db,{...base,request_id:randomUUID(),project_name:'新工作 B',work_type:'場勘'}),
 sibling=await saveLog(db,{...base,request_id:randomUUID(),project_id:a.project.id,project_name:a.project.name,work_type:'文書作業'});
 await createPickups(db,a,[2,3]);await createPickups(db,sibling,[1]);
 return{a,b,sibling,base};
}
