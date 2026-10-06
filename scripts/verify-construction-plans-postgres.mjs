// Disposable native localhost PostgreSQL, synthetic identities, no production URL.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,cp} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {useIsolatedDatabaseFactory,ids} from './worklog-save-fixture.mjs';
import {constructionPlanServer,planUsers} from './construction-plan-fixture.mjs';
const runtime=fileURLToPath(new URL('../../.tmp/transaction-document-pg/node_modules/',import.meta.url));
const {default:pg}=await import(pathToFileURL(path.join(runtime,'pg/lib/index.js')));
pg.types.setTypeParser(1082,value=>value);
const cluster=await mkdtemp(path.join(tmpdir(),'guc-construction-pg-')),data=path.join(cluster,'data'),port=55441;
await cp(path.join(runtime,'@embedded-postgres/windows-x64/native'),path.join(cluster,'native'),{recursive:true});
const run=promisify(execFile),execute=(name,args)=>run(path.join(cluster,'native/bin',name+'.exe'),args,{windowsHide:true,timeout:30000,maxBuffer:1048576});
const clients=[];let started=false,base;
const connect=async()=>{const c=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});await c.connect();clients.push(c);return c;};
const call=async(c,name,args)=>(await c.query('select '+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args)).rows[0].result;
try{
 await execute('initdb',['-D',data,'--username=postgres','--auth=trust','--locale=C','--encoding=UTF8']);
 await execute('pg_ctl',['-D',data,'-l',path.join(cluster,'server.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);started=true;
 base=await connect();
 useIsolatedDatabaseFactory(async()=>({exec:async sql=>{const r=await base.query(sql);return Array.isArray(r)?r:[r];},query:(sql,args)=>base.query(sql,args),close:async()=>{}}));
 const f=await constructionPlanServer(),owner=await connect(),worker=await connect();
 for(const c of [owner,worker])await c.query("set role service_role;set statement_timeout='10s'");
 const waiting=async client=>{
  for(let i=0;i<40;i++){
   const row=(await base.query('select wait_event_type from pg_stat_activity where pid=$1',[client.processID])).rows[0];
   if(row?.wait_event_type==='Lock')return;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.fail('Expected concurrent request to wait on a database lock');
 };
 let plan=await call(owner,'save_construction_plan_v1',[planUsers.owner,JSON.stringify({id:randomUUID(),project_id:f.planProjects.small,construction_date:'2026-10-10',content:'並行施工測試',status:'pending',notes:'',assignee_user_ids:[planUsers.A,planUsers.B]}),false]);
 const project=(await base.query('select * from projects where id=$1',[plan.project_id])).rows[0];
 const log=()=>({request_id:randomUUID(),id:null,row_version:null,project_id:project.id,customer_id:ids.customer,department_id:project.department_id,project_name:project.name,log_date:plan.construction_date,work_type:'工程施工',time_period:'上午',status:'in_progress',summary:'施工中',completed_content:'',pending_content:'施工中',worker_user_ids:[planUsers.A],maintenance_events:[]});
 await owner.query('begin');
 plan=await call(owner,'save_construction_plan_v1',[planUsers.owner,JSON.stringify({...plan,assignee_user_ids:[planUsers.A]}),false]);
 const revoked=call(worker,'save_construction_work_log_v1',[planUsers.B,plan.id,JSON.stringify({...log(),worker_user_ids:[planUsers.B]})]).then(value=>({value}),error=>({error}));
 await waiting(worker);await owner.query('commit');
 assert.match((await revoked).error?.message||'',/目前被指派/);
 assert.equal((await base.query('select count(*)::int n from site_work_logs where construction_plan_id=$1',[plan.id])).rows[0].n,0);
 console.log('PASS native race: committed reassignment blocks removed worker waiting to save; no orphan log');
 await worker.query('begin');
 const saved=await call(worker,'save_construction_work_log_v1',[planUsers.A,plan.id,JSON.stringify(log())]);
 const removal=call(owner,'save_construction_plan_v1',[planUsers.owner,JSON.stringify({...plan,assignee_user_ids:[planUsers.B]}),false]);
 await waiting(owner);await worker.query('commit');plan=await removal;
 assert.equal((await base.query('select construction_plan_id from site_work_logs where id=$1',[saved.work_log.id])).rows[0].construction_plan_id,plan.id);
 await assert.rejects(call(worker,'save_construction_work_log_v1',[planUsers.A,plan.id,JSON.stringify(log())]),/目前被指派/);
 console.log('PASS native race: log committed first survives later removal; new creates denied');
 const outcomes=await Promise.allSettled([owner,worker].map((client,i)=>call(client,'save_construction_plan_v1',[planUsers.owner,JSON.stringify({...plan,content:'並行修改 '+i}),false])));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 assert.match(outcomes.find(r=>r.status==='rejected').reason.message,/其他使用者/);
 console.log('PASS native race: same-version concurrent plan edits allow one writer, reject stale writer');
 console.log('RESULT 3 native PostgreSQL concurrency groups passed; production writes 0');
}catch(error){console.error(error.message,error.where||'');process.exitCode=1;}
finally{
 for(const c of clients){await c.query('rollback').catch(()=>{});await c.end();}
 if(started)await execute('pg_ctl',['-D',data,'-m','fast','-w','stop']);
 useIsolatedDatabaseFactory(undefined);
}
