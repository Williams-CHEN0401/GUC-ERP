// Isolated PostgreSQL, synthetic rows only. PGLITE_MODULE points at an installed PGlite package.
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const db=new PGlite();
 const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260914004826_customer_category_management.sql'),'utf8');
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create table customers(id uuid primary key default gen_random_uuid(),customer_code text unique,customer_category text constraint customers_customer_category_check check(customer_category in ('school','government','social_welfare','cleaning_team')),name text,phone text,email text,address text,note text,source text,updated_by text,row_version integer default 1);
   create sequence business_number;
   create function next_business_number_value_v1(text) returns bigint language sql as 'select nextval(''public.business_number'')';
   create table contract_service_types(id uuid primary key default gen_random_uuid(),code text unique,is_active boolean default true);
   create table customer_contract_services(customer_id uuid references customers,service_type_id uuid references contract_service_types,primary key(customer_id,service_type_id));
   create table audit_logs(entity_type text,entity_id uuid,action text,before_data jsonb,after_data jsonb,actor text,source text);
   create schema audit_internal;
   insert into customers(customer_code,customer_category,name) values('C900','school','既有學校'),('C901','government','既有機關'),('C902','cleaning_team','既有清潔隊'),('C903','social_welfare','既有社福');
   insert into contract_service_types(code)values('surveillance');
   insert into customer_contract_services select customers.id,contract_service_types.id from customers cross join contract_service_types;
   grant usage on schema public,audit_internal to service_role;
   grant all on all tables in schema public to service_role;`);
  const audit=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260906152432_audit_context_and_query_indexes.sql'),'utf8').match(/create or replace function audit_internal.capture_links\(\)[\s\S]*?end \$\$;/)[0];
  await db.exec(audit);
  const wrappers=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260828000200_standalone_work_logs_contracts_accounts_nas.sql'),'utf8');
  const before=(await db.query('select * from customers order by customer_code')).rows;
  await db.exec(migration);
  for(const name of ['create_customer_with_contracts_v1','update_customer_with_contracts_v1']){
   await db.exec(wrappers.match(new RegExp('create or replace function public.'+name+'[\\s\\S]*?\\$\\$;'))[0]);
  }
  const call=async(action,row,name)=>(await db.query('select * from manage_customer_category_v1($1,$2,$3,$4,$5)',[action,row?.id||null,row?.row_version??null,name,'fixture'])).rows[0];
  assert.deepEqual((await db.query('select * from customers order by customer_code')).rows,before);
  assert.equal((await db.query('select count(*)::int n from customer_contract_services')).rows[0].n,4);
  const school=(await db.query("select * from customer_categories where code='school'")).rows[0];
  const renamed=await call('update',school,'教育機關');assert.equal(renamed.code,'school');assert.equal(renamed.row_version,2);
  assert.deepEqual((await db.query('select * from customers order by customer_code')).rows,before);
  await assert.rejects(call('update',school,'過期版本'),/更新或刪除/);
  await assert.rejects(call('delete',renamed,null),/仍有客戶/);
  await assert.rejects(call('create',null,' '),/1–80/);
  await assert.rejects(call('create',null,'a'.repeat(81)),/1–80/);
  const created=await call('create',null,' Corporate ');
  await assert.rejects(call('create',null,'corporate'),/已存在/);
  await assert.rejects(call('update',renamed,'CORPORATE'),/已存在/);
  const customer=(await db.query("select * from create_customer_with_contracts_v1($1,'新增企業',null,null,null,null,array['surveillance'],'fixture')",[created.code])).rows[0];
  assert.match(customer.customer_code,/^C\d{3}$/);assert.equal(customer.customer_category,created.code);
  await assert.rejects(call('delete',created,null),/仍有客戶/);
  await db.query("select update_customer_with_contracts_v1($1,1,'school','新增企業',null,null,null,null,array['surveillance'],'fixture')",[customer.id]);
  await call('delete',created,null);
  await assert.rejects(db.query("update customers set customer_category='missing' where id=$1",[customer.id]),/foreign key/);
  await assert.rejects(db.query("update customer_categories set code='renumbered' where id=$1",[school.id]),/不可變更/);
  const events=(await db.query("select action from audit_logs where entity_type='customer_categories'")).rows.map(r=>r.action);
  assert.deepEqual(events,['update','insert','delete']);
  assert.equal((await db.query('select count(*)::int n from customer_contract_services')).rows[0].n,5);
  for(const role of ['anon','authenticated']){
   await db.exec('set role '+role);
   await assert.rejects(call('create',null,'Denied'),/permission denied/);
   await assert.rejects(db.query('select * from customer_categories'),/permission denied/);
   await db.exec('reset role');
  }
  await db.exec('set role service_role');const permitted=await call('create',null,'Service-only');assert.equal(permitted.name,'Service-only');await db.exec('reset role');
  assert.equal((await db.query("select relrowsecurity from pg_class where oid='customer_categories'::regclass")).rows[0].relrowsecurity,true);
  console.log('PASS: PostgreSQL category CRUD, duplicates, version conflicts, immutable codes, FK/delete protection, existing rows/contracts, old customer RPC compatibility, audit, RLS and client denial.');
 }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
