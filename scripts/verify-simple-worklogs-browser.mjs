import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {receiptDocumentServer} from './receipt-document-fixture.mjs';
import {ids} from './worklog-save-fixture.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright'),{db,server}=await receiptDocumentServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();if(url.pathname==='/api/nas')return route.fulfill({json:{available:false}});return route.continue();});
 await page.goto(origin+'/?page=worklogs');await page.waitForFunction(()=>state.currentUser);if(await page.locator('#systemChooser').evaluate(e=>e.classList.contains('open')))await page.locator('[data-system-choice="erp"]').click();await page.waitForFunction(()=>scopeRequests.size===0);
 const form=page.locator('#modalForm'),save=async()=>{assert.equal(await form.evaluate(e=>e.checkValidity()),true);const wait=page.waitForResponse(r=>r.url().endsWith('/api/inventory')&&r.request().method()==='POST');await form.locator('button[type="submit"]').click();const response=await wait;assert.equal(response.status(),201,await response.text());await page.locator('#simpleModal.open').waitFor({state:'hidden'});return(await response.json()).result;};
 for(const type of ['送貨','文書作業']){
   await page.locator('[data-open="workLogModal"]').click();await form.locator('[name="customerCategory"]').selectOption('school');await form.locator('[name="customerId"]').selectOption(ids.customer);await form.locator('[name="departmentId"]').selectOption(ids.department);
   await form.locator('[name="projectName"]').fill(type+'簡化測試');await form.locator('[name="workType"]').selectOption(type);await form.locator('[name="workerIds"]').first().check();
   for(const name of ['summary','completedContent','pendingContent']){assert.equal(await form.locator(`[name="${name}"]`).isVisible(),false);assert.equal(await form.locator(`[name="${name}"]`).isDisabled(),true);assert.equal(await form.locator(`[name="${name}"]`).evaluate(e=>e.required),false);}
   assert.equal(await form.locator('[name="status"]').isVisible(),true);
   const output=new URL('../tmp/simple-worklogs-browser/',import.meta.url);await mkdir(output,{recursive:true});await page.screenshot({path:fileURLToPath(new URL(type==='送貨'?'delivery.png':'clerical.png',output)),fullPage:true});
   const saved=await save(),id=saved.work_log.id;
   let row=(await db.query('select * from site_work_logs where id=$1',[id])).rows[0];assert.ok(!row.summary);assert.equal(row.completed_content,null);assert.equal(row.pending_content,null);assert.equal(row.status,'in_progress');
   await page.reload();await page.locator(`[data-work-log-row="${id}"]`).dblclick();assert.equal(await form.locator('[name="summary"]').isVisible(),false);await form.locator('[name="timePeriod"]').fill('上午');await save();
   row=(await db.query('select * from site_work_logs where id=$1',[id])).rows[0];assert.ok(!row.summary);assert.equal(row.time_period,'上午');assert.equal(row.status,'in_progress');
   // Seed historical free-text only in the isolated database, then edit via the actual form.
   await db.query('update site_work_logs set summary=$2 where id=$1',[id,type+'既有工作內容']);
   await page.reload();await page.locator(`[data-work-log-row="${id}"]`).dblclick();assert.equal(await form.locator('[name="summary"]').inputValue(),type+'既有工作內容');assert.equal(await form.locator('[name="summary"]').isVisible(),false);
   await form.locator('[name="timePeriod"]').fill('下午');await save();row=(await db.query('select * from site_work_logs where id=$1',[id])).rows[0];assert.equal(row.summary,type+'既有工作內容');assert.equal(row.time_period,'下午');
 }
 await page.locator('[data-open="workLogModal"]').click();assert.equal(await form.locator('[name="completedContent"]').isVisible(),true);await form.locator('[name="completedContent"]').fill('原已完成內容');await form.locator('[name="pendingContent"]').fill('原待辦內容');await form.locator('[name="workType"]').selectOption('送貨');assert.equal(await form.locator('[name="summary"]').inputValue(),'原已完成內容\n原待辦內容');assert.equal(await form.locator('[name="summary"]').isVisible(),false);
 await form.locator('[name="workType"]').selectOption('工程施工');assert.equal(await form.locator('[name="completedContent"]').isVisible(),true);assert.equal(await form.locator('[name="completedContent"]').inputValue(),'原已完成內容');assert.equal(await form.locator('[name="pendingContent"]').inputValue(),'原待辦內容');
 assert.deepEqual(errors,[]);console.log('PASS delivery/clerical: all content fields hidden/disabled/not required; blank new/edit/reload SQL; historical summary, status and construction draft preserved.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await db.close();}
