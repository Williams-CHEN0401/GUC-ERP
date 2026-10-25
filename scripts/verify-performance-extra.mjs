import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
if(process.env.PERFORMANCE_TEST_INTERNAL!=='true')throw Error('Isolated test container only.');
const data=JSON.parse(await readFile('/test-output/runtime.json','utf8')),settings=JSON.parse(await readFile('/test-output/test-credentials.json','utf8'));
const db=new pg.Client({host:'db',user:'supabase_admin',database:'postgres',password:settings.password});await db.connect();
const results=[],base='http://127.0.0.1:3000/api/inventory';
async function read(actor,mode,options,expected=200){const r=await fetch(base+'?'+new URLSearchParams({scope:'performance',mode,...options}),{headers:{Authorization:'Bearer '+data.users[actor].token}});const b=await r.json();assert.equal(r.status,expected,JSON.stringify(b));return b.performance;}
async function command(actor,operation,payload,expected=201){const r=await fetch(base,{method:'POST',headers:{Authorization:'Bearer '+data.users[actor].token,'Content-Type':'application/json'},body:JSON.stringify({operation:'performance.'+operation,payload:{request_id:randomUUID(),...payload}})});const b=await r.json();assert.equal(r.status,expected,JSON.stringify(b));return b.result;}
try{
 await db.query('update site_work_logs set deleted_at=null,delete_reason=null where id=$1',[data.source.log]);
 const review=await read('admin','detail',{id:data.reviews.employee}),evidence=review.evidence[0];
 const current=await read('admin','source',{id:review.id,evidence_id:evidence.id});assert.equal(current.source.summary,'後來更新的施工文字');assert.notEqual(current.source.summary,evidence.snapshot.summary);
 await read('scorer','source',{id:review.id,evidence_id:evidence.id},403);await read('employee','source',{id:review.id,evidence_id:evidence.id},403);
 await db.query('update site_work_logs set deleted_at=now(),delete_reason=$2 where id=$1',[data.source.log,'隔離失效來源驗收']);
 await read('admin','source',{id:review.id,evidence_id:evidence.id},403);assert.ok((await read('admin','detail',{id:review.id})).evidence[0].redacted);
 await db.query('update site_work_logs set deleted_at=null,delete_reason=null where id=$1',[data.source.log]);
 results.push('Current source differs from frozen snapshot; revocation and soft deletion deny source endpoint and redact snapshot.');
 const month=(await db.query('select month::text from performance_periods where id=$1',[data.period])).rows[0].month;
 const task=await command('scorer','task_create',{title:'指定主管共同任務',category:'handover',assignee_id:data.users.employee.id,due_date:month.slice(0,7)+'-25'});assert.ok(task.id);
 await command('scorer','task_create',{title:'未管轄人員',category:'tools',assignee_id:data.users.admin2.id,due_date:month.slice(0,7)+'-25'},403);
 const scopedPeople=(await read('scorer','list',{})).people;assert.ok(scopedPeople.some(p=>p.id===data.users.employee.id));assert.ok(!scopedPeople.some(p=>p.id===data.users.admin2.id));
 results.push('Designated supervisor can assign a task only to approved employee/month; person options match relationship.');
 const config=JSON.parse(await readFile(new URL('../assets/performance-weights-v1.json',import.meta.url),'utf8'));delete config.timezone;
 await command('admin','template_create',{name:'缺少時區',config},400);results.push('Missing mandatory template field rejected.');
 const acl=(await db.query("select tablename,rowsecurity,has_table_privilege('anon','public.'||tablename,'SELECT') anon_read,has_table_privilege('authenticated','public.'||tablename,'SELECT') authenticated_read from pg_tables where schemaname='public' and tablename like 'performance_%'")).rows;
 assert.ok(acl.length>=13&&acl.every(t=>t.rowsecurity&&!t.anon_read&&!t.authenticated_read));results.push(`${acl.length} performance tables: RLS enabled, no anonymous/authenticated direct reads.`);
 console.log('PASS supplemental source lifecycle, supervisor task scope, strict template and table ACL checks.');
 await writeFile('/test-output/extra-results.json',JSON.stringify({checkedAt:new Date().toISOString(),status:'PASS',results},null,2));
}catch(e){console.error(e.stack);process.exitCode=1;}finally{await db.end();}
