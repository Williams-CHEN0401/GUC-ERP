import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const between=(a,b)=>app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)));
function flow({answers=[],permissions=true,loadFails=false}={}){
 const prompts=[],opens=[],closed=[],modal={dataset:{}},form={elements:Object.fromEntries(['receivedOn','customerCategory','customerId','departmentId'].map(k=>[k,{value:''}]))};
 const ctx=vm.createContext({confirm:m=>{prompts.push(m);return answers.shift()??false;},canModule:()=>permissions,openModal:(...a)=>opens.push(a),loadScope:async()=>{if(loadFails)throw Error('載入失敗');},byId:(a,id)=>a.find(r=>r.id===id),state:{siteData:{logs:[{id:'l',projectId:'p',log_date:'2026-09-24'}]},projects:[{id:'p',customerId:'c'}],customers:[{id:'c',category:'school'}]},document:{querySelector:s=>s==='#simpleModal'?modal:form},syncModalCustomerOptions:()=>{},syncModalDepartmentOptions:()=>{},workLogDepartmentId:()=> 'd',promptCloseWorkContent:async id=>closed.push(id)});
 vm.runInContext(between('async function continueWorkLogFollowup','async function promptCloseWorkContent'),ctx);return {ctx,prompts,opens,closed,modal,form};
}
test('followups pause for each form and resume pickup → manual repair → close',async()=>{
 const f=flow({answers:[true,true]});await f.ctx.continueWorkLogFollowup('l');assert.deepEqual(f.opens,[['workLogPickupModal','l']]);assert.equal(f.modal.dataset.followupStep,'repair');assert.equal(f.closed.length,0);
 await f.ctx.continueWorkLogFollowup('l',f.modal.dataset.followupStep);assert.deepEqual(f.opens[1],['repairModal']);assert.equal(f.modal.dataset.followupStep,'close');assert.equal(f.form.elements.customerId.value,'c');assert.equal(f.form.elements.departmentId.value,'d');assert.equal(f.form.elements.receivedOn.value,'2026-09-24');assert.equal(f.closed.length,0);
 await f.ctx.continueWorkLogFollowup('l',f.modal.dataset.followupStep);assert.deepEqual(f.closed,['l']);assert.deepEqual(f.prompts,['工作日誌已建立。是否登錄取貨？','是否登錄維修品？']);
});
test('declining optional forms still reaches close; permission denial skips forms',async()=>{
 for(const permissions of [true,false]){const f=flow({permissions});await f.ctx.continueWorkLogFollowup('l');assert.deepEqual(f.closed,['l']);assert.equal(f.opens.length,0);assert.equal(f.prompts.length,permissions?2:0);}
});
test('repair options load failure cannot open a stale form or proceed to closure',async()=>{
 const f=flow({answers:[true],loadFails:true});await assert.rejects(f.ctx.continueWorkLogFollowup('l','repair'),/載入失敗/);assert.equal(f.opens.length,0);assert.equal(f.closed.length,0);
});
test('close clears continuation before queueing; double close cannot repeat next step',async()=>{
 const dataset={type:'workLogPickupModal',followupLogId:'l',followupStep:'repair'},queued=[],calls=[];
 const modal={dataset,classList:{remove:()=>{}},setAttribute:()=>{}};
 const ctx=vm.createContext({document:{querySelector:s=>s==='#simpleModal'?modal:{classList:{contains:()=>false}}},closeEquipmentDrawer:()=>{},queueMicrotask:f=>queued.push(f),continueWorkLogFollowup:async(...a)=>calls.push(a),showToast:()=>{}});
 vm.runInContext(app.split(/\r?\n/).find(x=>x.startsWith('function closeModal(')),ctx);ctx.closeModal();ctx.closeModal();assert.equal(queued.length,1);await queued[0]();assert.deepEqual(calls,[['l','repair']]);
});
function contents(){
 const ctx=vm.createContext({projectTypeFromWorkType:t=>t==='維修紀錄'?'repair':'maintenance',inputField:(name,label,type,required,value)=>JSON.stringify({name,label,value})+'\n'});
 vm.runInContext(between('function workLogContentFields','function projectOwnerPickerField'),ctx);return ctx;
}
test('sections keep legacy text and preserve split values independently of status',()=>{
 const c=contents();let fields=c.workLogContentFields({status:'completed'},'歷史原文').trim().split('\n').map(JSON.parse);assert.equal(fields[1].value,'歷史原文');assert.equal(fields[2].value,'');
 fields=c.workLogContentFields({status:'in_progress'},'歷史原文').trim().split('\n').map(JSON.parse);assert.equal(fields[2].value,'歷史原文');
 fields=c.workLogContentFields({status:'completed',completed_content:'A',pending_content:'B'},'A\nB').trim().split('\n').map(JSON.parse);assert.equal(fields[1].value,'A');assert.equal(fields[2].value,'B');
 const form={elements:{workType:{value:'維護保養'},completedContent:{value:' 完成 '},pendingContent:{value:' 未完 '}}};assert.equal(c.workLogPlainContent(form),'完成\n未完');form.elements.pendingContent.value='字'.repeat(2000);assert.throws(()=>c.workLogPlainContent(form),/2000/);
 form.elements.workType.value='維修紀錄';assert.deepEqual(JSON.parse(JSON.stringify(c.workLogContentSections(form))),{completed_content:null,pending_content:null});
});
test('worker exclusions apply only to worklogs; historical selected IDs survive without appearing as choices',()=>{
 const esc=x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 const ctx=vm.createContext({esc,sortRows:a=>a,state:{siteWorkers:[{id:'a',displayName:'老闆娘',active:true},{id:'b',displayName:'Joyce',active:true},{id:'c',displayName:'正常人員',active:true}]}});
 vm.runInContext(app.split(/\r?\n/).find(x=>x.startsWith('function workerPickerField(')),ctx);
 assert.match(ctx.workerPickerField([]),/老闆娘/);assert.match(ctx.workerPickerField([]),/Joyce/);
 const html=ctx.workerPickerField(['a','c'],{workLogOnly:true});assert.doesNotMatch(html,/老闆娘|Joyce/);assert.match(html,/type="hidden" name="workerIds" value="a"/);assert.match(html,/已選 1 位/);assert.match(html,/正常人員/);
});
test('followup cannot close while saving; successful submission can advance it',()=>{
 const queued=[],modal={dataset:{type:'repairModal',followupLogId:'l',followupStep:'close'},classList:{remove:()=>{}},setAttribute:()=>{}},notices=[];
 const ctx=vm.createContext({document:{querySelector:s=>s==='#simpleModal'?modal:{classList:{contains:()=>true}}},closeEquipmentDrawer:()=>{},queueMicrotask:f=>queued.push(f),showToast:m=>notices.push(m)});
 vm.runInContext(app.split(/\r?\n/).find(x=>x.startsWith('function closeModal(')),ctx);
 ctx.closeModal();assert.equal(queued.length,0);assert.equal(modal.dataset.followupStep,'close');assert.match(notices[0],/儲存中/);
 ctx.closeModal(true);assert.equal(queued.length,1);assert.equal(modal.dataset.followupStep,undefined);
});
test('repair association snapshot queries only visible event IDs, exposes only a flag and fails closed',async()=>{
 const gateway=readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8');
 const source=gateway.slice(gateway.indexOf('async function withMaintenanceRepairState'),gateway.indexOf('async function scopedSnapshot'));
 const paths=[],ctx=vm.createContext({uuid:x=>typeof x==='string'?x:null,getAll:async path=>{paths.push(path);return [{source_maintenance_event_id:'event-a'}];}});
 vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'}),ctx);
 const result=await ctx.withMaintenanceRepairState({maintenance_events:[{id:'event-a',inventory_item_id:'item'},{id:'event-b',inventory_item_id:'item'}],errors:[]});
 assert.equal(paths.length,1);assert.equal(paths[0],'repair_items?select=source_maintenance_event_id&source_maintenance_event_id=in.(event-a,event-b)');
 assert.equal(result.maintenance_events[0].repair_registered,true);assert.equal(result.maintenance_events[1].repair_registered,false);assert.equal(result.repair_items,undefined);
 await ctx.withMaintenanceRepairState({});assert.equal(paths.length,1);
 ctx.getAll=async()=>{throw Error('temporary failure');};const failed=await ctx.withMaintenanceRepairState({maintenance_events:[{id:'event-a',inventory_item_id:'item'}],errors:[]});assert.equal(failed.maintenance_events[0].repair_registered,true);assert.equal(failed.errors[0].dataset,'maintenance_events');
 assert.match(app,/repairRegistered:r.repair_registered===true/);
});
