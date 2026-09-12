import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createPreviewServer} from './report-dates-preview-server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const server=createPreviewServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
const output=new URL('../tmp/report-dates/',import.meta.url);await mkdir(output,{recursive:true});
try{
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:960},timezoneId:'America/Los_Angeles'});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/?page=materials&work_content_id=p1',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.querySelector('#materialDateFrom').value==='2026-09-02');
  assert.equal(await page.locator('#materialDateTo').inputValue(),'2026-09-10');
  await page.locator('[data-report-tab="workers"]').click();
  assert.equal(await page.locator('.report-daily-table tbody tr').count(),2);
  await page.locator('#materialDateFrom').fill('2026-09-03');await page.locator('#materialDateFrom').dispatchEvent('change');
  await page.locator('[data-report-tab="overview"]').click();
  assert.equal(await page.locator('#materialDateFrom').inputValue(),'2026-09-03');
  await page.locator('#materialProject').selectOption('p2');
  assert.equal(await page.locator('#materialDateFrom').inputValue(),'2026-09-04');assert.equal(await page.locator('#materialDateTo').inputValue(),'');
  await page.evaluate(()=>openModal('projectModal','p2'));
  await page.locator('#modalForm [name="status"]').selectOption('completed');
  await page.locator('#modalForm [name="projectDate"]').fill('2026-09-01');
  await page.locator('#modalForm button[type="submit"]').click();
  const today=await page.evaluate(()=>GUCProjectReport.taipeiDate(new Date().toISOString()));
  await page.waitForFunction(day=>document.querySelector('#materialDateTo').value===day,today);
  assert.equal(await page.locator('#materialDateFrom').inputValue(),'2026-09-04','editing the form project date must not change actual creation date');
  await page.evaluate(()=>openModal('projectModal','p2'));
  await page.locator('#modalForm [name="status"]').selectOption('in_progress');
  await page.locator('#modalForm button[type="submit"]').click();
  await page.waitForFunction(()=>document.querySelector('#materialDateTo').value==='');
  await page.locator('#materialProject').selectOption('p3');assert.equal(await page.locator('#materialDateTo').inputValue(),'');
  await page.locator('#materialProject').selectOption('p1');
  // Same renderer after an incoming snapshot/status refresh; no real mutations.
  await page.evaluate(()=>{state.projects.find(p=>p.id==='p1').status='in_progress';renderProjectReport();});
  assert.equal(await page.locator('#materialDateTo').inputValue(),'');
  await page.evaluate(()=>{Object.assign(state.projects.find(p=>p.id==='p1'),{status:'completed',completedOn:'2026-09-12'});renderProjectReport();});
  assert.equal(await page.locator('#materialDateTo').inputValue(),'2026-09-12');
  await page.screenshot({path:fileURLToPath(new URL(`report-${width}.png`,output)),fullPage:true});
  assert.deepEqual(errors,[]);console.log(`PASS ${width}px: deep link, Taiwan date in foreign timezone, inclusive range, manual filter, tabs, project switch, form completion/reopening and refreshed completion.`);
  await context.close();
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
