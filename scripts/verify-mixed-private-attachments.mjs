
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import nasApi from '../api/nas.mjs';
import {accessAppointmentsServer} from './erp-access-fixture.mjs';
import {worklogAttachmentsServer} from './worklog-attachments-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';
import {ids} from './worklog-save-fixture.mjs';
import {withWebsiteAccess} from './website-access-test-helper.mjs';

const fixture=await worklogAttachmentsServer(accessAppointmentsServer);
const {db,nas,gatewayContext,gatewayHandler,historical}=fixture;
const admin=ids.actor,member='10000000-0000-4000-8000-000000000007';
const project=historical.work_log.project_id,privateLog=historical.work_log.id;
const authorization='Bearer isolated-attachment-test';
let actor=admin;
const rpc=(name,args)=>callAsService(db,name,args);
const context={customer_id:ids.customer,contract_service_type_id:ids.service,project_id:project};
const get=async values=>gatewayHandler(new Request('http://127.0.0.1/inventory-gateway?'+new URLSearchParams({scope:'nas_upload_context',...context,...values})));
const register=(target,rows)=>gatewayHandler(new Request('http://127.0.0.1/inventory-gateway',{
 method:'POST',body:JSON.stringify({operation:'create_contract_site_attachment_batch',payload:{...target,rows}})
}));
function formFor(mode,target){
 const body=new FormData();
 body.set('mode',mode);
 for(const [key,value] of Object.entries(target))body.set(key,value);
 return body;
}
async function post(body){
 const response=await nasApi.fetch(new Request('https://erp.fixture.test/api/nas',{method:'POST',headers:{Authorization:authorization},body}));
 return {status:response.status,data:await response.json()};
}
function uploadOptions(target,conflictChoice){
 const uploaded=[];
 return {
  uploaded, context:target, progress:()=>{},conflictChoice,
  async request(body){
   const {status,data}=await post(body);
   if(status>=400)throw Object.assign(new Error(data.error),{status});
   return data;
  },
  async register(rows){
   const response=await register(target,rows);
   assert.equal(response.status,201,await response.clone().text());
   uploaded.push(...rows);
  }
 };
}
const frontend=vm.createContext({FormData,File,Blob,crypto,Uint8Array});
vm.runInContext(readFileSync(new URL('../attachment-upload.js',import.meta.url),'utf8'),frontend);
async function hash(file){return createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex');}

try{
 await db.query("insert into app_users(id,username,display_name,role) values($1,'attachment-member','附件測試成員','operator')",[member]);
 for(const module of ['worklogs','site','equipment'])await db.query("insert into role_permissions values('operator',$1,true,true,false,false) on conflict(role_code,module) do update set can_view=true,can_create=true",[module]);
 await rpc('configure_erp_private_access_v1',[admin,admin,[],null]);
 const publicLog=randomUUID(),target={...context,work_log_id:publicLog};
 await db.query("insert into site_work_logs(id,project_id,site_id,log_date,reporter_user_id,title,summary,work_type) values($1,$2,$3,'2026-09-16',$4,'成員日誌','成員日誌','維修紀錄')",[publicLog,project,historical.work_log.site_id,member]);
 await db.exec("alter table site_assets add constraint mixed_attachment_fixture_log_fk foreign key (work_log_id) references site_work_logs(id)");
 gatewayContext.currentUser=withWebsiteAccess(async()=>{
  const user=(await db.query('select * from app_users where id=$1',[actor])).rows[0];
  user.permissions=(await db.query('select * from role_permissions where role_code=$1',[user.role])).rows;
  user.project_scoped=false;
  await gatewayContext.initializePrivateAccess(user);
  return user;
 });
 const filename='shared-photo.jpg';
 const original=new File([Buffer.from('private file bytes')],filename,{type:'image/jpeg'});
 const originalOptions=uploadOptions({...context,work_log_id:privateLog},()=>{throw Error('Unexpected conflict');});
 const seeded=await frontend.transferNasFiles({...originalOptions,files:[original]});
 assert.equal(seeded.uploaded.length,1,JSON.stringify(seeded.failed));
 const originalRow=seeded.uploaded[0],path=originalRow.nas_path;
 const storedOriginal=(await db.query('select * from site_assets where nas_path=$1',[path])).rows[0];
 assert.equal(storedOriginal.work_log_id,privateLog);
 actor=member;
 const scope=await rpc('erp_private_scope_v1',[member]);
 assert(scope.mutation_project_ids.includes(project));
 assert(scope.blocked_ids.includes(privateLog));
 assert(scope.blocked_ids.includes(storedOriginal.id));
 assert(!scope.blocked_ids.includes(project)&&!scope.blocked_ids.includes(publicLog));

 assert.equal((await get({work_log_id:publicLog})).status,403,'old NAS contract still fails closed');
 const policy={attachment_policy:'create_only_v1'};
 const allowed=await get({...policy,work_log_id:publicLog});
 assert.equal(allowed.status,200,await allowed.clone().text());
 const body=await allowed.json();
 assert.equal(body.can_overwrite,false);
 assert.deepEqual(body.protected_paths,[]);
 assert(!JSON.stringify(body).includes(path));
 assert.equal((await get({...policy,work_log_id:privateLog})).status,403);
 assert.equal((await get({...policy,work_log_id:randomUUID()})).status,400,'a different or missing log is denied');
 const projectScope=await get(policy);
 assert.equal(projectScope.status,200);
 assert.equal((await projectScope.json()).can_overwrite,false);

 const fresh=new File([Buffer.from('member bytes')],'fresh-photo.jpg',{type:'image/jpeg'});
 const colliding=new File([Buffer.alloc(5*1024*1024,9)],filename,{type:'image/jpeg'});
 const prepared=await (async()=>{
  const form=formFor('prepare_batch',target);
  form.set('file_metadata',JSON.stringify([{name:filename,size:fresh.size}]));
  return post(form);
 })();
 assert.equal(prepared.status,200,JSON.stringify(prepared.data));
 assert.equal(prepared.data.files[0].can_overwrite,false);

 const attempted=new File([Buffer.from('member bytes')],filename,{type:'image/jpeg'});
 const badUpload=formFor('upload',target);
 badUpload.set('preflight_ticket',prepared.data.file_tickets[0]);
 badUpload.set('conflict_actions',JSON.stringify({[filename]:'overwrite'}));
 badUpload.append('files',attempted);
 const blocked=await post(badUpload);
 assert.equal(blocked.status,409);
 assert.match(blocked.data.error,/不可覆蓋/);
 assert.deepEqual(nas.files.get(path),Buffer.from(await original.arrayBuffer()));

 const begin=formFor('begin_file',target);
 for(const [key,value] of Object.entries({preflight_ticket:prepared.data.file_tickets[0],file_name:filename,file_size:String(attempted.size),sha256:await hash(attempted),conflict_action:'overwrite'}))begin.set(key,value);
 const deniedChunk=await post(begin);
 assert.equal(deniedChunk.status,409);
 assert.match(deniedChunk.data.error,/不可覆蓋/);

 const options=uploadOptions(target,conflict=>{
  assert.equal(conflict.can_overwrite,false);
  return 'rename';
 });
 const result=await frontend.transferNasFiles({...options,files:[fresh,colliding]});
 assert.equal(result.uploaded.length,2,JSON.stringify(result.failed));
 assert.equal(result.failed.length,0);
 const newRow=result.uploaded.find(row=>row.original_name==='fresh-photo.jpg');
 const renamed=result.uploaded.find(row=>row.original_name===filename);
 assert.notEqual(renamed.nas_path,path);
 assert.equal(renamed.conflict_resolution,'rename');
 assert.deepEqual(nas.files.get(renamed.nas_path),Buffer.from(await colliding.arrayBuffer()));
 const saved=(await db.query('select * from site_assets where id=$1',[newRow.id])).rows[0];
 assert.equal(saved.work_log_id,publicLog);
 const retry=await register(target,[newRow]);
 assert.equal(retry.status,201,await retry.clone().text());
 assert.deepEqual((await db.query('select * from site_assets where id=$1',[newRow.id])).rows[0],saved);
 for(const attachmentTarget of [target,context]){
  const reindex=await register(attachmentTarget,[{...originalRow,id:randomUUID(),work_log_id:undefined,conflict_resolution:'new'}]);
  assert(reindex.status>=400);
  assert.deepEqual((await db.query('select * from site_assets where nas_path=$1',[path])).rows[0],storedOriginal);
 }
 const detached=uploadOptions(context,()=>{throw Error('Unexpected conflict');});
 const resultDetached=await frontend.transferNasFiles({...detached,files:[new File(['project only'],'project-photo.jpg',{type:'image/jpeg'})]});
 assert.equal(resultDetached.uploaded.length,1,JSON.stringify(resultDetached.failed));
 assert.equal((await db.query('select work_log_id from site_assets where id=$1',[resultDetached.uploaded[0].id])).rows[0].work_log_id,null);
 const copy=(await db.query('select * from site_assets where id=$1',[storedOriginal.id])).rows[0];
 assert.deepEqual(copy,storedOriginal);
 assert.deepEqual(nas.files.get(path),Buffer.from(await original.arrayBuffer()));

 // A ticket issued while overwrite is allowed must not survive a privacy change.
 const configure=async viewers=>{
  const version=(await db.query('select row_version from erp_private_access')).rows[0].row_version;
  await rpc('configure_erp_private_access_v1',[admin,admin,viewers,version]);
 };
 await configure([member]);
 const preflight=formFor('prepare_batch',context);
 preflight.set('file_metadata',JSON.stringify([{name:filename,size:attempted.size}]));
 const directBatch=await post(preflight);
 assert.equal(directBatch.status,200,JSON.stringify(directBatch.data));
 assert.notEqual(directBatch.data.files[0].can_overwrite,false);
 const directBegin=formFor('begin_file',context);
 const metadata={preflight_ticket:directBatch.data.file_tickets[0],file_name:filename,file_size:String(attempted.size),sha256:await hash(attempted),conflict_action:'overwrite',inline_tail:'true'};
 for(const [key,value] of Object.entries(metadata))directBegin.set(key,value);
 const beforeRevocation=await post(directBegin);
 assert.equal(beforeRevocation.status,200,JSON.stringify(beforeRevocation.data));
 await configure([]);
 const complete=formFor('complete_file',context);
 complete.set('upload_ticket',beforeRevocation.data.upload_ticket);
 complete.set('tail',attempted);
 const revoked=await post(complete);
 assert.equal(revoked.status,409);
 assert.match(revoked.data.error,/不可覆蓋/);
 assert.deepEqual(nas.files.get(path),Buffer.from(await original.arrayBuffer()));
 const cancel=formFor('cancel_file',context);
 cancel.set('upload_ticket',beforeRevocation.data.upload_ticket);
 assert.equal((await post(cancel)).status,200);

 await db.exec("update role_permissions set can_create=false where role_code='operator' and module='equipment'");
 assert.equal((await get({...policy,work_log_id:publicLog})).status,403);
 assert.equal((await register(target,[newRow])).status,403);
 assert.equal((await post(badUpload)).status,403);
 const signatures=['register_contract_site_attachments_v2(uuid,uuid,uuid,jsonb,text)','register_work_log_attachments_v1(uuid,uuid,uuid,uuid,jsonb,text)'];
 for(const signature of signatures){
  const {rows:[grants]}=await db.query("select has_function_privilege('service_role',$1,'execute') service, has_function_privilege('anon',$1,'execute') anon, has_function_privilege('authenticated',$1,'execute') authenticated",[signature]);
  assert.deepEqual(grants,{service:true,anon:false,authenticated:false});
 }
 console.log('PASS real isolated Gateway/SQL and memory NAS: mixed-project member uploads, chunked rename, overwrite and private-attachment reindex denial, repeat register, private log and permission denial.');
}finally{
 fixture.restore();
 await db.close();
}




