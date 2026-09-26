import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.SEARCH_PANEL_URL||'http://127.0.0.1:4226';
const out=new URL('../tmp/search-panels/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],external=[],isolatedNasDenials=[];
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin===base)return route.continue();
    external.push(route.request().url());return route.abort();
  });
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',message=>{
    if(message.type()!=='error')return;
    if(message.location().url===base+'/api/nas'&&message.text().includes('403'))isolatedNasDenials.push(message.text());
    else errors.push(message.text());
  });
  page.setDefaultTimeout(10000);
  const load=async(route,clicks=[])=>{
    await page.goto(base+'/?page='+route);
    await page.locator('#loginGate').waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.querySelector('#syncState').innerText.includes('已載入'));
    for(const selector of clicks)await page.locator(selector).click();
  };
  const panelFor=id=>page.locator('.search-panel').filter({has:page.locator(id)});
  const screenshot=async name=>page.screenshot({path:fileURLToPath(new URL(name+'.png',out)),fullPage:true});
  const cases=[
    ['transactions',[],'#pickupSearch'],
    ['transactions',['#transactions [data-tab="receipts"]'],'#receiptSearch'],
    ['repairs',[],'#repairSearch'],
    ['inventory',[],'#inventorySearch'],
    ['inventory',['#inventory [data-tab="categories"]'],'#productCategorySearch'],
    ['crm',[],'#customerSearch'],
    ['crm',['#customerCategoriesTab'],'#customerCategorySearch'],
    ['crm',['#customerDepartmentsTab'],'#customerDepartmentSearch'],
    ['crm',['#contractServicesTab'],'#contractServiceSearch'],
    ['crm',['#crm [data-tab="projects"]'],'#projectSearch'],
    ['crm',['#crm [data-tab="projects"]','#constructionTab'],'#constructionSearch'],
    ['crm',['#crm [data-tab="suppliers"]'],'#supplierSearch'],
    ['worklogs',[],'#worklogSearch'],
    ['materials',[],'#materialCustomerCategory'],
    ['settings',['#settings [data-tab="users"]'],'#userSearch'],
    ['settings',['#settings [data-tab="logs"]'],'#auditFilters']
  ];
  for(const [route,clicks,id] of cases){
    await load(route,clicks);
    assert.equal(await page.locator('.search-panel').count(),16);
    const panel=panelFor(id),popup=panel.locator('.search-panel-popup'),trigger=panel.locator('.search-panel-trigger');
    assert.equal(await popup.isVisible(),false,id+' initially collapsed');
    await trigger.click();assert.equal(await popup.isVisible(),true);
    assert.equal(await trigger.getAttribute('aria-expanded'),'true');
    assert.equal(await popup.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,id+' no inner horizontal overflow');
    assert.equal(await popup.locator('input,select').evaluateAll(els=>els.every(el=>el.labels?.length>0)),true,id+' all fields labeled');
    await page.keyboard.press('Escape');assert.equal(await popup.isVisible(),false);
    assert.equal(await trigger.evaluate(el=>el===document.activeElement),true,'Escape returns focus');
    await trigger.click();
    const search=popup.locator('input:not([type="date"])').first();
    if(await search.count()){
      await search.fill('找不到的測試搜尋999');
      await popup.getByRole('button',{name:'搜尋',exact:true}).click();
      assert.equal(await popup.isVisible(),false);
      assert.match(await panel.locator('.search-panel-summary').innerText(),/找不到的測試搜尋999/);
      await trigger.click();assert.equal(await search.inputValue(),'找不到的測試搜尋999');
    }
    await popup.getByRole('button',{name:'重設',exact:true}).click();
    if(await search.count())assert.equal(await search.inputValue(),'');
    if(await popup.isVisible())await popup.getByRole('button',{name:'收合篩選條件'}).click();
    assert.equal(await popup.isVisible(),false);
    console.log('PASS panel:',route,id);
  }
  // Every panel, including report and audit layouts, fits the narrow screen.
  await page.setViewportSize({width:390,height:844});
  for(const [route,clicks,id] of cases){
    await load(route,clicks);const panel=panelFor(id);
    await panel.locator('.search-panel-trigger').click();
    assert.equal(await panel.locator('.search-panel-popup').evaluate(el=>{const r=el.getBoundingClientRect();return el.scrollWidth<=el.clientWidth+1&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}),true,id+' mobile bounds');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,id+' page width');
    await panel.getByRole('button',{name:'收合篩選條件'}).click();
  }
  await page.setViewportSize({width:1440,height:1000});
  // Exercise real existing filtering and resets rather than only popup visibility.
  await load('inventory');let panel=panelFor('#inventorySearch');
  const inventoryBefore=await page.locator('#inventoryTable').innerText();
  await panel.locator('.search-panel-trigger').click();
  await page.locator('#inventorySearch').fill('取貨測試網路線');
  assert.equal(await page.locator('#inventoryTable tr').count(),1);
  assert.match(await page.locator('#inventoryTable').innerText(),/取貨測試網路線/);
  await panel.getByRole('button',{name:'搜尋',exact:true}).click();
  await panel.locator('.search-panel-trigger').click();await panel.getByRole('button',{name:'重設',exact:true}).click();
  assert.equal(await page.locator('select[id$="Sort"]').count(),0);
  assert.equal(await page.locator('#inventoryTable').innerText(),inventoryBefore);
  await load('crm',['#crm [data-tab="projects"]','#constructionTab']);panel=panelFor('#constructionSearch');
  await panel.locator('.search-panel-trigger').click();
  await page.locator('#constructionCategoryFilter').selectOption('');
  assert.match(await panel.locator('.search-panel-summary').innerText(),/未分類/);
  assert.equal(await page.locator('#constructionProjectTable').innerText(),'查無符合資料');
  await panel.getByRole('button',{name:'重設',exact:true}).click();
  assert.equal(await page.locator('#constructionCategoryFilter').inputValue(),'all');
  assert.match(await page.locator('#constructionProjectTable').innerText(),/搜尋工程範例/);
  await load('worklogs');panel=panelFor('#worklogSearch');
  const before=await page.locator('#worklogTable').innerText();
  await screenshot('desktop-collapsed');await panel.locator('.search-panel-trigger').click();
  await page.locator('#worklogCustomerCategoryFilter').selectOption('school');
  const data=await(await context.request.get(base+'/api/inventory?scope=worklogs')).json();
  const customer=data.projects.find(p=>p.id===data.site_work_logs[0].project_id).customer_id;
  await page.locator('#worklogCustomerFilter').selectOption(customer);
  assert.equal(await page.locator('#worklogDepartmentFilter').isDisabled(),false);
  await page.locator('#worklogTypeFilter').selectOption('維護保養');
  await page.locator('#worklogSearch').fill('第三季會議');
  assert.match(await page.locator('#worklogTable').innerText(),/第三季會議/);
  await screenshot('desktop-expanded');
  await panel.getByRole('button',{name:'搜尋',exact:true}).click();
  assert.match(await panel.locator('.search-panel-summary').innerText(),/第三季會議.*學校機關.*國立高雄大學.*維護保養/);
  await panel.locator('.search-panel-trigger').click();
  await panel.getByRole('button',{name:'重設',exact:true}).click();
  assert.equal(await page.locator('#worklogCustomerFilter').isDisabled(),true);
  assert.equal(await page.locator('#worklogCustomerFilter').inputValue(),'');
  assert.equal(await page.locator('#worklogTable').innerText(),before);
  await page.locator('#pageTitle').click();assert.equal(await panel.locator('.search-panel-popup').isVisible(),false);
  // Keyboard: open with Enter, apply with Enter; tab away dismisses without trapping focus.
  await panel.locator('.search-panel-trigger').focus();await page.keyboard.press('Enter');
  await page.locator('#worklogSearch').fill('第三季');await page.keyboard.press('Enter');
  assert.equal(await panel.locator('.search-panel-popup').isVisible(),false);
  await panel.locator('.search-panel-trigger').click();await panel.getByRole('button',{name:'重設',exact:true}).click();
  await panel.getByRole('button',{name:'搜尋',exact:true}).focus();await page.keyboard.press('Tab');
  assert.equal(await panel.locator('.search-panel-popup').isVisible(),false);
  // Existing create-dialog selectors remain untouched and immediately visible.
  await page.locator('[data-open="workLogModal"]').click();
  assert.equal(await page.locator('#modalForm .search-panel').count(),0);
  assert.equal(await page.locator('#modalForm [name="customerSelectorSearch"]').isVisible(),true);
  await page.locator('#simpleModal .modal-head [data-close]').click();
  // Navigation while open must close the panel, with no filter loss.
  await panel.locator('.search-panel-trigger').click();
  await page.locator('.nav-item[data-page="inventory"]').click();
  assert.equal(await page.locator('.search-panel-popup:visible').count(),0);
  // Mobile menu adapts within viewport; scrolling popup keeps controls/buttons reachable.
  await page.setViewportSize({width:390,height:844});await load('worklogs');panel=panelFor('#worklogSearch');
  await screenshot('mobile-collapsed');await panel.locator('.search-panel-trigger').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.equal(await panel.locator('.search-panel-popup').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}),true);
  await screenshot('mobile-expanded');
  await panel.getByRole('button',{name:'搜尋',exact:true}).click();assert.equal(await panel.locator('.search-panel-popup').isVisible(),false);
  await page.setViewportSize({width:1440,height:1000});
  await load('materials');panel=panelFor('#materialCustomerCategory');await panel.locator('.search-panel-trigger').click();
  await page.locator('#materialCustomerCategory').selectOption('school');await page.locator('#materialCustomer').selectOption(customer);
  const project=await page.locator('#materialProject option').evaluateAll(opts=>opts.find(o=>o.value)?.value);
  await page.locator('#materialProject').selectOption(project);
  await page.locator('#materialDateFrom').fill('2026-09-01');await page.locator('#materialDateTo').fill('2026-09-30');
  await panel.getByRole('button',{name:'搜尋',exact:true}).click();assert.match(await panel.locator('.search-panel-summary').innerText(),/2026-09-01/);
  await panel.locator('.search-panel-trigger').click();await panel.getByRole('button',{name:'重設',exact:true}).click();
  assert.equal(await page.locator('#materialDateFrom').inputValue(),'');assert.equal(await page.locator('#materialCustomer').isDisabled(),true);
  assert.match(await page.locator('#materialSummary').innerText(),/請選擇客戶與工作內容/);
  // Audit retains submit semantics: opening/typing alone does not send a query.
  await load('settings',['#settings [data-tab="logs"]']);panel=panelFor('#auditFilters');
  const requests=async()=>await(await context.request.get(base+'/__search_test')).json();
  const initialRequests=(await requests()).queries.length;
  await panel.locator('.search-panel-trigger').click();await panel.locator('[name="q"]').fill('稽核查詢');
  assert.equal((await requests()).queries.length,initialRequests);
  await panel.getByRole('button',{name:'搜尋',exact:true}).click();
  assert.equal((await requests()).queries.at(-1).q,'稽核查詢');
  await panel.locator('.search-panel-trigger').click();await panel.getByRole('button',{name:'重設',exact:true}).click();
  assert.equal((await requests()).queries.at(-1).q,undefined);
  assert.equal(await panel.locator('.search-panel-summary').innerText(),'點選展開篩選條件');
  assert.deepEqual((await requests()).mutations,[]);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Expected isolated NAS read denials (no NAS connection):',isolatedNasDenials.length);
  console.log('PASS: all 16 panels; keyword/category/reset without sorting dropdowns; dependent worklog/report selectors; audit query/reset; keyboard/outside/nav dismissal; mobile bounds; create form unchanged. No writes or external calls.');
}finally{await browser.close();}
