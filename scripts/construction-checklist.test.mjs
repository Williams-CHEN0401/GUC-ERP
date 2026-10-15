import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function fixture(){
 const handlers={},c=vm.createContext({document:{addEventListener:(name,fn)=>handlers[name]=fn},uid:()=> 'test-id',esc:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')});
 vm.runInContext(readFileSync(new URL('../construction-checklist.js',import.meta.url),'utf8'),c);return{c,handlers};
}
const plan={content:'配管施工',planned_days:14,worked_days:12,item_count:2,completed_item_count:1,completion_percent:57.1,completed_days:8,remaining_days:6,warning_after_days:12,needs_attention:true,unstarted_items:[{title:'C 棟配管施工'}],work_dates:['2026-09-01','2026-09-02'],items:[{id:'A',title:'A 棟',start_day:1,planned_days:4,is_completed:true,worked_days:2,log_dates:['2026-09-01','2026-09-02']}]};
test('completion and consumed workdays are independent metrics',()=>{
 const {c}=fixture(),html=c.constructionChecklistProgress(plan);
 assert.match(html,/已執行 12 天/);assert.match(html,/完成工期 8 天｜剩餘工期 6 天/);assert.match(html,/57.1%（1\/2 項完成）/);assert.doesNotMatch(html,/85.7%/);
 assert.match(c.constructionChecklistProgress({...plan,worked_days:16}),/超出預計施工天數 2 天/);
});
test('warning displays authoritative threshold and escapes titles',()=>{
 const {c}=fixture();assert.equal(c.constructionWarning({...plan,needs_attention:false}),'');
 const html=c.constructionWarning({...plan,unstarted_items:[{title:'<img src=x onerror=alert(1)>'}]});
 assert.match(html,/第 12 天/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
});
test('Gantt uses a common workday index and includes unique dated actual marks',()=>{
 const {c}=fixture(),html=c.constructionGantt(plan);
 assert.match(html,/工作日序/);assert.match(html,/第 2 個工作日/);assert.equal((html.match(/class="gantt-actual"/g)||[]).length,2);assert.match(html,/2026-09-01/);
 assert.equal(c.constructionGantt({items:[]}), '');
});
test('checklist respects completion permission and escapes the item title',()=>{
 const {c}=fixture(),p={...plan,items:[{...plan.items[0],title:'<script>bad</script>'}]};
 assert.match(c.constructionChecklist(p),/checked disabled/);assert.doesNotMatch(c.constructionChecklist(p),/<script>/);
 assert.match(c.constructionChecklist({...plan,can_complete_items:true,can_create_log:true}),/data-construction-item="A"/);
});
test('form rejects incomplete and out-of-range schedules before sending',()=>{
 const {c}=fixture();
 const row=(title,start,days)=>({dataset:{itemId:'A'},querySelector:s=>({value:({'[data-item-title]':title,'[data-item-start]':start,'[data-item-days]':days})[s]})});
 const form=rows=>({elements:{plannedDays:{value:14}},querySelectorAll:()=>rows});
 assert.throws(()=>c.collectConstructionItems(form([row('A',12,4)])),/超出總工期/);
 assert.throws(()=>c.collectConstructionItems(form([row('',1,4)])),/名稱/);
 assert.equal(c.collectConstructionItems(form([row(' A ',12,3)]))[0].title,'A');
});
