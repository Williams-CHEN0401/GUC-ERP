// Actual form -> Gateway validation -> restricted-role PostgreSQL -> reload.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
import {ids} from './worklog-save-fixture.mjs';
import {extraIds} from './department-cross-system-fixture.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=new URL('../tmp/department-cross-system/',import.meta.url);await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{for(const width of [1440,390]){
 const {server,db,calls}=await createWorklogTestServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port,context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();page.setDefaultTimeout(10000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.dismiss());
 await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 const form=page.locator('#modalForm'),choose=async(department=ids.department)=>{await form.locator('[name="customerCategory"]').selectOption('school');await form.locator('[name="customerId"]').selectOption(ids.customer);await form.locator('[name="departmentId"]').selectOption(department);};
 const submit=async()=>{const [result]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/inventory')&&r.request().method()==='POST'),form.locator('button[type="submit"]').click()]);assert.equal(result.status(),201,await result.text());await page.locator('#simpleModal').waitFor({state:'hidden'});};
 const open=async(type,id)=>{await page.waitForFunction(([type,id])=>state[({projectModal:'projects',repairModal:'repairItems',receiptModal:'receipts'})[type]]?.some(row=>row.id===id),[type,id]);await page.evaluate(([type,id])=>openModal(type,id),[type,id]);};
 try{
  console.log('Cross-system browser '+width+'px: work log');
  await page.goto(base+'/?page=worklogs');await page.locator('[data-open="workLogModal"]').click();
  assert.equal(await form.locator('[name="customerId"]').inputValue(),'');assert.equal(await form.locator('[name="departmentId"]').isDisabled(),true);
  await choose();await form.locator('[name="projectName"]').fill('高雄大學應數系查修 '+width);await form.locator('[name="workType"]').selectOption('維修紀錄');
  assert.equal(await form.locator('[name="summary"]').isVisible(),false);await form.locator('[name="workerIds"]').check();await form.locator('[name="eventType"]').selectOption('REPAIR');await form.locator('[name="eventServiceId"]').selectOption(ids.service);await form.locator('[name="eventInventoryCategoryId"]').selectOption(ids.category);await form.locator('[name="eventInventoryItemId"]').selectOption(ids.item);await form.locator('[name="eventHandlingProcess"]').fill('科室儲存與重新讀取驗證');
  await form.locator('[name="customerCategory"]').scrollIntoViewIfNeeded();await page.screenshot({path:fileURLToPath(new URL('worklog-form-'+width+'.png',output)),fullPage:true});
  const boxes=await form.locator('[data-customer-selector]>label').evaluateAll(rows=>rows.slice(0,3).map(row=>({x:row.getBoundingClientRect().x,y:row.getBoundingClientRect().y,right:row.getBoundingClientRect().right})));
  if(width===390)assert.ok(boxes[0].y<boxes[1].y&&boxes[1].y<boxes[2].y);
  assert.ok(boxes.every(box=>box.x>=0&&box.right<=width));await submit();
  assert.equal(calls[0].name,'upsert_customer_project_work_log_department_v1');const saved=calls[0].result;assert.equal(saved.project.department_id,ids.department);assert.equal(saved.created_repair_item_ids.length,1);
  await page.reload();await page.locator('#worklogTable strong').filter({hasText:'高雄大學應數系查修 '+width}).dblclick();assert.equal(await form.getByLabel('科室',{exact:true}).inputValue(),'應用數學系');
  await form.locator('[name="eventNotes"]').fill('重新載入後修改');await submit();assert.equal((await db.query('select count(*)::int count from repair_items')).rows[0].count,1);
  console.log('Cross-system browser '+width+'px: project, repair, receipt');
  await page.goto(base+'/?page=crm');await page.locator('[data-tab="projects"]').click();await page.locator('#projectListPane [data-open="projectModal"]').click();await choose(extraIds.secondDepartment);await form.locator('[name="name"]').fill('資訊室施工 '+width);await form.locator('[name="constructionCategory"]').selectOption('small_purchase');await submit();
  const project=calls.at(-1).result.project;assert.equal(project.department_id,extraIds.secondDepartment);await page.reload();await open('projectModal',project.id);assert.equal(await form.locator('[name="departmentId"]').inputValue(),extraIds.secondDepartment);await form.locator('[name="departmentId"]').selectOption(ids.department);await submit();assert.equal(calls.at(-1).result.project.department_id,ids.department);
  await page.goto(base+'/?page=repairs');await page.locator('[data-open="repairModal"]').click();await choose(extraIds.secondDepartment);await form.locator('[name="itemCategory"]').selectOption(ids.category);await form.locator('[name="itemId"]').selectOption(ids.item);await form.locator('[name="issueDescription"]').fill('資訊室手動登錄維修');await submit();
  const repair=calls.at(-1).result;assert.equal(repair.department_id,extraIds.secondDepartment);await page.reload();await open('repairModal',repair.id);assert.equal(await form.locator('[name="departmentId"]').inputValue(),extraIds.secondDepartment);await form.locator('[name="departmentId"]').selectOption(ids.department);await submit();assert.equal(calls.at(-1).result.department_id,ids.department);
  await page.goto(base+'/?page=transactions');await page.locator('[data-tab="receipts"]').click();await page.locator('[data-open="receiptModal"]').click();await form.locator('#receiptCustomerCategory').selectOption('school');await form.locator('input[name="receiptCustomerId"][value="'+ids.customer+'"]').check();await form.locator('[data-receipt-department="'+ids.customer+'"]').selectOption(ids.department);await form.locator('[data-batch-category]').selectOption(ids.category);await form.locator('[data-batch-item]').selectOption(ids.item);await submit();
  const receiptId=calls.at(-1).result.ids[0];await page.reload();await open('receiptModal',receiptId);assert.equal(await form.locator('[data-receipt-department="'+ids.customer+'"]').inputValue(),ids.department);await form.locator('[data-receipt-department="'+ids.customer+'"]').selectOption(extraIds.secondDepartment);await submit();assert.equal((await db.query('select department_id from stock_receipt_customers where stock_receipt_id=$1',[receiptId])).rows[0].department_id,extraIds.secondDepartment);
  await page.goto(base+'/?page=worklogs');await page.locator('#worklogCustomerCategoryFilter').selectOption('school');await page.locator('#worklogCustomerFilter').selectOption(ids.customer);await page.locator('#worklogDepartmentFilter').selectOption(ids.department);assert.match(await page.locator('#worklogTable').innerText(),/高雄大學應數系查修/);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'department filters must not overflow viewport');
  await page.screenshot({path:fileURLToPath(new URL('worklog-saved-'+width+'.png',output)),fullPage:true});assert.deepEqual(errors,[]);
  console.log('PASS '+width+'px: real Gateway/RPC worklog, project, repair, receipt create/edit/reload; department layout and filters; zero page errors');
 }catch(error){await page.screenshot({path:fileURLToPath(new URL('failure-'+width+'.png',output)),fullPage:true});console.error('Last call:',calls.at(-1)?.name,'Toast:',await page.locator('#toast').innerText(),'Invalid:',await form.locator(':invalid').evaluateAll(rows=>rows.map(row=>({name:row.name,message:row.validationMessage}))));throw error;}
 finally{await context.close();await new Promise(resolve=>server.close(resolve));await db.close();}
}}finally{await browser.close();}
