import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const dateHelper=app.slice(app.indexOf('function workLogToday()'),app.indexOf('function formatDate(',app.indexOf('function workLogToday()')));
const modal=app.slice(app.indexOf('if(type==="workLogModal")'),app.indexOf('if(type==="workLogPickupModal")',app.indexOf('if(type==="workLogModal")')));
function fixture(instant){
 let now=instant;
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}}
 const c=vm.createContext({Date:Clock,Intl});
 vm.runInContext(dateHelper,c);
 return {c,setTime:value=>{now=value;}};
}
function dateField(c,record){
 let date;
 Object.assign(c,{type:'workLogModal',id:record?.id||'',state:{siteData:{logs:record?[record]:[]},projects:[],customers:[],currentUser:{}},byId:(rows,id)=>rows.find(row=>row.id===id),constructionLogDefaults:()=>({}),canModule:()=>true,canWorkLog:()=>true,maintenanceEventsForLog:()=>[],workTypeFromProjectType:()=> '工程施工',WORK_LOG_TYPES:[],customerSelectorFields:()=>'',workLogDepartmentId:()=>'',selectField:()=>'',inputField:(name,_label,_type,_required,value)=>{if(name==='logDate')date=value;return '';},workLogTimePeriodField:()=>'',workLogProjectTitleField:()=>'',workerPickerField:()=>'',workLogWorkforceFields:()=>'',workLogContentFields:()=>'',maintenanceEditorFields:()=>'',submitField:()=>'',title:'',fields:''});
 vm.runInContext(modal,c);
 return date;
}

test('new work logs use the Taipei calendar day including UTC midnight boundaries',()=>{
 for(const [instant,expected]of [['2026-11-12T16:00:00Z','2026-11-13'],['2026-11-13T00:00:00Z','2026-11-13'],['2026-11-13T15:59:59Z','2026-11-13'],['2026-11-13T16:00:00Z','2026-11-14'],['2026-12-31T16:00:00Z','2027-01-01']]){
  const {c}=fixture(instant);assert.equal(dateField(c),expected,instant);
 }
});

test('reopening a new work log recalculates today after midnight',()=>{
 const f=fixture('2026-11-13T15:59:59Z');assert.equal(dateField(f.c),'2026-11-13');
 f.setTime('2026-11-13T16:00:00Z');assert.equal(dateField(f.c),'2026-11-14');
});

test('editing a historical work log keeps its saved date',()=>{
 const f=fixture('2026-11-13T16:00:00Z');assert.equal(dateField(f.c,{id:'existing',log_date:'2026-10-16'}),'2026-10-16');
});
