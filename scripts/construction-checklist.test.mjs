import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function fixture(){
 const handlers={},c=vm.createContext({document:{addEventListener:(name,fn)=>handlers[name]=fn},uid:()=> 'test-id',esc:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')});
 for(const file of ['../construction-v2.js','../construction-checklist.js'])vm.runInContext(readFileSync(new URL(file,import.meta.url),'utf8'),c);return{c,handlers};
}
const plan={construction_date:'2026-09-01',content:'配管施工',planned_days:14,worked_days:12,item_count:2,completed_item_count:1,completion_percent:50,completed_days:8,remaining_days:6,warning_after_days:12,needs_attention:true,unstarted_items:[{title:'C 棟配管施工'}],work_dates:['2026-09-01','2026-09-02'],items:[{id:'A',title:'A 棟',start_day:1,planned_days:4,is_completed:true,worked_days:2,log_dates:['2026-09-01','2026-09-02']}]};
test('completion and consumed workdays are independent metrics',()=>{
 const {c}=fixture(),html=c.constructionChecklistProgress(plan);
 assert.match(html,/12 \/ 14 天/);assert.match(html,/已完成 1 項/);assert.match(html,/50%/);assert.doesNotMatch(html,/完成工期|加權|85.7%/);
 assert.match(c.constructionChecklistProgress({...plan,worked_days:16}),/超出預計施工天數 2 天/);
});
test('warning displays configurable authoritative threshold and never falls back to fixed 80 percent',()=>{
 const {c}=fixture();assert.equal(c.constructionWarning({...plan,needs_attention:true}),'');
 const html=c.constructionWarning({...plan,progress_alert:true,warning_work_days:3,warning_min_progress:30,worked_days:3,completion_percent:14.3,progress_gap:15.7});
 assert.match(html,/3 個實際施工日須達 30%/);assert.match(html,/落後 15.7 個百分點/);assert.doesNotMatch(html,/80%/);
 assert.equal(c.constructionWarning({...plan,progress_alert:false}),'');
});
test('legacy workday Gantt keeps a common workday index and unique dated actual marks',()=>{
 const {c}=fixture(),html=c.constructionWorkdayGantt(plan);
 assert.match(html,/工作日序/);assert.match(html,/第 2 個工作日/);assert.equal((html.match(/class="gantt-actual"/g)||[]).length,2);assert.match(html,/2026-09-01/);
 assert.equal(c.constructionWorkdayGantt({items:[]}), '');
});
test('plan Gantt is date based: start date + days - 1 (calendar days, including the first day)',()=>{
 const {c}=fixture(),html=c.constructionGantt(plan);
 assert.match(html,/工期甘特圖（日期）/);assert.match(html,/2026-09-01～2026-09-04/);
 assert.equal((html.match(/class="v2-gantt-log"/g)||[]).length,2);
 assert.match(html,/data-gantt-scale="week"/);assert.match(html,/data-status="done"/);
 assert.equal(c.constructionGantt({items:[]}), '');
 const december=c.itemSchedule({construction_date:'2026-12-01',items:[]},{id:'x',start_day:1,planned_days:5,log_dates:[]});
 assert.equal(december.start,'2026-12-01');assert.equal(december.end,'2026-12-05');
});
test('checklist respects completion permission and escapes the item title',()=>{
 const {c}=fixture(),p={...plan,items:[{...plan.items[0],title:'<script>bad</script>'}]};
 assert.match(c.constructionChecklist(p),/checked disabled/);assert.doesNotMatch(c.constructionChecklist(p),/<script>/);
 assert.match(c.constructionChecklist({...plan,can_complete_items:true,can_create_log:true}),/data-construction-item="A"/);
 assert.match(c.constructionChecklist(plan),/預計 2026-09-01～2026-09-04（4 天）/);assert.match(c.constructionChecklist(plan),/實際 2026-09-01/);
});
test('form converts dates to the stored start day and rejects incomplete or out-of-range schedules',()=>{
 const {c}=fixture();
 const row=(title,date,days)=>({dataset:{itemId:'A'},querySelector:s=>({value:({'[data-item-title]':title,'[data-item-date]':date,'[data-item-days]':days})[s]})});
 const form=rows=>({elements:{plannedDays:{value:14},constructionDate:{value:'2026-12-01'}},querySelectorAll:()=>rows});
 assert.throws(()=>c.collectConstructionItems(form([row('A','2026-12-12',4)])),/超出施工規劃期間/);
 assert.throws(()=>c.collectConstructionItems(form([row('A','2026-11-30',2)])),/不可早於施工日期/);
 assert.throws(()=>c.collectConstructionItems(form([row('',  '2026-12-01',4)])),/名稱/);
 const saved=c.collectConstructionItems(form([row(' A ','2026-12-12',3)]))[0];
 assert.equal(saved.title,'A');assert.equal(saved.start_day,12);assert.equal(saved.planned_days,3);
});