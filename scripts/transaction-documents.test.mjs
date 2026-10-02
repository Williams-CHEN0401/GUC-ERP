import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../receipt-documents.js',import.meta.url),'utf8');
const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
function fixture(){
 const elements=new Map(),element=id=>{if(!elements.has(id))elements.set(id,{value:'',innerHTML:''});return elements.get(id);};
 const state={receipts:[],pickups:[],inventory:[{id:'i1',name:'電腦'},{id:'i2',name:'交換器'},{id:'i3',name:'隱藏第三項<script>'}],suppliers:[{id:'s',name:'供應商'}],projects:[{id:'p',name:'維修工作',code:'P001'}],customers:[]};
 const context=vm.createContext({state,tableState:{receipt:{page:1,perPage:10},pickup:{page:1,perPage:10}},document:{querySelector:element,addEventListener:()=>{}},byId:(rows,id)=>rows.find(r=>r.id===id),matches:(values,q)=>!q||values.some(v=>String(v).includes(q)),esc:v=>String(v??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),canModule:()=>true,editableRowAttributes:()=>'',emptyRow:()=>'',renderPagination:(key,id,total)=>element(id).total=total});
 for(const name of ['sortRows','tablePage'])vm.runInContext(app.match(new RegExp('function '+name+'\\([^\\n]+'))[0],context);
 vm.runInContext(source,context);return{state,context,element,run:s=>vm.runInContext(s,context)};
}
for(const kind of ['receipt','pickup'])test(kind+' groups before pagination/search/sort and counts distinct IDs',()=>{
 const f=fixture(),rows=f.state[kind==='receipt'?'receipts':'pickups'];
 for(let d=1;d<=11;d++)for(let i=1;i<=3;i++)rows.push({id:d+'-'+i,documentId:'d'+d,documentNo:'20261002'+(d>1?'-'+d:''),date:'2026-10-02',supplierId:'s',projectId:'p',itemId:'i'+i,quantity:i,note:'',customerIds:[]});
 const render=kind==='receipt'?'renderReceiptDocuments()':'renderPickupDocuments()';f.run(render);
 assert.equal(f.element(kind+'Pagination').total,11);assert.equal((f.element('#'+kind+'Table').innerHTML.match(/<tr/g)||[]).length,10);assert.match(f.element('#'+kind+'Table').innerHTML,/3 種/);assert.match(f.element('#'+kind+'Table').innerHTML,/<td>6<\/td>/);assert.match(f.element('#'+kind+'Table').innerHTML,/另有 1 筆明細/);assert.ok(!f.element('#'+kind+'Table').innerHTML.includes('<script>'));
 f.context.tableState[kind].search='隱藏第三項';f.run(render);assert.equal(f.element(kind+'Pagination').total,11);
 f.context.tableState[kind].sortKey='documentNo';f.context.tableState[kind].direction='asc';f.context.tableState[kind].page=2;f.run(render);assert.match(f.element('#'+kind+'Table').innerHTML,/20261002-11/);
 f.element('#'+kind+'DateFrom').value='2026-10-03';f.run(render);assert.equal(f.element(kind+'Pagination').total,0);
 f.element('#'+kind+'DateFrom').value='';f.context.tableState[kind].page=1;f.context.tableState[kind].search='20261002-2';f.run(render);assert.equal(f.element(kind+'Pagination').total,1);assert.match(f.element('#'+kind+'Table').innerHTML,/3 種/);
});
test('legacy rows with matching names/date remain separate without document IDs',()=>{
 const f=fixture();f.state.receipts=[1,2,3].map(n=>({id:String(n),date:'2026-09-24',supplierId:'s',itemId:'i1',quantity:1}));f.run('renderReceiptDocuments()');assert.equal(f.element('receiptPagination').total,3);
});
test('receipt item kinds count stable item IDs, not detail lines',()=>{
 const f=fixture();f.state.receipts=[1,2].map(n=>({id:String(n),documentId:'same',date:'2026-09-24',supplierId:'s',itemId:'i1',quantity:n,note:'note'+n}));f.run('renderReceiptDocuments()');assert.match(f.element('#receiptTable').innerHTML,/1 種/);assert.match(f.element('#receiptTable').innerHTML,/<td>3<\/td>/);
});
