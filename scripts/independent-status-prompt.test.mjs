import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function fixture({yes=true,allowed=true,scoped=false,closed=false,fail=false}={}){
 const project={id:'p',name:'測試工作',rowVersion:3,status:closed?'completed':'in_progress'},calls=[],toasts=[],prompts=[];
 const ctx=vm.createContext({state:{projects:[project],siteData:{logs:[{id:'l',projectId:'p',status:'in_progress'}]},currentUser:{project_scoped:scoped}},byId:(rows,id)=>rows.find(x=>x.id===id),canModule:()=>allowed,confirm:message=>{prompts.push(message);return yes;},showToast:(...args)=>toasts.push(args),mutate:async(...args)=>{calls.push(args);if(fail)throw Error('隔離失敗');project.status='completed';return {project};}});
 vm.runInContext(app.slice(app.indexOf('async function promptCloseWorkContent('),app.indexOf('function nasFormRequest(')),ctx);
 return{ctx,project,calls,toasts,prompts};
}
test('declining close never mutates the work or log',async()=>{
 const f=fixture({yes:false});await f.ctx.promptCloseWorkContent('l');assert.equal(f.calls.length,0);assert.equal(f.project.status,'in_progress');
});
test('explicit close sends a narrow versioned action; daily status is unchanged',async()=>{
 const f=fixture();await f.ctx.promptCloseWorkContent('l');assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'close_work_content');assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0][1])),{id:'p',row_version:3,work_log_id:'l'});assert.equal(f.ctx.state.siteData.logs[0].status,'in_progress');assert.match(f.toasts[0][0],/已結案/);
});
test('unauthorized, project-scoped and already closed work never submits',async()=>{
 for(const options of [{allowed:false},{scoped:true},{closed:true}]){const f=fixture(options);await f.ctx.promptCloseWorkContent('l');assert.equal(f.calls.length,0);assert.equal(f.prompts.length,0);}
});
test('closure failure does not re-save the log or repeat submission',async()=>{
 const f=fixture({fail:true});await f.ctx.promptCloseWorkContent('l');assert.equal(f.calls.length,1);assert.match(f.toasts[0][0],/日誌已儲存.*結案未完成/);
});
test('pickup save or cancellation clears the followup before invoking it',()=>{
 const source=app.split(/\r?\n/).find(line=>line.startsWith('function closeModal('));
 assert.match(source,/delete modal.dataset.closeProjectLogId;if\(followup\)queueMicrotask/);
 assert.ok(app.includes('else await promptCloseWorkContent(newWorkLogId)'));
 assert.ok(app.includes('dataset.closeProjectLogId=newWorkLogId'));
});
