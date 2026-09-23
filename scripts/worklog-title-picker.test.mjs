import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const extract=name=>{const start=source.indexOf('function '+name+'('),end=source.indexOf('\nfunction ',start+1);return source.slice(start,end<0?undefined:end);};
function fixture(){
 const original={id:'a',name:'原工作',customerId:'c',departmentId:'d',status:'in_progress',rawType:'clerical'},target={...original,id:'b',name:'可選工作',rawType:'site_survey'};
 const input={value:original.name,readOnly:false},choice={value:''},hint={},form={elements:{projectName:input,workType:{value:'文書作業',dataset:{},disabled:false},status:{value:'completed',dataset:{},disabled:false}},querySelector:s=>s==='#workLogProjectChoice'?choice:s==='[data-work-log-title-hint]'?hint:null};
 const ctx=vm.createContext({state:{currentUser:{}},esc:s=>s,valueText:s=>s.trim().toLowerCase(),document:{querySelector:()=>form,addEventListener(){}},workLogOriginalProject:()=>original,workLogFormCustomerId:()=>original.customerId,workLogSelectableProjects:()=>[original,target],workTypeFromProjectType:t=>({clerical:'文書作業',site_survey:'場勘'}[t]),syncWorkLogProjectDefaults(){},syncWorkLogMaintenanceType(){},canModule:()=>true});
 ctx.workLogTitleDepartment=()=>original.departmentId;
 vm.runInContext(['isMaintenanceWorkLog','workLogContextChanged','workLogProjectTitleField','workLogChosenProject','syncWorkLogTitleChoice','workLogSaveProject','workLogMatchesSave'].map(extract).join('\n'),ctx);
 return{ctx,original,target,input,choice,form,hint};
}
test('editable title has manual text, datalist and visible dropdown; readonly does not gain a picker',()=>{
 const {ctx}=fixture();const html=ctx.workLogProjectTitleField('c','原工作');assert.match(html,/name="projectName"/);assert.match(html,/id="workLogProjectChoice"/);assert.match(html,/<datalist/);
 const readonly=ctx.workLogProjectTitleField('c','原工作',true);assert.match(readonly,/readonly aria-readonly/);assert.doesNotMatch(readonly,/id="workLogProjectChoice"/);
});
test('selecting moves only the chosen ID and preserves independent status and daily type',()=>{
 const {ctx,target,original,input,choice,form,hint}=fixture();choice.value=target.id;ctx.syncWorkLogTitleChoice(true);
 assert.equal(input.value,target.name);assert.equal(ctx.workLogSaveProject(original).id,target.id);assert.equal(form.elements.workType.value,'文書作業');assert.equal(form.elements.status.value,'completed');assert.equal(form.elements.status.disabled,false);assert.equal(form.elements.workType.disabled,false);assert.match(hint.textContent,/只將這筆日誌/);assert.match(hint.textContent,/取貨保留原工作/);
 input.value='手動新名稱';ctx.syncWorkLogTitleChoice();assert.equal(choice.value,'');assert.equal(ctx.workLogSaveProject(original).id,original.id);assert.equal(form.elements.workType.value,'文書作業');assert.equal(form.elements.status.value,'completed');assert.equal(form.elements.workType.disabled,false);assert.match(hint.textContent,/同步原工作內容/);
});
test('native title suggestions resolve the same project and preserve server-aligned permission boundary',()=>{
 const {ctx,input,target,original}=fixture();input.value=target.name;ctx.syncWorkLogTitleChoice();assert.equal(ctx.workLogSaveProject(original).id,target.id);
 ctx.canModule=()=>false;assert.throws(()=>ctx.workLogSaveProject(original),/權限/);
});
test('save confirmation checks project identity, not only duplicated title fields',()=>{
 const {ctx}=fixture(),payload={project_id:'a',project_name:'原工作',log_date:'2026-09-16',time_period:'',work_type:'文書作業',status:'in_progress',summary:'',worker_user_ids:[]};
 const log={projectId:'b',title:payload.project_name,log_date:payload.log_date,work_type:payload.work_type,status:payload.status,workerIds:[]};
 assert.equal(ctx.workLogMatchesSave(log,payload),false);log.projectId='a';assert.equal(ctx.workLogMatchesSave(log,payload),true);
});

test('customer/department edit resolves a new destination without changing the original project ID',()=>{
 const {ctx,original,input}=fixture();
 ctx.workLogFormCustomerId=()=> 'other-customer';ctx.workLogSelectableProjects=()=>[];
 input.value='新客戶工作';assert.equal(ctx.workLogSaveProject(original),null);
 ctx.canModule=(_,action)=>action!=='CREATE';assert.throws(()=>ctx.workLogSaveProject(original),/建立新工作/);
});
test('repair receipt migration preserves the existing entrypoint ACL and uses work-log date without bulk backfill',()=>{
 const sql=readFileSync(new URL('../supabase/migrations/20260916002422_worklog_repair_received_date.sql',import.meta.url),'utf8');
 assert.match(sql,/v_notes,p_log_date,null,null,v_cause/);assert.match(sql,/r\.received_on is distinct from p_log_date/);assert.match(sql,/e\.work_log_id=v_work_log_id/);assert.match(sql,/'UPDATE_REPAIR_ITEM'/);
 assert.doesNotMatch(sql,/\b(?:grant|revoke|alter table|create table|create trigger)\b/i);assert.match(source,/receivedOn:payload\.log_date/);
});
