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
test('admin defaults to all after async data arrives, preserves chosen scope, and resets for another account',()=>{
 const h=harness(),mine={id:'mine'},other={id:'other'};
 h.state.dashboard.assignments.pending=[mine];
 assert.deepEqual(h.context.assignmentPendingRows(),[mine]);
 h.state.dashboard.assignments.all_pending=[mine,other];
 assert.deepEqual(h.context.assignmentPendingRows(),[mine,other]);
 assert.equal(h.node('#pendingAssignmentTitle').textContent,'所有人的待辦');
 h.choose('mine');assert.deepEqual(h.context.assignmentPendingRows(),[mine]);
 h.state.dashboard.assignments.all_pending=[mine,other,{id:'new'}];
 assert.deepEqual(h.context.assignmentPendingRows(),[mine]);
 h.state.currentUser.id='second-admin';assert.equal(h.context.assignmentPendingRows().length,3);
});
test('non-admin cannot select all even if stale privileged data remains in memory',()=>{
 const h=harness();h.state.dashboard.assignments={pending:[{id:'mine'}],all_pending:[{id:'private'}]};
 h.context.assignmentPendingRows();h.state.currentUser={id:'worker',role:'operator'};
 h.choose('all');assert.deepEqual(h.context.assignmentPendingRows(),[{id:'mine'}]);
 assert.equal(h.node('#assignmentScope').label.hidden,true);
 assert.equal(h.node('#assignmentScope').value,'mine');
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
