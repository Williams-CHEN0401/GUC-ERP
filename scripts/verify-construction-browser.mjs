import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createPreviewServer} from './construction-preview-server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const server=createPreviewServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:'chrome',headless:true});
const output=new URL('../tmp/construction/',import.meta.url);await mkdir(output,{recursive:true});
try{
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:960}});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/?page=crm',{waitUntil:'networkidle'});
  await page.locator('[data-tab="projects"]').click();
  assert.equal(await page.locator('#projectTable tr').count(),4);
  await page.locator('#constructionTab').click();
  assert.equal(await page.locator('#constructionProjectTable tr').count(),3);
  await page.locator('#constructionCategoryFilter').selectOption('tender');
  assert.ok((await page.locator('#constructionProjectTable').innerText()).includes('無完成紀錄'));
  await page.locator('#constructionCategoryFilter').selectOption('');
  await page.locator('#constructionProjectTable tr').dblclick();
  await page.locator('[name="constructionCategory"]').selectOption('small_purchase');
  await page.locator('#modalForm button[type="submit"]').click();
  await page.waitForFunction(()=>!document.querySelector('#simpleModal').classList.contains('open'));
  await page.locator('#constructionCategoryFilter').selectOption('small_purchase');
  assert.equal(await page.locator('#constructionProjectTable tr').count(),2);
  await page.locator('#constructionSearch').fill('進行中');
  assert.equal(await page.locator('#constructionProjectTable tr').count(),1);
  await page.screenshot({path:fileURLToPath(new URL('classification-'+width+'.png',output)),fullPage:true});
  await page.locator('#projectListTab').click();
  assert.equal(await page.locator('#projectTable tr').count(),4);
  await page.evaluate(()=>openModal('workLogModal'));
  await page.locator('#modalForm [name="customerCategory"]').selectOption('school');
  await page.locator('#modalForm [name="customerId"]').selectOption('c1');
  const choices=await page.locator('#workLogProjectNames option').evaluateAll(nodes=>nodes.map(n=>n.value));
  assert.deepEqual(choices.sort(),['維修測試','進行中測試專案'].sort());
  await page.locator('#modalForm [name="projectName"]').fill('可以自由新增的新日誌');
  assert.equal(await page.locator('#modalForm [name="projectName"]').inputValue(),'可以自由新增的新日誌');
  assert.deepEqual(errors,[]);
  console.log('PASS '+width+'px: sub-tabs, categories, filter, edit/save, original list, active-only worklogs and free title.');
  await context.close();
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
