import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function harness(){
 const rows=[],events={},button={},category={value:'cat'},selection={value:'a'},notices=[],opened=[];
 const inventory=[{id:'a',name:'網路線 CAT6',code:'A01',categoryId:'cat',category:'線材',brand:'A',model:'CAT6',unit:'米'},{id:'b',name:'網路線 CAT6A',code:'A02',categoryId:'other',category:'其他',brand:'B',model:'6A',unit:'箱'},{id:'c',name:'網路攝影機',code:'A03',categoryId:'cat'}];
 const c=vm.createContext({state:{inventory,categories:[]},allowed:true,canModule:()=>c.allowed,showToast:message=>notices.push(message),openModal:(type,id)=>opened.push({type,id}),document:{querySelector:s=>s==='#adjustEditItem'?button:s==='#adjustCategory'?category:s==='#adjustItem'?selection:{dataset:{}},querySelectorAll:()=>rows,addEventListener:(name,fn)=>events[name]=fn}});
 for(const name of ['esc','byId'])vm.runInContext(app.split(/\r?\n/).find(line=>line.startsWith('function '+name+'(')),c);
 vm.runInContext(app.slice(app.indexOf('function normalizeInventoryName('),app.indexOf('function transactionItemSearchFields(')),c);
 const row=value=>{const input={value},panel={innerHTML:'',hidden:true};const node={querySelector:s=>s==='[name="name"]'?input:panel};rows.push(node);return {input,panel,node};};
 return {c,row,events,button,category,selection,notices,opened};
}
test('similar names match Chinese substrings, normalized Latin/width/spacing and multiple keywords across categories',()=>{
 const {c}=harness(),ids=q=>Array.from(c.similarInventoryItems(q),item=>item.id);
 assert.deepEqual(ids(' 網路線 ｃａｔ６ '),['a','b']);
 assert.deepEqual(ids('CAT6 網路'),['a','b']);
 assert.deepEqual(ids('網路'),['a','b','c']);
 assert.deepEqual(ids('網路線CAT6加強版'),['a']);
 assert.deepEqual(ids('　 '),[]);assert.deepEqual(ids('不存在'),[]);
});
test('suggestions escape text, mark same names, cap long lists and clear independently without replacing draft input',()=>{
 const {c,row}=harness(),one=row('網路線 CAT6'),two=row('攝影機');
 c.refreshItemNameSuggestions();assert.match(one.panel.innerHTML,/同名品項/);assert.match(one.panel.innerHTML,/A01/);assert.match(two.panel.innerHTML,/A03/);
 assert.equal(one.input.value,'網路線 CAT6');
 c.state.inventory=Array.from({length:12},(_,i)=>({id:String(i),name:'<img onerror=alert(1)>網路'+i,code:'C'+i}));one.input.value='網路';c.renderItemNameSuggestions(one.node);
 assert.match(one.panel.innerHTML,/找到 12 筆/);assert.equal((one.panel.innerHTML.match(/<li>/g)||[]).length,8);assert.ok(!one.panel.innerHTML.includes('<img'));assert.match(one.panel.innerHTML,/&lt;img/);
 one.input.value='none';c.renderItemNameSuggestions(one.node);assert.match(one.panel.innerHTML,/沒有找到/);
 one.input.value=' ';c.renderItemNameSuggestions(one.node);assert.equal(one.panel.hidden,true);assert.equal(one.panel.innerHTML,'');
});
test('name input updates its row and Enter does not submit the batch or interfere with IME composition',()=>{
 const {row,events}=harness(),one=row('網路'),target={matches:()=>true,closest:()=>one.node};let prevented=0;
 events.input({target});assert.match(one.panel.innerHTML,/找到 3 筆/);
 events.keydown({target,key:'Enter',isComposing:true,preventDefault(){prevented++;}});assert.equal(prevented,0);
 events.keydown({target,key:'Enter',isComposing:false,preventDefault(){prevented++;}});assert.equal(prevented,1);
});
