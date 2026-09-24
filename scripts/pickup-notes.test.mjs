import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {definition} from './worklog-save-fixture.mjs';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const gateway=readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8');
const migration=readFileSync(new URL('../supabase/migrations/20260924082425_pickup_row_notes.sql',import.meta.url),'utf8');
const baseline=readFileSync(new URL('../supabase/migrations/20260923003902_independent_work_log_pickup_project.sql',import.meta.url),'utf8');
const source=name=>app.split(/\r?\n/).find(line=>line.startsWith('function '+name+'('));
function ui(){
 const context=vm.createContext({itemCategoryOptions:()=>'',inventoryItemOptions:()=>'',state:{inventory:[{id:'i',categoryId:'c'},{id:'j',categoryId:'c'}]},MAX_BATCH_ROWS:20});
 for(const name of ['esc','byId','valueText','transactionBatchRow','collectTransactionBatchRows'])vm.runInContext(source(name),context);
 return context;
}
test('both batch types show a safely escaped optional last note, before delete',()=>{
 const c=ui();
 for(const type of ['pickup','receipt']){
  const html=c.transactionBatchRow(type,{note:'"><script>alert(1)</script>'});
  assert.ok(html.indexOf('batchQuantity')<html.indexOf('batchNote'));assert.ok(html.indexOf('batchNote')<html.indexOf('data-remove-batch-row'));
  assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/name="batchNote"[^>]*required/);
 }
 assert.match(c.transactionBatchRow('pickup'),/maxlength="500"/);
});
test('row collector preserves each note, trims blank, rejects overlong and duplicate pickups',()=>{
 const c=ui(),data=[{item:'i',note:' A '},{item:'j',note:' B '}];
 c.document={querySelectorAll:()=>data.map(row=>({querySelector:key=>({value:key==='[data-batch-category]'?'c':key==='[data-batch-item]'?row.item:key==='[name="batchQuantity"]'?'2':row.note})}))};
 assert.deepEqual(Array.from(c.collectTransactionBatchRows('pickup'),x=>x.note),['A','B']);
 data[1].note='  ';assert.equal(c.collectTransactionBatchRows('pickup')[1].note,'');
 data[1].note='長'.repeat(501);assert.throws(()=>c.collectTransactionBatchRows('pickup'),/500/);
 data[1].note='不同';data[1].item='i';assert.throws(()=>c.collectTransactionBatchRows('pickup'),/重複/);
});
test('both pickup submit paths send notes, hydrate and edit retain them, Gateway selects them',()=>{
 for(const prefix of ['  if(type==="pickupModal"){const project=','  if(type==="workLogPickupModal"){const log=']){
  const line=app.split(/\r?\n/).find(x=>x.startsWith(prefix)&&x.includes('await mutate'));
  assert.match(line,/quantity:r.quantity,note:r.note/);
 }
 assert.match(app,/quantity:Number\(r.quantity\),note:r.note\|\|""/);
 const modal=app.split(/\r?\n/).find(x=>x.startsWith('  if(type==="pickupModal"){title='));
 assert.ok(modal.includes('name="note"'));assert.ok(modal.includes('esc(r.note||"")'));assert.ok(modal.includes('maxlength="500"'));
 assert.match(gateway,/pickup_records\?select=id,pickup_date,project_id,inventory_item_id,quantity,note,/);
 assert.match(gateway,/hasNote\?"update_pickup_record_v2":"update_pickup_record"/);
});
test('note-aware edit keeps the original locks, inventory/link logic and versioned single update',()=>{
 const actual=definition(migration,'update_pickup_record_v2')
  .replace('public.update_pickup_record_v2(','public.update_pickup_record(')
  .replace('  p_note text,\n','')
  .replace("  if char_length(p_note) > 500 then raise exception '取貨備註不可超過 500 個字。'; end if;\n",'')
  .replace("      note = nullif(btrim(p_note), ''),\n",'');
 assert.equal(actual.replaceAll('\r',''),definition(baseline,'update_pickup_record').replaceAll('\r',''));
});
test('pickup grid can shrink while receipt layout remains explicitly scoped',()=>{
 const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
 assert.ok(css.includes('.transaction-batch-row{display:grid;grid-template-columns:34px minmax(0,1fr) minmax(0,1.4fr) 85px minmax(0,1fr) 70px'));
 assert.ok(css.includes('.receipt-batch .transaction-batch-row{grid-template-columns:34px minmax(130px,1fr) minmax(190px,1.4fr) 85px minmax(140px,1fr) 70px}'));
});
