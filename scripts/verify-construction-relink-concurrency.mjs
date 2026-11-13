// Two real PostgreSQL sessions. Explicit disposable native Docker database only.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
const cfg=JSON.parse(fs.readFileSync(process.env.CONSTRUCTION_RELINK_NATIVE_CONFIG,'utf8'));
assert(/^guc_construction_relink_release_\d+$/.test(cfg.database));
assert(/^guc-construction-relink-release-\d+-db$/.test(cfg.container));
for(const k of ['actor','log','sourcePlan','targetPlan','item'])assert(/^[a-f0-9-]{36}$/.test(cfg[k]));
const q=v=>"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
const args=['exec','-i',cfg.container,'psql','-U','supabase_admin','-d',cfg.database,'-X','-qAt','-v','ON_ERROR_STOP=1'];
const sql=text=>{const r=spawnSync(cfg.docker,args,{input:text,encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:8e6});assert.equal(r.status,0,String(r.stderr).slice(0,300));return r.stdout.trim();};
const read=text=>JSON.parse(sql('begin read only;'+text+';rollback;'));
const fingerprint=()=>read("select jsonb_build_object('logs',(select md5(string_agg(to_jsonb(l)::text,''order by id))from site_work_logs l),'requests',(select count(*)from work_log_save_requests),'workers',(select md5(string_agg(to_jsonb(w)::text,''order by work_log_id,user_id))from site_work_log_workers w),'audit',(select count(*)from audit_logs))");
const payload=read("select jsonb_build_object('id',l.id,'row_version',l.row_version,'request_id',"+q(randomUUID())+",'project_id',p.id,'project_name',p.name,'customer_id',p.customer_id,'department_id',p.department_id,'log_date',l.log_date,'work_type',l.work_type,'time_period',l.time_period,'status',l.status,'summary',l.summary,'completed_content',l.completed_content,'pending_content',l.pending_content,'maintenance_events','[]'::jsonb,'worker_user_ids',coalesce((select jsonb_agg(user_id)from site_work_log_workers where work_log_id=l.id),'[]'),'construction_item_id',"+q(cfg.item)+")from site_work_logs l join projects p on p.id=l.project_id where l.id="+q(cfg.log));
assert(payload);const before=fingerprint(),tag='relink-race-'+randomUUID().slice(0,8),sessions=[];
function session(label){const child=spawn(cfg.docker,args,{windowsHide:true,stdio:['pipe','pipe','pipe']}),s={child,stdout:'',stderr:'',exit:once(child,'exit')};child.stdout.on('data',b=>s.stdout+=b);child.stderr.on('data',b=>s.stderr+=b);sessions.push(s);child.stdin.on('error',()=>{});child.stdin.write('set application_name='+q(tag+'-'+label)+';begin;set local role service_role;\n');return s;}
async function waitFor(test,message){for(let i=0;i<50;i++){if(await test())return;await new Promise(r=>setTimeout(r,100));}throw Error(message);}
try{
 const source=session('source');source.child.stdin.write('select 1 from construction_plans where id='+q(cfg.sourcePlan)+" for update;select 'SOURCE_LOCKED';\n");
 await waitFor(()=>source.stdout.includes('SOURCE_LOCKED'),'Source plan did not lock');
 const move=session('move');move.child.stdin.end('select save_construction_work_log_v1('+q(cfg.actor)+','+q(cfg.targetPlan)+','+q(payload)+");select 'MOVE_SAVED';rollback;\n");
 await waitFor(()=>read("select to_jsonb(exists(select 1 from pg_stat_activity where application_name="+q(tag+'-move')+" and wait_event_type='Lock'))"),'Move did not wait on source lock');
 source.child.stdin.end('select 1 from projects where id='+q(payload.project_id)+" for update;select 'PROJECT_LOCKED';rollback;\n");
 const timer=setTimeout(()=>{for(const s of sessions)s.child.kill();},20000);
 const outcomes=await Promise.all(sessions.map(s=>s.exit));clearTimeout(timer);
 const deadlock=sessions.some(s=>/deadlock detected/i.test(s.stderr));
 if(process.argv.includes('--expect-deadlock'))assert(deadlock,'Old lock order did not reproduce the expected deadlock');
 else{assert(!deadlock,'Concurrent relink deadlocked');assert(outcomes.every(([code])=>code===0),sessions.map(s=>s.stderr).join('\n'));assert(move.stdout.includes('MOVE_SAVED'));assert(source.stdout.includes('PROJECT_LOCKED'));}
 assert.deepEqual(fingerprint(),before,'Concurrency test retained changes');
 console.log(JSON.stringify({passed:true,mode:process.argv.includes('--expect-deadlock')?'reproduced-old-deadlock':'ordered-locks',deadlockDetected:deadlock,originalRowsUnchanged:true,rolledBack:true,productionWrites:0}));
}finally{for(const s of sessions){if(s.child.exitCode===null){s.child.stdin.end('rollback;\n');s.child.kill();}}}
