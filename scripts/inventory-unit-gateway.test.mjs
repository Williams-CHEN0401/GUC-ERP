import {withWebsiteAccess} from './website-access-test-helper.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';import {readFileSync} from 'node:fs';import {stripTypeScriptTypes} from 'node:module';import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';
const source=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8').replace(/^import .*node:async_hooks.*;\r?\n/m,''),{mode:'strip'});
const id='20000000-0000-4000-8000-000000000001';
function fixture({update=true,module='inventory',anonymous=false,mode='ok'}={}){
 let handler;const patches=[];
 const c=vm.createContext({AsyncLocalStorage,performance,URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,crypto,console,Deno:{env:{get:()=>''},serve:fn=>handler=fn}});vm.runInContext(source,c);
 c.currentUser=withWebsiteAccess(async()=>anonymous?null:{id,username:'fixture',role:'custom',is_active:true,permissions:[{module,can_view:true,can_create:false,can_update:update,can_delete:false}]});
 c.get=c.getAll=async()=>[];c.rpc=async()=>({});
 c.db=async(path,init={})=>{
  if(path.startsWith('audit_logs'))return Response.json([],{status:201});
  assert.equal(init.method,'PATCH');assert.match(path,/^inventory_items\?id=eq\.[\w-]+&row_version=eq\.\d+$/);patches.push({path,body:JSON.parse(init.body)});
  if(mode==='stale')return Response.json([]);
  if(mode==='guard')return Response.json({code:'P0001',message:'尚有原規格的整包庫存，不能直接改變預設長度。'},{status:400});
  return Response.json([{id,...JSON.parse(init.body)}]);
 };
 return{patches,send:async(payload={})=>{const response=await handler(new Request('https://fixture.invalid/inventory-gateway',{method:'POST',body:JSON.stringify({operation:'update_inventory_item',payload:{id,row_version:4,units_only:true,unit:'捲',meters_per_unit:200,...payload}})}));return{status:response.status,body:await response.json()};}};
}
test('unit-only save needs the existing update permission and writes only units plus standard audit metadata',async()=>{
 const f=fixture(),result=await f.send({item_name:'不能覆寫名稱',brand:'不能覆寫品牌',opening_quantity:999,category_id:id});assert.equal(result.status,201);
 assert.deepEqual(f.patches[0].body,{unit:'捲',meters_per_unit:200,source:'web',updated_by:'fixture'});assert.match(f.patches[0].path,/row_version=eq\.4$/);
 const omitted=fixture();assert.equal((await omitted.send({meters_per_unit:undefined})).status,201);assert.equal(Object.hasOwn(omitted.patches[0].body,'meters_per_unit'),false);
});
test('read-only, wrong-module and anonymous requests cannot write per-item units',async()=>{
 for(const options of [{update:false},{module:'projects'},{anonymous:true}]){const f=fixture(options),result=await f.send();assert.equal(result.status,options.anonymous?401:403);assert.equal(f.patches.length,0);}
});
test('invalid units, versions and lengths are rejected before inventory writes',async()=>{
 for(const payload of [{unit:''},{unit:'單'.repeat(31)},{row_version:0},{id:'invalid'},{meters_per_unit:-1},{meters_per_unit:0},{meters_per_unit:1.234},{meters_per_unit:'NaN'},{meters_per_unit:1e12}]){const f=fixture(),result=await f.send(payload);assert.equal(result.status,400);assert.equal(f.patches.length,0);}
});
test('native inventory profile guard errors and optimistic concurrency are retained',async()=>{
 const guard=fixture({mode:'guard'}),rejected=await guard.send();assert.equal(rejected.status,400);assert.match(rejected.body.error,/原規格.*整包庫存/);
 const stale=fixture({mode:'stale'}),outdated=await stale.send();assert.equal(outdated.status,400);assert.match(outdated.body.error,/其他管理者更新/);
});
test('unit-only flag does not remove the existing full-item validation path',async()=>{
 const f=fixture(),result=await f.send({units_only:false});assert.equal(result.status,400);assert.match(result.body.error,/完整填寫品項/);assert.equal(f.patches.length,0);
});
