import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {ids} from './worklog-save-fixture.mjs';
import {extraIds} from './department-cross-system-fixture.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright'),origin=process.env.TEST_ORIGIN||'http://127.0.0.1:4234';
const browser=await chromium.launch({channel:'chrome',headless:true}),errors=[],external=[];
const output=new URL('../tmp/receipt-documents-browser/',import.meta.url);await mkdir(output,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.origin);return route.abort();}if(url.pathname==='/api/nas')return route.fulfill({json:{available:false}});return route.continue();});
 await page.goto(origin+'/?page=transactions');await page.waitForFunction(()=>state.currentUser);if(await page.locator('#systemChooser').evaluate(e=>e.classList.contains('open')))await page.locator('[data-system-choice="erp"]').click();await page.waitForFunction(()=>scopeRequests.size===0);
 await page.locator('#transactions [data-tab="receipts"]').click();await page.locator('[data-open="receiptModal"]').click();const form=page.locator('#modalForm');
 await form.locator('[name="supplierId"]').selectOption(extraIds.supplier);await form.locator('[name="date"]').fill('2026-09-30');
 const stockBefore=await page.evaluate(id=>byId(state.inventory,id).quantity,ids.item);const runTag=String(Date.now());const fill=async(index,qty,note)=>{const row=form.locator('[data-batch-row]').nth(index);await row.locator('[data-batch-category]').selectOption(ids.category);await row.locator('[data-batch-item]').selectOption(ids.item);await row.locator('[name="batchQuantity"]').fill(String(qty));await row.locator('[name="batchNote"]').fill(note+' '+runTag);};
 await fill(0,3,'整單第一項');await form.locator('[data-add-transaction-row]').click();await fill(1,4,'整單第二項');
 await form.locator('#receiptCustomerCategory').selectOption('school');await form.locator(`[name="receiptCustomerId"][value="${ids.customer}"]`).check();await form.locator(`[data-receipt-department="${ids.customer}"]`).selectOption(ids.department);
 const save=async()=>{assert.equal(await form.evaluate(e=>e.checkValidity()),true);const pending=page.waitForResponse(r=>r.url().endsWith('/api/inventory')&&r.request().method()==='POST');await form.locator('button[type="submit"]').click();const response=await pending;assert.equal(response.status(),201,await response.text());await page.locator('#simpleModal.open').waitFor({state:'hidden'});};
 const docId=await form.evaluate(f=>f._receiptDocument.id);await save();let rows=await page.evaluate(id=>state.receipts.filter(r=>r.documentId===id),docId);assert.equal(rows.length,2);assert.ok(rows[0].documentId);assert.equal(rows[0].documentId,rows[1].documentId);assert.equal(await page.evaluate(id=>byId(state.inventory,id).quantity,ids.item),stockBefore+7);
 await page.reload();await page.waitForFunction(()=>scopeRequests.size===0&&state.receipts.length>0);await page.locator('#transactions [data-tab="receipts"]').click();
 assert.equal(await page.locator(`#receiptTable tr[data-row-id="${docId}"]`).count(),1);
 await page.locator(`#receiptTable tr[data-row-id="${docId}"]`).dblclick();assert.equal(await form.locator('[data-batch-row]').count(),2);
 await form.locator('[name="date"]').fill('2026-10-01');await fill(0,5,'整單第一項已改');await fill(1,6,'整單第二項已改');
 await form.locator('[data-add-transaction-row]').click();await fill(2,2,'整單第三項');await save();
 rows=await page.evaluate(id=>state.receipts.filter(r=>r.documentId===id),docId);assert.equal(rows.length,3);assert.ok(rows.every(r=>r.date==='2026-10-01'&&r.customerIds.includes('30000000-0000-4000-8000-000000000001')));assert.deepEqual(rows.map(r=>r.quantity).sort((a,b)=>a-b),[2,5,6]);assert.equal(await page.evaluate(id=>byId(state.inventory,id).quantity,ids.item),stockBefore+13);
 await page.locator('#transactions [data-pane="receipts"] .search-panel-trigger').click();await page.locator('#receiptSearch').fill('整單第三項 '+runTag);assert.equal(await page.locator('#receiptTable tr[data-row-id]').count(),1);await page.keyboard.press('Escape');
 await page.screenshot({path:fileURLToPath(new URL('desktop.png',output))});await page.setViewportSize({width:390,height:844});await page.reload();await page.waitForFunction(()=>scopeRequests.size===0&&state.receipts.length>0);await page.locator('#transactions [data-tab="receipts"]').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 await page.locator(`#receiptTable tr[data-row-id="${docId}"]`).focus();await page.keyboard.press('Enter');await page.locator('#simpleModal.open').waitFor();await page.screenshot({path:fileURLToPath(new URL('mobile.png',output))});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 if(process.env.TEST_RECEIPT_DELETE==='1'){
   await page.locator('#simpleModal button[data-close]').click();await page.locator('#simpleModal.open').waitFor({state:'hidden'});await page.setViewportSize({width:1440,height:1000});
   page.once('dialog',dialog=>{assert.match(dialog.message(),/整張進貨單.*3/);return dialog.accept();});
   const response=page.waitForResponse(r=>r.url().endsWith('/api/inventory')&&r.request().method()==='POST');await page.locator(`#receiptTable tr[data-row-id="${docId}"] [data-delete-receipt]`).click();const removed=await response;assert.equal(removed.status(),201,await removed.text());
   await page.waitForFunction(id=>!state.receipts.some(r=>r.documentId===id),docId);await page.reload();await page.waitForFunction(()=>scopeRequests.size===0&&state.currentUser);assert.equal(await page.evaluate(id=>state.receipts.filter(r=>r.documentId===id).length,docId),0);assert.equal(await page.evaluate(id=>byId(state.inventory,id).quantity,ids.item),stockBefore);
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);const results=['新增兩列只顯示一張單','重新載入仍保持整單','一次修改全部明細與日期','同單新增第三列','訂貨客戶科室保存','明細備註搜尋整張单','390px 不水平溢出',...(process.env.TEST_RECEIPT_DELETE==='1'?['整單刪除：三列全刪、重讀消失、庫存恢復']:[])];await writeFile(new URL('results.json',output),JSON.stringify({results,errors,external},null,2));console.log('PASS',results);
}finally{await browser.close();}
