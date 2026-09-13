// Real ERP UI and production CSP, served with synthetic, read-only API responses.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture} from './report-dates-preview-server.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=new URL('../tmp/audit-dialog/',import.meta.url);
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const configuration=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
const securityHeaders=configuration.headers[0].headers;
const records=[{
  id:'audit-1',actor:'測試管理員',action:'UPDATE',entity_type:'maintenance_events',
  created_at:'2026-09-13T13:31:29Z',entity_id:'00000000-0000-4000-8000-000000000001',
  source_ip:'192.0.2.10',request_id:'synthetic-audit-request',
  user_agent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '+ '測試瀏覽器識別資訊'.repeat(18),
  before_data:{description:'原設定',note:'舊備註',password:'hidden-before'},
  after_data:{description:('已更新設備設定，確認運作正常。\n').repeat(30),note:'<img src=x onerror=alert(1)>',password:'hidden-after'},
},{id:'audit-2',actor:'測試檢視者',action:'LOGIN',entity_type:'session',created_at:'2026-09-12T02:00:00Z'}];

async function fixtureServer(baseline=false){
  const original=new Map();
  if(baseline)for(const file of ['app.js','index.html','interface-theme.css']){
    original.set('/'+file,execFileSync('git',['-c',`safe.directory=${root.replace(/\\/g,'/').replace(/\/$/,'')}`,'show',`651a704dbcabb64a3a814e75f0a7ddf8913bbc8e:${file}`],{cwd:root}));
  }
  let writes=0;
  const server=createServer(async(req,res)=>{
    for(const header of securityHeaders)res.setHeader(header.key,header.value);
    res.setHeader('Cache-Control','no-store');
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method!=='GET'){writes++;res.writeHead(403);res.end();return;}
    if(url.pathname==='/api/public-config'){
      res.setHeader('Content-Type','application/javascript');
      res.end('globalThis.GUC_PUBLIC_CONFIG={};sessionStorage.setItem("GUC_ERP_ACCESS_TOKEN","synthetic-local-session");');return;
    }
    if(url.pathname==='/api/inventory'){
      const body=url.searchParams.get('entity')==='audit_logs'
        ?{records,pagination:{total:records.length,page_count:1}}
        :{...fixture,scope:url.searchParams.get('scope')||'session'};
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));return;
    }
    if(url.pathname.startsWith('/api/')){res.writeHead(403);res.end('{}');return;}
    const relative=url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname);
    const file=path.resolve(root,'.'+relative);
    if(!file.startsWith(root)||!(relative==='/index.html'||/^\/[\w-]+\.(js|css)$/.test(relative)||relative.startsWith('/assets/'))){res.writeHead(404);res.end();return;}
    try{
      const content=original.get(relative)||await readFile(file);
      res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':'text/html');
      res.end(content);
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {base:`http://127.0.0.1:${server.address().port}`,writes:()=>writes,close:()=>new Promise(resolve=>server.close(resolve))};
}

