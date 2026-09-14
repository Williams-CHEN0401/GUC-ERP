import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../customer-departments.js',import.meta.url),'utf8');
function context(){
 const state={customerDepartmentsReady:true,customerDepartments:[{id:'d1',customerId:'c1',name:'資訊室',active:true,rowVersion:1},{id:'d2',customerId:'c2',name:'資訊室',active:true,rowVersion:1},{id:'old',customerId:'c1',name:'舊科室',active:false,rowVersion:2}],customers:[{id:'c1'},{id:'c2'},{id:'c3'}],projects:[]};
 const ctx=vm.createContext({state,document:{addEventListener(){}},byId:(rows,id)=>rows.find(row=>row.id===id),valueText:v=>String(v).trim().toLowerCase(),matches:()=>true,uid:()=> 'new',esc:v=>String(v??'')});
 vm.runInContext(source,ctx);return ctx;
}
test('department choices are scoped to stable customer ID and preserve only the original inactive relation',()=>{
 const c=context();assert.equal(c.customerDepartmentChoice('c1','d1'),'d1');assert.throws(()=>c.customerDepartmentChoice('c2','d1'),/不屬於/);
 assert.throws(()=>c.customerDepartmentChoice('c1','old'),/已停用/);
 assert.equal(c.customerDepartmentChoice('c1','old',{legacyCustomerId:'c1',legacyDepartmentId:'old'}),'old');
 assert.throws(()=>c.customerDepartmentChoice('c1',''),/請選擇科室/);
 assert.equal(c.customerDepartmentChoice('c1','',{legacyCustomerId:'c1',legacyDepartmentId:''}),null);
 assert.equal(c.customerDepartmentChoice('c3',''),null);
 c.state.customerDepartmentsReady=false;assert.throws(()=>c.customerDepartmentChoice('c3',''),/尚未載入/);
});
test('department preview CRUD validates names, concurrency, ownership and soft-deactivates',()=>{
 const c=context();assert.throws(()=>c.previewCustomerDepartmentMutation('create_customer_department',{customer_id:'c1',name:' 資訊室 '}),/相同名稱/);
 const row=c.previewCustomerDepartmentMutation('create_customer_department',{customer_id:'c3',name:'資訊室'});assert.equal(row.customerId,'c3');
 assert.throws(()=>c.previewCustomerDepartmentMutation('update_customer_department',{id:'d1',row_version:99,customer_id:'c1',name:'新名'}),/其他使用者/);
 c.previewCustomerDepartmentMutation('deactivate_customer_department',{id:'d1',row_version:1,customer_id:'c1'});
 assert.equal(c.state.customerDepartments.length,4);assert.equal(c.state.customerDepartments[0].active,false);
 c.previewCustomerDepartmentMutation('update_customer_department',{id:'d1',row_version:2,customer_id:'c1',name:'資訊室',is_active:true});assert.equal(c.state.customerDepartments[0].active,true);
});
test('ERP mutation payloads include departments and existing receipt multi-customer shape remains',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8'),html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(app,/department_id:modalDepartmentValue\(\)/);assert.match(app,/department_id:workLogDepartmentValue/);assert.match(app,/customer_ids,customer_departments/);
 for(const id of ['customerDepartmentsPane','worklogDepartmentFilter','materialDepartment'])assert.ok(html.includes('id="'+id+'"'));
 assert.match(html,/customer-departments\.js/);assert.match(source,/所選工作內容與客戶／科室不一致/);
});
