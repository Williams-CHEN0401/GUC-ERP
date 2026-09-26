import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const source=read('table-sorting.js'),app=read('app.js'),html=read('index.html');
const context=vm.createContext({});vm.runInContext(source,context);
const {compareValues,cellValue,localTables}=context.GucTableSorting;
test('header sorting uses natural text/numbers, real numbers, chronological ISO dates and empty-last order',()=>{
  assert.ok(compareValues('項目2','項目10','asc')<0);
  assert.ok(compareValues('項目2','項目10','desc')>0);
  assert.ok(compareValues(99,1000,'asc')<0);
  assert.ok(compareValues(1.2,1.11,'asc')>0);
  assert.ok(compareValues('2026-01-10','2026-09-01','asc')<0);
  assert.equal(compareValues('一樣','一樣','asc'),0);
  for(const direction of ['asc','desc'])assert.equal(compareValues('',12,direction),1);
});
test('report quantities use raw numeric values, not formatted comma/unit text',()=>{
  assert.equal(cellValue({dataset:{sortType:'number',sortValue:'1000'},textContent:'1,000 台'}),1000);
  assert.equal(cellValue({dataset:{},textContent:'  機型  12  '}),'機型 12');
  assert.equal(cellValue({dataset:{sortType:'number',sortValue:'invalid'}}),'');
});
test('ERP sorting dropdowns and their boot handlers are removed without removing search filters',()=>{
  assert.doesNotMatch(html+app+read('search-panels.js'),/pickupSort|receiptSort|repairSort|inventorySort|customerSort|projectSort|supplierSort|userSort|function setSort\(/);
  for(const id of ['pickupSearch','repairStatusFilter','categoryFilter','worklogCustomerFilter','auditFilters'])assert.ok(html.includes('id="'+id+'"'));
  assert.match(html,/\/table-sorting.js/);assert.match(html,/\/table-sorting.css/);
  assert.ok(html.indexOf('/table-sorting.css')<html.indexOf('</head>'));
  assert.ok(html.indexOf('/table-sorting.js')>html.indexOf('/search-panels.js'));
  assert.ok(html.indexOf('/table-sorting.js')<html.indexOf('</body>'));
  assert.ok(html.trimEnd().endsWith('</html>'));
});
test('all paginated data columns have header controls, excluding actions and compound audit summaries',()=>{
  for(const name of ['pickup','receipt','repair','inventory','customer','project','supplier','user','worklog']){
    const end=html.indexOf('<tbody id="'+name+'Table">'),start=html.lastIndexOf('<thead>',end);
    const headers=html.slice(start,end).match(/<th(?: [^>]*)?>.*?<\/th>/g);
    assert.equal(headers.at(-1),'<th>操作</th>');
    for(const header of headers.slice(0,-1))assert.match(header,/data-table-sort=/,name);
  }
  assert.equal(Object.keys(localTables).length,11);
  assert.match(html,/data-table-sort="audit" data-key="created_at"/);
  assert.doesNotMatch(source,/fetch\(|localStorage|sessionStorage|apiRequest/);
});
test('date/status keys match displayed values, and source sorting precedes pagination',()=>{
  assert.match(html,/data-table-sort="customer" data-key="updatedRaw"/);
  assert.match(html,/data-table-sort="repair" data-key="statusText"/);
  assert.match(html,/data-table-sort="worklog" data-key="workerLabels"/);
  assert.match(html,/data-table-sort="worklog" data-key="pickupSummary"/);
  assert.match(app,/tablePage\("pickup",sortRows\(pickupRows/);
  assert.match(app,/tablePage\("receipt",sortRows\(receiptRows/);
  assert.match(app,/tablePage\("worklog",sortRows\(rows/);
  assert.match(app,/control.sortKey = key; control.page = 1; rerenderTable\(name\)/);
  assert.match(app,/auditPage.page = 1; return loadAuditPage\(\)/);
});
