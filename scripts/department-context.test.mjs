import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8'),departments=readFileSync(new URL('../customer-departments.js',import.meta.url),'utf8');
const extract=name=>{const start=app.indexOf('function '+name+'('),end=app.indexOf('\nfunction ',start+1);return app.slice(start,end<0?undefined:end);};
function fixture(){
 const list={tagName:'DATALIST'},field={value:'資訊維護',dataset:{},readOnly:false},modal={dataset:{type:'workLogModal'}},form={elements:{projectName:field,customerId:{value:'c1'},departmentId:{value:'d1'},workType:{value:'工程施工'},status:{value:'in_progress'}},querySelector:selector=>selector==='#workLogProjectNames'?list:null};
 const state={projects:[{id:'p1',code:'P1',customerId:'c1',departmentId:'d1',name:'資訊維護',rawType:'maintenance',status:'in_progress'},{id:'p2',code:'P2',customerId:'c1',departmentId:'d2',name:'其他科室查修',rawType:'repair',status:'in_progress'},{id:'p3',code:'P3',customerId:'c1',departmentId:'d1',name:'已完成',status:'completed'}],pickups:[{id:'pickup1',projectId:'p3'}],customerDepartmentsReady:true,customerDepartments:[{id:'d1',customerId:'c1',name:'資訊室',active:true},{id:'d2',customerId:'c1',name:'數學系',active:true}]};
 const ctx=vm.createContext({state,document:{querySelector:selector=>selector==='#modalForm'?form:selector==='#simpleModal'?modal:null,addEventListener(){}},esc:v=>String(v??''),byId:(rows,id)=>rows.find(row=>row.id===id),matches:()=>true,valueText:v=>String(v).trim().toLowerCase(),syncWorkLogMaintenanceType(){},workTypeFromProjectType:type=>({maintenance:'維護保養',repair:'維修紀錄'}[type]||'工程施工')});
 vm.runInContext(departments,ctx);
 ctx.modalDepartmentFilter=()=>form.elements.departmentId.value;
 vm.runInContext(['isNewRepairWorkLog','workLogOriginalProject','workLogTitleDepartment','workLogFormCustomerId','workLogSelectableProjects','syncWorkLogProjectNames','syncWorkLogProjectDefaults','syncModalProjectOptions'].map(extract).join('\n'),ctx);
 return{ctx,state,field,form,list,modal};
}
test('department labels distinguish missing master data from actual legacy NULL',()=>{const {ctx}=fixture();assert.equal(ctx.customerDepartmentLabel(''),'尚未設定科室');assert.match(ctx.customerDepartmentLabel('missing'),/尚未載入/);assert.equal(ctx.customerDepartmentLabel('d1'),'資訊室');});

test('editing a work log retains customer title options without an editable customer field',()=>{
 const {ctx,state,field,form,list,modal}=fixture();
 state.siteData={logs:[{id:'log1',projectId:'p1'}]};modal.dataset.id='log1';
 delete form.elements.customerId;
 ctx.syncWorkLogProjectNames();
 assert.match(list.innerHTML,/資訊維護/);
 assert.doesNotMatch(list.innerHTML,/其他科室查修|已完成/);
 assert.equal(field.value,'資訊維護');
 field.value='手動輸入的新名稱';ctx.syncWorkLogProjectNames();
 assert.equal(field.value,'手動輸入的新名稱');
});
test('work-log defaults never come from another department with a typed title',()=>{
 const {ctx,field,form}=fixture();field.value='其他科室查修';ctx.syncWorkLogProjectDefaults();assert.equal(form.elements.workType.value,'工程施工');assert.equal(form.elements.departmentId.required,true);
 form.elements.departmentId.value='d2';ctx.syncWorkLogProjectDefaults();assert.equal(form.elements.workType.value,'維修紀錄');assert.equal(form.elements.departmentId.required,false);
});

test('new repair keeps its selected type and status when a same-name construction exists',()=>{
 const {ctx,state,field,form}=fixture();state.projects[0].rawType='construction';state.projects[0].status='completed';
 field.value='資訊維護';form.elements.workType.value='維修紀錄';form.elements.status.value='in_progress';
 ctx.syncWorkLogProjectDefaults();assert.equal(form.elements.workType.value,'維修紀錄');assert.equal(form.elements.status.value,'in_progress');assert.equal(form.elements.departmentId.required,true);
});
test('changing department clears stale selected work content but preserves a new free-text title',()=>{
 const {ctx,field,form}=fixture();ctx.syncWorkLogProjectNames();ctx.syncWorkLogProjectDefaults();assert.equal(form.elements.workType.value,'維護保養');
 form.elements.departmentId.value='d2';ctx.syncWorkLogProjectNames();ctx.syncWorkLogProjectDefaults();assert.equal(field.value,'');assert.equal(form.elements.workType.value,'工程施工');
 field.value='新工作內容';form.elements.departmentId.value='d1';ctx.syncWorkLogProjectNames();assert.equal(field.value,'新工作內容');
});
test('scoped dropdown keeps an allowed selection when refreshed and removes cross-department selection',()=>{
 const {ctx,state,list,field,form}=fixture();state.currentUser={project_scoped:true};state.projectAccess=[{project_id:'p1',can_create_work_log:true}];list.tagName='SELECT';ctx.syncWorkLogProjectNames();assert.equal(field.value,'資訊維護');ctx.syncWorkLogProjectNames();assert.equal(field.value,'資訊維護');form.elements.departmentId.value='d2';ctx.syncWorkLogProjectNames();assert.equal(field.value,'');
});
test('editing a pickup preserves its completed project while new pickups cannot select it',()=>{
 const {ctx,form,modal}=fixture();form.elements.projectId={value:'p3'};modal.dataset={type:'pickupModal',id:'pickup1'};ctx.syncModalProjectOptions();assert.match(form.elements.projectId.innerHTML,/已完成/);assert.equal(form.elements.projectId.value,'p3');modal.dataset.id='';ctx.syncModalProjectOptions();assert.doesNotMatch(form.elements.projectId.innerHTML,/已完成/);
});
