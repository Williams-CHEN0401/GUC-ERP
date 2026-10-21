import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../work-log-construction-reminder.js',import.meta.url),'utf8');
const context=vm.createContext({document:{addEventListener(){}}});vm.runInContext(source,context);
const groups=(plans,id='P')=>JSON.parse(JSON.stringify(context.workLogPendingConstructionGroups(plans,id)));
test('reminders retain unchecked items even if their daily work is marked completed',()=>{
 const plans=[{id:'a',project_id:'P',content:'施工',status:'in_progress',items:[{id:'unchecked',title:'網路線',is_completed:false,worked_days:1},{id:'checked',title:'設備',is_completed:true}]}];
 assert.deepEqual(groups(plans),[{id:'a',title:'施工',items:[{id:'unchecked',title:'網路線'}]}]);
});
test('cancelled plans and different projects cannot appear in reminders',()=>{
 assert.deepEqual(groups([{id:'a',project_id:'Q',status:'pending',items:[{is_completed:false}]},{id:'b',project_id:'P',status:'cancelled',items:[{is_completed:false}]}]),[]);
});
test('legacy plans use plan status; a checked plan disappears from reminders',()=>{
 assert.deepEqual(groups([{id:'a',project_id:'P',content:'legacy',status:'pending',items:[]},{id:'b',project_id:'P',status:'completed',items:[]},{id:'c',project_id:'P',status:'completed',items:[{is_completed:true}]}]),[{id:'a',title:'legacy',items:[]}]);
});
