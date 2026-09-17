// Real project and assignment RPCs. Strict SQL-backed REST reads reject columns
// absent from the production-shaped fixture, unlike canned snapshot mocks.
import {titlePickerDatabase} from './worklog-title-fixture.mjs';
import {ids,sql,saveLog,sample} from './worklog-save-fixture.mjs';
export const assignmentMigration='20260917003129_work_assignment_manual_project.sql';
export async function assignmentDatabase(){
 const db=await titlePickerDatabase();
 await db.exec(`
 alter table repair_items add created_at timestamptz default now();
 alter table inventory_items add item_name text default '隔離品項',add brand text,add model text,
 add inventory_code text default 'TEST-001',add unit text default '台';
 alter table customer_contract_services add is_active boolean default true;
 create table contract_service_types(id uuid primary key,code text,name text,is_active boolean default true,sort_order integer default 1);
 alter table pickup_records add pickup_date date,add inventory_item_id uuid references inventory_items,
 add quantity numeric,add source text,add updated_by text,add created_by_user_id uuid,add created_by_username text;
 grant select on contract_service_types to service_role;
 `);
 await db.query("insert into contract_service_types(id,code,name) values($1,'computer','電腦設備')",[ids.service]);
 await db.exec(await sql('20260916232954_work_assignments_dashboard.sql'));
 await db.exec(await sql('20260916233046_index_work_assignments_inventory_item.sql'));
 await db.exec(await sql(assignmentMigration));
 const previousDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()-86400000));
 await saveLog(db,{...sample(),log_date:previousDate,maintenance_events:[]});
 return db;
}
export async function restRead(db,path){
 const url=new URL(path,'http://isolated.invalid/'),table=url.pathname.slice(1),params=url.searchParams,values=[];
 const identifier=value=>{if(!/^[a-z_][a-z_0-9]*$/.test(value))throw Error('Unsafe fixture identifier: '+value);return '"'+value+'"';};
 const bind=value=>{values.push(value);return '$'+values.length;};
 const select=(params.get('select')||'*').split(',').map(x=>x==='*'?'*':identifier(x)).join(',');
 const where=[];
 for(const [key,value] of params){
  if(['select','order','limit','offset'].includes(key))continue;
  const column=identifier(key);
  if(value==='is.null')where.push(column+' is null');
  else if(value.startsWith('eq.'))where.push(column+' = '+bind(value.slice(3)));
  else if(value.startsWith('neq.'))where.push(column+' <> '+bind(value.slice(4)));
  else if(/^in\.\(.*\)$/.test(value))where.push(column+' in ('+value.slice(4,-1).split(',').map(bind).join(',')+')');
  else throw Error('Unsupported isolated filter: '+value);
 }
 let query='select '+select+' from '+identifier(table)+(where.length?' where '+where.join(' and '):'');
 if(params.has('order'))query+=' order by '+params.get('order').split(',').map(part=>{const [column,direction='asc']=part.split('.');if(!['asc','desc'].includes(direction))throw Error('Invalid order');return identifier(column)+' '+direction;}).join(',');
 query+=' limit '+bind(Number(params.get('limit')||1000))+' offset '+bind(Number(params.get('offset')||0));
 const rows=(await db.query(query,values)).rows;
 return rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date&&['log_date','received_on','project_date','pickup_date'].includes(key)?value.toISOString().slice(0,10):value])));
}
