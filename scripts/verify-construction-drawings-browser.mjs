import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {constructionDrawingsServer} from './construction-drawings-fixture.mjs';
import {ids} from './worklog-save-fixture.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixture=await constructionDrawingsServer(),{server,db,nas,plans,failedNames,metadataFailures,modes}=fixture;
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const output=new URL('../tmp/construction-drawings-browser/',import.meta.url);await mkdir(output,{recursive:true});
const results=[],pass=label=>{results.push(label);console.log('PASS '+label);};
function pdf(){
 const objects=['<</Type /Catalog /Pages 2 0 R>>','<</Type /Pages /Kids [3 0 R] /Count 1>>','<</Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R>>','<</Length 0>>\nstream\n\nendstream'];
 let content='%PDF-1.4\n',offsets=[0];
 objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(content));content+=`${index+1} 0 obj\n${object}\nendobj\n`;});
 const xref=Buffer.byteLength(content);content+=`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<</Size 5 /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(content);
}
const pdfBytes=pdf(),pngBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=','base64');
const smallFiles=[{name:'平面配置.pdf',mimeType:'application/pdf',buffer:pdfBytes},{name:'機櫃示意.png',mimeType:'image/png',buffer:pngBytes},{name:'配線原圖.dxf',mimeType:'application/dxf',buffer:Buffer.from('0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n')}];
const largeFile={name:'建築大圖.dwg',mimeType:'application/acad',buffer:Buffer.concat([Buffer.from('AC1032'),Buffer.alloc(7*1024*1024,65)])};
let browser;
try{
 browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 const page=await context.newPage(),errors=[],external=[];
 page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===origin||['blob:','data:'].includes(url.protocol)?route.continue():(external.push(url.origin+url.pathname),route.abort());});
 async function load(user='owner',target=page){
  await target.goto(origin+'/?page=projects&test_user='+user);
  await target.waitForFunction(()=>state.currentUser);
  if(await target.locator('#systemChooser').evaluate(node=>node.classList.contains('open')))await target.locator('[data-system-choice="erp"]').click();
  await target.waitForFunction(()=>scopeRequests.size===0);
 }
 async function open(plan=plans[0],target=page){
  await target.locator('#constructionPlanningTab').click();
  const card=target.locator(`[data-planning-plan="${plan.id}"]`);
  if(!(await card.evaluate(node=>node.open)))await card.locator('summary').first().click();
  await target.locator(`[data-open-construction-drawings="${plan.id}"]`).click();
  await target.locator('#constructionDrawingList').waitFor();
 }
 const form=page.locator('#modalForm'),list=page.locator('#constructionDrawingList');
 async function upload(files){if(!(await form.locator('[name="drawingContractServiceId"]').inputValue()))await form.locator('[name="drawingContractServiceId"]').selectOption(ids.service);await form.locator('[name="drawingFiles"]').setInputFiles(files);await form.locator('[type="submit"]').click();await page.waitForFunction(()=>!document.querySelector('#modalForm').classList.contains('busy')&&document.querySelector('#attachmentUploadProgress')?.dataset.stage);}
 await load();await open();assert.match(await form.innerText(),/隔離測試/);
 assert.equal(await form.locator('[name="drawingContractServiceId"]').inputValue(),ids.service);
 assert.match(await page.locator('#constructionDrawingPathHint').innerText(),/^\/施工規劃圖\//);
 await upload([...smallFiles,largeFile]);
 assert.equal(await list.locator('li').count(),4,await form.innerText());
 let rows=(await db.query('select * from site_assets where construction_plan_id=$1',[plans[0].id])).rows;
 const customer=(await db.query('select name from customers where id=$1',[ids.customer])).rows[0],service=(await db.query('select name from contract_service_types where id=$1',[ids.service])).rows[0],project=(await db.query('select name from projects where id=$1',[plans[0].project_id])).rows[0];
 for(const file of [...smallFiles,largeFile]){
  const row=rows.find(row=>row.original_name===file.name);assert.ok(row,file.name);assert.deepEqual(nas.files.get(row.nas_path),file.buffer);assert.equal(row.sha256,createHash('sha256').update(file.buffer).digest('hex'));
  const parts=row.nas_path.split('/').filter(Boolean);assert.equal(parts.length,7);assert.deepEqual(parts.slice(0,4),['施工規劃圖',customer.name.normalize('NFKC'),service.name.normalize('NFKC'),project.name.normalize('NFKC')]);assert.match(parts[4],/^\d{4}-\d{2}-\d{2}$/);assert.equal(parts[5],plans[0].id);assert.equal(row.contract_service_type_id,ids.service);
 }
 assert.ok(nas.folders.has('/GUC-ERP'),'the existing work-log share is retained');
 assert.ok(modes.some(mode=>mode.mode==='upload_chunk'),'large drawing used actual chunk path');
 assert.ok(modes.some(mode=>mode.mode==='complete_file'));
 pass('Actual UI → NAS API → memory WebDAV hash verification → Gateway → PostgreSQL index, four originals including chunked 7 MiB DWG under /施工規劃圖/customer/service/project/date/plan');
 await form.evaluate(node=>node.scrollTop=0);await page.screenshot({path:fileURLToPath(new URL('desktop-engineering-drawings.png',output))});
 await page.reload();await page.waitForFunction(()=>state.currentUser&&scopeRequests.size===0);await open();assert.equal(await list.locator('li').count(),4);
 pass('Reload retains all four plan-bound attachment records');

 const secondService=randomUUID();await db.query("insert into contract_service_types(id,code,name) values($1,'drawing-second','監控設備（隔離）')",[secondService]);
 await db.query('insert into customer_contract_services(customer_id,service_type_id,is_active) values($1,$2,true)',[ids.customer,secondService]);
 await page.reload();await page.waitForFunction(()=>state.currentUser&&scopeRequests.size===0);await open();
 const servicePicker=form.locator('[name="drawingContractServiceId"]');assert.equal(await servicePicker.inputValue(),'');
 await form.locator('[name="drawingFiles"]').setInputFiles([smallFiles[0]]);const beforeMissingService=modes.length;await form.locator('[type="submit"]').click();
 assert.equal(await servicePicker.evaluate(select=>select.validity.valueMissing),true);assert.equal(modes.length,beforeMissingService);
 await servicePicker.selectOption(ids.service);await form.locator('[name="drawingFiles"]').setInputFiles([]);
 pass('Single linked contract is preselected; multiple contracts require explicit selection before NAS requests');

 const pngRow=rows.find(row=>row.original_name.endsWith('.png'));
 const popupPromise=page.waitForEvent('popup');await page.locator(`[data-drawing-view="${pngRow.id}"]`).click();const popup=await popupPromise;
 await popup.waitForURL(url=>url.protocol==='blob:',{waitUntil:'commit'});await popup.waitForFunction(()=>document.querySelector('img')?.naturalWidth>0);assert.equal(await popup.locator('img').evaluate(img=>img.naturalWidth),1);await popup.close();
 const pdfRow=rows.find(row=>row.original_name.endsWith('.pdf'));
 const pdfPopupPromise=page.waitForEvent('popup');await page.locator(`[data-drawing-view="${pdfRow.id}"]`).click();const pdfPopup=await pdfPopupPromise;
 await pdfPopup.waitForURL(url=>url.protocol==='blob:',{waitUntil:'commit'});await pdfPopup.close();
 const dxfRow=rows.find(row=>row.original_name.endsWith('.dxf'));
 const downloadPromise=page.waitForEvent('download');await page.locator(`[data-drawing-download="${dxfRow.id}"]`).click();const download=await downloadPromise;
 assert.equal(download.suggestedFilename(),'配線原圖.dxf');assert.deepEqual(await readFile(await download.path()),smallFiles[2].buffer);
 pass('Image renders in a new tab under production CSP; PDF opens; CAD download preserves original bytes and filename');

 const failedFile={name:'重試圖.pdf',mimeType:'application/pdf',buffer:pdfBytes};
 const goodFile={name:'新增圖.pdf',mimeType:'application/pdf',buffer:pdfBytes};
 failedNames.add(failedFile.name);await upload([goodFile,failedFile]);
 assert.match(await form.innerText(),/成功 1／2/);const beforeRetry=nas.calls.filter(call=>call.method==='PUT').length;
 failedNames.clear();await form.locator('[type="submit"]').click();await page.waitForFunction(()=>!document.querySelector('#modalForm').classList.contains('busy')&&document.querySelector('#attachmentUploadProgress')?.dataset.stage==='complete');
 assert.equal(nas.calls.filter(call=>call.method==='PUT').length-beforeRetry,1);
 assert.equal(await list.locator('li').count(),6);pass('Partial failure preserves successful file; retry writes only the failed file');

 const indexFile={name:'索引重試圖.pdf',mimeType:'application/pdf',buffer:pdfBytes};metadataFailures.add(indexFile.name);await upload([indexFile]);
 assert.match(await form.innerText(),/索引保存失敗/);assert.equal(await form.locator('[data-drawing-new-batch]').isVisible(),false);
 const beforeIndexRetry=nas.calls.filter(call=>call.method==='PUT').length;metadataFailures.clear();
 await form.locator('[type="submit"]').click();await page.waitForFunction(()=>!document.querySelector('#modalForm').classList.contains('busy')&&document.querySelector('#attachmentUploadProgress')?.dataset.stage==='complete');
 assert.equal(nas.calls.filter(call=>call.method==='PUT').length,beforeIndexRetry);assert.equal(await list.locator('li').count(),7);
 pass('Index failure retains NAS success and retries metadata without uploading again');

 page.once('dialog',dialog=>dialog.accept('2'));await upload([smallFiles[0]]);assert.equal(await list.locator('li').count(),8);
 const beforeCancel=nas.calls.filter(call=>call.method==='PUT').length;page.once('dialog',dialog=>dialog.accept('3'));await upload([smallFiles[0]]);
 assert.equal(nas.calls.filter(call=>call.method==='PUT').length,beforeCancel);assert.equal(await list.locator('li').count(),8);
 pass('Duplicate filename offers separate saved name or cancellation; cancellation performs no NAS write');

 const readAs=async(user,path)=>fixture.originalFetch(origin+path,{headers:{Authorization:'Bearer isolated-plan-'+user}});
 const allowed=await readAs('A','/api/inventory?scope=construction_drawings&plan_id='+plans[0].id);assert.equal(allowed.status,200);
 const scoped=await allowed.json();assert.equal(scoped.can_upload,false);assert.equal(scoped.drawings.length,8);
 const beforeDenied=nas.calls.length;
 assert.equal((await readAs('C','/api/inventory?scope=construction_drawings&plan_id='+plans[0].id)).status,403);
 assert.equal((await readAs('C','/api/nas?mode=drawing&asset_id='+pngRow.id)).status,403);
 assert.equal(nas.calls.length,beforeDenied,'denied read must not contact NAS');
 const deniedForm=new FormData();for(const [key,value]of Object.entries({mode:'prepare_batch',construction_plan_id:plans[0].id,project_id:plans[0].project_id,customer_id:scoped.customer_id,contract_service_type_id:ids.service,file_metadata:JSON.stringify([{name:'forged.pdf',size:pdfBytes.length}])}))deniedForm.append(key,value);
 const deniedUpload=await fixture.originalFetch(origin+'/api/nas',{method:'POST',headers:{Authorization:'Bearer isolated-plan-A'},body:deniedForm});assert.ok([400,403].includes(deniedUpload.status));assert.match((await deniedUpload.json()).error,/負責人|權限/);
 pass('Assigned worker may read; upload denied; unassigned user denied list and file before contacting NAS');

 await page.reload();await page.waitForFunction(()=>state.currentUser&&scopeRequests.size===0);await open(plans[1]);assert.equal(await list.locator('li').count(),0);
 pass('Each construction plan has its own attachment list');
 const thirtyFiles=Array.from({length:30},(_,index)=>({name:'批次工程圖-'+String(index+1).padStart(2,'0')+'.pdf',mimeType:'application/pdf',buffer:pdfBytes}));
 await form.locator('[name="drawingContractServiceId"]').selectOption(ids.service);
 await form.locator('[name="drawingFiles"]').setInputFiles([...thirtyFiles,{name:'超額31.pdf',mimeType:'application/pdf',buffer:pdfBytes}]);
 const beforeTooMany=modes.length;await form.locator('[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('#toast p').textContent.includes('1～30'));
 assert.equal(modes.length,beforeTooMany);await upload(thirtyFiles);assert.equal(await list.locator('li').count(),30);
 const batchRows=(await db.query('select * from site_assets where construction_plan_id=$1',[plans[1].id])).rows;assert.equal(batchRows.length,30);
 for(const row of batchRows){assert.deepEqual(nas.files.get(row.nas_path),pdfBytes);assert.equal(row.contract_service_type_id,ids.service);assert.ok(row.nas_path.startsWith('/施工規劃圖/'));}
 pass('Work-log-equivalent batch limits: 31 rejected before NAS; all 30 accepted and indexed with original bytes');

 // Hold an authentic NAS response, change the application's session, then
 // release the bytes: the previous user's file must never appear afterward.
 await page.reload();await page.waitForFunction(()=>state.currentUser&&scopeRequests.size===0);await open();
 let releaseDownload,downloadReady,downloadDone;
 const downloadGate=new Promise(resolve=>releaseDownload=resolve),downloadHeld=new Promise(resolve=>downloadReady=resolve),downloadFinished=new Promise(resolve=>downloadDone=resolve);
 const holdDownload=async route=>{const response=await route.fetch();downloadReady();await downloadGate;try{await route.fulfill({response});}catch{/* The session change intentionally aborts the original browser request. */}finally{downloadDone();}};
 await page.route('**/api/nas?mode=drawing*',holdDownload);
 const heldPopupPromise=page.waitForEvent('popup');await page.locator(`[data-drawing-view="${pngRow.id}"]`).click();const heldPopup=await heldPopupPromise;
 await downloadHeld;const popupClosed=heldPopup.waitForEvent('close');await page.evaluate(()=>storeAccessToken('isolated-plan-A'));await popupClosed;
 assert.equal(await form.locator('*').count(),0);assert.equal(await page.locator('#simpleModal').evaluate(node=>node.classList.contains('open')),false);
 releaseDownload();await downloadFinished;await page.unroute('**/api/nas?mode=drawing*',holdDownload);
 pass('Changing session during a verified NAS download closes the old viewer and clears the drawing dialog');

 await page.reload();await page.waitForFunction(()=>state.currentUser&&scopeRequests.size===0);await open();
 await page.evaluate(()=>{const request=nasFormRequest;globalThis.__drawingPendingRequests=0;nasFormRequest=async(...args)=>{globalThis.__drawingPendingRequests++;try{return await request(...args);}finally{globalThis.__drawingPendingRequests--;}};});
 let releaseUpload,uploadReady,uploadDone,heldUploadResult;
 const uploadGate=new Promise(resolve=>releaseUpload=resolve),uploadHeld=new Promise(resolve=>uploadReady=resolve),uploadFinished=new Promise(resolve=>uploadDone=resolve);
 const holdUpload=async route=>{
  const req=route.request();
  if(req.method()!=='POST')return route.continue();
  const body=await new Request(req.url(),{method:'POST',headers:req.headers(),body:req.postDataBuffer()}).formData();
  if(body.get('mode')!=='upload')return route.continue();
  const response=await route.fetch();heldUploadResult=await response.json();uploadReady();await uploadGate;
  try{await route.fulfill({response});}finally{uploadDone();}
 };
 await page.route('**/api/nas',holdUpload);
 const beforeRegistration=fixture.calls.filter(call=>call.name==='register_construction_drawings_v1').length;
 await form.locator('[name="drawingContractServiceId"]').selectOption(ids.service);
 await form.locator('[name="drawingFiles"]').setInputFiles([{name:'切換帳號時的工程圖.pdf',mimeType:'application/pdf',buffer:pdfBytes}]);
 await form.locator('[type="submit"]').click();await uploadHeld;
 assert.equal(heldUploadResult.uploaded.length,1);assert.ok(nas.files.has(heldUploadResult.uploaded[0].nas_path));
 await page.evaluate(()=>storeAccessToken('isolated-plan-A'));assert.equal(await form.locator('*').count(),0);
 releaseUpload();await uploadFinished;await page.waitForFunction(()=>globalThis.__drawingPendingRequests===0);
 assert.equal(fixture.calls.filter(call=>call.name==='register_construction_drawings_v1').length,beforeRegistration);
 assert.equal((await db.query('select count(*)::int n from site_assets where original_name=$1',['切換帳號時的工程圖.pdf'])).rows[0].n,0);
 assert.equal(await page.evaluate(()=>constructionDrawingBatches.size),0);
 await page.unroute('**/api/nas',holdUpload);
 pass('Session change after NAS write prevents metadata registration under the new identity and clears the cached batch');
 await context.close();
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),mobilePage=await mobile.newPage();
 mobilePage.on('pageerror',error=>errors.push(error.message));await load('owner',mobilePage);await open(plans[0],mobilePage);
 const box=await mobilePage.locator('#constructionDrawingList').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=391,JSON.stringify(box));
 await mobilePage.screenshot({path:fileURLToPath(new URL('mobile-engineering-drawings.png',output))});await mobile.close();pass('390 px mobile attachment list remains within viewport');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(fixture.external,[]);
 await writeFile(new URL('results.json',output),JSON.stringify({results,errors,external,productionDatabaseWrites:0,productionNasWrites:0},null,2));
}catch(error){console.error('Recent isolated SQL failures:',fixture.failures.slice(-5));throw error;}
finally{await browser?.close();await new Promise(resolve=>server.close(resolve));fixture.restore();await db.close();}
