import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../search-panels.js',import.meta.url),'utf8');
const context=vm.createContext({});vm.runInContext(source,context);
const {defaultValue,describeFilters,resetFields}=context.GucSearchPanels;
const select=(value,options,disabled=false)=>({tagName:'SELECT',value,options,disabled,selectedOptions:options.filter(o=>o.value===value)});
test('search panels preserve explicit select defaults, including construction all vs empty',()=>{
  assert.equal(defaultValue(select('all',[{value:'all'},{value:''}])),'all');
  assert.equal(defaultValue(select('b',[{value:'a'},{value:'b',defaultSelected:true}])),'b');
  assert.equal(defaultValue({tagName:'INPUT',defaultValue:''}),'');
});
test('summary shows actual conditions and skips disabled descendants or empty text',()=>{
  const fields=[
    {label:'關鍵字',initial:'',control:{tagName:'INPUT',value:'  測試  '}},
    {label:'類型',initial:'all',control:select('',[{value:'',textContent:'未分類'}])},
    {label:'客戶',initial:'',control:select('old',[{value:'old',textContent:'舊客戶'}],true)},
    {label:'空白',initial:'',control:{tagName:'INPUT',value:'  '}},
    {label:'預設排序',initial:'date:desc',control:select('date:desc',[])}
  ];
  assert.deepEqual(Array.from(describeFilters(fields)),['關鍵字：測試','類型：未分類']);
});
test('reset dispatches original events in dependency order and does not change disabled state',()=>{
  const events=[];
  const make=(name,control)=>Object.assign(control,{ownerDocument:{defaultView:{Event:class{constructor(type,init){this.type=type;Object.assign(this,init);}}}},dispatchEvent(e){events.push([name,e.type,e.bubbles,this.value]);}});
  const category=make('category',select('school',[{value:''},{value:'school'}]));
  const customer=make('customer',select('a',[{value:''},{value:'a'}],true));
  resetFields([{control:category,initial:''},{control:customer,initial:''},{control:make('keyword',{tagName:'INPUT',value:'x'}),initial:''},{control:make('date',{tagName:'INPUT',type:'date',value:'2026-09-26'}),initial:''}]);
  assert.deepEqual(events,[['category','change',true,''],['customer','change',true,''],['keyword','input',true,''],['date','change',true,'']]);
  assert.equal(customer.disabled,true);
});
test('all list filters share a presentation-only module; form pickers remain out of scope',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.equal((html.match(/class="filterbar/g)||[]).length,14);
  assert.equal(context.GucSearchPanels.selector,'.content .filterbar, .content .report-selector, .content #auditFilters');
  assert.ok(html.indexOf('/search-panels.js')>html.indexOf('/form-reference-sync.js'));
  assert.match(html,/href="\/search-panels.css"/);
  assert.doesNotMatch(source,/\bfetch\s*\(|localStorage|sessionStorage|apiRequest|innerHTML\s*=\s*container/);
  assert.match(source,/if \(existingSubmit\) container.append\(actions\)/);
  assert.match(source,/container.requestSubmit\(apply\)/);
});
