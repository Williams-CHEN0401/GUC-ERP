import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function options(customerId,selected){
  const context=vm.createContext({state:{projects:[
    {id:'active',customerId:'customer',status:'in_progress',code:'A',name:'進行中工作'},
    {id:'original',customerId:'customer',status:'completed',code:'B',name:'原已結案工作'},
    {id:'closed-other',customerId:'customer',status:'completed',code:'C',name:'另一已結案工作'},
    {id:'foreign',customerId:'other',status:'completed',code:'D',name:'其他客戶工作'},
  ]}});
  for(const name of ['esc','selectField','projectOptions']){
    vm.runInContext(app.split(/\r?\n/).find(line=>line.startsWith(`function ${name}(`)),context);
  }
  return context.projectOptions(customerId,selected);
}

test('editing a pickup initially selects its original work even after that work has closed',()=>{
  assert.match(options('customer','original'),/<option value="original" selected>B｜原已結案工作<\/option>/);
});
test('editing still selects an in-progress original instead of the placeholder',()=>{
  assert.match(options('customer','active'),/<option value="active" selected>/);
});
test('the closed-work exception is limited to the original selected work',()=>{
  const html=options('customer','original');
  assert.match(html,/<option value="active"/);
  assert.doesNotMatch(html,/<option value="(?:closed-other|foreign)"/);
});
test('new pickups keep a blank default and exclude all closed work',()=>{
  const html=options('customer');
  assert.match(html,/<option value="" selected>請選擇工作內容/);
  assert.doesNotMatch(html,/<option value="(?:original|closed-other|foreign)"/);
});
test('a selected ID does not bypass customer ownership or invent a missing work',()=>{
  assert.doesNotMatch(options('customer','foreign'),/<option value="foreign"/);
  assert.doesNotMatch(options('customer','missing'),/<option value="missing"/);
  assert.doesNotMatch(options('','original'),/<option value="original"/);
});
