import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../assignment-ui.js',import.meta.url),'utf8');
function harness(){
 const nodes=new Map(),listeners=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'all',textContent:'',hidden:false,label:{hidden:true},closest(){return this.label;},addEventListener(){}});return nodes.get(id);};
 const state={currentUser:{id:'admin',role:'admin'},dashboard:{assignments:{pending:[],completed:[]}}};
 const context=vm.createContext({state,document:{querySelector:node,addEventListener:(name,fn)=>listeners.push([name,fn])},window:{addEventListener(){}},setInterval(){},canAdmin:()=>state.currentUser.role==='admin',esc:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),assignmentPlanningSummary:()=>'',appointmentTypeLabel:()=> '預約',constructionAssignmentAction:(row,options)=>JSON.stringify(options)});
 context.renderDashboard=()=>context.assignmentPendingRows();
 vm.runInContext(source,context);
 const choose=value=>{node('#assignmentScope').value=value;for(const[name,fn]of listeners)if(name==='change')fn({target:{id:'assignmentScope',value,closest:()=>null}});};
 return {context,state,node,choose};
}
test('every Dashboard uses the assignee ID, including admins with stale all-person data',()=>{
 const h=harness(),mine={id:'mine',assignee_user_id:'admin'},other={id:'other',assignee_user_id:'worker'};
 h.state.dashboard.assignments={pending:[mine,other],all_pending:[mine,other]};
 assert.deepEqual(h.context.assignmentPendingRows(),[mine]);
 assert.equal(h.node('#pendingAssignmentTitle').textContent,'我的待辦');
 h.state.currentUser={id:'worker',role:'operator'};
 assert.deepEqual(h.context.assignmentPendingRows(),[other]);
 h.state.currentUser={id:'unassigned',role:'admin'};
 assert.equal(h.context.assignmentPendingRows().length,0);
});
test('other-person cards are read-only, names are escaped, and own entries beyond personal page still complete',()=>{
 const h=harness(),row={id:'beyond-page',assignment_type:'general',assignee_user_id:'admin',assignee:'<人員>',creator:'<管理員>',project:'工作',instructions:'測試'};
 assert.match(h.context.assignmentPendingCard(row),/data-complete-assignment="beyond-page"/);
 const other=h.context.assignmentPendingCard({...row,assignee_user_id:'other'});
 assert.doesNotMatch(other,/data-complete-assignment/);assert.match(other,/負責人：&lt;人員>/);
 assert.doesNotMatch(other,/<人員>|<管理員>/);
 assert.equal(JSON.parse(h.context.assignmentPendingCard({...row,assignment_type:'construction'})).readOnly,true);
 h.state.dashboard.assignments.pending=[row];
 assert.equal(JSON.parse(h.context.assignmentPendingCard({...row,assignment_type:'construction'})).readOnly,false);
});

test('one multi-person request renders once, preserves order and targets the current person even when not first',()=>{
 const h=harness(),first={id:'other',assignment_request_id:'request-1',created_by_user_id:'creator',assignment_type:'general',assignee_user_id:'worker',assignee:'柏翰',creator:'Williams',project:'電話查修',instructions:'查修讀卡機',status:'pending'};
 const mine={...first,id:'mine',assignee_user_id:'admin',assignee:'賜勝',status:'in_progress',row_version:4};
 const separate={...first,id:'separate',assignment_request_id:'request-2'};
 const input=[first,separate,mine],before=JSON.stringify(input),grouped=h.context.groupPendingAssignments(input);
 assert.equal(grouped.length,2);assert.equal(grouped[0].assignee,'柏翰、賜勝');assert.equal(grouped[1].id,'separate');
 assert.equal(grouped[0].assignment_members[1],mine);assert.equal(JSON.stringify(input),before);
 const html=h.context.assignmentPendingCard(grouped[0]);
 assert.match(html,/負責人：柏翰、賜勝/);assert.match(html,/data-complete-assignment="mine">完成我的指派/);
 assert.equal((html.match(/<article/g)||[]).length,1);assert.doesNotMatch(html,/data-complete-assignment="other"/);
 // Completion removes only the current user's raw row; the coworker remains.
 const remaining=h.context.groupPendingAssignments(input.filter(row=>row.id!==mine.id));
 assert.equal(remaining[0].assignment_members[0],first);assert.doesNotMatch(h.context.assignmentPendingCard(remaining[0]),/data-complete-assignment/);
});

test('grouping retains separate requests, creators, legacy rows and construction cards',()=>{
 const h=harness(),base={id:'a',assignment_type:'general',assignment_request_id:'r',created_by_user_id:'creator',assignee:'<A>',instructions:'same'};
 const rows=[base,{...base,id:'b',assignment_request_id:'other'}, {...base,id:'c',created_by_user_id:'other'}, {...base,id:'d',assignment_request_id:null}, {...base,id:'e',assignment_request_id:null}, {...base,id:'plan',assignment_type:'construction'}];
 assert.equal(h.context.groupPendingAssignments(rows).length,rows.length);
 const html=h.context.assignmentPendingCard(h.context.groupPendingAssignments([base,{...base,id:'f',assignee:'<B>'}])[0]);
 assert.match(html,/&lt;A>、&lt;B>/);assert.doesNotMatch(html,/<A>|<B>/);
 assert.equal(h.context.groupPendingAssignments([]).length,0);
});

test('Dashboard grouping never includes coworkers and pickup quantity remains per assignee',()=>{
 const h=harness(),other={id:'other',assignment_type:'pickup',assignment_request_id:'r',created_by_user_id:'creator',assignee_user_id:'worker',assignee:'施工人員',item:'設備',pickup_quantity:2};
 const mine={...other,id:'mine',assignee_user_id:'admin',assignee:'管理員'};
 h.state.dashboard.assignments={pending:[mine],all_pending:[other,mine],completed:[]};
 const groups=h.context.groupPendingAssignments(h.context.assignmentPendingRows());
 assert.equal(groups.length,1);assert.equal(groups[0].assignment_members.length,1);
 assert.match(h.context.assignmentPendingCard(groups[0]),/取貨：設備 × 2/);
});
