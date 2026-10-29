// Isolated PostgreSQL + the actual Gateway. Table columns mirror production;
// unrelated business constraints are omitted, not claimed as tested here.
import fs from 'node:fs';import vm from 'node:vm';import {AsyncLocalStorage} from 'node:async_hooks';import {stripTypeScriptTypes} from 'node:module';import {randomUUID} from 'node:crypto';
export const migration='20261029084350_system_audit_coverage.sql';
export const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const text=f=>fs.readFileSync(new URL(f,import.meta.url),'utf8');
export async function auditFixture({history=[]}={}){
 const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table audit_logs(id bigserial primary key,entity_type text,entity_id uuid not null,action text check(action in ('insert','update','delete','import','export','UPDATE_CREDENTIAL','IMPORT_DEVICES','BATCH_UPDATE','BATCH_DELETE','CREATE_REPAIR_ITEM','UPDATE_REPAIR_ITEM','DELETE_REPAIR_ITEM','LOGIN','LOGOUT')),before_data jsonb,after_data jsonb,source text,actor text,created_at timestamptz default now());`);
 const schema=JSON.parse(text('./fixtures/system-audit-columns.json'));
 for(const table of schema)await db.exec('create table '+table.name+'('+table.columns.map(c=>'"'+c.name+'" '+c.type).join(',')+')');
 await db.exec(`create table phone_terminal_import_logs(id uuid,customer_id uuid,source_rows jsonb);
 alter table suppliers alter column id set default gen_random_uuid(),alter column row_version set default 1;
 alter table suppliers add primary key(id);
 create function fixture_supplier_version() returns trigger language plpgsql as $$ begin new.row_version=old.row_version+1;return new;end $$;
 create trigger supplier_version before update on suppliers for each row execute function fixture_supplier_version();`);
 await db.exec(text('../supabase/migrations/20260906152432_audit_context_and_query_indexes.sql'));
 // Historical snapshot precedes migration; no legacy data is invented or backfilled.
 for(let i=0;i<history.length;i+=200){const chunk=history.slice(i,i+200),cols=['id','entity_type','entity_id','action','before_data','after_data','source','actor','created_at','actor_user_id','source_ip','user_agent','request_id','system_module'],values=[];
  await db.query('insert into audit_logs('+cols.join(',')+') values '+chunk.map(r=>'('+cols.map(k=>{values.push(r[k]&&typeof r[k]==='object'?JSON.stringify(r[k]):r[k]??null);return '$'+values.length;}).join(',')+')').join(','),values);
 }
 await db.exec("select setval(pg_get_serial_sequence('audit_logs','id'),coalesce((select max(id) from audit_logs),0)+1,false)");
 await db.exec(text('../supabase/migrations/'+migration));
 let handler;const context=vm.createContext({AsyncLocalStorage,performance,Deno:{env:{get:()=>''},serve:f=>handler=f},URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,console,crypto});
 vm.runInContext(stripTypeScriptTypes(text('../supabase/functions/inventory-gateway/index.ts').replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'}),context);
 const users={admin:{id:id(1),username:'audit-admin',display_name:'隔離管理員',role:'admin',is_active:true,permissions:[]},worker:{id:id(2),username:'audit-worker',display_name:'隔離操作員',role:'worker',is_active:true,permissions:[{module:'suppliers',can_view:true,can_create:true,can_update:true,can_delete:true}]},auditor:{id:id(3),username:'audit-reader',display_name:'隔離日誌檢視者',role:'auditor',is_active:true,permissions:[{module:'audit',can_view:true}]}};
 context.currentUser=async request=>users[(request.headers.get('authorization')||'').replace('Bearer audit-test-','')]||null;
 const ident=s=>{if(!/^[a-z_][a-z_0-9]*$/.test(s))throw Error('Unsafe identifier');return '"'+s+'"';};
 let chain=Promise.resolve();
 context.db=(path,init={})=>{const audit=vm.runInContext('auditContext.getStore()',context),job=chain.then(async()=>{
  await db.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false),set_config('request.headers',$1,false)",[JSON.stringify({'x-guc-audit-context':JSON.stringify(audit||{})})]);
  const url=new URL(path,'http://isolated.invalid'),table=ident(url.pathname.slice(1)),q=url.searchParams,params=[],bind=v=>{params.push(v);return '$'+params.length;},where=[];
  for(const [key,value] of q){if(['select','order','limit','offset'].includes(key))continue;
   if(key==='or'){
    const terms=value.slice(1,-1).split(',').map(t=>{const m=/^([a-z_]+)\.ilike\.([^(),]*)$/.exec(t);if(!m)throw Error('Unsafe search');return ident(m[1])+' ilike '+bind(m[2].replaceAll('*','%'));});where.push('('+terms.join(' or ')+')');continue;
   }
   const col=ident(key);
   if(value.startsWith('eq.'))where.push(col+' = '+bind(value.slice(3)));
   else if(value.startsWith('gte.'))where.push(col+' >= '+bind(value.slice(4)));
   else if(value.startsWith('lt.'))where.push(col+' < '+bind(value.slice(3)));
   else if(value.startsWith('ilike.'))where.push(col+' ilike '+bind(value.slice(6).replaceAll('*','%')));
   else if(value.startsWith('ilike(any).{'))where.push('('+value.slice(12,-1).split(',').map(v=>col+' ilike '+bind(v.replaceAll('*','%'))).join(' or ')+')');
   else if(value.startsWith('in.('))where.push(col+' in ('+value.slice(4,-1).split(',').map(bind).join(',')+')');
   else throw Error('Unsupported fixture filter '+key);
  }
  const clause=where.length?' where '+where.join(' and '):'';
  if(init.method==='POST'){
   const row=JSON.parse(init.body),cols=Object.keys(row),args=cols.map(k=>row[k]&&typeof row[k]==='object'?JSON.stringify(row[k]):row[k]);
   const r=await db.query('insert into '+table+'('+cols.map(ident).join(',')+') values('+cols.map((_,i)=>'$'+(i+1)).join(',')+') returning *',args);return Response.json(r.rows,{status:201});
  }
  if(init.method==='PATCH'){
   const row=JSON.parse(init.body),set=Object.keys(row).map(k=>ident(k)+' = '+bind(row[k]));const r=await db.query('update '+table+' set '+set.join(',')+clause+' returning *',params);return Response.json(r.rows);
  }
  if(init.method&&init.method!=='GET')throw Error('Fixture denies unsupported write');
  const total=(await db.query('select count(*) total from '+table+clause,params)).rows[0].total;
  const order=q.has('order')?' order by '+q.get('order').split(',').map(s=>{const [key,dir]=s.split('.');if(!['asc','desc'].includes(dir))throw Error('Invalid order');return ident(key)+' '+dir;}).join(','):'';
  const select=(q.get('select')||'*').split(',').map(s=>s==='*'?'*':ident(s)).join(',');
  const r=await db.query('select '+select+' from '+table+clause+order+' limit '+bind(Number(q.get('limit')||1000))+' offset '+bind(Number(q.get('offset')||0)),params);
  return Response.json(r.rows,{headers:{'content-range':`0-${r.rows.length-1}/${total}`}});
 });chain=job.catch(()=>{});return job;};
 return {db,handler,context,users,schema,close:()=>db.close()};
}
