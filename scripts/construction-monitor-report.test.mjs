import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../work-content-report.js',import.meta.url),'utf8');
const context=vm.createContext({Intl,Date});vm.runInContext(source,context);
const {render,renderPerformance}=context.GUCWorkContentReport;
function report({completed=1,percent=14.3,worked=3,alert=true,overdue=false}={}){
 return {project:{id:'work',name:'讀卡機工程',customer:'測試客戶',contractStartDate:'2026-10-01',contractEndDate:'2026-12-31',remainingContractDays:67,contractOverdue:overdue},kpis:{},materialCategoryStats:[],materialStats:[],materialRows:[],workerStats:[],dailyRows:[],constructionSummary:{planCount:1,plannedDays:7,totalItemCount:7,completedItemCount:completed,progressPercent:percent,projectDays:worked,delayedPlanCount:alert?1:0},constructionPlans:[{id:'plan',project_id:'work',content:'行政大樓讀卡機施工',status:'in_progress',construction_date:'2026-10-10',planned_days:7,worked_days:worked,item_count:7,completed_item_count:completed,progress_percent:percent,warning_work_days:3,warning_min_progress:30,progress_alert:alert,progress_gap:alert?15.7:0,assignees:[{name:'工程師甲'}],items:Array.from({length:7},(_,i)=>({id:'i'+i,title:'施工項目'+(i+1),start_day:i+1,planned_days:i===0?4:1,is_completed:i<completed,worked_days:i===0?3:0,logs:[]})),logs:[{id:'log',date:'2026-10-10',summary:'現場施工',status:'in_progress',can_open:true}],can_open:true}]};
}
test('reference-style card separates item counts, execution days and contract calendar',()=>{
 const html=render({report:report()});
 assert.match(html,/<strong>1 \/ 7<\/strong>/);assert.match(html,/14\.3%/);assert.match(html,/<strong>3 \/ 7<\/strong>/);
 assert.match(html,/工期執行：3天\/7天/);assert.match(html,/剩餘履約日曆天數 67 天/);
 assert.match(html,/預計7天完成｜已完成1項/);assert.match(html,/gr-monitor-plan gr-progress-warning/);
 assert.match(html,/落後 15\.7 個百分點/);assert.doesNotMatch(html,/依各子項目預計天數加權|完成工期/);
 assert.match(html,/<details class="gr-plan" data-report-plan="plan">/);assert.doesNotMatch(html,/<details[^>]*open/);
 assert.match(html,/工程師甲/);assert.match(html,/data-edit-work-log="log"/);assert.match(html,/data-construction-project="work"/);
});
test('server alert boundary states render without a second client calculation',()=>{
 for(const fixture of [{completed:1,percent:14.3,worked:2,alert:false},{completed:1,percent:14.3,worked:3,alert:true},{completed:3,percent:42.9,worked:3,alert:false},{completed:1,percent:14.3,worked:4,alert:true},{completed:3,percent:42.9,worked:4,alert:false}]){
  const html=render({report:report(fixture)});assert.equal(html.includes('施工進度未達目標'),fixture.alert);assert.equal(html.includes('gr-monitor-plan gr-progress-warning'),fixture.alert);
 }
});
test('deadline and progress warning stay independent; unset thresholds do not manufacture warnings',()=>{
 const late=render({report:report({alert:false,overdue:true})});assert.match(late,/履約期限已逾期/);assert.doesNotMatch(late,/施工進度未達目標/);
 const progressOnly=render({report:report({alert:true,overdue:false})});assert.match(progressOnly,/施工進度未達目標/);assert.doesNotMatch(progressOnly,/履約期限已逾期/);
 const unset=report({alert:false});Object.assign(unset.constructionPlans[0],{warning_work_days:null,warning_min_progress:null});assert.match(render({report:unset}),/尚未設定進度告警門檻/);
});
test('overall project uses backend item total ratio and never averages individual plans',()=>{
 const r=report();Object.assign(r.constructionSummary,{totalItemCount:20,completedItemCount:8,progressPercent:40});r.constructionPlans.push({...r.constructionPlans[0],id:'p2',item_count:5,completed_item_count:3,progress_percent:60});
 const html=render({report:r});assert.match(html,/已完成 8 \/ 20 項/);assert.match(html,/class="gr-gauge-value">40%/);assert.doesNotMatch(html,/37\.15%/);
 const accounting=render({report:r,accounting:true,pricePermissions:{view:true}});assert.match(accounting,/class="gr-gauge-value">40%/);assert.match(accounting,/data-gr-open-log="log"/);
});
test('zero effective items preserve unknown completion and never derive it from spent days',()=>{
 const r=report();Object.assign(r.constructionPlans[0],{items:[],item_count:0,completed_item_count:0,progress_percent:null,worked_days:8,overrun_days:1,progress_alert:false});Object.assign(r.constructionSummary,{totalItemCount:0,completedItemCount:0,progressPercent:null});
 const html=render({report:r});assert.match(html,/尚未設定施工項目/);assert.match(html,/超出預計施工天數 1 天/);assert.doesNotMatch(html,/114\.3%|NaN|Infinity/);
});
function managers(){return [{managerId:'a',name:'主管甲',projectCount:3,completedProjectCount:1,inProgressProjectCount:2,overdueProjectCount:1,delayedPlanCount:2,onTimeCompletionRate:100,onTimeEligibleCount:1,onTimeCompletedCount:1,projects:[{id:'w1',name:'甲工程',code:'P1',customer:'客戶甲',status:'completed',progressPercent:100,contractEndDate:'2026-10-01',completedOn:'2026-09-30',contractOverdue:false,delayedPlanCount:0}]},{managerId:'b',name:'主管乙',projectCount:1,completedProjectCount:0,inProgressProjectCount:1,overdueProjectCount:0,delayedPlanCount:0,onTimeCompletionRate:null,onTimeEligibleCount:0,onTimeCompletedCount:0,projects:[{id:'w2',name:'乙工程',status:'in_progress'}]}];}
test('manager statistics expose traceable authorized rows and suppress unavailable rates',()=>{
 const html=renderPerformance(managers(),true);assert.match(html,/專案負責人執行統計/);assert.match(html,/資料不足/);assert.match(html,/甲工程/);assert.match(html,/2026-09-30/);assert.match(html,/不作個人評分/);
 assert.equal(renderPerformance(managers(),false),'');
});
test('manager selector filters both statistics and source projects without widening scope',()=>{
 const listeners={},region={innerHTML:''},isolated=vm.createContext({Intl,Date,document:{addEventListener(name,fn){listeners[name]=fn;}}});vm.runInContext(source,isolated);isolated.GUCWorkContentReport.renderPerformance(managers(),true);
 const select={value:'b',closest(){return {querySelector(){return region;}};}};listeners.change({target:{closest(selector){return selector==='[data-gr-manager-filter]'?select:null;}}});
 assert.match(region.innerHTML,/主管乙|乙工程/);assert.doesNotMatch(region.innerHTML,/主管甲|甲工程/);
});
