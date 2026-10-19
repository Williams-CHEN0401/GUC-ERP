import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const context=vm.createContext({Intl,Date});
vm.runInContext(readFileSync(new URL('../work-content-report.js',import.meta.url),'utf8'),context);
const render=context.GUCWorkContentReport.render;
function report(){return {project:{name:'工程 <img src=x onerror=alert(1)>',code:'T1',createdAt:'2026-09-01T16:30:00Z'},kpis:{},materialStats:[],materialRows:[],workerStats:[],dailyRows:[],constructionPlans:[{id:'p1',project_id:'work1',content:'未開始',status:'pending',planned_days:7,completed_days:0,remaining_days:7,progress_percent:0,items:[],logs:[],assignees:[]}],constructionSummary:{planCount:1,plannedDays:7,completedDays:0,remainingDays:7,projectDays:0,overdueItemCount:0}};}
test('shared dashboard retains zero-log plans and escapes API text',()=>{
 const html=render({report:report()});assert.match(html,/data-report-plan="p1"/);assert.match(html,/0 \/ 7 天/);assert.doesNotMatch(html,/<img|onerror="/);assert.match(html,/&lt;img/);assert.match(html,/2026-09-02/);
});
test('dashboard displays server completion percentage and excess days without client recomputation',()=>{
 const r=report();Object.assign(r.constructionPlans[0],{completed_days:9,planned_days:7,progress_percent:128.6,remaining_days:0,overrun_days:2});
 const html=render({report:r});assert.match(html,/128.6%/);assert.match(html,/超出預計施工天數 2 天/);assert.match(html,/value="100"/);
});
test('unknown planned duration never renders NaN or infinity',()=>{
 const r=report();r.constructionPlans[0].planned_days=null;r.constructionSummary.plannedDays=0;
 const html=render({report:r});assert.match(html,/未設定/);assert.doesNotMatch(html,/NaN|Infinity/);
});
test('Accounting preserves cents; price edit controls follow existing permissions',()=>{
 const r=report();r.materialStats=[{id:'item',name:'材料',quantity:2,unit:'台',unit_price:12.34,amount:24.68,price_source:'manual'}];
 const erp=render({report:r});assert.doesNotMatch(erp,/單價（元）|data-gr-edit-price|12.34/);
 const readonly=render({report:r,accounting:true,pricePermissions:{view:true}});assert.match(readonly,/12.34/);assert.doesNotMatch(readonly,/data-gr-edit-price|data-gr-clear-price/);
 const writer=render({report:r,accounting:true,pricePermissions:{view:true,update:true,delete:true}});assert.match(writer,/data-gr-edit-price="item"/);assert.match(writer,/data-gr-clear-price="item"/);
});
test('report geometry remains usable under production CSP without inline styles',()=>{
 const r=report();r.workerStats=[{name:'阿祥',constructionDays:9},{name:'阿勝',constructionDays:6}];
 const html=render({report:r});
 assert.doesNotMatch(html,/\sstyle=/);
 const bars=[...html.matchAll(/class="gr-column-bar"[^>]+height="([\d.]+)"/g)].map(m=>Number(m[1]));
 assert.equal(bars.length,2);assert(bars[0]>0);assert(Math.abs(bars[1]/bars[0]-2/3)<.0001);
 assert.match(html,/class="gr-gauge"/);assert.match(html,/class="gr-gantt-bar"/);
});
function materialReport(){
 const r=report();
 r.project.id='work1';
 r.materialCategoryStats=[
  {id:'supplies',name:'耗材',recordCount:2,totalsByUnit:[{unit:'包',total:4}],amount:48.13,unpricedItemCount:0},
  {id:'cable',name:'線材',recordCount:2,totalsByUnit:[{unit:'米',total:150},{unit:'捲',total:2}],amount:12345.66,unpricedItemCount:0},
  {id:null,name:'未分類',recordCount:1,totalsByUnit:[{unit:'米',total:5}],amount:null,unpricedItemCount:1}
 ];
 r.materialStats=[
  {id:'white-tie',name:'CV-180束帶(白色)',categoryId:'supplies',categoryName:'耗材',quantity:3,unit:'包',unit_price:12.34,amount:37.02,price_source:'manual',recordCount:1},
  {id:'black-tie',name:'CV-180束帶(黑)',categoryId:'supplies',categoryName:'耗材',quantity:1,unit:'包',unit_price:11.11,amount:11.11,price_source:'receipt',recordCount:1},
  {id:'wire',name:'網路線',categoryId:'cable',categoryName:'線材',quantity:150,unit:'米',unit_price:80,amount:12000,recordCount:1},
  {id:'roll',name:'預製線捲',categoryId:'cable',categoryName:'線材',quantity:2,unit:'捲',unit_price:172.83,amount:345.66,recordCount:1},
  {id:'uncategorized',name:'其他材料',categoryId:null,categoryName:'未分類',quantity:5,unit:'米',unit_price:null,amount:null,recordCount:1}
 ];
 r.materialRows=r.materialStats.map(row=>({categoryId:row.categoryId,item:{name:row.name,unit:row.unit},quantity:row.quantity,date:'2026-10-13'}));
 return r;
}
function itemColumns(html){
 return [...html.matchAll(/<g\b([^>]*)>([\s\S]*?)<\/g>/g)].flatMap(([,attributes,body])=>{
  const id=attributes.match(/\bdata-gr-item-id="([^"]*)"/)?.[1];
  const rawValue=attributes.match(/\bdata-chart-value="([^"]*)"/)?.[1];
  return id==null?[]:[{id,value:Number(rawValue),rawValue,body}];
 });
}
function categoryGroups(html){return [...html.matchAll(/\bdata-gr-material-category-group="([^"]*)"/g)].map(m=>m[1]);}
test('material quantity chart keeps white and black CV-180 ties as independent item columns',()=>{
 const r=materialReport(),html=render({report:r,tab:'materials'}),bars=itemColumns(html);
 assert.deepEqual(bars.map(({id,value})=>[id,value]),[['white-tie',3],['black-tie',1],['wire',150],['roll',2],['uncategorized',5]]);
 assert.match(bars[0].body,/CV-180束帶\(白色\).*3 包/);assert.match(bars[1].body,/CV-180束帶\(黑\).*1 包/);
 assert.deepEqual(categoryGroups(html),['supplies','cable','cable','__uncategorized']);
 assert.doesNotMatch(html,/4 包|12,345.66|單價（元）/);
 assert.doesNotMatch(html,/\sstyle=/);
 const heights=bars.slice(0,2).map(bar=>Number(bar.body.match(/class="gr-column-bar"[^>]*height="([\d.]+)"/)?.[1]));
 assert(heights[0]>0);assert(Math.abs(heights[1]/heights[0]-1/3)<.0001);
});
test('material categories with mixed units keep separate quantity axes and never create a summed unit',()=>{
 const html=render({report:materialReport(),tab:'materials'});
 const cards=[...html.matchAll(/<section class="gr-material-category"[\s\S]*?<\/section><\/section>/g)].map(m=>m[0]);
 assert.equal(cards.length,4,'Each category/unit plot occupies its own grid card');
 assert(cards.every(card=>(card.match(/class="gr-material-unit"/g)||[]).length===1));
 assert.deepEqual(cards.map(card=>card.match(/data-gr-unit="([^"]+)"/)[1]),['包','米','捲','米']);
 assert.match(html,/data-gr-unit="米"/);assert.match(html,/data-gr-unit="捲"/);assert.doesNotMatch(html,/data-gr-unit="捲" hidden/);
 const charts=[...html.matchAll(/<svg\b[^>]*class="gr-columns"[^>]*>[\s\S]*?<\/svg>/g)].map(m=>m[0]);
 const wireChart=charts.find(chart=>chart.includes('data-gr-item-id="wire"'));
 const rollChart=charts.find(chart=>chart.includes('data-gr-item-id="roll"'));
 assert(wireChart);assert(rollChart);assert.notEqual(wireChart,rollChart);
 assert.match(wireChart,/150 米/);assert.doesNotMatch(wireChart,/data-gr-item-id="roll"/);
 assert.match(rollChart,/2 捲/);assert.doesNotMatch(rollChart,/data-gr-item-id="wire"/);
 assert.doesNotMatch(html,/data-chart-value="(?:152|157)"|152 米|152 捲/);
});
test('accounting 12pt column charts reserve axis and multi-line label space without changing ERP geometry',()=>{
 const r=materialReport();r.materialStats[0].name='測試使用三行顯示的材料品項名稱與品牌';r.materialStats[0].quantity=12345.67;
 const erp=render({report:r,tab:'materials'}),accounting=render({report:r,tab:'materials',accounting:true});
 const firstSvg=html=>html.match(/<svg\b[^>]*class="gr-columns"[\s\S]*?<\/svg>/)[0];
 const a=firstSvg(accounting),e=firstSvg(erp),width=svg=>Number(svg.match(/viewBox="0 0 ([\d.]+) 258"/)[1]);
 assert.match(e,/class="gr-baseline" x1="42" y1="184"/);assert.match(e,/dy="15"/);
 assert.match(a,/class="gr-baseline" x1="[\d.]+" y1="170"/);assert.match(a,/dy="25"/);assert(width(a)>width(e));
 assert(Number(a.match(/class="gr-baseline" x1="([\d.]+)"/)[1])>42);
 assert.deepEqual(itemColumns(accounting).map(({id,value})=>[id,value]),itemColumns(erp).map(({id,value})=>[id,value]));
});
test('category and item identities remain distinct when their display names are identical',()=>{
 const r=materialReport();
 r.materialCategoryStats[1].name='耗材';
 r.materialStats[1].name=r.materialStats[0].name;
 r.materialStats[2].categoryName='耗材';r.materialStats[3].categoryName='耗材';
 const html=render({report:r,tab:'materials'});
 assert.deepEqual(categoryGroups(html),['supplies','cable','cable','__uncategorized']);
 assert.deepEqual(itemColumns(html).map(({id,value})=>[id,value]),[['white-tie',3],['black-tie',1],['wire',150],['roll',2],['uncategorized',5]]);
});
test('accounting item amounts and unpriced states follow price-view permission without using category totals',()=>{
 const r=materialReport();
 const hidden=render({report:r,tab:'materials',accounting:true,pricePermissions:{view:false,update:true,delete:true}});
 assert.deepEqual(itemColumns(hidden).slice(0,2).map(({value})=>value),[3,1]);
 assert.doesNotMatch(hidden,/37\.02|11\.11|12,345\.66|單價（元）|data-gr-edit-price|data-gr-clear-price/);
 const visible=render({report:r,tab:'materials',accounting:true,pricePermissions:{view:true}}),bars=itemColumns(visible);
 assert.deepEqual(categoryGroups(visible),['supplies','cable','__uncategorized'],'Price mode keeps one card per category regardless of quantity units');
 assert.equal(bars.length,r.materialStats.length,'Price mode must not duplicate items across quantity units');
 assert.deepEqual(bars.slice(0,4).map(({id,value})=>[id,value]),[['white-tie',37.02],['black-tie',11.11],['wire',12000],['roll',345.66]]);
 assert.match(bars[0].body,/\$37.02/);assert.match(bars[1].body,/\$11.11/);
 const missing=bars.find(bar=>bar.id==='uncategorized');
 assert.equal(missing.rawValue,'');assert.match(missing.body,/未定價/);assert.doesNotMatch(missing.body,/\$0(?:[^\d]|$)/);
 assert.doesNotMatch(visible,/\$12,345.66|data-gr-edit-price|data-gr-clear-price/);
 assert.match(visible,/1 個品項未設定價格/);
 const overview=render({report:r,accounting:true,pricePermissions:{view:true}});
 assert.match(overview,/未分類 · 未定價/);assert.doesNotMatch(overview,/未分類 · 0 元/);
 const zero=materialReport();zero.materialStats[0].amount=0;zero.materialStats[0].unit_price=0;
 const zeroBar=itemColumns(render({report:zero,tab:'materials',accounting:true,pricePermissions:{view:true}}))[0];
 assert.equal(zeroBar.rawValue,'0');assert.match(zeroBar.body,/\$0(?:[^\d]|$)/);assert.doesNotMatch(zeroBar.body,/未定價/);
});
test('category labels and unknown category data never create fake item groupings',()=>{
 const r=report();r.materialStats=[{id:'i',name:'攝影機',quantity:2,unit:'台'}];
 assert.match(render({report:r,tab:'materials'}),/材料分類統計尚未載入/);
 r.materialStats[0].categoryId='cat';r.materialStats[0].name='<script>alert(1)</script>';
 r.materialCategoryStats=[{id:'cat',name:'<img src=x onerror=alert(1)>',totalsByUnit:[{unit:'台',total:2}]}];
 const html=render({report:r,tab:'materials'});assert.doesNotMatch(html,/<img|<script/);assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);
});
test('category changes filter item charts, summary, detail and distribution without replacing plan state',()=>{
 const listeners={},regions=Object.fromEntries(['chart','table','rows','donut'].map(name=>['[data-gr-category-'+name+']',{innerHTML:''}]));
 const host={querySelectorAll(selector){return regions[selector]?[regions[selector]]:[];},set innerHTML(_){assert.fail('Category filtering must not replace the report and discard expanded plans');}};
 const document={addEventListener(name,fn){listeners[name]=fn;}};
 const isolated=vm.createContext({Intl,Date,document});vm.runInContext(readFileSync(new URL('../work-content-report.js',import.meta.url),'utf8'),isolated);
 const renderer=isolated.GUCWorkContentReport.render,r=materialReport();
 renderer({report:r});
 const select={value:'supplies',closest(){return host;}};
 const change=()=>listeners.change({target:{closest(){return select;}}});
 change();
 assert.deepEqual(itemColumns(regions['[data-gr-category-chart]'].innerHTML).map(({id,value})=>[id,value]),[['white-tie',3],['black-tie',1]]);
 for(const name of ['table','rows']){
  assert.match(regions['[data-gr-category-'+name+']'].innerHTML,/CV-180束帶/);
  assert.doesNotMatch(regions['[data-gr-category-'+name+']'].innerHTML,/網路線|預製線捲|其他材料/);
 }
 assert.match(regions['[data-gr-category-donut]'].innerHTML,/耗材/);assert.doesNotMatch(regions['[data-gr-category-donut]'].innerHTML,/線材|未分類/);
 select.value='__uncategorized';change();
 assert.deepEqual(itemColumns(regions['[data-gr-category-chart]'].innerHTML).map(({id})=>id),['uncategorized']);
 select.value='';change();
 assert.equal(itemColumns(regions['[data-gr-category-chart]'].innerHTML).length,5);
 select.value='supplies';change();
 r.project.id='another-work';
 assert.equal(itemColumns(renderer({report:r})).length,5,'Changing work contents clears the previous category filter');
});
test('overview keeps the project heading and five KPIs before the requested five report rows',()=>{
 const html=render({report:materialReport()}),dashboard=html.indexOf('<div class="gr-dashboard">');
 assert(dashboard>0);assert(html.indexOf('class="gr-heading"')<dashboard);
 assert.equal([...html.slice(0,dashboard).matchAll(/class="gr-kpi(?: gr-alert)?"/g)].length,5);
 const titles=['施工項目排程','施工規劃明細','人員施工統計','專案進度','用料統計','材料種類領用占比','材料品項彙總'];
 const offsets=titles.map(title=>html.indexOf('<h2>'+title+'</h2>',dashboard));
 assert(offsets.every(position=>position>dashboard));
 assert(offsets.every((position,i)=>i===0||position>offsets[i-1]),'Report cards follow schedule, details, personnel/progress, material/distribution, summary order');
 assert.match(html,/<details class="gr-plan" data-gr-schedule="p1">/);assert.match(html,/<details class="gr-plan" data-report-plan="p1">/);
});
