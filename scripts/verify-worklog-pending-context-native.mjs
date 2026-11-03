// Run the same regression suite against a disposable native PostgreSQL 17.
// The container has no source/production mounts and uses only tmpfs data.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {useIsolatedDatabaseFactory} from './worklog-save-fixture.mjs';
const {default:pg}=await import(process.env.POSTGRES_MODULE||'pg');
// PostgreSQL DATE is a calendar day. Do not shift it through the host timezone.
pg.types.setTypeParser(1082,value=>value);
const run=promisify(execFile),name='guc-pending-context-test-'+randomUUID().slice(0,8);
const docker=(...args)=>run(process.env.DOCKER_BIN||'docker',args,{windowsHide:true,timeout:30000,maxBuffer:2e6});
let started=false,client;
try{
 await docker('run','-d','--name',name,'--label','guc.purpose=isolated-pending-context-test','--user','postgres','--tmpfs','/tmp',
  '-p','127.0.0.1::5432','--entrypoint','/bin/sh','supabase/postgres:17.6.1.136','-c',
  'initdb -D /tmp/guc-context-pg -U postgres --auth=trust --encoding=UTF8 --locale=C && echo "host all all 0.0.0.0/0 trust" >> /tmp/guc-context-pg/pg_hba.conf && exec postgres -D /tmp/guc-context-pg -h 0.0.0.0 -p 5432');started=true;
 const port=Number((await docker('port',name,'5432/tcp')).stdout.trim().split(':').pop());
 for(let attempt=0;attempt<30;attempt++){
  client=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:1000});
  try{await client.connect();break;}catch(error){await client.end();client=null;if(attempt===29)throw error;await new Promise(resolve=>setTimeout(resolve,300));}
 }
 const adapter={exec:async query=>{const result=await client.query(query);return Array.isArray(result)?result:[result];},query:(query,params)=>client.query(query,params),close:async()=>{}};
 useIsolatedDatabaseFactory(async()=>adapter);
 await import('./verify-worklog-pending-context-db.mjs');
 if(process.env.SUPABASE_CLI_BIN){
  const url=`postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable&options=-c%20default_transaction_read_only%3Don`;
  const result=await run(process.env.SUPABASE_CLI_BIN,['db','advisors','--db-url',url,'--type','security','--level','warn','--fail-on','none','--output-format','json'],{windowsHide:true,timeout:60000,maxBuffer:4e6});
  const output=new URL('../tmp/pending-context/',import.meta.url);await mkdir(output,{recursive:true});
  await writeFile(new URL('native-security-advisors.log',output),result.stdout+'\n'+result.stderr);
  console.log('Security advisors completed (read-only synthetic PostgreSQL); evidence: tmp/pending-context/native-security-advisors.log');
 }
 console.log('PASS native PostgreSQL:',(await client.query('select version()')).rows[0].version);
}finally{
 useIsolatedDatabaseFactory(undefined);await client?.end();
 if(started){
  const label=(await docker('inspect','--format','{{index .Config.Labels "guc.purpose"}}',name)).stdout.trim();
  if(label!=='isolated-pending-context-test')throw Error('Refuse to remove an unowned container');
  await docker('rm','-f',name);
 }
}
