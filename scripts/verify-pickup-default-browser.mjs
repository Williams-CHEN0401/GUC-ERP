// Chrome -> actual ERP form -> existing Gateway -> isolated SQL -> reload.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {pickupDefaultServer} from './pickup-default-preview-server.mjs';
import {extraIds} from './department-cross-system-fixture.mjs';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixture=await pickupDefaultServer(),{server,db,calls,independent,legacy}=fixture;
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
const errors=[],external=[],results=[];
const all=async table=>(await db.query('select * from '+table+' order by id')).rows;
const pickup=async id=>(await db.query('select * from pickup_records where id=$1',[id])).rows[0];
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.route('**/*',route=>{
    if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}
    return route.continue();
  });
  const go=async()=>{
    await page.goto(origin+'/?page=transactions');
    await page.waitForFunction(()=>document.querySelector('#pickupTable [data-row-id]')||document.querySelector('#systemChooser.open'));
    if(await page.locator('#systemChooser').evaluate(node=>node.classList.contains('open')))
      await page.locator('[data-system-choice="erp"]').click();
    await page.locator('#pickupTable [data-row-id]').first().waitFor();
  };
  const open=async id=>{
    const row=page.locator(`#pickupTable [data-row-id="${id}"]`);
    await row.focus();await row.press('Enter');
    await page.locator('#simpleModal.open').waitFor();
    await page.waitForFunction(()=>formReferenceRequests.size===0);
  };
  const selected=()=>page.locator('#modalForm [name="projectId"]').inputValue();
  const close=()=>page.locator('#simpleModal button[data-close]').click();
  const save=async()=>{
    const response=page.waitForResponse(res=>res.url().includes('/api/inventory')&&res.request().method()==='POST');
    await page.locator('#modalForm button[type="submit"]').click();
    const res=await response;assert.equal(res.status(),201,await res.text());
    await page.locator('#simpleModal.open').waitFor({state:'hidden'});
  };
  const originals=await all('pickup_records'),logs=await all('site_work_logs'),projects=await all('projects');
  const closed=originals.find(row=>row.work_log_id===independent.a.work_log.id);
  const active=originals.find(row=>row.work_log_id===independent.b.work_log.id);
  const noDepartment=originals.find(row=>row.project_id===legacy.project.id);
  await go();
  await open(closed.id);
  assert.equal(await selected(),closed.project_id);
  assert.equal(await page.locator('#modalForm [name="departmentId"]').inputValue(),independent.a.project.department_id);
  assert.deepEqual(await all('pickup_records'),originals,'opening edit must not mutate rows');
  await page.evaluate(()=>refreshVisibleFormReferences({force:true}));
  assert.equal(await selected(),closed.project_id,'background reference refresh retains original');
  await mkdir(new URL('../.next/pickup-default-verification/',import.meta.url),{recursive:true});
  await page.screenshot({path:fileURLToPath(new URL('../.next/pickup-default-verification/desktop.png',import.meta.url)),fullPage:true});
  await page.locator('#modalForm [name="note"]').fill('僅修改備註，保留原工作');
  await save();
  let row=await pickup(closed.id);
  assert.equal(row.project_id,closed.project_id);assert.equal(row.work_log_id,closed.work_log_id);
  assert.equal(row.quantity,closed.quantity);assert.equal(row.inventory_item_id,closed.inventory_item_id);
  assert.equal(row.note,'僅修改備註，保留原工作');
  assert.equal(row.row_version,closed.row_version+1);
  await go();await open(closed.id);assert.equal(await selected(),closed.project_id);await close();
  results.push('Closed original selected, refreshed, saved through RPC and retained after reload; quantity/log link unchanged.');
  await open(active.id);assert.equal(await selected(),active.project_id);
  await page.locator('#modalForm [name="note"]').fill('進行中工作保留');await save();
  assert.equal((await pickup(active.id)).project_id,active.project_id);
  assert.equal((await pickup(active.id)).work_log_id,active.work_log_id);
  await go();await open(active.id);assert.equal(await selected(),active.project_id);await close();
  results.push('In-progress original retained through save/reload.');
  await open(noDepartment.id);assert.equal(await selected(),noDepartment.project_id);
  assert.equal(await page.locator('#modalForm [name="departmentId"]').inputValue(),'');await close();
  results.push('Historical work without department retains its closed original.');
  await open(closed.id);
  await page.locator('#modalForm [name="projectId"]').selectOption(active.project_id);
  await page.evaluate(()=>refreshVisibleFormReferences({force:true}));
  assert.equal(await selected(),active.project_id,'refresh must not reset an intentional new selection');
  await save();row=await pickup(closed.id);
  assert.equal(row.project_id,active.project_id);assert.equal(row.work_log_id,null);
  await go();await open(closed.id);assert.equal(await selected(),active.project_id);await close();
  results.push('Intentional reassignment remains supported; only edited pickup detaches its old log.');
  await open(active.id);
  await page.locator('#modalForm [name="customerId"]').selectOption(extraIds.otherCustomer);
  assert.equal(await selected(),'');await close();
  await open(active.id);await page.locator('#modalForm [name="departmentId"]').selectOption('');
  assert.equal(await selected(),'');await close();
  results.push('Customer/department changes still clear invalid choices.');
  await page.locator('[data-open="pickupModal"]').click();
  await page.locator('#modalForm [name="customerCategory"]').selectOption('school');
  await page.locator('#modalForm [name="customerId"]').selectOption(independent.a.project.customer_id);
  await page.locator('#modalForm [name="departmentId"]').selectOption(independent.a.project.department_id);
  assert.equal(await selected(),'');
  assert.equal(await page.locator(`#modalForm [name="projectId"] option[value="${independent.a.project.id}"]`).count(),0);
  assert.equal(await page.locator(`#modalForm [name="projectId"] option[value="${active.project_id}"]`).count(),1);await close();
  results.push('New pickup stays blank and offers active work only.');
  await page.setViewportSize({width:390,height:844});await open(noDepartment.id);
  assert.equal(await selected(),noDepartment.project_id);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:fileURLToPath(new URL('../.next/pickup-default-verification/mobile.png',import.meta.url)),fullPage:true});
  assert.deepEqual(await all('site_work_logs'),logs);assert.deepEqual(await all('projects'),projects);
  for(const sibling of originals.filter(row=>![closed.id,active.id].includes(row.id)))assert.deepEqual(await pickup(sibling.id),sibling);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  assert.equal(calls.filter(call=>call.name==='update_pickup_record_v2').length,3);
  results.push('390px Chrome layout valid; sibling pickups, logs and work master unchanged; no browser errors/outbound requests.');
  console.log(JSON.stringify({status:'PASS',browser:await browser.version(),results,rpcSaves:3,errors,external},null,2));
}finally{
  await browser?.close();await new Promise(resolve=>server.close(resolve));await db.close();
}
