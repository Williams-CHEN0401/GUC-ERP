// Actual UI -> Gateway -> real SQL functions in a synthetic in-memory database.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {independentRepairsServer} from './independent-repairs-fixture.mjs';
import {ids} from './worklog-save-fixture.mjs';
import {extraIds} from './department-cross-system-fixture.mjs';
import {secondItem} from './pickup-notes-fixture.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixture=await independentRepairsServer(),{server,db,historical,calls,failures}=fixture;
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const output=new URL('../tmp/independent-repairs-browser/',import.meta.url);await mkdir(output,{recursive:true});
const row=async(table,id)=>(await db.query('select * from '+table+' where id=$1',[id])).rows[0];
let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/*',route=>{
    const target=new URL(route.request().url());
    if(target.origin!==origin){external.push(target.origin);return route.abort();}
    // NAS is outside this task; never connect to it. Worklog UI checks it on entry.
    if(target.pathname==='/api/nas')return route.fulfill({json:{message:'隔離環境，不連線 NAS',root:'/isolated'}});
    return route.continue();
  });
  await page.goto(origin+'/?page=worklogs');
  await page.waitForFunction(()=>document.querySelector('#worklogTable [data-work-log-row]')||document.querySelector('#systemChooser.open'));
  if(await page.locator('#systemChooser').evaluate(el=>el.classList.contains('open')))await page.locator('[data-system-choice="erp"]').click();
  await page.locator('#worklogTable [data-work-log-row]').first().waitFor();
  assert.ok((await page.locator('body').innerText()).length>100);assert.deepEqual(errors,[]);
  const form=page.locator('#modalForm');
  const openLog=async()=>{
    await page.locator('a[data-page="worklogs"]').click();
    await page.locator(`[data-work-log-row="${historical.work_log.id}"]`).dblclick();
    await page.locator('#simpleModal.open').waitFor();await page.waitForFunction(()=>formReferenceRequests.size===0);
  };
  const openRepair=async id=>{
    await page.locator('a[data-page="repairs"]').click();
    await page.locator(`#repairTable [data-row-id="${id}"]`).dblclick();
    await page.locator('#simpleModal.open').waitFor();await page.waitForFunction(()=>formReferenceRequests.size===0);
  };
  const save=async()=>{
    assert.equal(await form.evaluate(el=>el.checkValidity()),true,'form should be valid');
    const wait=page.waitForResponse(r=>r.url()===origin+'/api/inventory'&&r.request().method()==='POST');
    await form.locator('button[type="submit"]').click();const response=await wait;
    assert.equal(response.status(),201,JSON.stringify({response:await response.text(),failure:failures.at(-1)}));
    await page.locator('#simpleModal.open').waitFor({state:'hidden'});
  };
  const initialEvent=(await db.query('select * from maintenance_events where work_log_id=$1',[historical.work_log.id])).rows[0];
  const repair=(await db.query('select * from repair_items where source_maintenance_event_id=$1',[initialEvent.id])).rows[0];
  await openLog();
  assert.equal(await form.locator('[name="eventInventoryCategoryId"]').isDisabled(),false);
  assert.equal(await form.locator('[name="eventInventoryItemId"]').isDisabled(),false);
  await form.locator('[name="customerId"]').selectOption(extraIds.otherCustomer);
  await form.locator('[name="departmentId"]').selectOption(extraIds.otherDepartment);
  await form.locator('[name="projectName"]').fill('瀏覽器獨立修改工作');
  await form.locator('[name="eventServiceId"]').selectOption(ids.service);
  await form.locator('[name="logDate"]').fill('2026-09-29');
  await form.locator('[name="eventInventoryItemId"]').selectOption(secondItem);
  await form.locator('[name="eventCause"]').fill('修改日誌故障內容');
  await form.locator('[name="eventHandlingProcess"]').fill('修改日誌處理流程');
  await form.locator('[name="eventNotes"]').fill('日誌備註獨立');
  await page.screenshot({path:fileURLToPath(new URL('worklog-desktop.png',output))});
  await save();
  assert.deepEqual(await row('repair_items',repair.id),repair,'UI log edit must not alter repair');
  const log=await row('site_work_logs',historical.work_log.id),event=await row('maintenance_events',initialEvent.id);
  assert.equal((await row('projects',log.project_id)).customer_id,extraIds.otherCustomer);assert.equal(event.inventory_item_id,secondItem);
  await openRepair(repair.id);
  assert.equal(await form.locator('[name="customerId"]').inputValue(),ids.customer);
  // Move the repair to a third customer with no department; preserve source trace.
  await form.locator('[name="customerId"]').selectOption(extraIds.emptyCustomer);
  await form.locator('[name="receivedOn"]').fill('2026-09-20');
  await form.locator('[name="quantity"]').fill('2');
  await form.locator('[name="status"]').selectOption('received');
  await form.locator('[name="serialNumber"]').fill('BROWSER-SERIAL');
  await form.locator('[name="issueDescription"]').fill('維修品獨立故障');
  await form.locator('[name="notes"]').fill('維修品備註独立');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await form.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
  await page.screenshot({path:fileURLToPath(new URL('repair-mobile.png',output))});
  await save();
  const changed=await row('repair_items',repair.id);assert.equal(changed.customer_id,extraIds.emptyCustomer);assert.equal(changed.department_id,null);assert.equal(changed.source_maintenance_event_id,event.id);
  assert.deepEqual(await row('site_work_logs',log.id),log);assert.deepEqual(await row('maintenance_events',event.id),event);
  await page.setViewportSize({width:1440,height:1000});await openLog();
  assert.equal(await form.locator('[name="customerId"]').inputValue(),extraIds.otherCustomer);
  assert.equal(await form.locator('[name="eventInventoryItemId"]').inputValue(),secondItem);
  await form.locator('[name="eventNotes"]').fill('來源維修品客戶不同，仍可保存');await save();
  assert.deepEqual(await row('repair_items',repair.id),changed);
  await page.reload();await page.locator('#worklogTable [data-work-log-row]').first().waitFor();await openLog();
  assert.equal(await form.locator('[name="eventNotes"]').inputValue(),'來源維修品客戶不同，仍可保存');
  await page.locator('#simpleModal button[data-close]').click();await openRepair(repair.id);
  assert.equal(await form.locator('[name="customerId"]').inputValue(),extraIds.emptyCustomer);
  assert.equal(await form.locator('[name="receivedOn"]').inputValue(),'2026-09-20');
  assert.equal(await form.locator('[name="notes"]').inputValue(),'維修品備註独立');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(calls.length,3);
  console.log('PASS: desktop and 390px UI; 3 real form saves through Gateway/SQL; customer/department/item/date/text independent; reload verified; provenance retained; no external requests or browser errors.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await db.close();}
