// Real Gateway + real SQL. Synthetic identities and loopback only.
import {independentRepairsServer} from './independent-repairs-fixture.mjs';
import {sql,ids} from './worklog-save-fixture.mjs';
import {restRead} from './work-assignment-fixture.mjs';
export const appointmentMigration='20260930103942_customer_appointments_worklog_attachments.sql';
export async function appointmentsServer(){
  const fixture=await independentRepairsServer(),{db,server,additionalRpcs,gatewayHandler,gatewayContext}=fixture;
  fixture.customerCategories.push({id:'government',code:'government',name:'政府機關'});
  await db.exec(await sql('20260917041026_fix_work_assignment_completion_audit.sql'));
  await db.exec(await sql(appointmentMigration));
  // Columns needed by actual Dashboard and master-data SELECTs, not canned responses.
  await db.exec(`alter table repair_items add column if not exists created_at timestamptz default now();
    alter table customers add column if not exists phone text,add column if not exists email text,add column if not exists address text,
    add column if not exists note text,add column if not exists created_at timestamptz default now(),add column if not exists updated_at timestamptz default now(),add column if not exists row_version integer default 1;
    create table if not exists customer_categories(id uuid primary key default gen_random_uuid(),code text,name text,row_version integer default 1,sort_order integer default 1,created_at timestamptz default now());
    insert into customer_categories(code,name) values('school','學校機關'),('government','政府機關');
    grant select on customer_categories to service_role;`);
  additionalRpcs.push('upsert_customer_appointment_v1','complete_work_assignment_v1','acknowledge_work_assignment_v1','create_work_assignment_v1','create_work_assignment_with_project_v1');
  gatewayContext.db=async(path,init={})=>{if(init.method&&init.method!=='GET')throw Error('Fixture denies REST writes');try{return Response.json((await restRead(db,path)).map(row=>({...row,...(row.appointment_date instanceof Date?{appointment_date:row.appointment_date.toISOString().slice(0,10)}:{})})));}catch(error){console.error('Fixture REST:',path,error.message);throw error;}};
  const fallback=server.listeners('request')[0];server.removeAllListeners('request');
  server.on('request',async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/api/inventory'&&((req.method==='GET'&&['appointments','dashboard'].includes(url.searchParams.get('scope')))||req.method==='POST')){
      try{
        let body='';if(req.method==='POST')for await(const chunk of req){body+=chunk;if(body.length>1000000)throw Error('Too large');}
        const request=new Request('http://127.0.0.1/inventory-gateway'+url.search,{method:req.method,headers:req.headers,...(body?{body}:{})});
        const response=await gatewayHandler(request);res.writeHead(response.status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(await response.text());
      }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
      return;
    }
    return fallback(req,res);
  });
  return fixture;
}
if(process.argv[1]?.endsWith('appointments-fixture.mjs')){
  const {server}=await appointmentsServer();server.listen(4233,'127.0.0.1',()=>console.log('http://127.0.0.1:4233/?page=appointments — 隔離資料庫，不連線正式 DB/NAS'));
}
