import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'tmp/performance');
process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(out,'browsers');
const playwright=await import(process.env.PLAYWRIGHT_MODULE||pathToFileURL('C:/Users/Williams/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const fixture=JSON.parse(await readFile(path.join(out,'runtime.json'),'utf8'));
const base='http://localhost:4268';if(fixture.baseUrl!==base)throw Error('Unexpected test destination');
const results=[],errors=[];await mkdir(path.join(out,'screenshots'),{recursive:true});
async function api(actor,operation,payload){const r=await fetch(base+'/api/inventory',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+fixture.users[actor].token},body:JSON.stringify({operation:'performance.'+operation,payload:{request_id:randomUUID(),...payload}})});const body=await r.json();assert.equal(r.status,201,JSON.stringify(body));return body.result;}
async function detail(actor,id){const r=await fetch(base+'/api/inventory?'+new URLSearchParams({scope:'performance',mode:'detail',id}),{headers:{Authorization:'Bearer '+fixture.users[actor].token}});const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b.performance;}
async function login(browser,actor,width=390){
 const context=await browser.newContext({viewport:{width,height:844},deviceScaleFactor:1,acceptDownloads:true});const page=await context.newPage();
 page.on('pageerror',e=>errors.push({actor,message:e.message}));
 page.on('request',r=>{assert.ok(new URL(r.url()).origin===base||r.url().startsWith('blob:'),'Browser must not call external services: '+r.url());});
 await page.goto(base+'/?page=performance');await page.locator('#loginForm [name=username]').fill(fixture.users[actor].username);await page.locator('#loginForm [name=password]').fill(fixture.users[actor].password);
 const loaded=page.waitForResponse(r=>r.url().includes('scope=performance')&&r.request().method()==='GET');await page.locator('#loginForm button').click();await (await loaded).finished();
 await page.locator('#performanceRoot [data-performance-tab=self]').waitFor({state:'visible'});
 return {page,context};
}
async function widthCheck(page,label){
 const dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(dimensions.scroll<=dimensions.width+1,label+' overflow '+JSON.stringify(dimensions));
 const sizes=await page.locator('#performanceRoot button:visible').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().height));assert.ok(sizes.every(h=>h>=43),label+' targets must be 44px');
}
async function clickAction(page,action){
 const response=page.waitForResponse(r=>r.url().includes('/api/inventory')&&r.request().method()==='POST'&&r.request().postDataJSON()?.operation==='performance.'+action);
 await page.locator(`[data-performance-action="${action}"]`).click();const r=await response;assert.equal(r.status(),201,await r.text());
 await page.waitForFunction(()=>!document.querySelector('#performanceRoot button:disabled'));
 assert.equal((await page.locator('#performanceMessage').innerText()).trim(),'');
}
async function submit(page,name){
 const response=page.waitForResponse(r=>r.url().includes('/api/inventory')&&r.request().method()==='POST'&&r.request().postDataJSON()?.operation==='performance.'+name);
 await page.locator(`[data-performance-form="${name}"] button`).click();const r=await response;assert.equal(r.status(),201,await r.text());
 await page.waitForFunction(()=>!document.querySelector('#performanceRoot button:disabled'));assert.equal((await page.locator('#performanceMessage').innerText()).trim(),'');
}
try{
 const list=await (await fetch(base+'/api/inventory?scope=performance',{headers:{Authorization:'Bearer '+fixture.users.admin.token}})).json();
 const uiYear=Math.max(...list.performance.periods.map(p=>Number(p.month.slice(0,4))))+1;
 let index=0;
 for(const engine of ['chrome','msedge','webkit']){
  const browser=engine==='webkit'?await playwright.webkit.launch({headless:true}):await playwright.chromium.launch({headless:true,channel:engine});
  const contexts=[];
  try{
   const month=uiYear+'-'+String(++index).padStart(2,'0')+'-01';
   const period=await api('admin','period_create',{month,template_id:fixture.template});
   const review=await api('admin','review_create',{period_id:period.id,employee_id:fixture.users.employee.id,reviewer_id:fixture.users.scorer.id,approver_id:fixture.users.admin.id,allocations:[{job_role:'construction',percent:100}]});
   const scorer=await login(browser,'scorer');contexts.push(scorer.context);const p=scorer.page;
   await p.locator('[data-performance-tab=reviews]').click();await p.locator(`[data-performance-action=detail][data-id="${review.id}"]`).click();
   await p.locator('[data-performance-form=review_score]').waitFor();
   assert.equal(await p.locator('[data-perf-item][open]').count(),0);
   for(const item of await p.locator('[data-criterion]').all()){await item.locator('..').locator('..').locator(':scope > summary').click();await item.locator('[name=rating]').selectOption('4');await item.locator('[name=reason]').fill('現場測試符合要求，完成後已交接。');}
   await widthCheck(p,engine+' scorer form');await submit(p,'review_score');
   assert.equal((await detail('scorer',review.id)).score,80);await p.screenshot({path:path.join(out,'screenshots',engine+'-scorer-390.png'),fullPage:true});
   await clickAction(p,'review_submit');assert.equal((await detail('scorer',review.id)).status,'SUBMITTED');
   const employee=await login(browser,'employee');contexts.push(employee.context);
   await employee.page.locator(`[data-performance-action=detail][data-id="${review.id}"]`).click();await employee.page.locator('[data-performance-form=review_respond]').waitFor();
   assert.equal(await employee.page.locator('[data-performance-form=review_score] button').count(),0);
   await employee.page.locator('[name=response_type]').selectOption('concern');await employee.page.locator('[data-performance-form=review_respond] [name=message]').fill('已知悉，希望下月安排網路設備訓練。');
   await widthCheck(employee.page,engine+' employee reply');await submit(employee.page,'review_respond');assert.equal((await detail('employee',review.id)).status,'EMPLOYEE_RESPONDED');
   await employee.page.screenshot({path:path.join(out,'screenshots',engine+'-employee-390.png'),fullPage:true});
   const admin=await login(browser,'admin');contexts.push(admin.context);await admin.page.locator('[data-performance-tab=approval]').click();await admin.page.locator(`[data-performance-action=detail][data-id="${review.id}"]`).click();
   await admin.page.locator('[data-performance-action=review_approve]').waitFor();await widthCheck(admin.page,engine+' approval');await clickAction(admin.page,'review_approve');await clickAction(admin.page,'review_publish');
   assert.equal((await detail('employee',review.id)).status,'PUBLISHED');await admin.page.screenshot({path:path.join(out,'screenshots',engine+'-approved-390.png'),fullPage:true});
   await employee.page.locator('[data-performance-action=refresh]').click();await employee.page.locator('.perf-detail').getByText('已發布',{exact:true}).waitFor();
   for(const type of ['export','excel']){const downloadPromise=employee.page.waitForEvent('download');await employee.page.locator(`[data-performance-action=${type}]`).click();const download=await downloadPromise;await download.saveAs(path.join(out,engine+'-'+download.suggestedFilename()));}
   await admin.page.setViewportSize({width:1440,height:1000});await widthCheck(admin.page,engine+' desktop');await admin.page.screenshot({path:path.join(out,'screenshots',engine+'-desktop.png'),fullPage:true});
   results.push({engine,status:'PASS',viewport:'390×844 and 1440×1000',flow:'actual UI login, seven ratings, 80.00 persistence, employee concern, separate approval/publication, refresh, CSV and XLSX downloads',reviewId:review.id});console.log('PASS '+engine+' mobile scoring/reply/approval/publication/export and desktop');
  }finally{for(const context of contexts)await context.close();await browser.close();}
 }
 assert.deepEqual(errors,[]);console.log('PASS AT-20: all three engines; no overflow or browser runtime errors.');
}catch(e){console.error(e.stack);results.push({status:'FAIL',error:e.message});process.exitCode=1;}
finally{await writeFile(path.join(out,'browser-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),case:'AT-20',results,errors,physicalDeviceTested:false},null,2));}
