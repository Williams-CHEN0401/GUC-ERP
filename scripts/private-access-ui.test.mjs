import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
test('large private exclusions use bounded table RPC with trusted actor and preserve query options',()=>{
 const actorId='10000000-0000-4000-8000-000000000001';
 const scope={configured:true,direct:false,actorId,filters:{audit_logs:{id:Array.from({length:13000},(_,i)=>String(i+1))}}};
 const context=vm.createContext({URLSearchParams,privateContext:{getStore:()=>scope},uuid:value=>value===actorId?value:null});
 const source=read('supabase/functions/inventory-gateway/index.ts');
 vm.runInContext(stripTypeScriptTypes(source.slice(source.indexOf('function privateReadPath('),source.indexOf('function privateContainsId('))),context);
 const path='audit_logs?select=id,actor&order=id.desc&limit=30&offset=60';
 const result=context.privateReadRequest(path,{headers:{Range:'60-89'}});
 assert.equal(result.path,'rpc/private_select_audit_logs_v1?'+path.split('?')[1]);
 assert.equal(result.init.method,'POST');assert.equal(result.init.headers.Range,'60-89');
 assert.deepEqual(JSON.parse(result.init.body),{p_private_actor:actorId});assert.ok(result.path.length<6000);
 assert.equal(context.privateReadRequest(path,{method:'PATCH',body:'{}'}).path,path);
 scope.direct=true;assert.equal(context.privateReadRequest(path).path,path);
 scope.direct=false;scope.actorId='invalid';assert.throws(()=>context.privateReadRequest(path),/範圍/);
});
test('appointments use Taiwan day, exact reminder boundary and only open statuses',()=>{
 const source=read('customer-appointments.js'),context=vm.createContext({Intl,Date});
 vm.runInContext(source.slice(source.indexOf('function appointmentToday'),source.indexOf('function appointmentTypeLabel')),context);
 assert.equal(context.appointmentToday(new Date('2026-10-04T16:00:00Z')),'2026-10-05');
 for(const status of ['pending','in_progress']){
  const row={status,appointment_date:'2026-10-05',reminder_days:3};
  assert.equal(context.appointmentOverdue(row,'2026-10-07'),false);
  assert.equal(context.appointmentOverdue(row,'2026-10-08'),true);
 }
 for(const status of ['completed','cancelled'])assert.equal(context.appointmentOverdue({status,appointment_date:'2026-10-05',reminder_days:0},'2026-10-08'),false);
 assert.equal(context.appointmentOverdue({status:'pending',appointment_date:'2028-02-28',reminder_days:2},'2028-03-01'),true);
 assert.equal(context.appointmentOverdue({status:'pending',appointment_date:'2026-10-05',reminder_days:-1},'2026-10-08'),false);
});
test('private cache drops stale responses and clears cross-page records when ACL changes',()=>{
 const source=read('private-access.js'),state={currentUser:{id:'a',permissions:[],private_access:{visibility_version:3,direct:false}},customers:[{id:'private'}],siteData:{logs:[{id:'hidden'}]},dashboard:{}};
 const context=vm.createContext({state,loadedScopes:new Set(['crm']),lastSnapshot:{customers:state.customers}});
 vm.runInContext(source.slice(0,source.indexOf('const accessStatusLabel')),context);
 assert.equal(context.invalidatePrivateCache({current_user:{...state.currentUser,private_access:{visibility_version:2,direct:true}}}),false);
 assert.equal(state.customers.length,1);
 assert.equal(context.invalidatePrivateCache({current_user:{...state.currentUser,private_access:{visibility_version:4,direct:false}}}),true);
 assert.equal(state.customers.length,0);assert.equal(state.siteData.logs.length,0);assert.equal(context.loadedScopes.size,0);
});
test('custom role controls pages, worklog actions and readonly appointment form',()=>{
 const context=vm.createContext({state:{currentUser:{role:'qa_role',permissions:[{module:'worklogs',can_view:true,can_create:true},{module:'appointments',can_view:true}]}},document:{addEventListener(){}},byId:()=>null});
 vm.runInContext(read('permissions-ui.js'),context);
 assert.equal(context.canPage('worklogs'),true);assert.equal(context.canPage('transactions'),false);
 assert.equal(context.canModule('appointments','UPDATE'),false);
 const source=read('app.js');vm.runInContext(source.slice(source.indexOf('function workLogActionMenu'),source.indexOf('function renderWorkLogs')),context);
 assert.equal(context.workLogActionMenu({id:'log'}),'—');
 context.state.currentUser.permissions.push({module:'pickups',can_view:true,can_create:true});
 assert.match(context.workLogActionMenu({id:'log'}),/data-work-log-pickup/);
 assert.doesNotMatch(context.workLogActionMenu({id:'log'}),/data-work-log-attachment|data-delete-work-log/);
 context.state.currentUser.private_access={configured:true,can_configure:true,direct:true};
 assert.equal(context.canPage('settings'),true);
 context.state.currentUser.private_access={configured:true,direct:false,configuration:{owner_user_id:'owner',viewer_user_ids:['allowed']}};
 assert.equal(context.canManagePrivateIdentity('owner'),false);assert.equal(context.canManagePrivateIdentity('allowed'),false);assert.equal(context.canManagePrivateIdentity('other'),true);
});
