import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
// Run against verify-construction-equipment.mjs --preview. All records are synthetic.
const origin=new URL(process.env.DRAWING_PREVIEW_URL || 'http://127.0.0.1:4656').origin;
assert.equal(new URL(origin).hostname,'127.0.0.1');
const fixture=await fetch(origin+'/__drawing_test').then(r=>r.json());
assert(fixture.isolated);
const {project_id,id}=fixture.plans[0], first='暫編-CAM-001', name='有編號工程圖（示範）.png';
const browser=await chromium.launch({channel:'chrome'});
async function load(user){
 const page=await browser.newPage();
 await page.goto(origin+'/?page=projects&test_user='+user);
 await page.waitForFunction(()=>state.currentUser);
 if(await page.locator('#systemChooser.open').count())await page.locator('[data-system-choice="erp"]').click();
 await page.waitForFunction(()=>scopeRequests.size===0);
 return page;
}
try{
 const page=await load('owner');
 const api=(p,arg)=>p.evaluate(a=>apiRequest(a),arg);
 const scope=()=>api(page,{method:'GET',scope:'construction_plans',projectId:project_id});
 let plans=(await scope()).construction_plans,p=plans.find(p=>p.id===id);
 // Seed other plans to exercise cross-plan visibility with the same device codes.
 for(const title of ['監視器配線、廣播配線','監視器及廣播設備安裝']){
  if(plans.some(p=>p.content===title))continue;
  await api(page,{operation:'save_construction_plan',payload:{id:crypto.randomUUID(),project_id,construction_date:'2026-11-20',content:title,status:'pending',planned_days:3,assignee_user_ids:p.assignee_user_ids,items:[{id:crypto.randomUUID(),title:'示範施工區',start_day:1,planned_days:3}],drawing_points:p.drawing_points}});
 }
 await page.reload();
 await page.waitForFunction(()=>state.currentUser && scopeRequests.size===0);
 await page.locator('#constructionPlanningTab').click();
 const entry=page.locator('#constructionPlanningList [data-project-drawings="'+project_id+'"]');
 await entry.waitFor();assert.equal(await entry.count(),1);assert.equal(await page.locator('[data-planning-plan] [data-project-drawings]').count(),0);
 await entry.click();await page.locator('#constructionDrawingList').waitFor();
 if(await page.locator('[name=drawingOwnerPlan]').inputValue()!==id)await page.locator('[name=drawingOwnerPlan]').selectOption(id);await page.waitForFunction(id=>constructionDrawingContext.construction_plan_id===id,id);
 const icon=process.env.DRAWING_LEGEND_FILE ? await readFile(process.env.DRAWING_LEGEND_FILE) : null;
 const positions=p.drawing_points.map(({code},i)=>({code,x:(65+(i%9)*105)/1000,y:(65+Math.floor(i/9)*79)/620}));
 if(!await page.locator('#constructionDrawingList li').filter({hasText:'有編號工程圖'}).count()){
  const image=await page.evaluate(async({positions,icon})=>{
    const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=620;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#f6f7f2';ctx.fillRect(0,0,1000,620);
    const img=new Image();if(icon){img.src='data:image/png;base64,'+icon;await img.decode();}
    ctx.fillStyle='#214633';ctx.font='17px sans-serif';ctx.fillText('有編號工程圖 · 示範配置',20,26);
    for(const {code,x,y} of positions){if(icon)ctx.drawImage(img,x*1000-20,y*620-18,40,36);else ctx.fillRect(x*1000-13,y*620-8,26,16);ctx.fillStyle='#94382e';ctx.fillText(code.slice(-3),x*1000+22,y*620+5);}
    return canvas.toDataURL('image/png').split(',')[1];
  },{positions,icon:icon?.toString('base64')});
  const service=page.locator('[name=drawingContractServiceId]');if(!await service.inputValue())await service.selectOption({index:1});
  await page.locator('[name=drawingFiles]').setInputFiles([{name,mimeType:'image/png',buffer:Buffer.from(image,'base64')},...(icon?[{name:'攝影機圖示.png',mimeType:'image/png',buffer:icon}]:[])]);
  await page.locator('#modalForm [type=submit]').click();
 }
 const row=page.locator('#constructionDrawingList li').filter({hasText:'有編號工程圖'});await row.waitFor({timeout:9000}).catch(async e=>{throw Error(await page.locator('#modalForm').innerText()+' '+(await page.locator('body').innerText()).slice(-600),{cause:e});});
 await row.locator('[data-drawing-default]').click();
 await page.locator('.drawing-stage,[data-drawing-annotate]').first().waitFor();
 if(await page.locator('[data-drawing-annotate]').count())await page.locator('[data-drawing-annotate]').click();
 const stage=page.locator('.drawing-stage');await stage.waitFor();await page.waitForFunction(()=>document.querySelector('.drawing-stage img')?.naturalWidth===1000);
 const asset=(await api(page,{method:'GET',scope:'construction_drawings',planId:id})).drawings.find(d=>d.original_name===name);
 const marker=(user,code,position,expected=null,sha=asset.sha256)=>api(user,{operation:'save_construction_drawing_marker',payload:{asset_id:asset.id,code,position,expected,sha256:sha}});
 await page.locator('.drawing-locator-settings summary').click();
 if(!asset.drawing_markers[first]){
  await page.locator('[data-marker-select]').selectOption(first);
  await page.locator('[data-marker-kind]').selectOption('icon');
  const box=await stage.boundingBox();
  await stage.click({position:{x:box.width*positions[0].x,y:box.height*positions[0].y}});
  await page.locator('[data-marker-code="'+first+'"][data-anchor=icon]').waitFor({timeout:8000}).catch(async e=>{throw Error((await page.locator('body').innerText()).slice(-1300),{cause:e});});
 }
 const labelAt=({x,y})=>({x:x+.036,y});
 if(!asset.drawing_markers[first]?.label){
  if(await page.locator('[data-note-close]').isVisible())await page.locator('[data-note-close]').click();
  await page.locator('[data-marker-select]').selectOption(first);
  await page.locator('[data-marker-kind]').selectOption('label');
  const box=await stage.boundingBox(),label=labelAt(positions[0]);
  await stage.click({position:{x:box.width*label.x,y:box.height*label.y}});
  await page.locator('[data-marker-code="'+first+'"][data-anchor=label]').waitFor();
 }
 const paired=positions[1];
 if(!asset.drawing_markers[paired.code]){
  await page.locator('[data-marker-select]').selectOption(paired.code);
  await page.locator('[data-marker-kind]').selectOption('pair');
  const rect=await stage.boundingBox(), label=labelAt(paired);
  await stage.click({position:{x:rect.width*label.x,y:rect.height*label.y}});
  assert.equal(await page.locator('[data-marker-code="'+paired.code+'"]').count(),0);
  await stage.click({position:{x:rect.width*paired.x,y:rect.height*paired.y}});
  await page.locator('[data-marker-code="'+paired.code+'"][data-anchor=label]').waitFor();
 }
 for(const point of positions.slice(2)){
  const {code,x,y}=point, previous=asset.drawing_markers[code];
  if(previous?.label)continue;
  const label=labelAt(point);
  // A label can be registered before its icon.
  if(!previous)await marker(page,code,{label});
  await marker(page,code,{x,y,label},previous||{label});
 }
 const current=(await api(page,{method:'GET',scope:'construction_drawings',planId:id})).drawings.find(d=>d.id===asset.id);
 assert.equal(Object.keys(current.drawing_markers).length,61);
 assert(Object.values(current.drawing_markers).every(p=>p.label && Number.isFinite(p.x)));
 await assert.rejects(marker(page,first,{label:{x:-.1,y:.5}},current.drawing_markers[first]),/範圍/);
 await assert.rejects(marker(page,first,{label:{x:.1}},current.drawing_markers[first]),/座標/);
 await assert.rejects(marker(page,first,{x:.99,y:.99},null),/變更/);
 await assert.rejects(marker(page,first,{x:2,y:.5},current.drawing_markers[first]),/範圍/);
 await assert.rejects(marker(page,'不存在',{x:.5,y:.5}),/編號/);
 await assert.rejects(marker(page,first,{x:.3,y:.4},current.drawing_markers[first],'old'),/變更/);
 const worker=await load('A');
 await assert.rejects(marker(worker,first,{x:.5,y:.5},current.drawing_markers[first]),/權限|負責人|管理員/);
 const stranger=await load('C');
 await assert.rejects(api(stranger,{method:'GET',scope:'construction_drawings',planId:id}),/權限|找不到/);
 await page.locator('[data-drawing-reload]').click();
 await page.waitForFunction(()=>!document.querySelector('#constructionDrawingList').inert && document.querySelector('.drawing-stage img')?.naturalWidth>0);
 await row.locator('[data-drawing-default]').click();
 await page.locator('[data-marker-code="'+first+'"][data-anchor=icon]').click();
 const note=page.locator('.drawing-note');
 await note.getByText('示範施工區',{exact:false}).first().waitFor();
 assert.match(await note.innerText(),/未填報/);
 // Worker writes an actual construction log via the ERP Gateway.
 const data=await api(worker,{method:'GET',scope:'construction_plans',projectId:project_id});
 const plan=data.construction_plans.find(s=>s.id===id);
 if(!plan.equipment_state.some(e=>e.code===first&&e.status==='done')){
  const [one,two]=plan.items;
  await worker.locator('#constructionPlanningTab').click();
  const card=worker.locator('#constructionPlanningList [data-planning-plan="'+id+'"]');
  if(!await card.evaluate(d=>d.open))await card.locator('summary').first().click();
  await card.getByRole('button',{name:'填寫工作日誌',exact:true}).click();
  const form=worker.locator('#modalForm');
  await form.locator('[name=completedContent]').fill('示範配管已完成');
  await form.locator('[name=pendingContent]').fill('示範設備安裝中');
  const second='暫編-CAM-002', third='暫編-CAM-003';
  const task=item=>form.locator('[data-log-item][value="'+item.id+'"]');
  const picker=form.locator('[data-equipment-item]');
  const box=code=>form.locator('[data-device-code][value="'+code+'"]');
  const status=code=>box(code).locator('xpath=ancestor::div[1]').locator('[data-device-status]');
  const saveLog=async()=>{
    const write=worker.waitForResponse(r=>r.request().method()==='POST'&&r.request().postData()?.includes('upsert_customer_project_work_log'),{timeout:10000});
    await form.locator('[type=submit]').click();
    const result=await write;assert.equal(result.status(),201,await result.text());
    await worker.waitForFunction(()=>document.querySelector('#simpleModal').dataset.type!=='workLogModal' || !document.querySelector('#simpleModal').classList.contains('open'));
  };
  await task(one).check();
  assert.equal(await form.locator('[data-device-code]').count(),61);
  assert(await status(first).isDisabled());
  await box(first).check();await status(first).selectOption('done');
  await box(second).check();await status(second).selectOption('working');
  await box(third).check();await status(third).selectOption('na');
  await task(two).check();
  assert.equal(await picker.inputValue(),two.id);assert(!await box(first).isChecked());
  await box(first).check();await status(first).selectOption('working');
  await task(one).uncheck();
  assert.equal(await form.evaluate(f=>equipmentEntryValues(f).length),1);
  await task(one).check();
  assert.equal(await status(third).inputValue(),'na');
  await saveLog();
  const saved=await api(worker,{method:'GET',scope:'construction_plans',projectId:project_id});
  const cells=saved.construction_plans.find(p=>p.id===id).equipment_state;
  const expected=[[first,one.id,'done'],[second,one.id,'working'],[third,one.id,'na'],[first,two.id,'working']];
  for(const [code,item,state] of expected)assert.equal(cells.find(c=>c.code===code&&c.item===item)?.status,state);
  const logId=cells.find(c=>c.code===second&&c.item===one.id).log_id;
  await worker.evaluate(id=>openConstructionPlans(id),project_id);
  const detail=worker.locator('#modalForm [data-planning-plan="'+id+'"]');
  if(!await detail.evaluate(d=>d.open))await detail.locator('summary').first().click();
  await detail.locator('.construction-log-list summary').click();
  await detail.locator('.construction-log-list [data-construction-open-log="'+logId+'"]').click();
  await picker.selectOption(one.id);
  assert(await box(first).isChecked());assert.equal(await status(first).inputValue(),'done');
  assert(await box(second).isChecked());assert.equal(await status(second).inputValue(),'working');
  await picker.selectOption(two.id);
  assert(await box(first).isChecked());assert.equal(await status(first).inputValue(),'working');
  await picker.selectOption(one.id);
  await status(second).selectOption('pending');
  await box(third).uncheck();assert(await status(third).isDisabled());
  await saveLog();
  const edited=(await api(worker,{method:'GET',scope:'construction_plans',projectId:project_id})).site_work_logs.find(l=>l.id===logId);
  assert.equal(edited.equipment_progress.length,3);
  assert(edited.equipment_progress.some(e=>e.code===second&&e.item===one.id&&e.status==='pending'));
  assert(edited.equipment_progress.some(e=>e.code===first&&e.item===one.id&&e.status==='done'));
  assert(edited.equipment_progress.some(e=>e.code===first&&e.item===two.id&&e.status==='working'));
  console.log('PASS multi-device journal create, work-item switching, independent statuses, reopen, edit and removal');
 }
 await page.locator('[data-note-close]').click();await page.locator('[data-marker-code="'+first+'"][data-anchor=icon]').click();
 await note.getByText(/✓ 已完成/).waitFor();assert.match(await note.innerText(),/施工中/);assert.match(await note.innerText(),/未填報/);
 await page.setViewportSize({width:390,height:844});
 const box=await note.boundingBox();assert(box.x>=0&&box.x+box.width<=391);
 await page.locator('[data-note-close]').click();
 await page.locator('[data-marker-code="'+first+'"][data-anchor=label]').click();
 await note.getByText(/✓ 已完成/).waitFor();const expected=await note.innerText();
 await page.locator('[data-drawing-grid]').click();
 const grid=page.locator('.drawing-grid');
 assert.equal(await grid.locator('button').count(),61);
 const cell=grid.locator('[data-grid-code="'+first+'"]');
 for(const selector of ['img','span']){
  await cell.locator(selector).click();
  await note.getByText(/✓ 已完成/).waitFor();assert.equal(await note.innerText(),expected);
  await note.locator('[data-note-close]').click();
 }
 await row.locator('[data-drawing-default]').click();
 await page.locator('[data-marker-code="'+first+'"][data-anchor=icon]').click();
 await note.getByText(/✓ 已完成/).waitFor();assert.equal(await note.innerText(),expected);
 console.log('PASS original label, original icon and generated grid have identical live notes');
 console.log('PASS 61 markers, original file upload, one per-project entry, three plan readback, position save, optimistic concurrency and permission restrictions, live two-item journal update, mobile note.');
} finally { await browser.close(); }

