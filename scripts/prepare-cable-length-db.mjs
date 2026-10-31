// Clone an existing synthetic cable fixture and apply the real migrations.
// Neither source nor destination can be the production `postgres` database.
import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const docker=process.env.DOCKER_EXE||'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
const source=process.env.CABLE_LENGTH_SOURCE||'guc_cable_meter_20261022',database=process.env.CABLE_LENGTH_DATABASE||'guc_cable_length_verify_20261031';
if(![source,database].every(n=>/^guc_cable_[a-z0-9_]+$/.test(n))||source===database)throw Error('Only distinct isolated guc_cable_* databases are allowed');
const run=(args,input)=>{const r=spawnSync(docker,args,{input,windowsHide:true,maxBuffer:100e6});if(r.status)throw Error(r.stderr.toString());return r.stdout;};
const query=(db,q)=>run(['exec','-i','supabase-db','psql','-U','supabase_admin','-d',db,'-X','-qAt','-v','ON_ERROR_STOP=1'],q).toString().trim();
if(query('postgres',`select count(*) from pg_database where datname='${database}'`)!=='0')throw Error('Destination already exists; choose a fresh isolated name');
const dump=run(['exec','supabase-db','pg_dump','-U','supabase_admin','-d',source,'-Fc']);
query('postgres',`create database ${database}`);run(['exec','-i','supabase-db','pg_restore','-U','supabase_admin','-d',database,'--exit-on-error'],dump);
const read=name=>fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8').replaceAll('\r\n','\n');
if(query(database,"select count(*) from information_schema.columns where table_name='projects' and column_name='contract_end_date'")==='0')query(database,read('20261025062408_construction_contract_monitoring.sql'));
query(database,'begin;'+read('20261031075010_cable_length_snapshots_and_unpacking.sql')+'commit;');
console.log(JSON.stringify({database,source,migrationApplied:true,productionWrites:false}));
