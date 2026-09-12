// Isolated PostgreSQL-compatible PGlite fixture; never connects to Supabase.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
try{
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table projects(id uuid primary key, status text, project_type text default 'construction', name text, created_at timestamptz default now(), updated_at timestamptz default now(), updated_by text, completed_on date);
    create table audit_logs(entity_type text,entity_id uuid,action text,before_data jsonb,after_data jsonb,created_at timestamptz);
    create table site_work_logs(id uuid primary key,project_id uuid references projects,work_type text,status text,updated_by text);
    alter table projects enable row level security;
    grant select,insert,update on projects,site_work_logs to service_role;
    insert into projects(id,status,created_at) values ('${id(1)}','completed','2026-08-01Z'),('${id(2)}','completed','2026-08-01Z'),('${id(3)}','in_progress','2026-08-01Z');
    insert into audit_logs values
      ('project','${id(1)}','update','{"status":"in_progress"}','{"status":"completed"}','2026-09-01T16:10:00Z'),
      ('project','${id(1)}','update','{"status":"completed"}','{"status":"in_progress"}','2026-09-04T00:00:00Z'),
      ('project','${id(1)}','update','{"status":"in_progress"}','{"status":"completed"}','2026-09-06T16:10:00Z'),
      ('project','${id(1)}','update','{"status":"completed"}','{"status":"completed"}','2026-09-11T00:00:00Z');`);
  // Install the actual repository's bidirectional project/work-log synchronization.
  const sync=readFileSync(new URL('../supabase/migrations/20260902110557_sync_project_type_status_with_work_logs.sql',import.meta.url),'utf8');
  await db.exec(sync.slice(sync.indexOf('create or replace function public.sync_project_fields'),sync.indexOf('create or replace function public.upsert_erp_project')));
  await db.exec(readFileSync(new URL('../supabase/migrations/20260912053403_track_project_completion_date.sql',import.meta.url),'utf8'));
  const row=async n=>(await db.query('select completed_on::text as day,created_at::text as created from projects where id=$1',[id(n)])).rows[0];
  assert.equal((await row(1)).day,'2026-09-07');
  assert.equal((await row(2)).day,null,'no audit history must not invent a completion date');
  const today=(await db.query("select (statement_timestamp() at time zone 'Asia/Taipei')::date::text as day")).rows[0].day;
  await db.exec(`set role service_role; update projects set name='later edit',completed_on='2099-01-01' where id='${id(1)}';`);
  assert.equal((await row(1)).day,'2026-09-07','unrelated edits cannot move completion');
  await db.exec(`update projects set status='in_progress' where id='${id(1)}';`);
  assert.equal((await row(1)).day,null);
  await db.exec(`update projects set status='completed' where id='${id(1)}';`);
  assert.equal((await row(1)).day,today);
  await db.exec(`insert into projects(id,status) values('${id(4)}','completed');`);
  assert.equal((await row(4)).day,today,'created completed is marked today');
  await db.exec(`insert into site_work_logs(id,project_id,work_type,status) values('${id(10)}','${id(3)}','工程施工','completed');`);
  assert.equal((await row(3)).day,today,'work-log completion records project date');
  await db.exec(`update site_work_logs set status='in_progress' where id='${id(10)}';`);
  assert.equal((await row(3)).day,null,'work-log reopening clears end date');
  await db.exec(`update site_work_logs set status='completed' where id='${id(10)}';`);
  assert.equal((await row(3)).day,today);
  await db.exec('reset role');
  for(const role of ['anon','authenticated']){
    const grants=(await db.query(`select has_function_privilege('${role}','public.track_project_completion_date_v1()','execute') as allowed`)).rows[0];
    assert.equal(grants.allowed,false);
  }
  assert.equal((await db.query("select relrowsecurity from pg_class where oid='projects'::regclass")).rows[0].relrowsecurity,true);
  console.log('PASS: historical backfill, unknown history, date immutability, create/complete/reopen, work-log synchronization, RLS and function grants. Local database only.');
}finally{await db.close();}
