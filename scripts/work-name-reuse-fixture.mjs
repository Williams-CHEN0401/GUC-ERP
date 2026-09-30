// Existing Gateway + current SQL in a synthetic PGlite database. Never production.
import {appointmentsServer} from './appointments-fixture.mjs';
import {sql} from './worklog-save-fixture.mjs';
export const workNameReuseMigration='20260930151330_reuse_deleted_work_names.sql';
export async function workNameReuseServer({fixed=true}={}){
 const fixture=await appointmentsServer();
 // The minimal base uses an equivalent index with a fixture-only name.
 await fixture.db.exec('alter index public.project_name_uq rename to projects_customer_normalized_name_uidx');
 if(fixed)await fixture.db.exec(await sql(workNameReuseMigration));
 // Match the production Gateway's projects?deleted_at=is.null read boundary.
 // Other historical fixtures deliberately include deleted projects for old-log tests.
 const fallback=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');
 fixture.server.on('request',async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(req.method==='GET'&&url.pathname==='/api/inventory'&&url.searchParams.get('scope')==='worklogs'){
   try{
    const data=await fixture.snapshot('worklogs');data.projects=data.projects.filter(row=>!row.deleted_at);
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify(url.searchParams.get('options_only')==='1'?fixture.gatewayContext.referenceSnapshot(data):data));
   }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
   return;
  }
  return fallback(req,res);
 });
 return fixture;
}
if(process.argv[1]?.endsWith('work-name-reuse-fixture.mjs')){
 const {server}=await workNameReuseServer();
 server.listen(4236,'127.0.0.1',()=>console.log('http://127.0.0.1:4236/?page=worklogs — 隔離名稱重用測試，不寫入正式 DB/NAS'));
}
