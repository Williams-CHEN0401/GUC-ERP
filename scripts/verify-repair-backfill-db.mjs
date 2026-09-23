import assert from 'node:assert/strict';
import {formSyncDatabase} from './form-sync-fixture.mjs';
import {sql,saveLog,sample,ids} from './worklog-save-fixture.mjs';
import {createPickups} from './independent-work-fixture.mjs';
import {attachQuotationList} from './repair-quotation-fixture.mjs';
import {snapshotQuery,buildBackfill} from './repair-visit-backfill.mjs';
const db=await formSyncDatabase();
try{
 const quotes=await attachQuotationList(db);
 await db.exec('create table if not exists project_costs(id uuid primary key,project_id uuid);create table if not exists site_devices(id uuid primary key,site_id uuid);');
 const base={...sample(),project_name:'電話查修',log_date:'2026-09-01'};
 const a=await saveLog(db,base),b=await saveLog(db,{...sample(),project_id:a.project.id,project_name:base.project_name}),c=await saveLog(db,{...sample(),project_id:a.project.id,project_name:base.project_name});
 await createPickups(db,b,[2,3]);await createPickups(db,a,[1]);
 await db.query('insert into site_assets(project_id) values($1)',[a.project.id]);
 await db.query('insert into project_workers(project_id,user_id,is_assignee,can_view,can_create_work_log,can_update_work_log,can_delete_work_log) values($1,$2,true,true,true,false,false),($1,$3,false,true,false,false,false)',[a.project.id,ids.scoped,ids.viewer]);
 await db.exec(await sql('20260923060629_repair_visit_quotation_rows.sql'));
 const snapshot=async()=>(await db.query(snapshotQuery([a.project.id]))).rows[0].snapshot;
 const backup=await snapshot(),plan={snapshot:backup,targetIds:[b.work_log.id,c.work_log.id],actorId:ids.actor,actor:'fixture-admin',operation:'repair-backfill-fixture'};
 const statement=buildBackfill(plan);
 await db.query('update site_work_logs set summary=$2 where id=$1',[b.work_log.id,'競爭修改']);
 await assert.rejects(db.exec(statement),/Snapshot changed/);await db.exec('rollback');
 assert.equal((await quotes()).total,1);
 const fresh={...plan,snapshot:await snapshot()};
 assert.throws(()=>buildBackfill({...fresh,targetIds:[a.work_log.id]}),/later repair/);
 assert.throws(()=>buildBackfill({...fresh,snapshot:{...fresh.snapshot,quotations:[{}]}}),/Dependency/);
 assert.throws(()=>buildBackfill({...fresh,snapshot:{...fresh.snapshot,assets:[{work_log_id:b.work_log.id}]}}),/Dependency/);
 // Force failure after a project has been created: entire transaction rolls back.
 const bad=buildBackfill(fresh).replace("update public.site_work_logs set site_id=v_site.id,project_id=v_new.id,title=v_name,updated_by=v_actor where id=v_log.id;","raise exception 'injected failure';");
 await assert.rejects(db.exec(bad),/injected failure/);await db.exec('rollback');
 assert.deepEqual(await snapshot(),fresh.snapshot);assert.equal((await quotes()).total,1);
 const result=await db.exec(buildBackfill(fresh)),mapping=result.at(-1).rows;
 assert.equal(mapping.length,2);assert.deepEqual(mapping.map(x=>x.name).sort(),['電話查修260915','電話查修260915-2']);
 assert.equal(mapping.reduce((s,x)=>s+x.pickups,0),2);assert.ok(mapping.every(x=>x.access_rows===2));
 assert.equal((await quotes({search:'電話查修'})).total,3);
 const reread=await db.exec(buildBackfill(fresh));assert.deepEqual(reread.at(-1).rows,mapping);
 assert.equal((await quotes()).total,3);
 assert.equal((await db.query('select count(*)::int n from site_work_logs')).rows[0].n,3);
 console.log('PASS: guarded exact backfill, stale snapshot rejection, dependency rejection, failure rollback, same-day suffix, quotation rows, pickup quantities/log links, inherited grants, unchanged history/source, idempotent replay');
}finally{await db.close();}
