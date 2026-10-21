import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function fixture(){
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const render=app.slice(app.indexOf('function renderProjectReport(){'),app.indexOf('function download(',app.indexOf('function renderProjectReport(){')));
 const container={dataset:{},innerHTML:'',querySelectorAll:()=>[],classList:{add(){}}};
 const context=vm.createContext({document:{querySelector:()=>container,querySelectorAll:()=>[]},syncProjectReportDates(){},reportErrorDatasets:()=>[],selected:{project:{id:'a'},report:{value:1}},selectedProjectReport(){return this.selected;},reportEmpty:(title,message)=>title+message,activeProjectReportTab:'overview',GUCWorkContentReport:{render:({report})=>`report:${report.value}`}});
 // The browser globals are lexical, not methods.
 vm.runInContext('selectedProjectReport=()=>selected;',context);
 vm.runInContext(render,context);return{context,container,render:()=>vm.runInContext('renderProjectReport()',context)};
}
test('reload restores unchanged report after loading, failure, empty selection, or missing datasets',()=>{
 for(const state of ['loading','error','empty','datasets']){
  const f=fixture();f.render();assert.equal(f.container.innerHTML,'report:1');
  if(state==='datasets')vm.runInContext('reportErrorDatasets=()=>[{dataset:"projects"}]',f.context);
  else f.context.selected=state==='empty'?{}:{project:{id:'a'},report:state==='error'?{error:'network failed'}:null};
  f.render();assert.notEqual(f.container.innerHTML,'report:1');
  f.context.selected={project:{id:'a'},report:{value:1}};vm.runInContext('reportErrorDatasets=()=>[]',f.context);
  f.render();assert.equal(f.container.innerHTML,'report:1',state);
  f.context.selected.report.value=2;f.render();assert.equal(f.container.innerHTML,'report:2');
 }
});
test('stale report responses cannot replace a newer reload; malformed replies settle as errors',async()=>{
 const pending=[];let renders=0;
 const c=vm.createContext({Map,Set,JSON,Error,document:{querySelector:()=>({value:''}),addEventListener(){}},window:{addEventListener(){}},setInterval(){},queueMicrotask,renderProjectReport(){renders++;},currentPage:()=> 'materials',state:{currentUser:{id:'user'}},apiRequest:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))});
 vm.runInContext(readFileSync(new URL('../shared-report-ui.js',import.meta.url),'utf8'),c);
 vm.runInContext('sharedProjectReport("p");invalidateSharedReports();sharedProjectReport("p")',c);
 pending[0].resolve({report:{value:'old'}});pending[1].resolve({report:{value:'new'}});await new Promise(setImmediate);
 assert.equal(vm.runInContext('sharedProjectReport("p").value',c),'new');
 vm.runInContext('invalidateSharedReports();sharedProjectReport("p")',c);pending[2].resolve({});await new Promise(setImmediate);
 assert.match(vm.runInContext('sharedProjectReport("p").error',c),/未完整回傳/);assert.equal(pending.length,3);assert(renders>0);
});
