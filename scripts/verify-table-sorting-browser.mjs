import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base='http://127.0.0.1:4226',out=new URL('../tmp/table-sorting/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[],external=[];
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin===base)return route.continue();
    external.push(route.request().url());return route.abort();
  });
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&!(message.location().url===base+'/api/nas'&&message.text().includes('403')))errors.push(message.text());});
  const load=async(route,clicks=[])=>{
    await page.goto(base+'/?page='+route);await page.locator('#loginGate').waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.querySelector('#syncState').innerText.includes('已載入'));
    for(const selector of clicks)await page.locator(selector).click();
  };
  // Synthetic in-memory rows only: use the real renderers, never submit a mutation.
  const seed=async()=>page.evaluate(async()=>{
    await Promise.all([...formReferenceRequests.values()]);
    // Keep this in-memory fixture intact; live option refresh is covered by the search-panel suite.
    for(const scope of Object.values(PAGE_SCOPES))formReferenceTimes.set(scope,Date.now()+60000);
    const numbers=[10,2,12,1,11,3,9,4,8,5,7,6],date=n=>'2026-09-'+String(n).padStart(2,'0');
    const make=(prefix,extra)=>numbers.map(n=>({id:prefix+n,createdAt:date(n),updatedRaw:date(n),updatedAt:date(n),rowVersion:1,...extra(n)}));
    state.categories=make('category',n=>({name:'種類'+n,prefix:'T'+n,active:n%2===0}));
    state.inventory=make('item',n=>({code:'T'+n,category:'種類'+n,name:'品項'+n,brand:'品牌'+n,model:'機型'+n,unit:'台',quantity:n}));
    state.contractServiceTypes=make('service',n=>({code:'service'+n,name:'承攬'+n,sortOrder:n,active:true}));state.contractServicesReady=true;
    state.customers=make('customer',n=>({code:'C'+n,name:'客戶'+n,category:n%2?'school':'government',phone:'000'+n,address:'地址'+n,updated:date(n),contractServiceCodes:['service'+n]}));
    state.customerDepartments=make('department',n=>({name:'科室'+n,customerId:'customer1',active:n%2===0}));state.customerDepartmentsReady=true;
    state.customerCategories=[{id:'school',code:'school',name:'學校機關',active:true},{id:'government',code:'government',name:'政府機關',active:true},{id:'social',code:'social_welfare',name:'社福機關',active:true}];
    state.projects=make('project',n=>({code:'P'+n,name:'工作'+n,customerId:'customer'+n,departmentId:'',type:'工程施工',rawType:'construction',constructionCategory:n%2?'small_purchase':'tender',status:n%2?'completed':'in_progress',owner:'人員'+n}));
    state.suppliers=make('supplier',n=>({name:'供應商'+n,contact:'窗口'+n,phone:'000'+n,email:'mail'+n+'@example.test'}));
    state.accounts=make('user',n=>({username:'user'+n,displayName:'人員'+n,role:n%2?'operator':'viewer',active:n%2===0,activeLabel:n%2?'停用':'啟用',updated:date(n)}));
    state.siteWorkers=make('worker',n=>({displayName:'人員'+n,active:true}));
    state.pickups=make('pickup',n=>({date:date(n),itemId:'item'+n,projectId:'project'+n,customerId:'customer'+n,quantity:n,account:'人員'+n,workLogId:'log'+n}));
    state.receipts=make('receipt',n=>({date:date(n),itemId:'item'+n,supplierId:'supplier'+n,quantity:n,note:'備註'+n,customerIds:['customer'+n]}));
    state.repairItems=make('repair',n=>({code:'R'+n,receivedOn:date(n),itemId:'item'+n,customerId:'customer'+n,supplierId:'supplier'+n,quantity:n,issueDescription:'故障'+n,status:n%2?'received':'supplier_returned'}));
    state.siteData.logs=make('log',n=>({projectId:'project'+n,log_date:date(n),work_type:n%2?'維修紀錄':'工程施工',status:n%2?'completed':'in_progress',workerIds:['worker'+n],summary:'日誌'+n}));
    state.dashboard={...state.dashboard,repairs:numbers.map(n=>({received_on:date(n),repair_no:'R'+n,customer:'客戶'+n,item:'品項'+n,issue_description:'故障'+n,status:n%2?'received':'supplier_returned'})),worklogs:numbers.map(n=>({log_date:date(n),customer:'客戶'+n,project:'工作'+n,workers:'人員'+n,summary:'日誌'+n}))};
    for(const control of Object.values(tableState))control.perPage=100;
    renderTransactions();renderRepairs();renderInventory();renderMasterData();renderWorkLogs();renderUsers();
    renderProductCategories();renderCustomerCategories();renderCustomerDepartments();renderContractServiceCatalog();renderConstructionProjects();renderDashboard();
  });
  const headers=id=>page.locator('#'+id).locator('..').locator('thead .table-sort-button');
  // Compare rendered business values independently of the table-state adapter.
  const values=async(id,index)=>page.locator('#'+id+' tr').evaluateAll((rows,{id,index})=>rows.filter(r=>r.cells.length>1).map(row=>{
    const cell=row.cells[index],text=cell.innerText.trim();
    if(cell.dataset.sortType==='number')return Number(cell.dataset.sortValue);
    if((id==='pickupTable'||id==='receiptTable')&&index===4-(id==='receiptTable'?1:0))return Number(text.split(' ')[0]);
    if(id==='inventoryTable'&&index===5)return Number(text);
    if(id==='pickupTable'&&index===2)return cell.querySelector('small').innerText;
    if(id==='repairTable'&&[0,2,3].includes(index))return cell.querySelector('strong').innerText.split('｜').at(-1);
    if(id==='repairTable'&&index===5)return cell.childNodes[0].textContent;
    if(id==='customerTable'&&index===3)return [...cell.querySelectorAll('.tag-list span')].map(s=>s.textContent).join('、');
    if(id==='worklogTable'&&index===1)return cell.querySelector('strong').innerText;
    return text.replace(/\s+/g,' ');
  }),{id,index});
  const compare=(a,b,direction)=>{
    const empty=v=>v===''||v==='—';
    if(empty(a)||empty(b))return empty(a)===empty(b)?0:empty(a)?1:-1;
    const result=typeof a==='number'&&typeof b==='number'?a-b:String(a).localeCompare(String(b),'zh-Hant',{numeric:true});
    return direction==='asc'?result:-result;
  };
  let columns=0,tables=0;
  const verify=async id=>{
    assert.ok(await page.locator('#'+id+' tr').count()>1,id+' has multiple rows');
    const buttons=headers(id),count=await buttons.count();assert.ok(count>0,id+' sortable headings');
    for(let i=0;i<count;i++){
      for(const direction of ['asc','desc']){
        await buttons.nth(i).click();
        assert.equal(await buttons.nth(i).locator('..').getAttribute('aria-sort'),direction==='asc'?'ascending':'descending',id);
        const actual=await values(id,i),expected=[...actual].sort((a,b)=>compare(a,b,direction));
        assert.deepEqual(actual,expected,id+' column '+i+' '+direction);
      }
      columns++;
    }
    tables++;console.log('PASS headers:',id,count);
  };
  const cases=[
    ['transactions',[],'pickupTable'],['transactions',['#transactions [data-tab="receipts"]'],'receiptTable'],
    ['repairs',[],'repairTable'],['inventory',[],'inventoryTable'],
    ['inventory',['#inventory [data-tab="categories"]'],'productCategoryTable'],
    ['crm',[],'customerTable'],['crm',['#customerCategoriesTab'],'customerCategoryTable'],
    ['crm',['#customerDepartmentsTab'],'customerDepartmentTable'],
    ['crm',['#contractServicesTab'],'contractServiceTable'],
    ['crm',['#crm [data-tab="projects"]'],'projectTable'],
    ['crm',['#crm [data-tab="projects"]','#constructionTab'],'constructionProjectTable'],
    ['crm',['#crm [data-tab="suppliers"]'],'supplierTable'],
    ['worklogs',[],'worklogTable'],['settings',['#settings [data-tab="users"]'],'userTable'],
    ['dashboard',[],'dashboardWorklogTable'],['dashboard',[],'dashboardRepairTable']
  ];
  for(const [route,clicks,id] of cases){
    await load(route,clicks);await seed();
    if(id==='customerDepartmentTable'){
      const panel=page.locator('.search-panel').filter({has:page.locator('#departmentCustomerCategory')});
      await panel.locator('.search-panel-trigger').click();
      await page.locator('#departmentCustomerCategory').selectOption('school');await page.locator('#departmentCustomer').selectOption('customer1');
      await panel.getByRole('button',{name:'搜尋',exact:true}).click();
    }
    await verify(id);
    assert.equal(await page.locator('select[id$="Sort"]').count(),0);
  }
  // Report sections are rendered from complete synthetic aggregates, with real report renderers.
  await load('materials');
  await page.evaluate(()=>{
    const ns=[10,2,1,1000],date=n=>'2026-09-'+String(n===1000?20:n).padStart(2,'0');
    const report={kpis:{materialTypeCount:4,materialRecordCount:4,constructionDays:4,workerCount:4,workerDays:4},totalsByUnit:[],
      materialStats:ns.map(n=>({name:'材料'+n,brand:'品牌'+n,model:'型號'+n,quantity:n,unit:'台',recordCount:n,firstDate:date(n),recentDate:date(n)})),
      materialRows:ns.map(n=>({date:date(n),item:{name:'品項'+n,brand:'品牌'+n,model:'型號'+n,unit:'台'},quantity:n,account:'人員'+n})),
      workerStats:ns.map(n=>({name:'人員'+n,displayName:'人員'+n,userId:'user'+n,constructionDays:n,recordCount:n,firstDate:date(n),recentDate:date(n),active:n%2===0})),
      dailyRows:ns.map(n=>({id:'log'+n,date:date(n),timePeriod:'上午',workerNames:['人員'+n],dailyHeadcount:n,summary:'日誌'+n,status:n%2?'completed':'in_progress'}))};
    document.querySelector('#materialSummary').innerHTML=renderProjectMaterials(report)+renderProjectWorkers({},report);
  });
  for(const id of ['materialStatsTable','materialRowsTable','workerStatsTable','dailyRowsTable'])await verify(id);
  // Sorting survives a renderer replacing local table rows, including an empty search.
  await load('inventory',['#inventory [data-tab="categories"]']);await seed();
  await headers('productCategoryTable').nth(1).click();await headers('productCategoryTable').nth(1).click();
  const categoryPanel=page.locator('.search-panel').filter({has:page.locator('#productCategorySearch')});
  await categoryPanel.locator('.search-panel-trigger').click();await page.locator('#productCategorySearch').fill('no-match');
  assert.equal(await page.locator('#productCategoryTable tr td').count(),1);
  await categoryPanel.getByRole('button',{name:'重設',exact:true}).click();await page.keyboard.press('Escape');
  assert.equal(await headers('productCategoryTable').nth(1).locator('..').getAttribute('aria-sort'),'descending');
  assert.equal((await values('productCategoryTable',1))[0],'T12');
  // Numeric sorting spans every result, then pagination. Changing direction returns to page 1.
  await load('inventory');await seed();
  await page.locator('[data-page-size="inventory"]').selectOption('10');
  const quantity=page.locator('th[data-table-sort="inventory"][data-key="quantity"] button');
  await quantity.click();assert.deepEqual(await values('inventoryTable',5),[1,2,3,4,5,6,7,8,9,10]);
  await page.locator('[data-page-move="inventory"][data-to="next"]').click();assert.deepEqual(await values('inventoryTable',5),[11,12]);
  await quantity.click();assert.deepEqual(await values('inventoryTable',5),[12,11,10,9,8,7,6,5,4,3]);
  const panel=page.locator('.search-panel').filter({has:page.locator('#inventorySearch')});
  await panel.locator('.search-panel-trigger').click();await page.locator('#inventorySearch').fill('品項12');
  assert.deepEqual(await values('inventoryTable',5),[12]);
  await panel.getByRole('button',{name:'重設',exact:true}).click();await page.keyboard.press('Escape');
  assert.deepEqual(await values('inventoryTable',5),[12,11,10,9,8,7,6,5,4,3]);
  assert.equal(await quantity.locator('..').getAttribute('aria-sort'),'descending');
  // Native buttons retain keyboard and mobile operation, with a visible current direction.
  await quantity.focus();await page.keyboard.press('Enter');assert.equal(await quantity.locator('..').getAttribute('aria-sort'),'ascending');
  await page.keyboard.press('Space');assert.equal(await quantity.locator('..').getAttribute('aria-sort'),'descending');
  await page.screenshot({path:fileURLToPath(new URL('desktop-headers.png',out)),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=0);
  await quantity.click();assert.equal(await quantity.locator('..').getAttribute('aria-sort'),'ascending');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.screenshot({path:fileURLToPath(new URL('mobile-headers.png',out)),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  // Audit uses server ordering, not a DOM reorder of the current 25 records.
  await load('settings',['#settings [data-tab="logs"]']);
  await page.locator('#logTable tr[data-audit-row]').first().waitFor();
  const time=page.locator('th[data-table-sort="audit"] button');
  const auditIds=()=>page.locator('#logTable tr[data-audit-row]').evaluateAll(rows=>rows.map(r=>Number(r.dataset.auditRow)));
  assert.equal((await auditIds())[0],52);
  await time.click();await page.waitForFunction(()=>document.querySelector('#logTable tr')?.dataset.auditRow==='1');
  assert.deepEqual(await auditIds(),Array.from({length:25},(_,i)=>i+1));
  await page.locator('[data-audit-page="next"]').click();await page.waitForFunction(()=>document.querySelector('#logTable tr')?.dataset.auditRow==='26');
  assert.equal((await auditIds()).at(-1),50);
  await time.click();await page.waitForFunction(()=>document.querySelector('#logTable tr')?.dataset.auditRow==='52');
  assert.equal(await time.locator('..').getAttribute('aria-sort'),'descending');
  const traffic=await(await context.request.get(base+'/__search_test')).json();
  assert.ok(traffic.queries.some(q=>q.sort_direction==='asc'&&q.page==='2'));assert.equal(traffic.queries.at(-1).page,'1');
  assert.deepEqual(traffic.mutations,[]);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('PASS',tables+1,'tables,',columns+1,'sortable columns; pagination, search/reset retention, rerender, empty results, keyboard/mobile, server audit ordering. No writes or external calls.');
}finally{await browser.close();}
