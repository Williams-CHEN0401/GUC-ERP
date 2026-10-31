// Dedicated disposable PostgreSQL, loopback only, no volumes or production data.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {useIsolatedDatabaseFactory,ids,sample} from './worklog-save-fixture.mjs';
import {maintenancePendingServer,pendingList,pendingPayload} from './maintenance-pending-fixture.mjs';
const {default:pg}=await import(process.env.POSTGRES_MODULE||'pg');
const run=promisify(execFile),container='guc-maintenance-pending-test-'+Date.now();
const docker=(...args)=>run('docker',args,{windowsHide:true,timeout:30000,maxBuffer:1024*1024});
let started=false,base;const clients=[];
try{
 await docker('run','-d','--name',container,'--label','guc.purpose=isolated-maintenance-pending-test','--user','postgres','--tmpfs','/tmp','-p','127.0.0.1::5432','--entrypoint','/bin/sh','supabase/postgres:17.6.1.136','-c','initdb -D /tmp/guc-pending-pg -U postgres --auth=trust --encoding=UTF8 --locale=C && echo "host all all 0.0.0.0/0 trust" >> /tmp/guc-pending-pg/pg_hba.conf && exec postgres -D /tmp/guc-pending-pg -h 0.0.0.0 -p 5432');started=true;
 const port=Number((await docker('port',container,'5432/tcp')).stdout.trim().split(':').pop());
 const config={host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:1000};
 for(let attempt=0;attempt<30;attempt++){
  base=new pg.Client(config);try{await base.connect();break;}catch(e){await base.end();base=null;if(attempt===29)throw e;await new Promise(r=>setTimeout(r,400));}
 }
 const adapter={exec:async s=>{const r=await base.query(s);return Array.isArray(r)?r:[r];},query:(s,p)=>base.query(s,p),close:async()=>{}};
 useIsolatedDatabaseFactory(async()=>adapter);const f=await maintenancePendingServer(),pid=f.first.work_log.project_id;
 const items=(await pendingList(adapter,pid)).items;
 for(let i=0;i<4;i++){const c=new pg.Client(config);await c.connect();await c.query("set role service_role;set statement_timeout='15s'");clients.push(c);}
 const payload=item=>{const key=randomUUID();return pendingPayload({project_id:pid,project_name:f.first.work_log.title,log_date:'2026-10-30',maintenance_events:[{...sample().maintenance_events[0],client_key:key,occurred_at:'2026-10-30',inventory_category_id:null,inventory_item_id:null,pending_content:''}],resolved_maintenance_items:[{...item,target_client_key:key}]});};
 const send=(c,p)=>c.query('select save_work_log_workforce_v1($1,$2) result',[ids.actor,JSON.stringify(p)]);
 const count=async()=>(await base.query('select (select count(*)::int from site_work_logs) logs,(select count(*)::int from maintenance_events) events')).rows[0];
 const before=await count();const results=await Promise.allSettled(clients.slice(0,2).map(c=>send(c,payload(items[0]))));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/已更新/);
 const after=await count();assert.equal(after.logs,before.logs+1);assert.equal(after.events,before.events+1);
 const fresh=(await pendingList(adapter,pid)).items[0],retry=payload(fresh);
 const replays=await Promise.all(clients.map(c=>send(c,retry)));assert.ok(replays.every(r=>r.rows[0].result.work_log.id===replays[0].rows[0].result.work_log.id));
 assert.equal((await count()).logs,after.logs+1);assert.equal((await count()).events,after.events+1);
 const history=(await base.query('select pending_completions from maintenance_events where id=$1',[items[0].source_event_id])).rows[0].pending_completions;assert.equal(history.length,2);
 const out=new URL('../tmp/maintenance-pending/',import.meta.url);await mkdir(out,{recursive:true});await writeFile(new URL('concurrency.json',out),JSON.stringify({passed:true,postgres:(await base.query('select version()')).rows[0].version,checks:['two simultaneous completions: one winner, one stale rejection, full rollback','four simultaneous retries: exactly one log and one event','history recorded once per item'],counts:await count()},null,2));
 console.log('PASS: real PostgreSQL simultaneous completion and four-connection retry; exactly one save, no partial writes.');
}catch(e){console.error(e.message);if(e.where)console.error(e.where);if(started)console.error((await docker('logs','--tail','12',container)).stdout);process.exitCode=1;}
finally{for(const c of clients)await c.end();await base?.end();useIsolatedDatabaseFactory(undefined);if(started)await docker('rm','-f',container);}
