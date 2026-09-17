import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../assignment-ui.js',import.meta.url),'utf8');
const row=()=>({id:'assignment-1',row_version:1,project:'隔離工作',assignment_type:'general',created_by_user_id:'creator'});
function harness(overrides={}){
 const nodes=new Map(),events={},calls={posts:[],loads:[],pages:[],toasts:[],pickupTabs:0};
 const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',disabled:false,open:false,attrs:{},listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},showModal(){this.open=true;},close(){this.open=false;},setAttribute(name,value){this.attrs[name]=value;},querySelectorAll(){return[];},querySelector(){return null;}});return nodes.get(id);};
 const dialog=node('#assignmentCompletionDialog');
 const state={currentUser:{id:'assignee'},dashboard:{assignments:{pending:[row()],completed:[]}}};
 const context=vm.createContext({
  document:{hidden:false,addEventListener:(name,fn)=>events[name]=fn,querySelector:selector=>selector.startsWith('#')?node(selector):selector.startsWith('[data-tabs')?{click(){calls.pickupTabs++;}}:null},
  window:{addEventListener:(name,fn)=>events[name]=fn},setInterval:(fn,delay)=>{events.interval=fn;events.delay=delay;},state,
  PREVIEW_MODE:false,accessToken:'synthetic-test-only',loadedScopes:new Set(['dashboard']),scopeRequests:new Map(),
  currentPage:()=> 'dashboard',requestedPageFromUrl:()=> 'dashboard',canPage:()=>true,canModule:()=>true,
  renderDashboard(){},showToast:(...args)=>calls.toasts.push(args),
  apiRequest:async request=>{calls.posts.push(request);return{result:{assignment:{...row(),status:'completed',completed_at:'2026-09-17T01:00:00Z'}}};},
  loadScope:async(scope,options)=>{calls.loads.push({scope,...options});return{errors:[]};},
  switchPage:async page=>calls.pages.push(page),...overrides
 });
 vm.runInContext(source,context);
 return{context,state,calls,node,dialog,events,run:code=>vm.runInContext(code,context),open:(r=row())=>context.openAssignmentCompletion(r)};
}
test('completion waits for persisted response then offers existing pages; no follow-up record created',async()=>{
 const h=harness();h.open();assert.equal(h.dialog.open,true);assert.equal(h.calls.posts.length,0);
 await h.context.saveAssignmentCompletion();
 assert.equal(h.calls.posts.length,1);assert.equal(h.calls.posts[0].operation,'complete_work_assignment');
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls.posts[0].payload)),{id:'assignment-1',row_version:1});
 assert.match(h.node('#assignmentCompletionTitle').textContent,/已完成/);assert.match(h.node('#assignmentCompletionActions').innerHTML,/新增工作日誌.*登錄取貨.*稍後/);
 assert.equal(h.state.dashboard.assignments.pending.length,0);assert.equal(h.state.dashboard.assignments.completed.length,0);
 await h.context.followUpAssignment('worklog');assert.deepEqual(h.calls.pages,['worklogs']);assert.equal(h.dialog.open,false);assert.equal(h.calls.posts.length,1);
});
test('completion double click sends once and cannot navigate before saved',async()=>{
 let release,requests=0;const h=harness({apiRequest:()=>{requests++;return new Promise(resolve=>release=resolve);}});h.open();
 const save=h.context.saveAssignmentCompletion();await h.context.saveAssignmentCompletion();await h.context.followUpAssignment('pickup');
 assert.equal(h.run('assignmentCompletionBusy'),true);assert.equal(h.calls.pages.length,0);assert.equal(requests,1);
 assert.match(h.node('#assignmentCompletionStatus').textContent,/正在處理/);
 release({result:{assignment:{...row(),status:'completed',completed_at:'2026-09-17'}}});await save;
 await h.context.saveAssignmentCompletion();assert.equal(h.run('assignmentCompletionBusy'),false);assert.equal(requests,1);assert.equal(h.node('#assignmentCompletionStatus').textContent,'');
});
test('RPC failure is visible, keeps pending and allows retry, no success/navigation',async()=>{
 const h=harness({apiRequest:async()=>{throw Error('工作指派已被其他使用者更新');}});h.open();await h.context.saveAssignmentCompletion();
 assert.match(h.node('#assignmentCompletionError').textContent,/其他使用者更新/);assert.equal(h.state.dashboard.assignments.pending.length,1);
 assert.equal(h.run('assignmentCompletionSaved'),false);assert.equal(h.run('assignmentCompletionBusy'),false);
 await h.context.followUpAssignment('pickup');assert.equal(h.calls.pages.length,0);assert.equal(h.calls.toasts.length,1);
});
test('uncertain timeout and malformed success never claim completion',async()=>{
 for(const apiRequest of [async()=>{throw Object.assign(Error('timeout'),{status:504});},async()=>({result:{}})]){
  const h=harness({apiRequest});h.open();await h.context.saveAssignmentCompletion();assert.equal(h.run('assignmentCompletionSaved'),false);assert.match(h.node('#assignmentCompletionError').textContent,/確認/);
 }
});
test('committed save with failed reread stays completed and never resubmits',async()=>{
 for(const loadScope of [async()=>{throw Error('refresh offline');},async()=>({errors:['部分失敗']})]){
  const h=harness({loadScope});h.open();await h.context.saveAssignmentCompletion();assert.equal(h.run('assignmentCompletionSaved'),true);
  assert.match(h.node('#assignmentCompletionError').textContent,/工作已完成.*無需再次完成/);
  await h.context.saveAssignmentCompletion();assert.equal(h.calls.posts.length,1);
 }
});
test('drains older dashboard request before fresh reread',async()=>{
 let release;const h=harness();h.context.scopeRequests.set('dashboard',new Promise(resolve=>release=resolve));h.open();
 const save=h.context.saveAssignmentCompletion();await Promise.resolve();assert.equal(h.calls.loads.length,0);
 release();await save;assert.deepEqual(h.calls.loads,[{scope:'dashboard',force:true,silent:true}]);
});
test('pickup assignments offer view only; navigation selects pickup tab without creating records',async()=>{
 const h=harness();h.open({...row(),assignment_type:'pickup'});await h.context.saveAssignmentCompletion();
 assert.match(h.node('#assignmentCompletionActions').innerHTML,/查看取貨/);assert.doesNotMatch(h.node('#assignmentCompletionActions').innerHTML,/登錄取貨/);
 await h.context.followUpAssignment('pickup');assert.deepEqual(h.calls.pages,['transactions']);assert.equal(h.calls.pickupTabs,1);assert.equal(h.calls.posts.length,1);
});
test('general pickup navigation, permission denial and page failure preserve completion',async()=>{
 const h=harness();h.open();await h.context.saveAssignmentCompletion();await h.context.followUpAssignment('pickup');assert.equal(h.calls.pickupTabs,1);
 const denied=harness({canModule:()=>false});denied.open();await denied.context.saveAssignmentCompletion();
 assert.match(denied.node('#assignmentCompletionActions').innerHTML,/disabled.*權限/);await denied.context.followUpAssignment('pickup');await denied.context.followUpAssignment('worklog');assert.equal(denied.calls.pages.length,0);
 const failed=harness({switchPage:async()=>{throw Error('offline');}});failed.open();await failed.context.saveAssignmentCompletion();await failed.context.followUpAssignment('worklog');
 assert.equal(failed.dialog.open,true);assert.match(failed.node('#assignmentCompletionError').textContent,/工作已完成.*頁面載入失敗/);assert.equal(failed.calls.posts.length,1);
});
test('creator completing their own assignment gets a notice only once',async()=>{
 const h=harness();h.state.currentUser.id='creator';h.open();await h.context.saveAssignmentCompletion();await h.context.saveAssignmentCompletion();assert.equal(h.state.dashboard.assignments.completed.length,1);
});
test('acknowledgement failure is visible and reread failure does not restore acknowledged notice',async()=>{
 for(const failSave of [true,false]){
  const h=harness({...(failSave?{apiRequest:async()=>{throw Error('無權確認');}}:{loadScope:async()=>{throw Error('offline');}})});
  h.state.dashboard.assignments.completed=[row()];const button={disabled:false};await h.context.acknowledgeAssignmentCompletion(row(),button);
  assert.equal(button.disabled,false);assert.equal(h.state.dashboard.assignments.completed.length,failSave?1:0);
  assert.match(h.calls.toasts[0][0],failSave?/無權確認/:/通知已確認/);
 }
});
test('dashboard polling is scoped to visible selected dashboard, not login/chooser/other pages or modal',async()=>{
 const h=harness();assert.equal(h.events.delay,30000);await h.events.interval();assert.equal(h.calls.loads.length,1);
 const guards=[()=>{h.context.document.hidden=true;},()=>{h.context.accessToken='';},()=>{h.context.currentPage=()=> 'worklogs';},()=>{h.context.requestedPageFromUrl=()=>'';},()=>{h.dialog.open=true;},()=>{h.context.canPage=()=>false;},()=>{h.context.document.querySelector=()=>({});}];
 for(const guard of guards){h.context.document.hidden=false;h.context.accessToken='synthetic';h.context.currentPage=()=> 'dashboard';h.context.requestedPageFromUrl=()=> 'dashboard';h.dialog.open=false;h.context.canPage=()=>true;guard();await h.events.interval();assert.equal(h.calls.loads.length,1);}
});
test('cancel closes without writing; Escape cannot dismiss a save in progress',async()=>{
 const h=harness();h.open();await h.dialog.listeners.click({target:{closest:()=>({dataset:{assignmentAction:'close'}})}});assert.equal(h.dialog.open,false);assert.equal(h.calls.posts.length,0);
 h.run('assignmentCompletionBusy=true');let blocked=false;h.dialog.listeners.cancel({preventDefault(){blocked=true;}});assert.equal(blocked,true);
});
test('migration replaces only the completion audit action and preserves signature/body/ACL',()=>{
 const old=readFileSync(new URL('../supabase/migrations/20260916232954_work_assignments_dashboard.sql',import.meta.url),'utf8');
 const fix=readFileSync(new URL('../supabase/migrations/20260917041026_fix_work_assignment_completion_audit.sql',import.meta.url),'utf8');
 const fn=source=>source.match(/create or replace function public\.complete_work_assignment_v1\([\s\S]*?\n\$\$;/)[0].replaceAll('\r','');
 assert.equal(fn(fix),fn(old).replace("v_assignment.id, 'complete'","v_assignment.id, 'update'"));
 assert.match(fix,/from public, anon, authenticated/);assert.match(fix,/to service_role/);assert.doesNotMatch(fix,/alter table|drop table|truncate/i);
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');assert.match(app,/loadPageData\(name,\{force:name==="dashboard"\}\)/);
 assert.doesNotMatch(app,/completeAssignment&&confirm/);
});
