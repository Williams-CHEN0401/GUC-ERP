import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const app=read('app.js'),html=read('index.html'),permissions=read('permissions-ui.js');
const sourceBetween=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end));
const element=(page,active=false,group=false)=>{
  const classes=new Set(active?['active']:[]),attributes=new Map(group?[['data-work-group','']]:[]);
  return {dataset:{page},hidden:false,textContent:'',href:'',classList:{contains:name=>classes.has(name),toggle(name,on){if(on)classes.add(name);else classes.delete(name);},remove:name=>classes.delete(name)},
    hasAttribute:name=>attributes.has(name),setAttribute:(name,value)=>attributes.set(name,value),removeAttribute:name=>attributes.delete(name),getAttribute:name=>attributes.get(name)};
};
function harness(modules=null){
  const pages=['dashboard','crm','projects','worklogs','materials','settings'].map(name=>element(name,name==='dashboard'));
  const links=[element('dashboard',true),element('crm'),element('worklogs',false,true)];
  const children=['worklogs','projects','materials'].map(name=>element(name));
  const tabs={hidden:true,querySelectorAll:()=>children},title=element(),subtitle=element(),sidebar=element();
  const loads=[];
  const location={href:'http://localhost/?page=dashboard',search:'?page=dashboard'};
  const context=vm.createContext({URL,URLSearchParams,location,loads,
    state:{currentUser:modules===null?{role:'admin'}:{role:'custom',permissions:modules.map(module=>({module,can_view:true}))}},
    document:{title:'',querySelector:selector=>selector==='.page.active'?pages.find(page=>page.classList.contains('active')):({'#workManagementTabs':tabs,'#pageTitle':title,'#pageSubtitle':subtitle,'#sidebar':sidebar})[selector],
      querySelectorAll:selector=>selector==='.page'?pages:selector==='.nav-item'?links:selector==='.nav-item[data-page], [data-work-tab]'?[...links,...children]:[]},
    history:{replaceState(_state,_title,url){location.href='http://localhost'+url;location.search=new URL(location.href).search;}},
    window:{scrollTo(){}},accessToken:'synthetic-only',loadScope:async(scope,options)=>loads.push({scope,...options}),applyWorkContentReportLink(){},loadAuditPage(){},checkNasConnection(){}});
  vm.runInContext(permissions.slice(0,permissions.indexOf('function applyPermissionUI(')),context);
  vm.runInContext(app.match(/^const PAGE_SCOPES = .*$/m)[0]+app.match(/^const WORK_MANAGEMENT_PAGES = .*$/m)[0],context);
  vm.runInContext(sourceBetween(app,'const pageMeta =','const siteModules ='),context);
  vm.runInContext(sourceBetween(app,'function currentPage()','function setLoadState('),context);
  vm.runInContext(sourceBetween(app,'async function loadPageData(','async function checkNasConnection('),context);
  vm.runInContext(sourceBetween(app,'async function switchPage(','function setupTabs('),context);
  return {context,pages,links,children,tabs,title,loads,location};
}

