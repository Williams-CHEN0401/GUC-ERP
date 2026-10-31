import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const workforce=readFileSync(new URL('../work-log-workforce.js',import.meta.url),'utf8');
const maintenance=readFileSync(new URL('../maintenance-pending.js',import.meta.url),'utf8');
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function harness(extra={}){
 const context=vm.createContext({document:{addEventListener(){}},esc:escape,canWrite:()=>true,canWorkLog:()=>true,state:{maintenanceEvents:[]},...extra});
 vm.runInContext(maintenance+'\n'+workforce,context);
 return context;
}
function generalForm(content='本次施工',text='X'){
 const selected=[{dataset:{pendingLogIndex:'0'}}];
 const form={elements:{completedContent:{value:content},logDate:{value:'2026-10-28'},workType:{value:'工程施工'}},
  _pendingLogItems:[{pending_text:text,source_log_id:'source-log',row_version:3}],
  querySelectorAll:selector=>selector==='[data-pending-log-index]:checked'?selected:[]};
 return {form,selected};
}

test('承接未完成事項使用原文加日期，不額外產生方括號',()=>{
 const context=harness(),{form}=generalForm();
 context.syncPendingNotes(form);
 assert.equal(form.elements.completedContent.value,'本次施工\nX(10-28已完成)');
 assert.equal(context.maintenancePendingNote({pending_text:'X'},'2026-10-28'),'X(10-28已完成)');
 const payload=context.collectWorkLogWorkforce(form);
 assert.deepEqual(JSON.parse(JSON.stringify(payload.resolved_pending_items)),[{source_log_id:'source-log',row_version:3,pending_text:'X'}]);
});

test('事項原本包含方括號時保留原文，不刪除使用者的內容',()=>{
 const context=harness(),{form}=generalForm('本次施工','檢查 [A] 端子');
 context.syncPendingNotes(form);
 assert.equal(form.elements.completedContent.value,'本次施工\n檢查 [A] 端子(10-28已完成)');
 assert.equal(context.maintenancePendingNote({pending_text:'[X]'},'2026-10-28'),'[X](10-28已完成)');
});

test('修改日期及取消勾選只更新自動生成行，保留手填內容',()=>{
 const context=harness(),{form,selected}=generalForm('本次施工\n手填說明');
 context.syncPendingNotes(form);
 form.elements.logDate.value='2026-10-29';
 context.syncPendingNotes(form);
 assert.equal(form.elements.completedContent.value,'本次施工\n手填說明\nX(10-29已完成)');
 context.syncPendingNotes(form);
 assert.equal(form.elements.completedContent.value.split('X(10-29已完成)').length,2);
 selected.splice(0);
 context.syncPendingNotes(form);
 assert.equal(form.elements.completedContent.value,'本次施工\n手填說明');
});

test('與自動格式相同的既有手填行不因取消勾選而刪除',()=>{
 const context=harness(),{form,selected}=generalForm('X(10-28已完成)');
 context.syncPendingNotes(form);
 selected.splice(0);
 context.syncPendingNotes(form);
 assert.equal(form.elements.completedContent.value,'X(10-28已完成)');
});

test('維修未完成計數排除metadata display_text，但不排原始文字或其他待辦',()=>{
 const context=harness();
 const result=context.maintenanceActivePendingLines('X(10-28已完成)\nX\nY\nY\n',[
  {pending_text:'X',completed_date:'2026-10-28',display_text:'X(10-28已完成)'}
 ]);
 assert.deepEqual([...result],['X','Y']);
});

test('舊metadata沒有display_text時用原文與完整日期精確對應',()=>{
 const context=harness();
 const result=context.maintenanceActivePendingLines(' X(10-28已完成) \r\nY',[
  {pending_text:'X',completed_date:'2026-10-28'}
 ]);
 assert.deepEqual([...result],['Y']);
});

test('display_text為權威精確文字，不以日期模式猜測其他完成行',()=>{
 const context=harness();
 const result=context.maintenanceActivePendingLines('已修復：X\nX(10-28已完成)\nY(10-28已完成)',[
  {pending_text:'X',completed_date:'2026-10-28',display_text:'已修復：X'}
 ]);
 assert.deepEqual([...result],['X(10-28已完成)','Y(10-28已完成)']);
});

