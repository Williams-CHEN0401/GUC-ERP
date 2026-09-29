import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const between=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
test('已登錄維修品的事件品項仍可獨立編輯，保留停用的歷史種類',()=>{
  const state={inventory:[{id:'item',categoryId:'old',name:'原品項'}],categories:[{id:'old',name:'停用種類',active:false}],repairItems:[{sourceMaintenanceEventId:'event'}]};
  const ctx=vm.createContext({state,byId:(rows,id)=>rows.find(r=>r.id===id),esc:x=>String(x??''),itemCategoryOptions:()=>'<option value="">請選擇種類</option>',inventoryItemOptions:()=>'<option value="item" selected>原品項</option>'});
  vm.runInContext(between('function maintenanceInventoryFields','function syncMaintenanceInventoryOptions'),ctx);
  const html=ctx.maintenanceInventoryFields({id:'event',repairRegistered:true,eventType:'REPAIR',inventoryCategoryId:'old',inventoryItemId:'item'});
  assert.doesNotMatch(html,/disabled/);assert.match(html,/<option value="old" selected>停用種類/);
});
test('事件欄位權限與類型限制保留，但不因來源維修品而鎖定',()=>{
  let writable=true;const category={value:'category'},card={dataset:{repairRegistered:'true'},querySelector:selector=>selector.includes('eventType')?{value:'REPAIR'}:category};
  const label={},field={name:'eventInventoryItemId',closest:selector=>selector==='[data-maintenance-event]'?card:label};
  const editor={hidden:false,querySelectorAll:()=>[field]},form={elements:{hasMaintenance:{value:'yes'}},querySelector:()=>editor};
  const ctx=vm.createContext({document:{querySelector:()=>form},canWrite:()=>writable,isEquipmentRepairEvent:type=>type==='REPAIR'});
  vm.runInContext(between('function syncMaintenanceVisibility','function refreshMaintenanceServices'),ctx);
  ctx.syncMaintenanceVisibility();assert.equal(field.disabled,false);assert.equal(label.hidden,false);
  writable=false;ctx.syncMaintenanceVisibility();assert.equal(field.disabled,true);
  writable=true;category.value='';ctx.syncMaintenanceVisibility();assert.equal(field.disabled,true);
});
test('預覽不再覆寫來源維修品日期或綁定客戶／品項，保留設備保護',()=>{
  const preview=between('function applyPreviewMutation','function savedWorkLogId');
  assert.doesNotMatch(preview,/此日誌已登錄維修品|此明細已登錄維修品|repair\.receivedOn=payload\.log_date/);
  assert.match(app,/此日誌已有客戶設備關聯/);
  assert.doesNotMatch(between('function refreshMaintenanceInventoryChoices','async function refreshOpenWorkLogInventory'),/repairRegistered/);
});
test('migration 僅替換三個既有函式，保留資料與權限，基準不符時中止',()=>{
  const sql=readFileSync(new URL('../supabase/migrations/20260929150841_independent_worklog_repair_edits.sql',import.meta.url),'utf8');
  assert.equal((sql.match(/pg_get_functiondef/g)||[]).length,3);
  assert.equal((sql.match(/Unexpected .* baseline/g)||[]).length,4);
  assert.doesNotMatch(sql,/\b(?:alter table|create table|grant |revoke |create policy|drop table)\b/i);
  assert.match(sql,/begin;/);assert.match(sql,/commit;/);
});
