import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const between=(a,b)=>app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)));
function harness(){
 const values={eventType:'SOFTWARE_CONFIG',eventServiceId:'service',eventOccurredAt:'2026-09-15',eventCause:'無法連線',eventHandlingProcess:'檢查網路設定',eventNotes:'',eventInventoryCategoryId:'',eventInventoryItemId:''};
 const card={dataset:{equipmentIds:'[]'},querySelector:s=>({value:values[s.match(/name="([^"]+)"/)[1]]})};
 const label={hidden:false},modal={dataset:{type:'workLogModal',id:''}},form={elements:{summary:{value:'原本工作內容',closest:()=>label},hasMaintenance:{value:'yes'},workType:{value:'維修紀錄'},projectName:{value:'應用數學系查修'}},querySelectorAll:()=>[card]};
 const ctx=vm.createContext({document:{querySelector:s=>s==='#simpleModal'?modal:form},projectTypeFromWorkType:t=>t==='維修紀錄'?'repair':'maintenance',isEquipmentRepairEvent:t=>['REPAIR','REPLACEMENT'].includes(t),syncMaintenanceVisibility:()=>{}});
 vm.runInContext(between('function workLogSummaryForSave','function projectOwnerPickerField')+between('function syncWorkLogMaintenanceType','function syncMaintenanceVisibility'),ctx);
 return {ctx,form,label,card,values,modal};
}
test('repair hides/disables summary, restores entered value when switching back',()=>{
 const {ctx,form,label}=harness();ctx.syncWorkLogMaintenanceType();assert.equal(label.hidden,true);assert.equal(form.elements.summary.disabled,true);
 form.elements.workType.value='維護保養';ctx.syncWorkLogMaintenanceType();assert.equal(label.hidden,false);assert.equal(form.elements.summary.disabled,false);assert.equal(form.elements.summary.value,'原本工作內容');
});
test('repair saves without hidden content, derives from visible details and keeps optional fields optional',()=>{
 const {ctx,form,values}=harness();form.elements.summary.value='';
 let events=ctx.collectMaintenanceEvents();assert.equal(events[0].description,'無法連線\n檢查網路設定');assert.equal(events[0].result,'檢查網路設定');assert.equal(ctx.workLogSummaryForSave(form,events),events[0].description);
 values.eventCause='';values.eventHandlingProcess='';events=ctx.collectMaintenanceEvents();assert.equal(events[0].description,'應用數學系查修');
 values.eventCause='故'.repeat(2000);values.eventHandlingProcess='修'.repeat(2000);events=ctx.collectMaintenanceEvents();assert.equal(ctx.workLogSummaryForSave(form,events).length,2000);assert.equal(events[0].handling_process.length,2000);assert.equal(events[0].cause.length,2000);
});
test('existing repair free-text, per-event description and result are not overwritten by hidden fields',()=>{
 const {ctx,form,card,modal}=harness();modal.dataset.id='saved-log';card.dataset.eventId='saved-event';card.dataset.eventDescription='歷史維修內容';card.dataset.eventResult='歷史處理结果';card.dataset.workerIds='["old-worker"]';
 const events=ctx.collectMaintenanceEvents();assert.equal(events[0].description,'歷史維修內容');assert.equal(events[0].result,'歷史處理结果');assert.equal(ctx.workLogSummaryForSave(form,events),'原本工作內容');assert.deepEqual([...events[0].worker_user_ids],['old-worker']);
});
test('non-repair with existing maintenance retains shared required content and renamed error',()=>{
 const {ctx,form}=harness();form.elements.workType.value='維護保養';assert.equal(ctx.collectMaintenanceEvents()[0].description,'原本工作內容');form.elements.summary.value='';assert.throws(()=>ctx.collectMaintenanceEvents(),/工作內容/);
});
