import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function sourceBetween(start,end){
  const first=app.indexOf(start),last=app.indexOf(end,first);
  assert.ok(first>=0&&last>first);
  return app.slice(first,last);
}

test('開啟新增表單等待施工人員，不在進入前詢問維修品',async()=>{
  let release;
  const ready=new Promise(resolve=>{release=resolve;});
  const calls=[];
  const context=vm.createContext({
    ensureWorkLogWorkers:()=>ready,
    openModal:(...args)=>calls.push(args),
    confirm:()=>assert.fail('不可出現表單外確認視窗'),
    showToast:()=>assert.fail('正常載入不應報錯')
  });
  vm.runInContext(sourceBetween('async function openWorkLogModal','function syncAttachmentOptions'),context);
  const opening=context.openWorkLogModal();
  assert.equal(calls.length,0);
  release();
  assert.equal(await opening,true);
  assert.deepEqual(calls,[['workLogModal','']]);
});

test('切換種類清除上一種類品項，清除種類後停用品項選取',()=>{
  const item={innerHTML:'old item',disabled:false};
  const context=vm.createContext({inventoryItemOptions:category=>`options:${category}`});
  vm.runInContext(sourceBetween('function syncMaintenanceInventoryOptions','document.addEventListener("change"'),context);
  const category={value:'category-b',closest:()=>({querySelector:()=>item})};
  context.syncMaintenanceInventoryOptions(category);
  assert.equal(item.innerHTML,'options:category-b');
  assert.equal(item.disabled,false);
  category.value='';
  context.syncMaintenanceInventoryOptions(category);
  assert.equal(item.disabled,true);
  assert.equal(item.innerHTML,'options:');
});

test('空設備維修明細可被收集，設備有值時保留 UUID 清單',()=>{
  const values={eventType:'REPAIR',eventServiceId:'service-1',eventOccurredAt:'2026-09-05',eventCause:'',eventNotes:''};
  const card={dataset:{equipmentIds:'[]'},querySelector:selector=>({value:values[selector.match(/name="([^"]+)"/)[1]]})};
  const form={elements:{hasMaintenance:{value:'yes'},summary:{value:'現場檢查'}},querySelectorAll:()=>[card]};
  const context=vm.createContext({document:{querySelector:()=>form}});
  vm.runInContext(sourceBetween('function collectMaintenanceEvents','function projectOwnerPickerField'),context);
  let events=context.collectMaintenanceEvents();
  assert.equal(events.length,1);
  assert.equal(events[0].equipment_ids.length,0);
  assert.equal(events[0].description,'現場檢查');
  card.dataset.equipmentIds='["equipment-1","equipment-2"]';
  events=context.collectMaintenanceEvents();
  assert.equal(JSON.stringify(events[0].equipment_ids),'["equipment-1","equipment-2"]');
  form.elements.hasMaintenance.value='no';
  assert.equal(context.collectMaintenanceEvents().length,0);
});
