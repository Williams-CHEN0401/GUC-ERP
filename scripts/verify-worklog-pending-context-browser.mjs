import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pendingContextServer,ids,extraIds} from './worklog-pending-context-fixture.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const f=await pendingContextServer(),{db,server}=f,checks=[],errors=[],external=new Set();
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`,output=new URL('../tmp/pending-context/',import.meta.url);
await mkdir(output,{recursive:true});let browser,page;
const row=async id=>(await db.query('select * from site_work_logs where id=$1',[id])).rows[0];
try{
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1080}});page=await context.newPage();
 page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());if(url.origin!==origin){external.add(url.origin);return route.abort();}
  if(url.pathname==='/api/nas')return route.fulfill({json:{available:false}});return route.continue();
 });
 const ready=async()=>{
  await page.waitForFunction(()=>state.currentUser);
  if(await page.locator('#systemChooser').evaluate(el=>el.classList.contains('open')))await page.locator('[data-system-choice="erp"]').click();
  await page.waitForFunction(()=>scopeRequests.size===0);
  assert.equal(await page.evaluate(()=>PREVIEW_MODE),false,'real Gateway, no browser mutation simulation');
 };
 const form=page.locator('#modalForm');
 const openLog=async id=>{
  // Use the actual row + existing delegated double-click handler. The fixture
  // records are deterministic, while paginated filtering is only UI navigation.
  await page.evaluate(logId=>{const log=state.siteData.logs.find(r=>r.id===logId);document.querySelector('#worklogProjectFilter').value=log.projectId;renderSiteModules();},id);
  await page.locator(`[data-work-log-row="${id}"]`).dblclick();
  await page.waitForFunction(expected=>document.querySelector('#simpleModal')?.dataset.id===expected&&document.querySelector('#simpleModal').classList.contains('open')&&scopeRequests.size===0,id);
 };
 const close=()=>page.locator('#simpleModal button[data-close]').first().click();
 const save=async operation=>{
  assert.equal(await form.evaluate(el=>el.reportValidity()),true,'form validity');
  const responsePromise=page.waitForResponse(res=>res.url().startsWith(origin+'/api/inventory')&&res.request().method()==='POST'&&res.request().postDataJSON()?.operation===operation);
  await form.locator('button[type="submit"]').click();const response=await responsePromise,body=await response.json();
  assert.equal(response.status(),201,`HTTP ${response.status()}: ${body.error||''}`);assert.equal(body.audit_warning,undefined);
  await page.locator('#simpleModal.open').waitFor({state:'hidden'});return body.result;
 };
 await page.goto(origin+'/?page=worklogs');await ready();
 const id=f.contextCases.repairSourceId,sourceBefore=await row(id),siblingBefore=await row(f.contextCases.siblingId),destination=f.contextCases.destination;
 await openLog(id);
 const pendingBefore=await form.locator('[name="eventPendingContent"]').first().inputValue();
 await form.locator('[name="departmentId"]').selectOption(extraIds.secondDepartment);
 await form.locator('#workLogProjectChoice').selectOption(destination.id);
 assert.equal(await form.locator('[name="eventPendingContent"]').first().inputValue(),pendingBefore,'scope edit must not clear current pending content');
 await page.screenshot({path:new URL('repair-context-before-save.png',output).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
 const moved=await save('upsert_customer_project_work_log');assert.equal(moved.work_log.id,id);assert.equal((await row(id)).project_id,destination.id);
 assert.deepEqual(await row(f.contextCases.siblingId),siblingBefore);assert.equal((await row(id)).log_date.toString(),sourceBefore.log_date.toString());
 checks.push('actual repair modal department+work move saves; current pending text/date/ID and sibling unchanged');
 await page.reload();await ready();await openLog(id);
 assert.equal(await form.locator('[name="departmentId"]').inputValue(),extraIds.secondDepartment);
 assert.equal(await form.locator('[name="projectName"]').inputValue(),destination.name);
 assert.equal(await form.locator('[name="eventPendingContent"]').first().inputValue(),pendingBefore);
 await form.locator('[name="projectName"]').fill('改名後的未完成事項工作（合成）');await save('upsert_customer_project_work_log');
 await page.reload();await ready();await openLog(id);assert.equal(await form.locator('[name="projectName"]').inputValue(),'改名後的未完成事項工作（合成）');await close();
 checks.push('reload preserves scope and pending text; manual title rename saves and rereads');
 await page.locator('[data-open="workLogModal"]').click();
 await form.locator('[name="customerCategory"]').selectOption('cleaning_team');
 await form.locator('[name="customerId"]').selectOption(ids.customer);await form.locator('[name="departmentId"]').selectOption(extraIds.secondDepartment);
 await form.locator('#workLogProjectChoice').selectOption(destination.id);await form.locator('[name="workType"]').selectOption('維修紀錄');await form.locator('[name="logDate"]').fill('2026-11-03');
 await page.waitForFunction(()=>document.querySelector('#modalForm [data-maintenance-pending-items] legend'));
 const offered=await form.locator('[data-maintenance-pending-items]').textContent();assert.ok(offered.includes(pendingBefore.split('\n')[0]));assert.ok(offered.includes('改名後的未完成事項工作（合成）'));
 await close();checks.push('new visit in corrected department/work offers the same existing unfinished items with updated title');

 await page.goto(origin+'/?page=projects');await ready();await page.locator('[data-open="projectModal"]:visible').click();
 await form.locator('[name="customerCategory"]').selectOption('cleaning_team');await form.locator('[name="customerId"]').selectOption(ids.customer);
 assert.ok((await form.locator('[name="departmentId"] option').count())>1,'customer actually has departments');
 assert.equal(await form.locator('[name="departmentId"]').evaluate(el=>el.required),false);
 await form.locator('[name="name"]').fill('瀏覽器未選科室新增工作（合成）');await form.locator('[name="projectDate"]').fill('2026-11-03');
 await form.locator('[name="type"]').selectOption('repair');await form.locator('[name="projectWorkerIds"]').first().check();
 assert.equal(await form.locator('[name="departmentId"]').inputValue(),'');
 const created=await save('create_erp_project');assert.equal(created.project.department_id,null);
 await page.reload();await ready();await page.locator(`[data-row-editor="projectModal"][data-row-id="${created.project.id}"]:visible`).dblclick();
 assert.equal(await form.locator('[name="departmentId"]').inputValue(),'');assert.equal(await form.locator('[name="departmentId"]').evaluate(el=>el.required),false);
 await form.locator('[name="name"]').fill('瀏覽器未選科室修改工作（合成）');await save('update_erp_project');
 checks.push('work-content modal accepts no department for customer with departments; create, reload and edit all persist null');
 await page.setViewportSize({width:390,height:844});await page.locator('[data-open="projectModal"]:visible').click();
 await form.locator('[name="customerCategory"]').selectOption('cleaning_team');await form.locator('[name="customerId"]').selectOption(ids.customer);
 assert.equal(await form.locator('[name="departmentId"]').evaluate(el=>el.required),false);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
 await page.screenshot({path:new URL('optional-department-mobile.png',output).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
 checks.push('390px mobile modal keeps optional department and has no page horizontal overflow');
 assert.deepEqual(errors,[]);assert.deepEqual([...external],[]);
 await writeFile(new URL('browser-verification.json',output),JSON.stringify({passed:true,checks,errors,blockedExternalOrigins:[...external],productionWrites:false},null,2));
 console.log(JSON.stringify({passed:true,checks:checks.length,errors}));
}catch(error){if(page){await page.screenshot({path:new URL('failure.png',output).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true}).catch(()=>{});await writeFile(new URL('failure.json',output),JSON.stringify({message:error.message,checks,errors,failures:f.failures.slice(-4),calls:f.calls.slice(-3)},null,2));}throw error;}
finally{await browser?.close();server.close();await db.close();}
