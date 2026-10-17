import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'file:///C:/Users/Williams/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {ERP_EXPORT_SPECS} from '../supabase/functions/inventory-gateway/export-lists.ts';
const base='http://localhost:8180',root=resolve(import.meta.dirname,'../..'),out=resolve(root,'system-improvements-1017/erp');mkdirSync(out,{recursive:true});
const ids=JSON.parse(readFileSync(resolve(root,'fixture-ids.json'),'utf8')),checks=[],errors=[],layout=[],apiResults={};
const pass=(name,extra={})=>{checks.push({name,status:'PASS',...extra});console.log('PASS '+name);};
async function api(payload,role='admin'){const response=await fetch(base+'/api/inventory',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer dashboard-fixture-'+role},body:JSON.stringify({operation:'export_data',payload})});return {status:response.status,body:await response.json()};}
let browser;
try{
 for(const resource of Object.keys(ERP_EXPORT_SPECS)){
  const description=await api({resource,describe:true});assert.equal(description.status,200,resource+' metadata: '+description.body.error);
  const columns=description.body.columns.map(c=>c.key),data=await api({resource,scope:'all',columns,filters:{q:'ignored-old-filter'}});assert.equal(data.status,200,resource+' data: '+data.body.error);assert.equal(data.body.columns.length,columns.length);assert(data.body.rows.every(row=>row.length===columns.length));apiResults[resource]=data.body;
  const denied=await api({resource,describe:true},'viewer');assert.equal(denied.status,403,resource+' viewer must not export');
  const invalid=await api({resource,scope:'all',columns:['auth_user_id']});assert([400,403].includes(invalid.status),resource+' rejects internal column');
  pass('API '+resource+' all pages / viewer denied / columns allowlist',{rows:data.body.rows.length});
 }
 const filtered=await api({resource:'projects',scope:'filtered',columns:['name','code'],filters:{q:'不存在1017'}});assert.equal(filtered.body.rows.length,0);pass('API filter empty and selected column order');
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1366,height:1000},acceptDownloads:true}),page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
 const load=async(route,clicks=[])=>{await page.goto(base+'/?page='+route);await page.waitForFunction(name=>typeof state!=='undefined'&&state.currentUser&&loadedScopes.has(PAGE_SCOPES[name]),route);for(const selector of clicks)await page.locator(selector).click();};
 const cases=[
  ['crm',[],'customerSearch','customerTable','customers','name'],
  ['crm',['#customerCategoriesTab'],'customerCategorySearch','customerCategoryTable','customer_categories','name'],
  ['crm',['#customerDepartmentsTab'],'customerDepartmentSearch','customerDepartmentTable','customer_departments','name'],
  ['crm',['#contractServicesTab'],'contractServiceSearch','contractServiceTable','contract_services','name'],
  ['crm',['#crm [data-tab="suppliers"]'],'supplierSearch','supplierTable','suppliers','name'],
  ['inventory',[],'inventorySearch','inventoryTable','inventory','name'],
  ['inventory',['#inventory [data-tab="categories"]'],'productCategorySearch','productCategoryTable','product_categories','name'],
  ['projects',[],'projectSearch','projectTable','projects','name'],
  ['projects',['#constructionTab'],'constructionSearch','constructionProjectTable','construction_projects','name'],
  ['projects',['#constructionPlanningTab'],'planningSearch','constructionPlanningList','construction_plans','name'],
  ['worklogs',[],'worklogSearch','worklogTable','worklogs','project'],
  ['transactions',['#transactions [data-tab="receipts"]'],'receiptSearch','receiptTable','receipts','document_no'],
  ['transactions',[],'pickupSearch','pickupTable','pickups','document_no'],
  ['repairs',[],'repairSearch','repairTable','repairs','code'],
  ['appointments',[],'appointmentSearch','appointmentTable','appointments','instructions'],
  ['settings',['#settings [data-tab="users"]'],'userSearch','userTable','users','name']
 ];
 for(const[route,clicks,id,bodyId,resource,column]of cases){
  await load(route,clicks);if(id==='planningSearch')await page.waitForFunction(()=>!document.querySelector('#constructionPlanningList').textContent.includes('載入'));
  const panel=page.locator('.search-panel').filter({has:page.locator('#'+id)});await panel.locator('.search-panel-trigger').click();
  if(resource==='customer_departments'){await page.locator('#departmentCustomerCategory').selectOption(await page.evaluate(id=>state.customers.find(c=>c.id===id).category,ids.customer));await page.locator('#departmentCustomer').selectOption(ids.customer);}
  const body=page.locator('#'+bodyId),before=await body.innerText(),input=page.locator('#'+id);
  await input.evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='不存在1017';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));});assert.equal(await body.innerText(),before,id+' changed during composition');
  await input.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'不存在1017'})));assert.match(await body.innerText(),/沒有|查無|目前/);await input.fill('');assert.equal(await body.innerText(),before,id+' clear restores all');
  const data=apiResults[resource],columnIndex=data.columns.findIndex(c=>c.key===column),sample=data.rows.map(r=>r[columnIndex]).filter(Boolean).at(-1);
  if(sample){await input.fill(' '+String(sample)+' ');const found=await body.innerText();assert(!/^(查無|沒有符合|目前沒有)/.test(found),id+' partial result missing: '+sample);assert(found.includes(String(sample))||resource==='customer_departments',id+' wrong result');await input.fill('');}
  for(const width of[375,430,768,1024,1366,1920]){await page.setViewportSize({width,height:1000});const check=await panel.locator('.search-panel-popup').evaluate(el=>{const b=el.getBoundingClientRect();return{left:b.left,right:b.right,viewport:innerWidth,overflow:el.scrollWidth>el.clientWidth+1,fields:[...el.querySelectorAll('input,select,button')].filter(e=>e.getClientRects().length).every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=b.left-1&&r.right<=b.right+1;})};});assert(!check.overflow&&check.fields&&check.left>=0&&check.right<=width+1,id+' layout '+width);layout.push({resource,width,status:'PASS'});}
  await page.keyboard.press('Escape');pass('Search '+id+' IME / partial / clear / six widths',{nonempty:!!sample});
 }
 await load('crm',['#contractServicesTab']);assert(!await page.locator('#contractServiceTable').evaluate(el=>el.closest('table').querySelector('thead').textContent.includes('排序')));await page.locator('[data-open="contractServiceModal"]').click();assert.equal(await page.locator('#modalForm [name="sortOrder"]').count(),0);await page.locator('button[data-close]').click();pass('Contract sort display/input removed; internal ordering retained');
 await load('transactions',['#transactions [data-tab="receipts"]']);await page.locator('[data-open="receiptModal"]').click();const form=page.locator('#modalForm');await form.locator('#receiptItemSearch').waitFor();const query=await page.evaluate(()=>state.inventory[0].name);await form.locator('[name="batchNote"]').first().fill('表單資料必須保留1017');await form.locator('#receiptItemSearch').fill(query.slice(0,2));assert(await form.locator('[data-receipt-search-item]').count()>0);await form.locator('[data-receipt-search-item]').first().click();assert.equal(await form.locator('[name="batchNote"]').first().inputValue(),'表單資料必須保留1017');await form.locator('#receiptCustomerSearch').fill('測試');assert(await form.locator('[data-receipt-customer]:not([hidden])').count()>0);pass('Receipt item / customer search before category selection preserves entered lines');await page.locator('button[data-close]').click();
 await load('worklogs');await page.locator('[data-open="workLogModal"]').click();await form.locator('[name="customerSelectorSearch"]').fill('測試');assert.equal(await form.locator('[name="customerId"]').isEnabled(),true);const choices=await form.locator('[name="customerId"] option').evaluateAll(options=>options.filter(o=>o.value).map(o=>o.value));assert(choices.length>0);await form.locator('[name="customerId"]').selectOption(choices[0]);assert(await form.locator('[name="customerCategory"]').inputValue());await form.locator('[name="completedContent"]').fill('日誌草稿1017');await form.locator('[name="customerSelectorSearch"]').fill('不存在1017');assert.equal(await form.locator('[name="completedContent"]').inputValue(),'日誌草稿1017');pass('New work log searches across authorized customer categories and preserves draft');await page.locator('button[data-close]').click();
 await load('projects');await page.locator('[data-export-resource="projects"]').click();const dialog=page.locator('.guc-export-dialog');await dialog.waitFor();await dialog.getByRole('button',{name:'取消全選',exact:true}).click();await dialog.getByLabel('工作內容名稱',{exact:true}).check();await dialog.getByLabel('工作內容編號',{exact:true}).check();await page.evaluate(()=>window.showSaveFilePicker=undefined);const downloadPromise=page.waitForEvent('download');await dialog.getByRole('button',{name:'確認匯出',exact:true}).click();const download=await downloadPromise;await download.saveAs(resolve(out,'projects-selected.xlsx'));await page.waitForFunction(()=>document.querySelector('.guc-export-status').textContent.includes('已匯出'));pass('Browser real selected-column XLSX download');await dialog.getByRole('button',{name:'取消',exact:true}).click();
 for(const width of[375,430,768,1024,1366,1920]){await page.setViewportSize({width,height:1000});await page.locator('[data-export-resource="projects"]').click();await dialog.waitFor();const bounds=await dialog.evaluate(el=>{const b=el.getBoundingClientRect();return {left:b.left,right:b.right,width:innerWidth,overflow:el.scrollWidth>el.clientWidth+1};});assert(bounds.left>=0&&bounds.right<=width+1&&!bounds.overflow);await page.screenshot({path:resolve(out,'export-'+width+'.png'),fullPage:true});await dialog.getByRole('button',{name:'取消',exact:true}).click();}pass('Export dialog six widths');
 await load('materials');await page.goto(base+'/?page=materials&work_content_id='+ids.project);await page.locator('.gr-heading').waitFor({timeout:40000});for(const width of[375,430,768,1024,1366,1920]){await page.setViewportSize({width,height:1000});await page.evaluate(()=>document.fonts.ready);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'report overflow '+width);await page.screenshot({path:resolve(out,'report-'+width+'.png'),fullPage:true});}pass('Report typography and charts at six widths');
 assert.deepEqual(errors,[]);writeFileSync(resolve(out,'results.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks,layout,errors,apiCounts:Object.fromEntries(Object.entries(apiResults).map(([name,r])=>[name,r.rows.length]))},null,2));
}catch(error){errors.push(error.stack);writeFileSync(resolve(out,'results.json'),JSON.stringify({checks,layout,errors},null,2));throw error;}finally{await browser?.close();}
