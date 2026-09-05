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
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage(),errors=[],dialogs=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss();});
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
  await form.locator('[name="hasMaintenance"]').selectOption('yes');
  assert.equal(await form.locator('[name="eventInventoryItemId"]').isDisabled(),true);
  await form.locator('[name="eventServiceId"]').selectOption('service-1');
  await form.locator('[name="eventInventoryCategoryId"]').selectOption('category-1');
  assert.equal(await form.locator('[name="eventInventoryItemId"] option').count(),2);
  await form.locator('[name="eventInventoryItemId"]').selectOption('item-1');
  await form.locator('[name="eventInventoryCategoryId"]').selectOption('category-2');
  assert.equal(await form.locator('[name="eventInventoryItemId"]').inputValue(),'');
  assert.equal(await form.locator('[name="eventInventoryItemId"] option[value="item-1"]').count(),0);
  await form.locator('[name="eventInventoryCategoryId"]').selectOption('category-1');
  await form.locator('[name="eventInventoryItemId"]').selectOption('item-1');
  await form.locator('[name="eventNotes"]').fill('只同步此備註');
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
  assert.equal(saved.repairs[0].status,'');assert.equal(saved.repairs[0].issueDescription,'');
  assert.equal(saved.logs[0].workerIds[0],'worker-1');
  console.log('PASS real form entry, worker selection, category filter, mobile width, item-only save and NULL fields');
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('a[data-page="repairs"]').click();
  await page.locator('[data-edit-repair]').click();
  for(const name of ['receivedOn','quantity','status','issueDescription'])assert.equal(await form.locator('[name="'+name+'"]').inputValue(),'');
  assert.equal(await form.evaluate(node=>node.checkValidity()),false);
  await form.locator('[name="receivedOn"]').fill('2026-09-05');
  await form.locator('[name="quantity"]').fill('2');
  await form.locator('[name="status"]').selectOption('received');
  await form.locator('[name="issueDescription"]').fill('人工補充故障');
  await form.locator('button[type="submit"]').click();
  await page.locator('#simpleModal').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>state.repairItems[0].quantity),2);
  await page.locator('a[data-page="worklogs"]').click();
  await page.locator('[data-work-log-row]').dblclick();
  assert.equal(await form.locator('[name="eventInventoryItemId"]').inputValue(),'item-1');
  assert.equal(await form.locator('[name="eventInventoryItemId"]').isDisabled(),true);
  await form.locator('[name="summary"]').fill('日誌後續修改');
  await form.locator('button[type="submit"]').click();
  await page.locator('#simpleModal').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>state.repairItems.length),1);
  assert.equal(await page.evaluate(()=>state.repairItems[0].issueDescription),'人工補充故障');
  assert.deepEqual(errors,[]);
  console.log('PASS repair manual completion and work-log edits preserve the repair, no browser runtime errors');
}finally{
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
