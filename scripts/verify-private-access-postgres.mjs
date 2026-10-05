// Native, disposable localhost PostgreSQL. No production credentials or data.
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHmac,randomBytes} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdtemp,cp,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {useIsolatedDatabaseFactory,ids} from './worklog-save-fixture.mjs';
const runtime=fileURLToPath(new URL('../../.tmp/transaction-document-pg/node_modules/',import.meta.url));
const {default:pg}=await import(pathToFileURL(path.join(runtime,'pg/lib/index.js')));
// PostgREST/PGlite serialize DATE as YYYY-MM-DD, not a local-time JS Date.
pg.types.setTypeParser(1082,value=>value);
const cluster=await mkdtemp(path.join(tmpdir(),'guc-private-pg-'));
const data=path.join(cluster,'data'),run=promisify(execFile),port=55439;
await cp(path.join(runtime,'@embedded-postgres/windows-x64/native'),path.join(cluster,'native'),{recursive:true});
const execute=(name,args)=>run(path.join(cluster,'native/bin',name+'.exe'),args,{windowsHide:true,timeout:30000,maxBuffer:1024*1024});
const connect=async()=>{const c=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:5000});await c.connect();return c;};
let started=false,base,rest;const clients=[],results=[];
const pass=label=>{results.push(label);console.log('PASS '+label);};
try{
 await execute('initdb',['-D',data,'--username=postgres','--auth=trust','--locale=C','--encoding=UTF8']);
 await execute('pg_ctl',['-D',data,'-l',path.join(cluster,'server.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);started=true;
 base=await connect();
 useIsolatedDatabaseFactory(async()=>({exec:async s=>{const r=await base.query(s);return Array.isArray(r)?r:[r];},query:(s,p)=>base.query(s,p),close:async()=>{}}));
 await import('./verify-access-appointments-db.mjs');
 assert.ok(!process.exitCode,'Full ERP access verification must pass on native PostgreSQL');
 pass('All 14 ERP/Gateway/SQL verification groups pass on native PostgreSQL');
 const outsider='10000000-0000-4000-8000-000000000008';
 for(let i=0;i<12;i++){const c=await connect();await c.query("set role service_role;set statement_timeout='15s'");clients.push(c);}
 await Promise.all(clients.map(async(c,i)=>{
  for(let n=0;n<4;n++){
   const allowed=(i+n)%2===0,actor=allowed?ids.actor:outsider;
   await c.query('begin');
   await c.query('select erp_private_prepare_v1($1)',[actor]);
   const visible=(await c.query('select erp_private_json_visible_v1(to_jsonb($1::uuid)) visible',[ids.customer])).rows[0].visible;
   assert.equal(visible,allowed);
   // Actor substitution within one transaction must recompute the scope.
   await c.query('select erp_private_prepare_v1($1)',[allowed?outsider:ids.actor]);
   assert.equal((await c.query('select erp_private_json_visible_v1(to_jsonb($1::uuid)) visible',[ids.customer])).rows[0].visible,!allowed);
   await c.query('commit');
   await assert.rejects(c.query('select erp_private_json_visible_v1(to_jsonb($1::uuid))',[ids.customer]),/尚未完成/);
  }
 }));
 pass('12 connections / 48 transactions: actor isolation, actor-switch refresh, and no scope after commit');
 // At least the read-only production preflight's row counts, no production rows.
 await base.query(`alter table equipment_registry add constraint scale_customer_fk foreign key(customer_id) references customers;
 insert into customers(id,name,customer_code) select gen_random_uuid(),'SCALE_CUSTOMER_'||n,'SCALE-'||n from generate_series(1,124) n;
 insert into equipment_registry(id,customer_id,source_table,source_id,status) select gen_random_uuid(),'${ids.customer}','site_devices',gen_random_uuid(),'active' from generate_series(1,2028);
 insert into audit_logs(entity_type,entity_id,action,after_data,source,actor) select 'equipment_registry',e.id,'insert',to_jsonb(e),'isolated-scale','fixture' from equipment_registry e cross join generate_series(1,6) n;
 analyze;`);
 const scaleStart=performance.now();
 const scaleScope=(await clients[0].query('select erp_private_scope_v1($1) scope',[outsider])).rows[0].scope;
 const scaleMs=Math.round(performance.now()-scaleStart);
 const largestFilter=Math.max(0,...Object.values(scaleScope.filters).flatMap(columns=>Object.values(columns).map(values=>encodeURIComponent('not.in.('+values.join(',')+')').length)));
 console.log('Scaled scope: '+scaleMs+' ms; largest encoded REST filter: '+largestFilter+' bytes');
 assert.ok(scaleScope.blocked_ids.length>=2028);
 assert.ok(scaleMs<5000,'Scaled scope must finish within 5 seconds');
 assert.ok(largestFilter>16000,'Fixture must exercise the bounded RPC instead of a huge exclusion URL');
 for(const table of ['equipment_registry','audit_logs']){
  const idsToHide=scaleScope.filters[table].id.map(String);
  const rows=(await clients[0].query('select * from private_select_'+table+'_v1($1)',[outsider])).rows;
  assert.ok(rows.every(r=>!idsToHide.includes(String(r.id))),table+' must exclude every private row before pagination');
  assert.equal((await clients[0].query('select count(*)::int n from private_select_'+table+'_v1($1)',[ids.actor])).rows[0].n,(await base.query('select count(*)::int n from '+table)).rows[0].n);
 }
 for(const clientRole of ['anon','authenticated']){
  await base.query('set role '+clientRole);
  await assert.rejects(base.query('select * from private_select_audit_logs_v1($1)',[ids.actor]),/permission denied/);
  await base.query('reset role');
 }
 // Revocation on a different connection must affect the next statement.
 await clients[0].query('select private_select_customers_v1($1)',[ids.actor]);
 await base.query('update app_users set is_active=false where id=$1',[ids.actor]);
 await assert.rejects(clients[0].query('select * from private_select_customers_v1($1)',[ids.actor]),/權限/);
 await base.query('update app_users set is_active=true where id=$1',[ids.actor]);
 pass('2,028 equipment and 12,168 synthetic audits: bounded SQL reads, client denial and cross-connection revocation');
 if(process.argv.includes('--postgrest')){
  const binary=fileURLToPath(new URL('../../.tmp/private-access-postgrest-v16.4/postgrest.exe',import.meta.url));
  const jwtSecret=randomBytes(32).toString('hex');
  const tokenBody=[{alg:'HS256',typ:'JWT'},{role:'service_role',exp:Math.floor(Date.now()/1000)+300}].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  const token=tokenBody+'.'+createHmac('sha256',jwtSecret).update(tokenBody).digest('base64url');
  const headers={'Content-Type':'application/json',Authorization:'Bearer '+token,Prefer:'count=exact'};
  let logs='';
  const restEnv={...process.env,PGRST_DB_URI:`postgres://postgres@127.0.0.1:${port}/postgres`,PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'anon',PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:'55440',PGRST_JWT_SECRET:jwtSecret};
  const pathKey=Object.keys(restEnv).find(k=>k.toLowerCase()==='path')||'PATH';
  restEnv[pathKey]=path.join(cluster,'native/bin')+path.delimiter+(restEnv[pathKey]||'');
  rest=spawn(binary,[],{windowsHide:true,env:restEnv,stdio:['ignore','pipe','pipe']});
  rest.stdout.on('data',chunk=>logs=(logs+chunk).slice(-6000));rest.stderr.on('data',chunk=>logs=(logs+chunk).slice(-6000));
  const endpoint='http://127.0.0.1:55440/';let ready=false;
  for(let i=0;i<50;i++){try{const r=await fetch(endpoint,{headers});if(r.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(ready,'Isolated PostgREST must start: '+logs);
  const query='?select=id,actor&order=id.desc&limit=3&offset=2';
  const response=await fetch(endpoint+'rpc/private_select_audit_logs_v1'+query,{method:'POST',headers,body:JSON.stringify({p_private_actor:outsider})});
  assert.equal(response.status,206,await response.clone().text());
  const expected=(await clients[0].query('select id,actor from private_select_audit_logs_v1($1) order by id desc limit 3 offset 2',[outsider])).rows;
  assert.deepEqual((await response.json()).map(r=>({...r,id:String(r.id)})),expected);
  const count=(await clients[0].query('select count(*)::int n from private_select_audit_logs_v1($1)',[outsider])).rows[0].n;
  assert.equal(response.headers.get('content-range'),`2-${Math.min(4,count-1)}/${count}`);
  const relationQuery='?select=id,name,customer:customers!projects_customer_id_fkey(name)&order=id.asc&limit=3';
  const original=await fetch(endpoint+'projects'+relationQuery,{headers});
  const guarded=await fetch(endpoint+'rpc/private_select_projects_v1'+relationQuery,{method:'POST',headers,body:JSON.stringify({p_private_actor:ids.actor})});
  assert.equal(guarded.status,206,await guarded.clone().text());assert.deepEqual(await guarded.json(),await original.json());
  const denied=await fetch(endpoint+'rpc/private_select_audit_logs_v1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_private_actor:ids.actor})});
  assert.ok([401,403].includes(denied.status),await denied.text());
  pass('Native PostgREST HTTP: POST RPC filtering/order/pagination/count, FK embedding parity, and anonymous denial');
 }
 const timings=[];
 for(let i=0;i<10;i++){const start=performance.now();await clients[i].query('select erp_private_scope_v1($1)',[outsider]);timings.push(Math.round(performance.now()-start));}
 const out=fileURLToPath(new URL('../tmp/private-access/',import.meta.url));await mkdir(out,{recursive:true});
 await writeFile(path.join(out,'native-postgres-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),version:(await base.query('select version()')).rows[0].version,environment:'Disposable localhost PostgreSQL; synthetic data only',productionWrites:0,results,scopeMilliseconds:timings,scaleMs,largestFilter},null,2));
 console.log('Scope timings (synthetic fixture only): '+timings.join(', ')+' ms');
}catch(error){console.error(error.message,error.where||'');process.exitCode=1;}
finally{if(rest&&rest.exitCode===null){const stopped=once(rest,'exit');rest.kill();await stopped;}for(const c of clients)await c.end();if(base)await base.end();if(started)await execute('pg_ctl',['-D',data,'-m','fast','-w','stop']);useIsolatedDatabaseFactory(undefined);}
