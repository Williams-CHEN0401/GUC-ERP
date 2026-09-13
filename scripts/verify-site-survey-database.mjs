// Isolated PostgreSQL verification. QUOTATION_FIXTURE_DIR must point to a test
// checkout of GUC-Quotation e617391 with its PGlite dependency installed.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const fixtureRoot=process.env.QUOTATION_FIXTURE_DIR;
if(!fixtureRoot)throw Error('Set QUOTATION_FIXTURE_DIR to the isolated quotation test checkout.');
const {databaseFixture,actor,customer,project}=await import(pathToFileURL(path.resolve(fixtureRoot,'tests/database-fixture.mjs')));
const sql=name=>readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
function definition(source,name){
  const start=source.search(new RegExp(`create (?:or replace )?function public\\.${name}\\b`,'i'));
  assert(start>=0,name);
  const tail=source.slice(start),body=/\bas\s+(\$[a-z_]*\$)/i.exec(tail);
  assert(body,name);
  const end=tail.indexOf(body[1],body.index+body[0].length);
  return tail.slice(0,tail.indexOf(';',end+body[1].length)+1);
}
const db=await databaseFixture({sync:true});
try{
  // Expand the companion fixture with the columns used by the actual ERP RPCs.
  // The site provisioning adapter is fixture-only; numbering, permissions,
  // optimistic locking and both type-sync triggers below use repository SQL.
  await db.exec(`
    create table sites(id uuid primary key default gen_random_uuid(),project_id uuid unique references projects);
    alter table project_workers add can_create_work_log boolean default false,add can_update_work_log boolean default false,add can_delete_work_log boolean default false;
    alter table site_work_logs alter id set default gen_random_uuid();
    alter table site_work_logs alter status set default 'in_progress';
    alter table site_work_logs add site_id uuid references sites,add log_date date,add reporter_user_id uuid references app_users,add title text,add summary text,add source text,add row_version integer default 1,add updated_at timestamptz default now(),add time_period text,add deleted_at timestamptz;
    create table site_work_log_workers(work_log_id uuid references site_work_logs,user_id uuid references app_users,primary key(work_log_id,user_id));
    create trigger logs_version before update on site_work_logs for each row execute function increment_row_version();
    alter table projects add constraint projects_project_type_check check(project_type in ('construction','repair','maintenance','delivery'));
    alter table site_work_logs add constraint site_work_logs_work_type_check check(work_type in ('工程施工','維修紀錄','維護保養','送貨'));
    create function ensure_project_site_v1(p_project_id uuid,p_actor text) returns sites language plpgsql as $$
      declare result public.sites; begin
        insert into public.sites(project_id) values(p_project_id) on conflict(project_id) do nothing;
        select * into result from public.sites where project_id=p_project_id;return result;
      end;$$;
    insert into app_roles(code,project_scoped) values('viewer',false),('scoped',true);
    insert into app_users values('10000000-0000-4000-8000-000000000005','viewer','檢視者','viewer',true),('10000000-0000-4000-8000-000000000006','scoped','限定專案','scoped',true);
    insert into role_permissions values('scoped','worklogs',true,true,true,false);
  `);
  const permissions=sql('20260908060047_role_permissions_project_scope.sql');
  for(const name of ['has_project_permission_v1','assert_work_log_access_v1'])await db.exec(definition(permissions,name));
  await db.exec(definition(sql('20260828000200_standalone_work_logs_contracts_accounts_nas.sql'),'set_site_work_log_project_id_v1'));
  await db.exec('create trigger site_work_logs_project_link_v1 before insert or update of site_id on site_work_logs for each row execute function set_site_work_log_project_id_v1();');
  await db.exec(sql('20260911095725_clerical_work_log_type.sql'));
  await db.exec(sql('20260912152945_project_construction_category.sql'));
  await db.exec(`
    create trigger projects_sync_work_logs_v1 after insert or update of project_type,status on projects for each row execute function sync_project_fields_to_work_logs_v1();
    create trigger work_logs_sync_project_v1 after insert or update of project_id,work_type,status on site_work_logs for each row execute function sync_work_log_fields_to_project_v1();
    alter table projects enable row level security;alter table site_work_logs enable row level security;
    revoke all on projects,site_work_logs from public,anon,authenticated;
  `);
  const migration=sql('20260913140234_site_survey_work_type.sql');
  const names=[...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/gi)].map(m=>m[1]);
  assert.equal(names.length,8);
  const functions=await db.query(`select oid::regprocedure::text signature from pg_proc where proname=any($1)`,[names]);
  for(const {signature} of functions.rows)await db.exec(`revoke all on function ${signature} from public,anon,authenticated;grant execute on function ${signature} to service_role;`);
  const security=async()=>({
    functions:(await db.query('select proname,proacl::text,prosecdef,proconfig from pg_proc where proname=any($1) order by proname',[names])).rows,
    tables:(await db.query("select relname,relacl::text,relrowsecurity from pg_class where relname in ('projects','site_work_logs') order by relname")).rows,
    policies:(await db.query('select * from pg_policies order by schemaname,tablename,policyname')).rows,
    quotable:(await db.query('select quotable_work_types_v1() types')).rows
  });
  const projectUpsert=async(type='site_survey',id=null,version=null,who='williams')=>(await db.query(`select upsert_erp_project_with_workers_v4($1,$2,$3,$4,$5,'in_progress','',null,'','{}',$6,'2026-09-13',null) result`,[id,version,id?'場勘修改':'場勘 '+type,customer,type,who])).rows[0].result;
  await assert.rejects(projectUpsert(),/類型/);
  const before=await security(),dataBefore=(await db.query('select to_jsonb(p) data from projects p order by id')).rows;
  await db.exec(migration);
  assert.deepEqual(await security(),before,'Migration must preserve ACL, RLS and quotation type rules');
  assert.deepEqual((await db.query('select to_jsonb(p) data from projects p order by id')).rows,dataBefore,'No data rewrite');
  console.log('PASS: baseline rejects survey; migration preserves data, grants, RLS and quotation rules');
  const created=(await projectUpsert()).project;
  assert.equal(created.project_type,'site_survey');assert.match(created.project_code,/^\d{7}$/);
  const logUpsert=async({projectId=created.id,id=null,version=null,type='場勘',who=actor,v=3}={})=>{
    const args=[id,version,projectId,customer,projectId?created.name:'場勘自建 '+v,'2026-09-13',type,'隔離測試'];
    if(v===3)args.push('上午','in_progress');
    args.push([],who,'williams');
    return (await db.query(`select upsert_customer_project_work_log_v${v}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
  };
  const first=(await logUpsert()).work_log,second=(await logUpsert()).work_log;
  assert.equal(first.work_type,'場勘');assert.equal(second.work_type,'場勘');
  const row=async(table,id)=>(await db.query(`select * from ${table} where id=$1`,[id])).rows[0];
  await projectUpsert('delivery',created.id,(await row('projects',created.id)).row_version);
  assert.equal((await row('site_work_logs',first.id)).work_type,'送貨');
  await logUpsert({id:first.id,version:(await row('site_work_logs',first.id)).row_version});
  assert.equal((await row('projects',created.id)).project_type,'site_survey');
  assert.equal((await row('site_work_logs',second.id)).work_type,'場勘');
  await assert.rejects(logUpsert({id:first.id,version:1}),/其他使用者|版本/);
  await assert.rejects(projectUpsert('site_survey',created.id,1),/其他使用者|版本/);
  for(const v of [2,3]){
    const log=(await logUpsert({projectId:null,v})).work_log;
    assert.equal((await row('projects',log.project_id)).project_type,'site_survey');
  }
  for(const [type,label] of [['construction','工程施工'],['repair','維修紀錄'],['maintenance','維護保養'],['delivery','送貨'],['clerical','文書作業'],['site_survey','場勘']]){
    await projectUpsert(type,created.id,(await row('projects',created.id)).row_version);
    assert.equal((await row('site_work_logs',first.id)).work_type,label);
    await logUpsert({id:first.id,version:(await row('site_work_logs',first.id)).row_version,type:label});
    assert.equal((await row('projects',created.id)).project_type,type);
  }
  await db.query("update projects set status='completed' where id=$1",[created.id]);
  assert.equal((await row('site_work_logs',first.id)).status,'completed');
  await logUpsert({id:first.id,version:(await row('site_work_logs',first.id)).row_version});
  assert.equal((await row('projects',created.id)).status,'in_progress');
  console.log('PASS: project v4 and work-log v2/v3 create/edit, numbering, six types, sibling/status sync, stale versions');
  await assert.rejects(projectUpsert('unknown'),/類型/);
  await assert.rejects(logUpsert({type:'不存在'}),/類型/);
  await assert.rejects(projectUpsert('site_survey',null,null,'viewer'),/權限/);
  for(const who of [null,'10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000006'])await assert.rejects(logUpsert({who}),/權限/);
  await db.exec('set role anon');
  await assert.rejects(projectUpsert(),/permission denied/);
  await assert.rejects(logUpsert(),/permission denied/);
  await db.exec('reset role');
  await assert.rejects(db.query("update projects set project_type='unknown' where id=$1",[project]),/check constraint/);
  await assert.rejects(db.query("update site_work_logs set work_type='不存在' where id=$1",[first.id]),/check constraint/);
  console.log('PASS: unknown types, viewer, anonymous and unassigned scoped user denied');
}finally{await db.close();}
