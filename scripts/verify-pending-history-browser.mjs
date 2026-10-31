import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {pendingHistoryServer,historyText,otherPendingText,historyDisplay,ids} from './pending-history-fixture.mjs';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const f=await pendingHistoryServer(),{db,server,cases}=f;
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;
const output=new URL('../tmp/pending-history/',import.meta.url);await mkdir(output,{recursive:true});
const checks=[],errors=[],apiFailures=[],blockedOrigins=new Set(),display=historyDisplay(),targetOther='10/28新增待辦（合成）';
let browser,page,targetId;
const row=async id=>(await db.query('select * from site_work_logs where id=$1',[id])).rows[0];
const occurrences=(text,part)=>String(text||'').split(part).length-1;
try{
 const construction=await f.gatewayHandler(new Request(`http://127.0.0.1/inventory-gateway?scope=construction_plans&project_id=${cases.fresh.projectId}`,{headers:{authorization:'Bearer isolated-fixture-only'}}));
 assert.equal(construction.status,200,'actual authorized construction RPC accepts the synthetic classified project');
 assert.deepEqual((await construction.json()).construction_plans,[],'no construction plans exist in this synthetic project');
 browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.dismiss());
 page.on('response',response=>{if(response.url().startsWith(origin+'/api/')&&response.status()>=400)apiFailures.push({path:new URL(response.url()).pathname,status:response.status()});});
 await page.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin){blockedOrigins.add(url.origin);return route.abort();}
  if(url.pathname==='/api/nas')return route.fulfill({json:{available:false}});
  return route.continue();
 });
 const ready=async()=>{
  await page.waitForFunction(()=>state.currentUser);
  if(await page.locator('#systemChooser').evaluate(el=>el.classList.contains('open')))await page.locator('[data-system-choice="erp"]').click();
  await page.waitForFunction(()=>scopeRequests.size===0);
  assert.equal(await page.evaluate(()=>PREVIEW_MODE),false,'uses actual Gateway rather than browser mutation simulation');
 };
 await page.goto(origin+'/?page=worklogs');await ready();
 const form=page.locator('#modalForm');
 const close=()=>page.locator('#simpleModal button[data-close]').first().click();
 const edit=async(id,projectId)=>{
  if(!await page.locator('#worklogProjectFilter').isVisible())await page.locator('#worklogs .search-panel-trigger').click();
  await page.locator('#worklogProjectFilter').selectOption(projectId);
  await page.locator('#worklogs .search-panel-dismiss').click();
  await page.locator(`[data-work-log-row="${id}"]`).dblclick();
  await page.waitForFunction(expected=>{const modal=document.querySelector('#simpleModal');return modal?.classList.contains('open')&&modal.dataset.id===expected&&scopeRequests.size===0;},id);
  await page.waitForFunction(()=>document.querySelector('#modalForm [data-work-log-construction-reminder]')?.hidden===true);
 };
 const waitPending=()=>page.waitForFunction(()=>{
  const host=document.querySelector('#modalForm [data-pending-work-log-items]');
  return !!host?.querySelector('legend')&&document.querySelector('#modalForm [data-work-log-construction-reminder]')?.hidden===true;
 });
 const start=async({projectId=cases.fresh.projectId,customerId=ids.customer,departmentId=ids.department,date='2026-10-28'}={})=>{
  await page.locator('[data-open="workLogModal"]').click();
  await form.locator('[name="customerCategory"]').selectOption('cleaning_team');
  await form.locator('[name="customerId"]').selectOption(customerId);
  await form.locator('[name="departmentId"]').selectOption(departmentId);
  await form.locator('#workLogProjectChoice').selectOption(projectId);
  await form.locator('[name="workType"]').selectOption('工程施工');
  await form.locator('[name="logDate"]').fill(date);await form.locator('[name="timePeriod"]').fill('上午');
  await form.locator('[name="workerIds"]').first().check();await waitPending();
 };
 const pendingTexts=()=>form.locator('[data-pending-work-log-items] label').allTextContents();
 const save=async()=>{
  assert.equal(await form.evaluate(el=>el.checkValidity()),true,'browser validity');
  const wait=page.waitForResponse(response=>response.url().startsWith(origin+'/api/inventory')&&response.request().method()==='POST'&&response.request().postDataJSON()?.operation==='upsert_customer_project_work_log');
  await form.locator('button[type="submit"]').click();const response=await wait,body=await response.json();
  assert.equal(response.status(),201,`save HTTP ${response.status()}: ${String(body.error||'').slice(0,300)}`);
  assert.equal(body.audit_warning,undefined,'audit succeeds in isolated Gateway');
  await page.locator('#simpleModal.open').waitFor({state:'hidden',timeout:10000});return body.result;
 };
 const checkPair=async()=>{
  const source=await row(cases.fresh.sourceId),target=await row(targetId);
  assert.equal(occurrences(source.pending_content,display),1,'source unfinished retains one annotated history line');
  assert.equal(occurrences(source.pending_content,otherPendingText),1,'unresolved other source line remains');
  assert.equal(source.completed_content,'10/16原有完成事項（合成）','no completed transfer into source');
  assert.equal(source.status,'in_progress','other unresolved source line keeps unfinished state');
  assert.equal(occurrences(target.completed_content,display),1,'target completed contains exactly one annotated history line');
  assert.equal(occurrences(target.pending_content,historyText),0,'target unfinished does not gain resolved item');
  assert.equal(target.pending_content,targetOther);
  assert.equal(source.pending_completions.length,1);assert.equal(target.pending_sources.length,1);
  for(const [id,expectedPending,expectedCompleted] of [[source.id,source.pending_content,source.completed_content],[target.id,target.pending_content,target.completed_content]]){
   await edit(id,cases.fresh.projectId);
   assert.equal(await form.locator('[name="pendingContent"]').inputValue(),expectedPending,'textarea reads stored unfinished/history');
   assert.equal(await form.locator('[name="completedContent"]').inputValue(),expectedCompleted,'textarea reads stored completed');
   await close();
  }
 };

 // A new resolution is submitted by the current UI to the actual Gateway and SQL writer.
 await start();assert.equal((await pendingTexts()).length,2);
 await form.locator('[name="completedContent"]').fill('10/28原有完成事項（合成）');
 const checkbox=form.locator('[data-pending-work-log-items] label').filter({hasText:historyText}).locator('input');
 await checkbox.check();assert.equal(occurrences(await form.locator('[name="completedContent"]').inputValue(),display),1);
 await checkbox.uncheck();assert.equal(await form.locator('[name="completedContent"]').inputValue(),'10/28原有完成事項（合成）','uncheck preserves manual text');
 await checkbox.check();await form.locator('[name="pendingContent"]').fill(targetOther);
 const target=await save();targetId=target.work_log.id;await checkPair();checks.push('new resolution: UI → Gateway → SQL → both original textareas');

 await page.reload();await ready();await checkPair();checks.push('reload retains source unfinished history and unique target completed line');
 await edit(cases.fresh.sourceId,cases.fresh.projectId);await form.locator('[name="timePeriod"]').fill('上午（其他欄位編輯）');await save();
 await edit(targetId,cases.fresh.projectId);await form.locator('[name="timePeriod"]').fill('下午（其他欄位編輯）');await save();await checkPair();checks.push('unrelated source and target edits retain history');

 for(const date of ['2026-10-29','2026-10-30']){
  await start({date});const labels=await pendingTexts();
  assert.equal(labels.some(text=>text.includes(historyText)),false,'completed source cannot be selected again');
  assert.equal(labels.some(text=>text.includes(otherPendingText)),true,'other original pending item remains selectable');
  assert.equal(labels.some(text=>text.includes(targetOther)),true,'target new pending item remains selectable');
  const other=form.locator('[data-pending-work-log-items] label').filter({hasText:otherPendingText}).locator('input');
  assert.equal(await other.isEnabled(),true);await other.check();await other.uncheck();
  await form.locator('[name="completedContent"]').fill(`${date}新日誌自有完成內容（合成）`);await form.locator('[name="pendingContent"]').fill('');await save();
 }
 await page.reload();await ready();await checkPair();checks.push('two later logs plus refresh exclude completed item and retain other selectable pending work');

 await start({projectId:cases.sameName.projectId,customerId:cases.sameName.customerId,departmentId:cases.sameName.departmentId,date:'2026-10-30'});
 assert.equal((await pendingTexts()).length,1);assert.ok((await pendingTexts())[0].includes(historyText));
 assert.equal((await row(cases.sameName.sourceId)).pending_content,historyText);await close();checks.push('identical work name on different project ID remains independent');

 // The historical backfill must depend on present source/target evidence.
 const legacySource=await row(cases.legacy.sourceId),legacyTarget=await row(cases.legacy.targetId);
 assert.equal(occurrences(legacySource.pending_content,display),1);assert.equal(occurrences(legacySource.completed_content,historyText),0);
 assert.equal(occurrences(legacyTarget.completed_content,display),1);
 await edit(cases.legacy.sourceId,cases.legacy.projectId);assert.equal(await form.locator('[name="pendingContent"]').inputValue(),legacySource.pending_content);await close();
 const ambiguousAfter=await db.query('select * from site_work_logs where id=any($1::uuid[]) order by id',[[cases.ambiguous.sourceId,cases.ambiguous.targetId]]);
 for(const before of cases.ambiguous.before){const after=ambiguousAfter.rows.find(item=>item.id===before.id);assert.equal(after.completed_content,before.completed_content);assert.equal(after.pending_content,before.pending_content);}
 checks.push('deterministic historical backfill displayed; manually deleted target line is not reconstructed');

 await edit(cases.fresh.sourceId,cases.fresh.projectId);await form.locator('[name="pendingContent"]').scrollIntoViewIfNeeded();
 await page.screenshot({path:fileURLToPath(new URL('source-desktop.png',output)),fullPage:true});await close();
 await edit(targetId,cases.fresh.projectId);await form.locator('[name="completedContent"]').scrollIntoViewIfNeeded();
 await page.screenshot({path:fileURLToPath(new URL('target-desktop.png',output)),fullPage:true});await close();
 await page.setViewportSize({width:390,height:844});await start({date:'2026-10-31'});
 assert.equal(await form.evaluate(el=>el.scrollWidth>el.clientWidth+2),false,'mobile form does not horizontally overflow');
 await page.screenshot({path:fileURLToPath(new URL('next-pending-mobile.png',output)),fullPage:true});await close();checks.push('desktop textareas and mobile pending picker');
 assert.deepEqual(errors,[],'no browser execution errors');
 assert.deepEqual(apiFailures,[],'no failing isolated API requests, including construction reminder');
 await writeFile(new URL('result.json',output),JSON.stringify({passed:true,syntheticOnly:true,browser:'msedge',checks,errors,apiFailures,blockedExternalOrigins:[...blockedOrigins],limitations:['PGlite is not a PostgreSQL concurrency or Supabase Auth test','Synthetic construction projects are explicitly classified as small_purchase; no construction plans exist','No production, Docker, credentials, or customer records accessed']},null,2));
 console.log(`PASS ${checks.length} isolated browser/Gateway/PGlite checks. Evidence: ${fileURLToPath(output)}`);
}catch(error){
 await page?.screenshot({path:fileURLToPath(new URL('failure.png',output)),fullPage:true}).catch(()=>{});
 await writeFile(new URL('result.json',output),JSON.stringify({passed:false,syntheticOnly:true,checks,errors,error:String(error.stack||error).slice(0,5000)},null,2));
 console.error(error.stack||error);process.exitCode=1;
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await db.close();}