test('缺metadata或metadata無法辨識時，外觀像完成註記仍算未完成',()=>{
 const context=harness(),text='X(10-28已完成)';
 for(const metadata of [undefined,null,{},[],[null],[],[{pending_text:'X'}],[{pending_text:'X',completed_date:28}]]){
  assert.deepEqual([...context.maintenanceActivePendingLines(text,metadata)],[text]);
 }
});

function summaryHarness(events,values){
 const summary={hidden:false,textContent:''},editor={hidden:false,querySelector:()=>summary,querySelectorAll:()=>[]};
 const cards=values.map(({id,value})=>{
  const notesLabel={hidden:false},pendingLabel={hidden:false},notes={value:'',closest:()=>notesLabel},label={textContent:''};
  const card={dataset:{eventId:id},querySelector:selector=>({'[name="eventNotes"]':notes,'[name="eventPendingContent"]':pending,'[data-notes-label]':label}[selector])};
  const pending={value,closest:selector=>selector==='[data-maintenance-event]'?card:pendingLabel};
  return card;
 });
 const form={elements:{workType:{value:'維修紀錄'}},querySelector:selector=>selector==='#maintenanceEditor'?editor:null,
  querySelectorAll:selector=>selector==='[data-maintenance-event]'?cards:selector==='[name="eventPendingContent"]'?cards.map(card=>card.querySelector(selector)):[]};
 const context=harness({state:{maintenanceEvents:events},document:{addEventListener(){},querySelector:selector=>selector==='#modalForm'?form:selector==='#simpleModal'?{dataset:{id:'existing-log'}}:null}});
 return {context,form,summary};
}

test('維修摘要全是歷史行時顯示0項，不再要求進行中',()=>{
 const {context,summary}=summaryHarness([{id:'source',pendingCompletions:[{pending_text:'X',completed_date:'2026-10-28',display_text:'X(10-28已完成)'}]}],[{id:'source',value:'X(10-28已完成)'}]);
 context.syncMaintenancePendingFields();
 assert.equal(summary.textContent,'本次事件未完成：0 項');
 assert.equal(summary.hidden,false);
});

test('維修摘要依各事件自身metadata計數，不能用別人的完成紀錄扣除',()=>{
 const {context,summary}=summaryHarness([
  {id:'source',pendingCompletions:[{pending_text:'X',completed_date:'2026-10-28'}]},
  {id:'other',pendingCompletions:[],pendingSources:[{pending_text:'X',completed_date:'2026-10-28',display_text:'X(10-28已完成)'}]}
 ],[{id:'source',value:'X(10-28已完成)\nY'}, {id:'other',value:'X(10-28已完成)'}]);
 context.syncMaintenancePendingFields();
 assert.equal(summary.textContent,'本次事件未完成：2 項；儲存時請使用「進行中」狀態。');
});

test('新事件沒有來源metadata時正常計算去重待辦，非維修模式隱藏摘要',()=>{
 const {context,form,summary}=summaryHarness([],[{id:'',value:'X\nX\nY(10-28已完成)'}]);
 context.syncMaintenancePendingFields();
 assert.equal(summary.textContent,'本次事件未完成：2 項；儲存時請使用「進行中」狀態。');
 form.elements.workType.value='維護保養';
 context.syncMaintenancePendingFields();
 assert.equal(summary.hidden,true);
});

test('維修欄位保留來源歷史內容及舊備註並維持HTML escaping',()=>{
 const context=harness(),html=context.maintenancePendingFields({notes:'舊備註 <保留>',pendingContent:'X(10-28已完成)\n<script>',pendingCompletions:[{pending_text:'X',completed_date:'2026-10-28'}]});
 assert.match(html,/舊備註 &lt;保留&gt;/);
 assert.match(html,/X\(10-28已完成\)\n&lt;script&gt;/);
 assert.match(html,/已結清事項會保留並標示完成日期，不再列入待辦/);
 assert.match(html,/未完成事項處理紀錄（1）/);
 assert.doesNotMatch(html,/<script>/);
});
