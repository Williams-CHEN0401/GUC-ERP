import {readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),dir=path.join(root,'tmp/performance');
const settings=JSON.parse(await readFile(path.join(dir,'test-credentials.json'),'utf8'));
const container='guc-performance-test-db-1';
function docker(args){try{return execFileSync('docker',args,{encoding:'utf8',windowsHide:true,maxBuffer:30e6,timeout:120000});}catch(e){throw Error(String(e.stderr||e.message).slice(-4000));}}
const inspect=JSON.parse(docker(['inspect',container]))[0];
if(inspect.Config.Labels['com.docker.compose.project']!=='guc-performance-test'||Object.keys(inspect.NetworkSettings.Networks).some(n=>n!=='guc-performance-test_default'))throw Error('Isolation check failed');
const psql=(args,database='postgres')=>docker(['exec','-e','PGPASSWORD='+settings.password,container,'psql','-h','127.0.0.1','-U','supabase_admin','-d',database,'-X','-v','ON_ERROR_STOP=1',...args]);
if(process.argv.includes('--baseline')){
 let baseline=await readFile(path.join(dir,'baseline.sql'),'utf8');
 baseline=baseline.replace('CREATE SCHEMA public;','CREATE SCHEMA IF NOT EXISTS public;');
 await writeFile(path.join(dir,'baseline-test.sql'),baseline);
 docker(['cp',path.join(dir,'baseline-test.sql'),container+':/tmp/baseline.sql']);
 psql(['-1','-f','/tmp/baseline.sql']);console.log('Schema-only baseline restored into isolated PostgreSQL.');
}
if(process.argv.includes('--migrate')){
 for(const name of (await readdir(path.join(root,'supabase/migrations'))).filter(n=>n.includes('_performance_module_')).sort()){
  docker(['cp',path.join(root,'supabase/migrations',name),container+':/tmp/'+name]);
  psql(['-f','/tmp/'+name]);console.log('Applied '+name);
 }
 psql(['-c',"NOTIFY pgrst, 'reload schema'"]);
}
if(process.argv.includes('--auth-passwords')){
 psql(['-c',`alter role supabase_auth_admin password '${settings.password}'; alter role authenticator password '${settings.password}';`]);
 console.log('Configured only isolated Auth/PostgREST role passwords.');
}
if(process.argv.includes('--functions')){
 for(const name of (await readdir(path.join(root,'supabase/migrations'))).filter(n=>n.includes('_performance_module_')).sort()){
  const source=await readFile(path.join(root,'supabase/migrations',name),'utf8');
  const definitions=[...source.matchAll(/create function public\.performance_[\s\S]*?\$\$;/g)].map(m=>m[0].replace('create function','create or replace function'));
  await writeFile(path.join(dir,'functions.sql'),'begin;\n'+definitions.join('\n')+'\ncommit;');
  docker(['cp',path.join(dir,'functions.sql'),container+':/tmp/functions.sql']);psql(['-f','/tmp/functions.sql']);
 }
 psql(['-c',"NOTIFY pgrst, 'reload schema'"]);console.log('Refreshed isolated development functions.');
}
if(process.argv.includes('--fresh')){
 const database='performance_migration_'+Date.now();
 psql(['-c','create database '+database]);
 docker(['exec','-e','PGPASSWORD='+settings.password,container,'pg_dump','-h','127.0.0.1','-U','supabase_admin','-d','postgres','--schema-only','--no-owner','--schema=auth','--schema=extensions','--file=/tmp/performance-core.sql']);
 psql(['-1','-f','/tmp/performance-core.sql'],database);
 docker(['cp',path.join(dir,'baseline-test.sql'),container+':/tmp/baseline.sql']);psql(['-1','-f','/tmp/baseline.sql'],database);
 const migrations=[];
 for(const name of (await readdir(path.join(root,'supabase/migrations'))).filter(n=>n.includes('_performance_module_')).sort()){
  docker(['cp',path.join(root,'supabase/migrations',name),container+':/tmp/'+name]);psql(['-f','/tmp/'+name],database);migrations.push(name);
 }
 const count=Number(psql(['-At','-c',"select count(*) from pg_tables where schemaname='public' and tablename like 'performance_%'"],database).trim());
 await writeFile(path.join(dir,'fresh-migration-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),status:'PASS',database,migrations,performanceTables:count,productionWrites:0},null,2));
 console.log('PASS exact final migrations applied to a fresh schema-only database: '+count+' performance tables.');
}
console.log(psql(['-At','-c',"select version(); select count(*) from public.app_users;"]).trim());
