// Run against the loopback-only construction equipment fixture. No production identities or files.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=new URL(process.env.DRAWING_PREVIEW_URL||'http://127.0.0.1:4686').origin;
assert.equal(new URL(origin).hostname,'127.0.0.1');
const fixture=await fetch(origin+'/__drawing_test').then(r=>r.json());
assert(fixture.isolated);
const {project_id,id}=fixture.plans[0], browser=await chromium.launch({channel:'chrome'});
const api=(p,arg)=>p.evaluate(arg=>apiRequest(arg),arg);
const scope=async p=>(await api(p,{method:'GET',scope:'construction_plans',projectId:project_id})).construction_plans;
async function user(key,mobile=false){
  const p=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1340,height:920},isMobile:mobile,hasTouch:mobile});
  p.setDefaultTimeout(10000);
  p.on('pageerror',e=>console.error('Browser:',e.message));
  await p.goto(origin+'/?page=projects&test_user='+key);
  await p.waitForFunction(()=>state.currentUser&&!scopeRequests.size);
  if(await p.locator('#systemChooser.open').count())await p.locator('[data-system-choice=erp]').click();
  return p;
}
async function planning(p){
  await p.locator('#constructionPlanningTab').click();
  await p.locator('#constructionPlanningList [data-construction-project="'+project_id+'"]').click();
  await p.locator('#modalForm [data-planning-plan], #modalForm .construction-plan-section').first().waitFor();
}
const code='ROSTER-'+Date.now().toString(36),sample='暫編-CAM-005';
try{
 const p=await user('owner',true), worker=await user('A');
 const primary=(await scope(p)).find(x=>x.id===id);
 let other=(await scope(p)).find(x=>x.id!==id && x.drawing_points?.some(e=>e.code===sample));
 if(!other){
   await api(p,{operation:'save_construction_plan',payload:{id:crypto.randomUUID(),project_id,construction_date:'2026-11-25',content:'第二階段（示範）',status:'pending',planned_days:2,assignee_user_ids:primary.assignee_user_ids,items:[{id:crypto.randomUUID(),title:'現場驗收',start_day:1,planned_days:2}],drawing_points:primary.drawing_points}});
   other=(await scope(p)).find(x=>x.id!==id && x.drawing_points.some(e=>e.code===sample));
 }
 await planning(p);await p.evaluate(()=>openConstructionRoster(document.querySelector('#simpleModal').dataset.id));
 const dialog=p.locator('.project-roster'), form=dialog.locator('.roster-editor');
 const pick=dialog.locator('[data-roster-plan]');
 await pick.selectOption(id);await form.locator('[name=code]').fill(code);
 await form.locator('[name=name]').fill('清冊驗收');await form.locator('[name=location]').fill('示範位置');
 async function write(action){
   const response=p.waitForResponse(r=>r.request().method()==='POST'&&r.request().postData()?.includes('"save_construction_roster"'));
   await action();const r=await response;assert.equal(r.status(),201,await r.text());
   await p.waitForFunction(()=>!document.querySelector('[data-roster-plan]').disabled);
 }
 await write(()=>form.locator('[data-roster-save]').click());
 const row=c=>dialog.locator('.roster-list li').filter({has:dialog.page().getByText(c,{exact:true})});
 await row(code).waitFor();
 await row(sample).getByText('修改',{exact:true}).click();
 const renamed='一樓示範設備（清冊同步）'+(primary.drawing_points.find(pt=>pt.code===sample)?.name?.endsWith(' A')?' B':' A');
 await form.locator('[name=name]').fill(renamed);
 const before=await scope(p);
 await write(()=>form.locator('[data-roster-save]').click());
 const after=await scope(p);
 for(const plan of after.filter(x=>x.drawing_points.some(d=>d.code===sample))){
   assert.equal(plan.drawing_points.find(d=>d.code===sample).name,renamed);
   assert.deepEqual(plan.items,before.find(x=>x.id===plan.id).items);
   assert.deepEqual(plan.equipment_state,before.find(x=>x.id===plan.id).equipment_state);
 }
 assert(after.filter(x=>x.drawing_points.some(d=>d.code===sample)).length>=2);
 const staleVersions=Object.fromEntries(before.map(x=>[x.id,x.row_version]));
 await assert.rejects(api(p,{operation:'save_construction_roster',payload:{plan_id:id,versions:staleVersions,points:primary.drawing_points}}),/變更/);
 await assert.rejects(api(worker,{operation:'save_construction_roster',payload:{plan_id:id,versions:staleVersions,points:[]}}),/權限/);
 p.once('dialog',d=>d.accept());
 await write(()=>row(code).getByText('刪除',{exact:true}).click());
 assert.equal(await row(code).count(),0);
 await pick.selectOption(other.id);assert.match(await row(sample).innerText(),new RegExp(renamed));
 await dialog.locator('[data-roster-close]').click();
 await p.reload();await p.waitForFunction(()=>state.currentUser&&!scopeRequests.size);await planning(p);
 await p.evaluate(()=>openConstructionRoster(document.querySelector('#simpleModal').dataset.id));await pick.selectOption(id);
 assert.match(await row(sample).innerText(),new RegExp(renamed));assert.equal(await row(code).count(),0);
 console.log('PASS mobile roster create, cross-plan rename, delete, reload, stale revision and worker denial');
 await dialog.locator('[data-roster-close]').click();
 await p.locator('#modalForm [data-project-drawings]').click();
 await p.locator('#constructionDrawingList').waitFor();
 const name='第二階段分區示意圖.png';
 if(!await p.locator('#constructionDrawingList li').filter({hasText:name}).count()){
   const owner=p.locator('[name=drawingOwnerPlan]');if(await owner.count()&&await owner.inputValue()!==other.id){await owner.selectOption(other.id);await p.waitForFunction(id=>constructionDrawingContext.construction_plan_id===id,other.id);}
   const service=p.locator('[name=drawingContractServiceId]');if(!await service.inputValue())await service.selectOption({index:1});
   const image=await p.evaluate(()=>{const c=document.createElement('canvas');c.width=720;c.height=360;const g=c.getContext('2d');
     g.fillStyle='#f4f1e6';g.fillRect(0,0,720,360);g.strokeStyle='#71816d';g.lineWidth=3;
     g.strokeRect(35,72,265,200);g.strokeRect(390,72,265,200);g.font='22px sans-serif';g.fillStyle='#32473a';
     g.fillText('施工分區示意 · 測試圖',35,40);g.fillText('A 區',140,170);g.fillText('B 區',492,170);return c.toDataURL().split(',')[1];});
   await p.locator('[name=drawingFiles]').setInputFiles({name,mimeType:'image/png',buffer:Buffer.from(image,'base64')});
   await p.locator('#modalForm [type=submit]').click();await p.locator('#constructionDrawingList li').filter({hasText:name}).waitFor();
 }
 const docs=await p.evaluate(()=>drawingPages().map(r=>({id:r.id,name:r.original_name})));
 assert(docs.length>=2,'先執行工程圖標記測試建立第一張圖');
 const index=docs.findIndex(r=>r.name===name),asset=docs[index];
 assert((await api(p,{method:'GET',scope:'construction_drawings',planId:other.id})).drawings.some(r=>r.id===asset.id),'第二張圖應屬於指定規劃');
 const pager=p.locator('[data-gallery-select]');await pager.selectOption(asset.id);
 const loaded=async key=>p.waitForFunction(key=>activeDrawingAnnotation?.row?.id===key&&document.querySelector('.drawing-stage img')?.naturalWidth>0,key);
 await loaded(asset.id);
 const details=p.locator('.drawing-locator-settings');if(!await details.evaluate(d=>d.open))await details.locator('summary').click();
 const select=p.locator('[data-marker-select]'),stage=p.locator('.drawing-stage');
 const marker=p.locator('[data-marker-code="'+sample+'"][data-anchor=icon]');
 await select.selectOption(sample);await p.locator('[data-marker-kind]').selectOption('icon');
 let rect=await stage.boundingBox();await stage.click({position:{x:rect.width*.30,y:rect.height*.42}});
 await marker.waitFor();await p.waitForFunction(()=>!document.querySelector('[data-marker-select]').disabled);
 const firstPos=await marker.getAttribute('style');
 await select.selectOption(sample);rect=await stage.boundingBox();await stage.click({position:{x:rect.width*.72,y:rect.height*.47}});
 await p.waitForFunction(pos=>document.querySelector('[data-marker-code="暫編-CAM-005"][data-anchor=icon]').getAttribute('style')!==pos,firstPos);
 await select.selectOption(sample);p.once('dialog',d=>d.accept());await p.locator('[data-marker-remove]').click();await marker.waitFor({state:'detached'});
 await select.selectOption(sample);rect=await stage.boundingBox();await stage.click({position:{x:rect.width*.30,y:rect.height*.42}});await marker.waitFor();
 const beforeMarkers=(await api(p,{method:'GET',scope:'construction_drawings',planId:other.id})).drawings.find(r=>r.id===asset.id).drawing_markers;
 assert.equal(await p.locator('.gallery-point-list [data-grid-code]').count(),Object.keys(beforeMarkers).length);
 const width=await stage.boundingBox();assert(width.width<=390);
 await p.locator('[data-drawing-zoom]').click();assert((await stage.boundingBox()).width>width.width);
 await p.locator('[data-drawing-zoom]').click();
 const target=index===0?1:index-1;
 await p.getByRole('button',{name:index===0?'下一張':'上一張',exact:true}).click();await loaded(docs[target].id);
 await pager.selectOption(asset.id);await loaded(asset.id);await marker.waitFor();
 await p.reload();await p.waitForFunction(()=>state.currentUser&&!scopeRequests.size);await planning(p);
 await p.locator('#modalForm [data-project-drawings]').click();await p.locator('.drawing-stage img').waitFor();
 await pager.selectOption(asset.id);await loaded(asset.id);await marker.click();await p.locator('.drawing-note').getByText(sample,{exact:true}).waitFor();
 const grid=p.locator('.gallery-point-list [data-grid-code="'+sample+'"]');
 assert.equal(await grid.getAttribute('data-point-state'),await marker.getAttribute('data-point-state'));
 console.log('PASS second drawing upload, inline image, flip both directions, image-scoped list, marker create/move/remove/reopen, zoom and phone bounds');
 await planning(worker);await worker.locator('#modalForm [data-project-drawings]').click();
 await worker.locator('.drawing-stage img').waitFor();assert.equal(await worker.locator('[data-marker-select]').count(),0);
 console.log('PASS desktop assignee sees picture and statuses with read-only controls');
 const demoCodes=['暫編-CAM-005','暫編-CAM-006','暫編-CAM-007','暫編-CAM-008'];
 for(const plan of await scope(p)){
   if(!plan.drawing_points?.some(pt=>pt.code===demoCodes[0]))continue;
   const changes=[];
   for(const item of plan.items){
     for(const [index,status] of ['done','working','pending','na'].entries()){
       const device=demoCodes[index],before=plan.equipment_state.find(s=>s.item===item.id && s.code===device)?.status??null;
       if(before!==status)changes.push({code:device,item:item.id,status,before});
     }
   }
   if(changes.length)await api(worker,{operation:'import_construction_matrix',payload:{plan_id:plan.id,row_version:plan.row_version,request_id:crypto.randomUUID(),log_date:'2026-11-26',names:[],changes}});
 }
 const renameFromExcel='示範設備（Excel 同步）',current=(await scope(p)).find(plan=>plan.id===id);
 await api(p,{operation:'import_construction_matrix',payload:{plan_id:id,row_version:current.row_version,names:[{code:demoCodes[1],name:renameFromExcel}],changes:[],request_id:crypto.randomUUID(),log_date:'2026-11-26'}});
 for(const plan of (await scope(p)).filter(s=>s.drawing_points?.some(d=>d.code===demoCodes[1])))assert.equal(plan.drawing_points.find(d=>d.code===demoCodes[1]).name,renameFromExcel);
 await p.locator('[data-drawing-reload]').click();
 await p.waitForFunction(()=>!document.querySelector('#constructionDrawingList').inert && document.querySelector('.drawing-stage img')?.naturalWidth>0);
 const file=(await api(p,{method:'GET',scope:'construction_drawings',planId:other.id})).drawings.find(r=>r.id===asset.id);
 for(const [i,device] of demoCodes.entries()){
   await api(p,{operation:'save_construction_drawing_marker',payload:{asset_id:asset.id,sha256:file.sha256,code:device,expected:file.drawing_markers?.[device]||null,position:{x:[.26,.72,.32,.82][i],y:[.37,.37,.67,.67][i]}}});
 }
 await p.locator('[data-drawing-reload]').click();
 await p.waitForFunction(()=>!document.querySelector('#constructionDrawingList').inert && document.querySelector('.drawing-stage img')?.naturalWidth>0);
 await pager.selectOption(asset.id);await loaded(asset.id);
 const colors=new Set();
 for(const [i,key] of ['done','working','pending','na'].entries()){
   const dot=p.locator('[data-marker-code="'+demoCodes[i]+'"][data-anchor=icon]'),cell=p.locator('.gallery-point-list [data-grid-code="'+demoCodes[i]+'"]');
   assert.equal(await dot.getAttribute('data-point-state'),key);assert.equal(await cell.getAttribute('data-point-state'),key);
   colors.add(await dot.evaluate(el=>getComputedStyle(el).borderTopColor));
 }
 assert.equal(colors.size,4);
 console.log('PASS four live progress colors reflect persisted cells on image and list, and Excel names propagate to all matching plans');
}finally{await browser.close();}
