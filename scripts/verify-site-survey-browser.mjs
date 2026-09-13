// Actual ERP forms with synthetic data. All persistence is local Preview state.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createPreviewServer} from './report-dates-preview-server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const server=createPreviewServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:'chrome',headless:true});
const output=new URL('../tmp/site-survey/',import.meta.url);await mkdir(output,{recursive:true});
try{
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:960}}),errors=[];
  let writes=0;
  await context.route('**/*',route=>{
    if(route.request().method()!=='GET'){writes++;return route.abort();}
    return new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort();
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/?page=crm',{waitUntil:'networkidle'});
  await page.locator('[data-tab="projects"]').click();
  await page.evaluate(()=>openModal('projectModal','p1'));
  const form=page.locator('#modalForm');
  await form.locator('[name="type"]').selectOption('site_survey');
  assert.equal(await form.locator('[name="type"] option:checked').innerText(),'場勘');
  assert.equal(await page.locator('#constructionCategoryField').isVisible(),false);
  await form.locator('[name="status"]').selectOption('in_progress');
  await page.screenshot({path:fileURLToPath(new URL('survey-form-'+width+'.png',output)),fullPage:true});
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(()=>!document.querySelector('#simpleModal').classList.contains('open'));
  assert.match(await page.locator('#projectTable').innerText(),/場勘/);
  await page.evaluate(()=>openModal('projectModal','p1'));
  assert.equal(await form.locator('[name="type"]').inputValue(),'site_survey');
  await page.evaluate(()=>closeModal());
  await page.goto(base+'/?page=worklogs',{waitUntil:'networkidle'});
  // A navigation reload restores the read-only fixture. Change through its form again.
  await page.evaluate(()=>openModal('projectModal','p1'));
  await form.locator('[name="type"]').selectOption('site_survey');
  await form.locator('[name="status"]').selectOption('in_progress');
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(()=>!document.querySelector('#simpleModal').classList.contains('open'));
  await page.locator('#worklogTypeFilter').selectOption('場勘');
  assert.equal(await page.locator('#worklogTable [data-work-log-row]').count(),3);
  await page.evaluate(()=>openModal('workLogModal','l1'));
  assert.equal(await form.locator('[name="workType"]').inputValue(),'場勘');
  await form.locator('[name="summary"]').fill('場勘確認線路及設備配置');
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(()=>!document.querySelector('#simpleModal').classList.contains('open'));
  await page.evaluate(()=>openModal('workLogModal','l1'));
  assert.equal(await form.locator('[name="workType"]').inputValue(),'場勘');
  assert.equal(await form.locator('[name="summary"]').inputValue(),'場勘確認線路及設備配置');
  await page.evaluate(()=>closeModal());
  await page.evaluate(()=>openModal('workLogModal'));
  await form.locator('[name="customerCategory"]').selectOption('school');
  await form.locator('[name="customerId"]').selectOption('c1');
  await form.locator('[name="projectName"]').fill('已完成測試專案');
  await form.locator('[name="projectName"]').dispatchEvent('change');
  assert.equal(await form.locator('[name="workType"]').inputValue(),'場勘');
  assert.deepEqual(errors,[]);assert.equal(writes,0);
  console.log(`PASS ${width}px: 場勘 selection, save/reopen, work-log synchronization, filter, edit/save and new-log defaults; no external writes`);
  await context.close();
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
