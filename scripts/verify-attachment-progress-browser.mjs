import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {ids} from './worklog-save-fixture.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base='http://127.0.0.1:4214',out=new URL('../tmp/attachment-progress/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const context=await browser.newContext({viewport:{width:1280,height:950}}),page=await context.newPage(),errors=[];
 await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.type()==='prompt'?dialog.accept('2'):dialog.dismiss());page.setDefaultTimeout(25000);
 const initial=(await(await context.request.get(base+'/__attachment_test')).json()).indexed.length;
 await page.goto(base+'/?page=worklogs');
 const form=page.locator('#modalForm'),host=page.locator('#attachmentUploadProgress');
 const open=async()=>{const attachment=page.locator('[data-work-log-attachment]').first();await attachment.locator('xpath=ancestor::details').locator('summary').click();await attachment.click();await form.locator('[name="contractServiceTypeId"]').selectOption(ids.service);};
 const submit=async()=>{await form.locator('button[type="submit"]').click();await host.waitFor({state:'visible'});};
 await open();await form.locator('[name="files"]').setInputFiles([{name:'手機原始照片.heic',mimeType:'image/heic',buffer:Buffer.alloc(6*1024*1024,21)},{name:'工作文件.pdf',mimeType:'application/pdf',buffer:Buffer.alloc(1024*1024,33)}]);
 const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:20,downloadThroughput:10000000,uploadThroughput:700000});
 await submit();
 await page.waitForFunction(()=>{const h=document.querySelector('#attachmentUploadProgress');return h?._uploadSnapshot?.percent>0&&h._uploadSnapshot.percent<100;});
 await form.evaluate(el=>el.scrollTop=el.scrollHeight);await page.screenshot({path:fileURLToPath(new URL('upload-desktop.png',out)),fullPage:true});
 assert.equal(await form.locator('[name="files"]').evaluate(el=>el.inert),true);assert.equal(await host.evaluate(el=>getComputedStyle(el.closest('form')).opacity),'1');
 // Closing/duplicating the submission cannot lose the in-flight status or upload twice.
 await page.evaluate(()=>{closeModal();document.querySelector('#modalForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 assert.equal(await page.locator('#simpleModal').evaluate(el=>el.classList.contains('open')),true);
 await page.waitForFunction(()=>document.querySelector('#attachmentUploadProgress')?._uploadSnapshot?.files.some(f=>f.state==='registering'));
 assert.notEqual(await host.getAttribute('data-stage'),'complete');
 await page.locator('#simpleModal').waitFor({state:'hidden'});
 const result=await(await context.request.get(base+'/__attachment_test')).json();assert.equal(result.indexed.length-initial,2);
 // A second batch shows partial success and a persistent index error on mobile.
 await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 await page.setViewportSize({width:390,height:844});await open();
 await form.locator('[name="files"]').setInputFiles([{name:'成功照片.jpg',mimeType:'image/jpeg',buffer:Buffer.alloc(1024*50,1)},{name:'失敗文件.pdf',mimeType:'application/pdf',buffer:Buffer.alloc(1024*50,2)}]);await submit();
 await page.waitForFunction(()=>document.querySelector('#attachmentUploadProgress')?.dataset.stage==='error'&&!document.querySelector('#modalForm').classList.contains('busy'));
 const final=await host.innerText();assert.match(final,/成功 1／2/);assert.match(final,/失敗 1/);assert.match(final,/索引保存失敗/);assert.equal(await form.evaluate(el=>el.classList.contains('busy')),false);
 assert.equal(await form.locator('[name="files"]').evaluate(el=>el.inert),false);
 await host.scrollIntoViewIfNeeded();await page.screenshot({path:fileURLToPath(new URL('upload-mobile-error.png',out)),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(errors,[]);
 console.log('PASS real browser XHR: HEIC chunk + PDF parallel progress -> NAS memory validation -> index completion; duplicate/close guard; partial index failure retained on 390px mobile. No production writes.');
 await context.close();
}finally{await browser.close();}
