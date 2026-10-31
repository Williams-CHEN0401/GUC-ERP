import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {workflowIdentityServer} from './workflow-identity-fixture.mjs';
import {ids} from './worklog-save-fixture.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const f=await workflowIdentityServer(),{server,db}=f;
await db.query(`insert into projects(id,name,project_code,customer_id,department_id,project_type,status,construction_category)
 values('50000000-0000-4000-8000-000000000001','施工規劃位置測試','TEST-PLAN',$1,$2,'construction','in_progress','tender')`,[ids.customer,ids.department]);
await db.query(`insert into construction_plans(id,project_id,construction_date,content,created_by_user_id) values
 ('50000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','2026-10-15','後期設備安裝',$1),
 ('50000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000001','2026-10-01','前期配線',$1)`,[ids.actor]);
await db.query('insert into construction_plan_assignees select id,$1 from construction_plans',[ids.actor]);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
const out=new URL('../tmp/workflow-layout/',import.meta.url);await mkdir(out,{recursive:true});
let browser;const errors=[];
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
 await page.route('**/*',route=>{const u=new URL(route.request().url());return u.origin!==origin?route.abort():u.pathname==='/api/nas'?route.fulfill({json:{available:false}}):route.continue();});
 await page.goto(origin+'/?page=projects');await page.waitForFunction(()=>state.currentUser&&scopeRequests.size===0);
 if(await page.locator('#systemChooser').evaluate(e=>e.classList.contains('open')))await page.locator('[data-system-choice="erp"]').click();
 await page.locator('#constructionPlanningTab').click();await page.locator('[data-planning-plan]').first().waitFor();
 assert.deepEqual(await page.locator('#planningFilterType option').evaluateAll(es=>es.map(e=>e.value)),['','construction','repair']);
 const titles=()=>page.locator('[data-planning-plan]>summary>span').allTextContents();
 assert.match((await titles())[0],/前期配線/);await page.locator('#planningDateOrder').selectOption('desc');assert.match((await titles())[0],/後期設備安裝/);
 assert.equal(await page.locator('[data-planning-plan][open]').count(),0);await page.locator('[data-planning-plan]>summary').first().click();assert.equal(await page.locator('[data-planning-plan][open]').count(),1);
 await page.locator('#planningFilterType').selectOption('repair');assert.equal(await page.locator('[data-planning-plan]').count(),0);assert.match(await page.locator('#constructionPlanningList').innerText(),/攝影機、電話查修/);
 await page.locator('#planningFilterType').selectOption('construction');await page.screenshot({path:fileURLToPath(new URL('planning.png',out)),fullPage:true});
 await page.goto(origin+'/?page=worklogs');await page.waitForFunction(()=>state.currentUser&&scopeRequests.size===0);
 const form=page.locator('#modalForm');await page.locator('[data-open="workLogModal"]').click();
 await form.locator('[name="customerCategory"]').selectOption('cleaning_team');await form.locator('[name="customerId"]').selectOption(ids.customer);await form.locator('[name="departmentId"]').selectOption(ids.department);
 await form.locator('#workLogProjectChoice').selectOption('50000000-0000-4000-8000-000000000001');
 await form.locator('[data-construction-selectors]').waitFor({state:'visible'});
 assert.equal(await form.evaluate(el=>el.querySelector('.work-log-title-picker').nextElementSibling.matches('[data-construction-selectors]')),true);
 await page.screenshot({path:fileURLToPath(new URL('worklog-plan-position.png',out)),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await form.evaluate(el=>el.scrollWidth>el.clientWidth+2),false);
 await page.screenshot({path:fileURLToPath(new URL('worklog-mobile.png',out)),fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 await form.locator('#workLogProjectChoice').selectOption(f.first.project.id);await form.locator('[name="logDate"]').fill('2026-12-06');
 await form.locator('[data-maintenance-pending-index]').first().waitFor();
 await form.locator('[name="projectName"]').fill(f.first.project.name);
 await page.waitForFunction(()=>!document.querySelector('[data-maintenance-pending-index]'));
 assert.equal(await form.locator('#workLogProjectChoice').inputValue(),'');
 await form.locator('[name="workType"]').selectOption('送貨');await form.locator('[name="workerIds"]').first().check();
 const responsePromise=page.waitForResponse(r=>r.url().includes('/api/inventory')&&r.request().method()==='POST'&&r.request().postDataJSON()?.operation==='upsert_customer_project_work_log');
 await form.locator('button[type="submit"]').click();const response=await responsePromise,body=await response.json();assert.equal(response.status(),201,JSON.stringify(body));
 assert.equal(body.result.project.name,f.first.project.name+'261206');assert.notEqual(body.result.project.id,f.first.project.id);
 await page.locator('#simpleModal.open').waitFor({state:'hidden'});
 await page.goto(origin+'/?page=transactions&tab=returns');await page.waitForFunction(()=>state.currentUser&&scopeRequests.size===0);
 assert.equal(await page.locator('[data-return-clear],[data-return-refresh]').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS: construction enums/date sorting/collapse, selector below title desktop/mobile, manual same-name UI→Gateway→SQL, pending context cleared, return buttons removed');
}catch(e){console.error(e.stack);process.exitCode=1;}finally{await browser?.close();await new Promise(r=>server.close(r));await db.close();}