const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
await mkdir(output,{recursive:true});
const results=[];
async function openLogs(server,options={}){
  const context=await browser.newContext({viewport:{width:1440,height:960},timezoneId:'Asia/Taipei',...options});
  await context.route('**/*',route=>new URL(route.request().url()).origin===server.base?route.continue():route.abort());
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    globalThis.auditCspViolations=[];
    document.addEventListener('securitypolicyviolation',event=>globalThis.auditCspViolations.push(event.violatedDirective));
  });
  await page.goto(server.base+'/?page=settings',{waitUntil:'networkidle'});
  await page.locator('#settings [data-tab="logs"]').click();
  await page.locator('#logTable [data-audit-detail]').first().waitFor();
  return {context,page,errors};
}
try{
  // Reproduce the reported regression without changing the production CSP.
  const baseline=await fixtureServer(true);
  try{
    const {context,page}=await openLogs(baseline);
    await page.locator('#logTable [data-audit-detail]').first().click();
    await page.locator('#auditDialog button').click();
    assert.equal(await page.locator('#auditDialog').evaluate(node=>node.open),true);
    assert.ok((await page.evaluate(()=>auditCspViolations)).includes('script-src-attr'));
    results.push('Original close button failure reproduced under production CSP.');
    await context.close();
  }finally{await baseline.close();}
  const server=await fixtureServer();
  try{
    for(const width of [1440,390]){
      const {context,page,errors}=await openLogs(server,{viewport:{width,height:900},hasTouch:width===390,isMobile:width===390});
      const dialog=page.locator('#auditDialog'),row=page.locator('#logTable [data-audit-row]').first();
      assert.equal(await dialog.evaluate(node=>node.open),false);
      if(width===390)await row.locator('td').nth(1).tap();else await row.locator('td').nth(1).dblclick();
      await dialog.waitFor({state:'visible'});
      assert.match(await page.locator('#auditDetailTitle').innerText(),/測試管理員 修改了「設備維修履歷」/);
      assert.equal(await dialog.locator('img').count(),0,'audit content must remain escaped text');
      assert.doesNotMatch(await dialog.innerText(),/hidden-before|hidden-after/);
      const layout=await dialog.evaluate(node=>{
        const box=node.getBoundingClientRect(),body=node.querySelector('#auditDetailBody'),footer=node.querySelector('footer').getBoundingClientRect();
        const css=getComputedStyle(node),button=getComputedStyle(node.querySelector('footer button'));
        return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,viewport:innerWidth,height:innerHeight,overflow:body.scrollWidth>body.clientWidth,scrollable:body.scrollHeight>body.clientHeight,footerBottom:footer.bottom,color:css.color,background:css.backgroundColor,buttonHeight:node.querySelector('footer button').getBoundingClientRect().height,buttonRadius:button.borderRadius,buttonFont:button.fontSize};
      });
      assert.ok(layout.left>=0&&layout.right<=layout.viewport&&layout.top>=0&&layout.bottom<=layout.height,JSON.stringify(layout));
      assert.equal(layout.overflow,false);assert.equal(layout.scrollable,true);
      assert.ok(layout.footerBottom<=layout.height&&layout.buttonHeight>=44);
      assert.equal(layout.background,'rgb(255, 254, 250)');assert.equal(layout.color,'rgb(48, 59, 52)');
      assert.equal(layout.buttonRadius,'5px');assert.equal(layout.buttonFont,'14px');
      await page.screenshot({path:fileURLToPath(new URL(`audit-${width}.png`,output)),fullPage:true});
      await dialog.locator('footer button').click();
      await dialog.waitFor({state:'hidden'});
      assert.equal(await row.evaluate(node=>document.activeElement===node),true,'focus returns to the triggering row');
      await row.press('Enter');await dialog.waitFor({state:'visible'});
      await dialog.getByRole('button',{name:'關閉詳細內容'}).click();await dialog.waitFor({state:'hidden'});
      const button=row.locator('[data-audit-detail]');await button.click();await dialog.waitFor({state:'visible'});
      await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
      assert.equal(await button.evaluate(node=>document.activeElement===node),true);
      await page.locator('#logTable [data-audit-detail]').nth(1).click();await dialog.waitFor({state:'visible'});
      assert.match(await dialog.innerText(),/此筆舊紀錄未提供/);assert.match(await dialog.innerText(),/沒有欄位變更內容/);
      assert.doesNotMatch(await dialog.innerText(),/已更新設備設定/,'reopening must replace prior details');
      await dialog.locator('footer button').click();await dialog.waitFor({state:'hidden'});
      assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>auditCspViolations),[]);
      results.push(`${width}px: row ${width===390?'touch':'double-click'}, Enter, detail button, both close buttons, Escape, focus restoration, long content, legacy data, escaping and production CSP passed.`);
      await context.close();
    }
    assert.equal(server.writes(),0,'viewing and closing audit details never writes data');
  }finally{await server.close();}
}finally{await browser.close();}
await writeFile(new URL('results.json',output),JSON.stringify(results,null,2));
console.log(results.join('\n'));
