import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||pathToFileURL('C:/Users/Williams/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const out=path.resolve(import.meta.dirname,'../tmp/performance'),f=JSON.parse(await readFile(path.join(out,'runtime.json'),'utf8'));
const browser=await chromium.launch({headless:true,channel:'msedge'}),page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://localhost:4268/?page=performance');await page.locator('#loginForm [name=username]').fill(f.users.admin.username);await page.locator('#loginForm [name=password]').fill(f.users.admin.password);
 const loaded=page.waitForResponse(r=>r.url().includes('scope=performance'));await page.locator('#loginForm button').click();await(await loaded).finished();
 await page.locator('[data-performance-tab=approval]').click();await page.locator(`[data-performance-action=detail][data-id="${f.reviews.employee}"]`).click();await page.locator('[data-performance-action=source]').first().click();
 const dialog=page.locator('.perf-source-dialog');await dialog.waitFor({state:'visible'});assert.ok((await dialog.innerText()).includes('後來更新的施工文字'));assert.ok((await page.locator('.perf-evidence').first().innerText()).includes('已完成監控測試並交接'));
 await page.locator('[data-performance-source-close]').click();await dialog.waitFor({state:'detached'});
 await page.locator('[data-performance-tab=settings]').click();await page.locator('[data-performance-action=template-new]').click();
 const form=page.locator('[data-performance-form=template_create]');await form.waitFor();assert.equal(await form.locator('input[type=number]').count(),28);
 await form.locator('[name=construction_QUALITY]').fill('26');let response=page.waitForResponse(r=>r.request().method()==='POST'&&r.request().postDataJSON()?.operation==='performance.template_create');await form.locator('button').click();assert.equal((await response).status(),400);
 await page.locator('#performanceMessage').getByText(/權重合計/).waitFor();assert.equal(await form.locator('[name=construction_QUALITY]').inputValue(),'26');
 await form.locator('[name=construction_QUALITY]').fill('25');await form.locator('[name=name]').fill('手機權重設定驗收');response=page.waitForResponse(r=>r.request().method()==='POST'&&r.request().postDataJSON()?.operation==='performance.template_create');await form.locator('button').click();assert.equal((await response).status(),201);
 await page.locator('summary').filter({hasText:'手機權重設定驗收'}).waitFor();assert.deepEqual(errors,[]);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.screenshot({path:path.join(out,'screenshots/edge-settings-390.png'),fullPage:true});
 await writeFile(path.join(out,'ui-boundary-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),status:'PASS',checks:['Current-source dialog reauthorizes and preserves frozen snapshot','28 weight inputs, invalid sum rejected without losing edits','Valid template persisted and reread','390px settings no overflow'],errors},null,2));
 console.log('PASS source drilldown and mobile template editing, rejection recovery and saved reread.');
}finally{await browser.close();}