test('one sidebar work group has three link-based children and no duplicated project content',()=>{
  const nav=html.match(/<nav class="nav"[\s\S]*?<\/nav>/)[0];
  assert.equal((nav.match(/data-work-group/g)||[]).length,1);
  assert.match(nav,/<span>工作管理<\/span>/);
  assert.doesNotMatch(nav,/>工作日誌<|>工作內容統計報表</);
  const tabs=html.match(/<nav id="workManagementTabs"[\s\S]*?<\/nav>/)[0];
  assert.equal((tabs.match(/data-work-tab/g)||[]).length,3);
  for(const page of ['worklogs','projects','materials'])assert.match(tabs,new RegExp(`data-page="${page}" href="/\\?page=${page}" aria-controls="${page}"`));
  const crm=html.match(/<section class="page" id="crm"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(crm,/projectTable|data-tab="projects"/);
  assert.match(crm,/data-tab="customers"/);assert.match(crm,/data-tab="suppliers"/);
  assert.equal((html.match(/id="projectTable"/g)||[]).length,1);
  assert.match(html,/data-goto="projects"/);
});

test('all three children activate the parent and load only their existing scope',async()=>{
  const h=harness();
  for(const [page,scope] of [['worklogs','worklogs'],['projects','crm'],['materials','materials']]){
    h.loads.length=0;await h.context.switchPage(page);
    assert.equal(h.tabs.hidden,false);assert.equal(h.title.textContent,'工作管理');
    assert.equal(h.pages.filter(p=>p.classList.contains('active')).length,1);
    assert.equal(h.context.currentPage(),page);
    assert.equal(h.children.find(p=>p.classList.contains('active')).dataset.page,page);
    assert.equal(h.links[2].getAttribute('aria-current'),'page');
    assert.equal(h.links[2].href,'/?page='+page);
    assert.equal(h.loads.length,1);assert.equal(h.loads[0].scope,scope);
    assert.equal(h.context.requestedPageFromUrl(),page);
  }
  await h.context.switchPage('crm');assert.equal(h.tabs.hidden,true);
  assert.equal(h.links[2].getAttribute('aria-current'),undefined);
});

test('existing worklog/report links and CRM project alias land on the corresponding child',()=>{
  const h=harness();
  for(const [query,expected] of [['?page=worklogs','worklogs'],['?page=materials','materials'],['?page=projects','projects'],['?page=crm&tab=projects','projects'],['?page=crm','crm'],['?page=invalid','']]){
    h.location.href='http://localhost/'+query;h.location.search=query;
    assert.equal(h.context.requestedPageFromUrl(),expected);
  }
  h.location.href='http://localhost/?page=crm&tab=projects';
  assert.equal(h.context.pageUrl('crm'),'/?page=crm');
});

test('group navigation does not grant permissions and falls back to the first allowed child',async()=>{
  for(const [module,page]of [['worklogs','worklogs'],['projects','projects'],['reports','materials']]){
    const h=harness([module]);
    assert.equal(h.context.workManagementPage(),page);
    await h.context.switchPage('worklogs');assert.equal(h.context.currentPage(),page);
    assert.deepEqual(h.children.filter(link=>!link.hidden).map(link=>link.dataset.page),[page]);
    assert.equal(h.context.canModule(module,'UPDATE'),false);
    assert.equal(h.context.canPage('crm'),false);
    assert.equal(h.loads.length,1);
  }
  const h=harness(['customers']);await h.context.switchPage('projects');
  assert.equal(h.context.currentPage(),'crm');assert.equal(h.tabs.hidden,true);
  assert.equal(h.context.workManagementPage(),'worklogs');
  assert.match(permissions,/data-work-group'\)\?!WORK_MANAGEMENT_PAGES\.some\(canPage\)/);
});

test('work tabs reuse CRM tab styles and can wrap on narrow screens',()=>{
  const css=read('interface-theme.css');
  assert.match(html,/id="workManagementTabs" class="section-tabs work-management-tabs"/);
  for(const source of [read('styles.css'),css]){
    assert.match(source,/\.section-tabs :is\(button, a\)\s*\{/);
    assert.match(source,/\.section-tabs :is\(button, a\)\.active\s*\{/);
  }
  assert.match(css,/\.work-management-tabs\{[^}]*flex-wrap:wrap/);
  assert.doesNotMatch(css,/\.work-management-tabs a\.active\{/);
  assert.match(css,/\.work-management-tabs\[hidden\],\.work-management-tabs a\[hidden\]\{display:none\}/);
});

test('moved work-content page retains its existing reference refresh scope',async()=>{
  const h=harness();
  vm.runInContext(sourceBetween(read('form-reference-sync.js'),'function formReferenceScopes()','function formReferencesBusy()'),h.context);
  for(const [page,scope]of [['projects','crm'],['worklogs','worklogs'],['materials','materials']]){
    await h.context.switchPage(page);
    assert.deepEqual(Array.from(h.context.formReferenceScopes()),[scope]);
  }
});
