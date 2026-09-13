// Shared ERP/quotation contract integration; isolated PGlite only, no network.
// QUOTATION_FIXTURE_MODULE points at the companion quotation repository's tests/database-fixture.mjs.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {databaseFixture,actor,outsider,customer}=await import(process.env.QUOTATION_FIXTURE_MODULE);
const db=await databaseFixture({sync:true});
const call=async(name,args)=>(await db.query('select '+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args)).rows[0].result;
const args=(id=null,version=null,category='small_purchase',type='construction',user='williams')=>[id,version,'分類測試',customer,type,'in_progress',null,null,null,[actor],user,'2026-09-12',category];
try{
 await db.exec(readFileSync(new URL('../supabase/migrations/20260912152945_project_construction_category.sql',import.meta.url),'utf8'));
 const first=await call('upsert_erp_project_with_workers_v4',args());
 assert.equal(first.project.construction_category,'small_purchase');
 const second=await call('upsert_erp_project_with_workers_v4',args(first.project.id,first.project.row_version,'tender'));
 assert.equal(second.project.construction_category,'tender');
 assert.ok(second.project.row_version>first.project.row_version);
 await assert.rejects(call('upsert_erp_project_with_workers_v4',args(first.project.id,first.project.row_version)),/版本|更新|修改/);
 await assert.rejects(call('upsert_erp_project_with_workers_v4',args(null,null,'bad')),/分類/);
 await assert.rejects(call('upsert_erp_project_with_workers_v4',args(null,null,'tender','repair')),/分類/);
 await db.query("update role_permissions set can_create=false,can_update=false where role_code='operator'");
 await assert.rejects(call('upsert_erp_project_with_workers_v4',args(null,null,'small_purchase','construction','joyce')),/權限/);
 const old=await call('upsert_erp_project_with_workers_v3',args(second.project.id,second.project.row_version).slice(0,-1));
 assert.equal(old.project.construction_category,'tender','old clients do not erase the classification');
 const cleared=await call('upsert_erp_project_with_workers_v4',args(old.project.id,old.project.row_version,null,'repair'));
 assert.equal(cleared.project.construction_category,null);
 await db.exec('set role anon');
 await assert.rejects(call('upsert_erp_project_with_workers_v4',args()),/permission/);
 await db.exec('reset role');
 assert.equal((await db.query("select count(*)::int n from projects where name='分類測試'")).rows[0].n,1);
 console.log('PASS: create/update category, null, validation, stale versions, permission denial, v3 compatibility, transactional rows and anonymous denial.');
}finally{await db.close();}
