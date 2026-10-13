import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const context=vm.createContext({Intl,Date});
vm.runInContext(readFileSync(new URL('../work-content-report.js',import.meta.url),'utf8'),context);
const render=context.GUCWorkContentReport.render;
function report(){return {project:{name:'工程 <img src=x onerror=alert(1)>',code:'T1',createdAt:'2026-09-01T16:30:00Z'},kpis:{},materialStats:[],materialRows:[],workerStats:[],dailyRows:[],constructionPlans:[{id:'p1',project_id:'work1',content:'未開始',status:'pending',planned_days:7,completed_days:0,remaining_days:7,progress_percent:0,items:[],logs:[],assignees:[]}],constructionSummary:{planCount:1,plannedDays:7,completedDays:0,remainingDays:7,projectDays:0,overdueItemCount:0}};}
test('shared dashboard retains zero-log plans and escapes API text',()=>{
 const html=render({report:report()});assert.match(html,/data-report-plan="p1"/);assert.match(html,/0 \/ 7 天/);assert.doesNotMatch(html,/<img|onerror="/);assert.match(html,/&lt;img/);assert.match(html,/2026-09-02/);
});
test('dashboard displays server completion percentage and excess days without client recomputation',()=>{
 const r=report();Object.assign(r.constructionPlans[0],{completed_days:9,planned_days:7,progress_percent:128.6,remaining_days:0,overrun_days:2});
 const html=render({report:r});assert.match(html,/128.6%/);assert.match(html,/超出預計施工天數 2 天/);assert.match(html,/value="100"/);
});
test('unknown planned duration never renders NaN or infinity',()=>{
 const r=report();r.constructionPlans[0].planned_days=null;r.constructionSummary.plannedDays=0;
 const html=render({report:r});assert.match(html,/未設定/);assert.doesNotMatch(html,/NaN|Infinity/);
});
test('Accounting preserves cents; price edit controls follow existing permissions',()=>{
 const r=report();r.materialStats=[{id:'item',name:'材料',quantity:2,unit:'台',unit_price:12.34,amount:24.68,price_source:'manual'}];
 const erp=render({report:r});assert.doesNotMatch(erp,/單價（元）|data-gr-edit-price|12.34/);
 const readonly=render({report:r,accounting:true,pricePermissions:{view:true}});assert.match(readonly,/12.34/);assert.doesNotMatch(readonly,/data-gr-edit-price|data-gr-clear-price/);
 const writer=render({report:r,accounting:true,pricePermissions:{view:true,update:true,delete:true}});assert.match(writer,/data-gr-edit-price="item"/);assert.match(writer,/data-gr-clear-price="item"/);
});
