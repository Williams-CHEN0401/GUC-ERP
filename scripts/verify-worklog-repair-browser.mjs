// Browser-only fixture verification; no production API or credentials are used.
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=new URL('../tmp/worklog-repair-browser/',import.meta.url);
await mkdir(output,{recursive:true});
const allowed=new Map([['/','index.html'],['/app.js','app.js'],['/styles.css','styles.css'],['/project-report.js','project-report.js']]);
const server=createServer(async(req,res)=>{
  if(req.url==='/api/public-config'){res.setHeader('Content-Type','application/javascript');res.end('globalThis.GUC_PUBLIC_CONFIG={};');return;}
  const file=allowed.get(req.url?.split('?')[0]);
  if(!file){res.statusCode=req.url==='/favicon.ico'?204:404;res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');
  res.end(await readFile(new URL('../'+file,import.meta.url)));
});
// Production control flow against local mocked HTTP only: two real tabs, real item form,
// mutation response, focus refresh, existing hydration, and unchanged work-log draft.
async function verifyCrossTabInventoryRefresh(browser,url){
  const fixture={current_user:{id:'worker-1',username:'test',role:'admin',display_name:'測試員'},
    customers:[{id:'customer-1',customer_code:'C001',customer_category:'school',name:'測試學校'}],
    contract_service_types:[{id:'service-1',code:'monitoring',name:'監控系統',is_active:true}],
    customer_contract_services:[{customer_id:'customer-1',service_type_id:'service-1'}],
    categories:[{id:'category-1',name:'攝影機',is_active:true}],
    items:[{id:'item-1',category_id:'category-1',inventory_code:'CAM001',item_name:'既有品項',brand:'品牌'}],
    site_workers:[{id:'worker-1',display_name:'測試員',is_active:true}],projects:[],site_work_logs:[],repair_items:[]};
  const live=await browser.newContext(),posts=[],gets=[],errors=[];
  let failInventory=false;
  await live.addInitScript(()=>{window.BroadcastChannel=undefined;});
  await live.route('**/*',async route=>{
    const request=route.request(),target=new URL(request.url());
    if(target.hostname!=='127.0.0.1')return route.abort();
    if(target.pathname==='/app.js')return route.fulfill({contentType:'application/javascript',body:(await readFile(new URL('../app.js',import.meta.url),'utf8')).replace('const PREVIEW_MODE = location.hostname !== PRODUCTION_HOST;','const PREVIEW_MODE = false;')});
    if(target.pathname==='/api/nas')return route.fulfill({json:{message:'isolated fixture',root:'/test'}});
    if(target.pathname!=='/api/inventory')return route.continue();
    if(request.method()==='GET'){
      const scope=target.searchParams.get('scope');gets.push(scope);
      if(failInventory&&scope==='inventory')return route.fulfill({status:503,json:{error:'fixture offline'}});
      return route.fulfill({json:scope==='inventory'?{scope,items:fixture.items,categories:fixture.categories,errors:[]}:{...fixture,scope,errors:[]}});
    }
    const {operation,payload}=request.postDataJSON();posts.push(operation);
    assert.equal(operation,'create_inventory_item_batch','only this test item may be created');
    fixture.items.push(...payload.rows.map((row,index)=>({...row,id:'new-item-'+index,inventory_code:'NEW'+index})));
    return route.fulfill({status:201,json:{result:fixture.items.slice(-payload.rows.length)}});
  });
  const prepare=async(page)=>{
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.dismiss());
    await page.goto(url,{waitUntil:'networkidle'});await page.locator('#loginForm').waitFor({state:'visible'});
    await page.evaluate(snapshot=>{hydrateSnapshot(snapshot);storeAccessToken('isolated-test-token');Object.values(PAGE_SCOPES).forEach(scope=>loadedScopes.add(scope));hideLogin();document.querySelector('#systemChooser').classList.remove('open');},fixture);
  };
  try{
    const draft=await live.newPage();await prepare(draft);
    await draft.locator('a[data-page="worklogs"]').click();await draft.locator('[data-open="workLogModal"]').click();
    const form=draft.locator('#modalForm');
    await form.locator('[name="customerCategory"]').selectOption('school');await form.locator('[name="customerId"]').selectOption('customer-1');
    await form.locator('[name="projectName"]').fill('跨分頁草稿');await form.locator('[name="summary"]').fill('不可清空的工作內容');
    await form.locator('[name="logDate"]').fill('2026-09-05');await form.locator('[name="workerIds"]').check();
    await form.locator('[name="hasMaintenance"]').selectOption('yes');await form.locator('[name="eventType"]').selectOption('REPAIR');
    await form.locator('[name="eventServiceId"]').selectOption('service-1');await form.locator('[name="eventInventoryCategoryId"]').selectOption('category-1');
    await form.locator('[name="eventInventoryItemId"]').selectOption('item-1');await form.locator('[name="eventCause"]').fill('保留故障內容');
    await draft.evaluate(async()=>{await Promise.all([...scopeRequests.values()]);});
    const draftState=()=>form.evaluate(node=>({requestId:node.dataset.requestId,fields:[...node.elements].map(f=>[f.name,f.value,f.checked])}));
    const before=await draftState(),navigationCount=await draft.evaluate(()=>performance.getEntriesByType('navigation').length);
    const inventory=await live.newPage();await prepare(inventory);
    await inventory.locator('a[data-page="inventory"]').click();await inventory.locator('[data-tabs="inventory"] [data-tab="items"]').click();
    const itemForm=inventory.locator('#itemBatchForm');await itemForm.locator('[name="category"]').selectOption('category-1');
    await itemForm.locator('[name="name"]').fill('另一分頁新增品項');await itemForm.locator('[name="brand"]').fill('測試品牌');
    await itemForm.locator('button[type="submit"]').click();await itemForm.locator('[name="name"]').waitFor();
    await inventory.waitForFunction(()=>state.inventory.some(item=>item.id==='new-item-0'));
    await draft.bringToFront();await draft.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await draft.waitForFunction(()=>document.querySelector('[name="eventInventoryItemId"] option[value="new-item-0"]'));
    assert.deepEqual(await draftState(),before);assert.equal(await draft.evaluate(()=>performance.getEntriesByType('navigation').length),navigationCount);
    assert.deepEqual(posts,['create_inventory_item_batch']);assert.ok(gets.includes('inventory'));
    failInventory=true;await draft.evaluate(()=>refreshOpenWorkLogInventory());assert.deepEqual(await draftState(),before);
    assert.deepEqual(errors,[]);
    console.log('PASS actual cross-tab inventory form -> mocked HTTP mutation -> focus GET -> options refresh, no reload or lost draft, offline refresh preserves draft');
  }finally{await live.close();}
}
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  // This single-tab fixture has no session to inherit. Finish startup before seeding,
  // so the asynchronous cross-tab timeout cannot reopen login during form tests.
  await context.addInitScript(()=>{window.BroadcastChannel=undefined;});
  const page=await context.newPage(),errors=[],dialogs=[];
  page.on('pageerror',error=>errors.push(error.message));
  let acceptRepairPrompt=false;
  page.on('dialog',async dialog=>{dialogs.push(dialog.message());if(acceptRepairPrompt&&dialog.message().includes('是否要登錄維修設備'))await dialog.accept();else await dialog.dismiss();});
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
  await page.locator('#loginForm').waitFor({state:'visible'});
  assert.ok((await page.locator('body').innerText()).length>100);
  await page.screenshot({path:fileURLToPath(new URL('initial.png',output))});
  assert.deepEqual(errors,[]);
  console.log('PASS page loads, nonblank, no runtime errors');
  // Seed only the isolated browser state through the actual hydration function.
  await page.evaluate(()=>{
    hydrateSnapshot({
      current_user:{id:'worker-1',username:'test',display_name:'測試員',role:'admin'},
      customers:[{id:'customer-1',customer_code:'C001',customer_category:'school',name:'測試學校'}],
      contract_service_types:[{id:'service-1',name:'監控系統',code:'monitoring',is_active:true}],
      customer_contract_services:[{customer_id:'customer-1',service_type_id:'service-1'}],
      categories:[{id:'category-1',name:'攝影機',is_active:true},{id:'category-2',name:'交換器',is_active:true}],
      items:[{id:'item-1',category_id:'category-1',inventory_code:'CAM001',item_name:'測試攝影機',brand:'測試品牌',model:'型號A'},
        {id:'item-2',category_id:'category-2',inventory_code:'SW001',item_name:'測試交換器',brand:'測試品牌'}],
      site_workers:[{id:'worker-1',display_name:'施工測試員',is_active:true}],projects:[],site_work_logs:[],repair_items:[]
    });
    Object.values(PAGE_SCOPES).forEach(scope=>loadedScopes.add(scope));
    hideLogin();document.querySelector('#systemChooser').hidden=true;
    // The system chooser uses a class; call the normal ERP navigation helper below.
    document.querySelector('#systemChooser').classList.remove('open');
    renderAll();applyUserState();
  });
  await page.locator('a[data-page="worklogs"]').click();
  await page.locator('[data-open="workLogModal"]').click();
  assert.equal(dialogs.length,0,'no confirm before the form');
  const form=page.locator('#modalForm');
  assert.equal(await form.locator('[name="hasMaintenance"]').inputValue(),'no');
  assert.equal(await form.locator('#maintenanceEditor').isHidden(),true);
  await form.locator('[name="customerCategory"]').selectOption('school');
  await form.locator('[name="customerId"]').selectOption('customer-1');
  await form.locator('[name="projectName"]').fill('驗證專案');
  await form.locator('[name="workerIds"]').check();
  await form.locator('[name="summary"]').fill('現場檢查測試');
  assert.equal(await form.evaluate(node=>node.checkValidity()),true,'hidden repair controls must not block ordinary logs');
  await form.locator('[name="workType"]').selectOption('維護保養');
  assert.equal(dialogs.length,0,'other work types do not prompt');
  await form.locator('[name="workType"]').selectOption('維修紀錄');
  assert.equal(dialogs.length,1);
  assert.match(dialogs[0],/是否要登錄維修設備/);
  assert.equal(await form.locator('[name="hasMaintenance"]').inputValue(),'no');
  assert.equal(await form.locator('#maintenanceEditor').isHidden(),true);
  assert.deepEqual(await page.evaluate(()=>collectMaintenanceEvents()),[]);
  assert.equal(await form.evaluate(node=>node.checkValidity()),true,'declining must not block the ordinary save');
  await form.locator('[name="workType"]').selectOption('工程施工');
  acceptRepairPrompt=true;
  await form.locator('[name="workType"]').selectOption('維修紀錄');
  assert.equal(dialogs.length,2);
  assert.equal(await form.locator('[name="hasMaintenance"]').inputValue(),'yes');
  assert.equal(await form.locator('#maintenanceEditor').isVisible(),true);
  console.log('PASS repair selection prompts, cancel keeps ordinary log, accept reveals equipment details');
  assert.deepEqual(await form.locator('[name="eventType"] option').allTextContents(),['軟體設定','線路維修','線路更換','設備維修','設備更換']);
  assert.equal(await form.locator('[name="eventType"]').inputValue(),'SOFTWARE_CONFIG');
  assert.equal(await form.locator('[name="eventInventoryItemId"]').isDisabled(),true);
  await form.locator('[name="eventServiceId"]').selectOption('service-1');
  for(const type of ['SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','REPAIR','REPLACEMENT']){
    await form.locator('[name="eventType"]').selectOption(type);
    assert.equal(await page.evaluate(()=>collectMaintenanceEvents()[0].event_type),type);
    for(const name of ['eventInventoryCategoryId','eventInventoryItemId']){
      assert.equal(await form.locator('[name="'+name+'"]').isVisible(),['REPAIR','REPLACEMENT'].includes(type));
    }
    assert.equal(await form.locator('[data-open-equipment-picker]').isVisible(),true);
  }
  await form.locator('[name="logDate"]').fill('2026-09-05');
  assert.equal(await form.locator('[name="eventOccurredAt"]').inputValue(),'2026-09-05');
  await form.locator('[name="logDate"]').fill('2026-09-06');
  assert.equal(await form.locator('[name="eventOccurredAt"]').inputValue(),'2026-09-06');
  await form.locator('[data-add-maintenance-event]').click();
  assert.equal(await form.locator('[name="eventOccurredAt"]').last().inputValue(),'2026-09-06');
  await form.locator('[data-remove-maintenance-event]').last().click();
  assert.ok((await form.locator('.maintenance-question').innerText()).startsWith('登錄維修事項'));
  assert.equal(await form.locator('.maintenance-editor-head b').innerText(),'維修明細');
  await form.locator('[name="eventType"]').selectOption('REPAIR');
  await form.locator('[name="eventInventoryCategoryId"]').selectOption('category-1');
  assert.equal(await form.locator('[name="eventInventoryItemId"] option').count(),2);
  await form.locator('[name="eventInventoryItemId"]').selectOption('item-1');
  await form.locator('[name="eventInventoryCategoryId"]').selectOption('category-2');
  assert.equal(await form.locator('[name="eventInventoryItemId"]').inputValue(),'');
  assert.equal(await form.locator('[name="eventInventoryItemId"] option[value="item-1"]').count(),0);
  await form.locator('[name="eventInventoryCategoryId"]').selectOption('category-1');
  await form.locator('[name="eventInventoryItemId"]').selectOption('item-1');
  // Switching away must clear a new selection and omit it from the payload.
  await form.locator('[name="eventType"]').selectOption('LINE_REPAIR');
  assert.equal(await form.locator('[name="eventInventoryItemId"]').isHidden(),true);
  assert.equal((await page.evaluate(()=>collectMaintenanceEvents()[0])).inventory_item_id,null);
  await form.locator('[name="eventType"]').selectOption('REPLACEMENT');
  assert.equal(await form.locator('[name="eventInventoryItemId"]').inputValue(),'');
  await form.locator('[name="eventInventoryCategoryId"]').selectOption('category-1');
  await form.locator('[name="eventInventoryItemId"]').selectOption('item-1');
  const draftBefore=await form.evaluate(node=>({values:[...node.elements].map(f=>[f.name,f.value,f.checked]),requestId:node.dataset.requestId}));
  // Exercise the normal successful inventory mutation while the work-log draft remains mounted.
  await page.evaluate(()=>mutate('create_inventory_item_batch',{rows:[{category_id:'category-1',item_name:'新增測試品項',brand:'品牌',model:'新型號',unit:'台',opening_quantity:0}]},''));
  const addedItem=await page.evaluate(()=>state.inventory.find(item=>item.name==='新增測試品項'));
  assert.ok(addedItem);
  assert.equal(await form.locator('[name="eventInventoryItemId"] option[value="'+addedItem.id+'"]').count(),1);
  assert.deepEqual(await form.evaluate(node=>({values:[...node.elements].map(f=>[f.name,f.value,f.checked]),requestId:node.dataset.requestId})),draftBefore);
  assert.equal(await form.locator('[name="eventInventoryItemId"]').inputValue(),'item-1');
  await form.locator('[name="eventCause"]').fill('馬達異常');
  await form.locator('[name="eventNotes"]').fill('只同步此備註');
  console.log('PASS UI labels, new/edit date change, added event date, item mutation refresh preserves all draft fields, equipment-only fields and stale-selection clearing');
  const payload=await page.evaluate(()=>collectMaintenanceEvents()[0]);
  assert.equal(payload.inventory_item_id,'item-1');assert.deepEqual(payload.equipment_ids,[]);
  await page.screenshot({path:fileURLToPath(new URL('desktop-form.png',output))});
  await page.setViewportSize({width:390,height:844});
  await form.locator('[name="eventInventoryCategoryId"]').scrollIntoViewIfNeeded();
  const overflow=await form.evaluate(node=>node.scrollWidth>node.clientWidth+1);
  assert.equal(overflow,false,'mobile form must not overflow horizontally');
  await page.screenshot({path:fileURLToPath(new URL('mobile-form.png',output))});
  await form.locator('button[type="submit"]').click();
  await page.locator('#simpleModal').waitFor({state:'hidden'});
  const saved=await page.evaluate(()=>({repairs:state.repairItems,events:state.maintenanceEvents,links:state.maintenanceEventEquipment,logs:state.siteData.logs}));
  assert.equal(saved.repairs.length,1);assert.equal(saved.events.length,1);assert.equal(saved.logs.length,1);assert.equal(saved.links.length,0);
  assert.equal(saved.repairs[0].notes,'只同步此備註');
  assert.equal(saved.repairs[0].receivedOn,null);assert.equal(saved.repairs[0].quantity,null);
  assert.equal(saved.repairs[0].status,'');assert.equal(saved.repairs[0].issueDescription,'馬達異常');
  assert.equal(saved.logs[0].workerIds[0],'worker-1');
  assert.equal(saved.events[0].eventType,'REPLACEMENT');
  console.log('PASS real form entry, worker selection, category filter, mobile width, item-only save and NULL fields');
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('a[data-page="repairs"]').click();
  await page.locator('[data-edit-repair]').click();
  for(const name of ['receivedOn','quantity','status'])assert.equal(await form.locator('[name="'+name+'"]').inputValue(),'');
  assert.equal(await form.locator('[name="issueDescription"]').inputValue(),'馬達異常');
  assert.equal(await form.evaluate(node=>node.checkValidity()),false);
  await form.locator('[name="receivedOn"]').fill('2026-09-05');
  await form.locator('[name="quantity"]').fill('2');
  await form.locator('[name="status"]').selectOption('received');
  await form.locator('[name="issueDescription"]').fill('人工補充故障');
  await form.locator('button[type="submit"]').click();
  await page.locator('#simpleModal').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>state.repairItems[0].quantity),2);
  await page.locator('a[data-page="worklogs"]').click();
  await page.evaluate(()=>{state.maintenanceEvents[0].occurredAt='2026-09-04';});
  await page.locator('[data-work-log-row]').dblclick();
  assert.equal(await form.locator('[name="eventOccurredAt"]').inputValue(),'2026-09-04','opening an existing log must preserve its event date');
  await form.locator('[name="logDate"]').fill('2026-09-07');
  assert.equal(await form.locator('[name="eventOccurredAt"]').inputValue(),'2026-09-07');
  const promptsBeforeEdit=dialogs.length;
  assert.equal(dialogs.filter(message=>message.includes('是否要登錄維修設備')).length,2,'reopening an existing repair log must not prompt');
  await form.locator('[name="workType"]').selectOption('工程施工');
  await form.locator('[name="workType"]').selectOption('維修紀錄');
  assert.equal(dialogs.length,promptsBeforeEdit,'editing an existing log must not prompt');
  assert.equal(await form.locator('[name="eventType"]').inputValue(),'REPLACEMENT');
  assert.equal(await form.locator('[name="eventInventoryItemId"]').inputValue(),'item-1');
  assert.equal(await form.locator('[name="eventInventoryItemId"]').isDisabled(),true);
  await form.locator('[name="summary"]').fill('日誌後續修改');
  await form.locator('button[type="submit"]').click();
  await page.locator('#simpleModal').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>state.repairItems.length),1);
  assert.equal(await page.evaluate(()=>state.repairItems[0].issueDescription),'人工補充故障');
  // Simulate a historical record only in isolated preview state, then edit it normally.
  await page.evaluate(()=>{state.maintenanceEvents[0].eventType='INSPECTION';});
  await page.locator('[data-work-log-row]').dblclick();
  assert.equal(await form.locator('[name="eventType"]').inputValue(),'INSPECTION');
  assert.deepEqual(await form.locator('[name="eventType"] option').allTextContents(),['軟體設定','線路維修','線路更換','設備維修','設備更換','巡檢（舊分類）']);
  await form.locator('[name="eventNotes"]').fill('保留既有巡檢分類');
  await form.locator('button[type="submit"]').click();
  await page.locator('#simpleModal').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>state.maintenanceEvents[0].eventType),'INSPECTION');
  console.log('PASS exact five labels, selected type survives save/reopen, historical type remains unchanged');
  assert.deepEqual(errors,[]);
  console.log('PASS repair manual completion and work-log edits preserve the repair, no browser runtime errors');
  await verifyCrossTabInventoryRefresh(browser,'http://127.0.0.1:'+server.address().port);
}finally{
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
