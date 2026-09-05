import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const between=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
const helper=between('function isEquipmentRepairEvent','function syncMaintenanceInventoryOptions');

test('維修名稱只改顯示文字，保留 cause 和既有 API 欄位',()=>{
  assert.ok(app.includes('登錄維修事項'));
  assert.ok(app.includes('<b>維修明細</b>'));
  assert.ok(app.includes('inputField("eventCause","故障內容（選填）"'));
  assert.ok(!app.includes('設備維修明細'));
  assert.match(app,/cause:.*?\.cause\|\|""/);
});
test('非設備事件不送出未登錄的品項；已登錄關聯與設備履歷維持原值',()=>{
  const values={eventType:'REPAIR',eventServiceId:'service',eventOccurredAt:'2026-09-05',eventCause:'馬達異常',eventNotes:'',eventInventoryCategoryId:'category',eventInventoryItemId:'item'};
  const card={dataset:{equipmentIds:'["equipment"]'},querySelector:s=>({value:values[s.match(/name="([^"]+)"/)[1]]})};
  const form={elements:{hasMaintenance:{value:'yes'},summary:{value:'檢查'}},querySelectorAll:()=>[card]};
  const ctx=vm.createContext({document:{querySelector:()=>form}});
  vm.runInContext(helper+between('function collectMaintenanceEvents','function projectOwnerPickerField'),ctx);
  for(const type of ['REPAIR','REPLACEMENT','SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','INSPECTION']){
    values.eventType=type;
    const event=ctx.collectMaintenanceEvents()[0];
    assert.equal(event.inventory_item_id,['REPAIR','REPLACEMENT'].includes(type)?'item':null);
    assert.deepEqual([...event.equipment_ids],['equipment']);assert.equal(event.cause,'馬達異常');
  }
  values.eventInventoryCategoryId='';
  assert.equal(ctx.collectMaintenanceEvents()[0].inventory_item_id,null,'hidden incomplete selection must not block unrelated events');
  values.eventInventoryCategoryId='category';
  card.dataset.repairRegistered='true';card.dataset.eventId='existing';card.dataset.rowVersion='2';
  assert.equal(ctx.collectMaintenanceEvents()[0].inventory_item_id,'item');
});
test('返回表單僅重抓既有 inventory scope；背景、其他視窗、預覽不抓正式資料',async()=>{
  const modal={dataset:{type:'workLogModal'},classList:{contains:()=>true}},document={visibilityState:'visible',querySelector:()=>modal},calls=[];
  const ctx=vm.createContext({document,PREVIEW_MODE:false,loadScope:async(...args)=>calls.push(args)});
  vm.runInContext(between('async function refreshOpenWorkLogInventory','window.addEventListener("focus"'),ctx);
  await ctx.refreshOpenWorkLogInventory();assert.equal(calls.length,1);assert.equal(calls[0][0],'inventory');assert.equal(calls[0][1].force,true);
  document.visibilityState='hidden';await ctx.refreshOpenWorkLogInventory();assert.equal(calls.length,1);
  document.visibilityState='visible';modal.dataset.type='repairModal';await ctx.refreshOpenWorkLogInventory();assert.equal(calls.length,1);
  modal.dataset.type='workLogModal';ctx.loadScope=async()=>{throw new Error('offline');};await ctx.refreshOpenWorkLogInventory();
  ctx.PREVIEW_MODE=true;let refreshed=false;ctx.refreshMaintenanceInventoryChoices=()=>{refreshed=true;};
  ctx.loadScope=async()=>assert.fail('preview cannot reload production data');await ctx.refreshOpenWorkLogInventory();assert.equal(refreshed,true);
});
test('新函式沿用原簽章與權限，僅更動建立條件及故障欄位 mapping',()=>{
  const old=readFileSync(new URL('../supabase/migrations/20260905081650_maintenance_event_types.sql',import.meta.url),'utf8');
  const current=readFileSync(new URL('../supabase/migrations/20260905111720_worklog_repair_mapping.sql',import.meta.url),'utf8');
  const head=sql=>sql.slice(sql.indexOf('create or replace function'),sql.indexOf('as $$'));
  assert.equal(head(current),head(old));
  assert.doesNotMatch(current,/\b(?:alter table|create table|grant |revoke |create trigger)\b/i);
  assert.match(current,/v_register_repair := v_event_type in \('REPAIR','REPLACEMENT'\)/);
  assert.match(current,/p_customer_id,v_inventory_item_id,v_notes,null,null,null,v_cause/);
  assert.match(current,/v_cause := nullif\(btrim\(coalesce\(v_event_json->>'cause',''\)\),''\)/);
});
