import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const functions=['workLogSelectableProjects','workLogProjectTitleField','syncWorkLogProjectNames'];
const code=functions.map(name=>source.split('\n').find(line=>line.startsWith('function '+name+'('))).join('\n');
test('new work-log initial and refreshed choices exclude completed while preserving customer and grants',()=>{
 const state={projects:[{id:'p1',customerId:'c1',status:'in_progress',name:'施工',code:'P1'},{id:'p2',customerId:'c1',status:'completed',name:'完工',code:'P2'},{id:'p3',customerId:'c2',status:'in_progress',name:'其他客戶'},{id:'p4',customerId:'c1',status:'in_progress',name:'未授權'}],currentUser:{project_scoped:false},projectAccess:[{project_id:'p1',can_create_work_log:true},{project_id:'p2',can_create_work_log:true}]};
 const list={tagName:'DATALIST'},form={elements:{customerId:{value:'c1'}},querySelector:()=>list};
 const ctx=vm.createContext({state,esc:v=>v||'',document:{querySelector:()=>form}});
 vm.runInContext(code,ctx);
 assert.deepEqual(Array.from(ctx.workLogSelectableProjects('c1'),p=>p.id),['p1','p4']);
 const initial=ctx.workLogProjectTitleField('c1');assert.ok(initial.includes('施工'));assert.ok(!initial.includes('完工'));assert.ok(initial.includes('<input'));
 ctx.syncWorkLogProjectNames();assert.ok(!list.innerHTML.includes('完工'));
 state.currentUser.project_scoped=true;list.tagName='SELECT';
 assert.deepEqual(Array.from(ctx.workLogSelectableProjects('c1'),p=>p.id),['p1']);
 ctx.syncWorkLogProjectNames();assert.ok(!list.innerHTML.includes('未授權'));assert.ok(list.innerHTML.includes('施工'));
 assert.ok(ctx.workLogProjectTitleField('c1','完工',true).includes('value="完工"'),'existing read-only log keeps its title');
 assert.ok(ctx.workLogProjectTitleField('c1','完工',true).includes('readonly'));
});
test('classification uses a separate sub-tab and preserves original list and shared project type',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(html,/data-project-tab="construction">工程施工分類/);
 assert.match(html,/id="projectTable"/);assert.match(html,/id="projectPagination"/);
 assert.match(source,/project_type:data.type,construction_category:/);
 assert.match(source,/rawType==="construction"/);
 assert.match(source,/constructionCategory:payload.construction_category/);
});
