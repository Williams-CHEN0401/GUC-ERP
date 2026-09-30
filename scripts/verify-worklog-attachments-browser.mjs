import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {worklogAttachmentsServer} from './worklog-attachments-fixture.mjs';
import {ids} from './worklog-save-fixture.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixture=await worklogAttachmentsServer(),{server,db,nas,failedNames,metadataFailures,modes,historical}=fixture;
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
const output=new URL('../tmp/worklog-attachments-browser/',import.meta.url);await mkdir(output,{recursive:true});let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],external=[];
 page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(external.push(route.request().url()),route.abort()));
 await page.goto(origin+'/?page=worklogs');await page.waitForFunction(()=>state.currentUser);if(await page.locator('#systemChooser').evaluate(e=>e.classList.contains('open')))await page.locator('[data-system-choice="erp"]').click();await page.waitForFunction(()=>scopeRequests.size===0);
 const form=page.locator('#modalForm'),host=page.locator('#attachmentUploadProgress');
 const open=async()=>{const button=page.locator(`[data-work-log-attachment="${historical.work_log.id}"]`);await button.locator('xpath=ancestor::details').locator('summary').click();await button.click();await form.locator('[name="contractServiceTypeId"]').selectOption(ids.service);};
 const files=Array.from({length:30},(_,i)=>({name:`photo-${i}.jpg`,mimeType:'image/jpeg',buffer:Buffer.alloc(512*1024,i+1)}));
 await open();await form.locator('[name="files"]').setInputFiles([...files,{...files[0],name:'over-limit.jpg'}]);const before=modes.length;await form.locator('button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('#toast p').textContent.includes('1～30'));assert.equal(modes.length,before,'31 rejected before upload');
 ['photo-4.jpg','photo-15.jpg','photo-26.jpg'].forEach(name=>failedNames.add(name));
 await form.locator('[name="files"]').setInputFiles(files);await form.locator('button[type="submit"]').click();
 await page.waitForFunction(()=>document.querySelector('#attachmentUploadProgress')?.dataset.stage==='error'&&!document.querySelector('#modalForm').classList.contains('busy'));
 assert.match(await host.innerText(),/成功 27／30/);assert.equal((await db.query('select count(*)::int n from site_assets where work_log_id=$1',[historical.work_log.id])).rows[0].n,27);
 await host.scrollIntoViewIfNeeded();await page.screenshot({path:fileURLToPath(new URL('27-success-3-failure.png',output))});
 const putsBefore=nas.calls.filter(c=>c.method==='PUT').length,modesBefore=modes.length;failedNames.clear();await form.locator('button[type="submit"]').click();await page.locator('#simpleModal.open').waitFor({state:'hidden'});
 assert.equal(nas.calls.filter(c=>c.method==='PUT').length-putsBefore,3);assert.equal(modes.slice(modesBefore).filter(m=>m.mode==='upload').length,3);
 const rows=(await db.query('select * from site_assets where work_log_id=$1',[historical.work_log.id])).rows;assert.equal(rows.length,30);
 const beforeInvalid=JSON.stringify(rows);await assert.rejects(db.query('select register_work_log_attachments_v1($1,$2,$3,$4,$5,$6)',[ids.customer,ids.service,historical.work_log.project_id,crypto.randomUUID(),JSON.stringify([rows[0]]),'fixture-admin']),/工作日誌與工作內容不相符/);assert.equal(JSON.stringify((await db.query('select * from site_assets where work_log_id=$1',[historical.work_log.id])).rows),beforeInvalid);
 for(const row of rows){const original=files.find(file=>file.name===row.original_name);assert.deepEqual(nas.files.get(row.nas_path),original.buffer);assert.equal(row.sha256,createHash('sha256').update(original.buffer).digest('hex'));}
 await page.reload();await page.waitForFunction(()=>state.siteData.assets.length===30);assert.equal(await page.evaluate(id=>state.siteData.assets.filter(a=>a.work_log_id===id).length,historical.work_log.id),30);
 await open();metadataFailures.add('index-retry.jpg');await form.locator('[name="files"]').setInputFiles([{name:'index-retry.jpg',mimeType:'image/jpeg',buffer:Buffer.alloc(256,4)}]);await form.locator('button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('#attachmentUploadProgress')?.dataset.stage==='error'&&!document.querySelector('#modalForm').classList.contains('busy'));
 assert.match(await host.innerText(),/索引保存失敗/);const beforeIndexRetry=nas.calls.filter(c=>c.method==='PUT').length;metadataFailures.clear();await form.locator('button[type="submit"]').click();await page.locator('#simpleModal.open').waitFor({state:'hidden'});assert.equal(nas.calls.filter(c=>c.method==='PUT').length,beforeIndexRetry);assert.equal((await db.query('select count(*)::int n from site_assets')).rows[0].n,31);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);const results=['31 檔案前端拒絕','30 張：27 成功、3 失敗','只重傳 3 張失敗照片','30 張原始 bytes、SHA256、SQL 日誌 relation 相符','索引失敗只重試 SQL，NAS PUT 不增加','重新載入保留附件'];await writeFile(new URL('results.json',output),JSON.stringify({results,errors,external},null,2));console.log('PASS',results);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));fixture.restore();await db.close();}
