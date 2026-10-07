import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
function context(extra={}){
 const ctx=vm.createContext({Intl,Date,document:{addEventListener(){}},...extra});
 vm.runInContext(read('customer-appointments.js'),ctx);return ctx;
}
test('assignment date defaults to Taiwan today and legacy creation day, never appointment date',()=>{
 const c=context();
 assert.equal(c.appointmentAssignedDate(),c.appointmentToday());
 assert.equal(c.appointmentAssignedDate({created_at:'2026-10-01T17:30:00Z',appointment_date:'2026-10-12'}),'2026-10-02');
 assert.equal(c.appointmentAssignedDate({assigned_date:'2026-09-30',created_at:'2026-10-01T17:30:00Z'}),'2026-09-30');
 assert.equal(c.appointmentOverdue({assigned_date:'2020-01-01',appointment_date:'2026-10-12',status:'pending',reminder_days:3},'2026-10-14'),false);
});
test('assignment date is editable with existing appointment permission, read-only viewers unchanged',()=>{
 const row={id:'a',row_version:2,created_at:'2026-10-01T17:30:00Z'};
 const c=context({state:{appointments:[row],customers:[],siteWorkers:[]},byId:(rows,id)=>rows.find(r=>r.id===id),canModule:()=>true,customerSelectorFields:()=>'',inputField:(name,label,type,required,value)=>`<input name="${name}" aria-label="${label}" type="${type}" ${required?'required':''} value="${value}">`,selectField:()=>'',submitField:()=>'<button>儲存</button>'});
 const fields=c.appointmentFields('a').fields;
 assert.match(fields,/name="assignedDate" aria-label="指派日期" type="date" min="0001-01-01" max="9999-12-31" required value="2026-10-02"/);
 assert.doesNotMatch(fields,/建立日期/);
 c.canModule=()=>false;assert.match(c.appointmentFields('a').fields,/<fieldset[^>]*disabled>/);assert.doesNotMatch(c.appointmentFields('a').fields,/<button>/);
});
test('form save sends assigned_date separately and never sends editable creation time',async()=>{
 let sent;const c=context({canModule:()=>true,modalDepartmentValue:()=>null,mutate:async(op,payload)=>{sent={op,payload};}});
 await c.saveAppointment('a',{appointmentVersion:'2',assignedDate:'2028-02-29',appointmentDate:'2028-03-05',reminderDays:'3'});
 assert.equal(sent.op,'upsert_customer_appointment');assert.equal(sent.payload.assigned_date,'2028-02-29');assert.equal(sent.payload.appointment_date,'2028-03-05');assert.ok(!Object.hasOwn(sent.payload,'created_at'));
});
test('preview retains selected assignment date on older-client updates and cancellation',()=>{
 const state={appointments:[],customers:[],siteWorkers:[],currentUser:{id:'u'},dashboard:{assignments:{pending:[],completed:[]}}};
 const c=context({state,canModule:()=>true,uid:()=> 'a',byId:(rows,id)=>rows.find(r=>r.id===id)});
 let row=c.previewAppointment({assigned_date:'2026-09-30',status:'pending'});const created=row.created_at;
 row=c.previewAppointment({id:row.id,row_version:row.row_version,status:'cancelled'});
 assert.equal(row.assigned_date,'2026-09-30');assert.equal(row.created_at,created);assert.equal(row.row_version,2);
});
test('list sorts the displayed effective assignment date, cancellation explicitly preserves it',()=>{
 assert.match(read('index.html'),/data-table-sort="appointment" data-key="assigned_date">指派日期/);
 assert.match(read('customer-appointments.js'),/assigned_date:appointmentAssignedDate\(row\),customer:/);
 assert.match(read('customer-appointments.js'),/assigned_date:appointmentAssignedDate\(row\),status:'cancelled'/);
});
