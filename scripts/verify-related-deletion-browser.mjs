
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {relatedDeletionServer} from './related-deletion-preview.mjs';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {db,server,contextCases,cases} = await relatedDeletionServer();
const output = process.env.DELETION_TEST_OUTPUT || new URL('../tmp/related-deletion/', import.meta.url);

let browser;
try {
  await mkdir(output, {recursive: true});
  await new Promise((resolve,reject) => {
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const report = [];
  const errors = [];
  browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
  const context = await browser.newContext({viewport: {width: 1450, height: 950}});
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/nas') return route.fulfill({json: {available: false}});
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const readLog = async id => (await db.query('select * from site_work_logs where id=$1',[id])).rows[0];
  const readEvents = async id => (await db.query('select * from maintenance_events where work_log_id=$1 order by id',[id])).rows;
  const load = async () => {
    await page.goto(origin+'/?page=worklogs');
    await page.waitForFunction(() => state.currentUser);
    if (await page.locator('#systemChooser.open').count()) await page.locator('[data-system-choice="erp"]').click();
    await page.waitForFunction(() => scopeRequests.size === 0 && !!document.querySelector('[data-work-log-row]'));
    assert.equal(await page.evaluate(() => PREVIEW_MODE), false);
  };
  await load();
  for (const [id,label] of [[contextCases.repairSourceId,'維修日誌含待辦'],[cases.showcase.targetId,'施工日誌含結清來源']]) {
    const before = await readLog(id), events = await readEvents(id);
    await page.evaluate(projectId => {
      document.querySelector('#worklogProjectFilter').value=projectId;
      renderSiteModules();
    }, before.project_id);
    const row = page.locator('[data-work-log-row="'+id+'"]');
    await row.locator('summary').click();
    page.once('dialog', async dialog => {
      await dialog.accept();
      assert.match(dialog.message(),/待辦清單/);
    });
    const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' &&
      response.request().postDataJSON()?.operation === 'delete_standalone_work_log');
    await row.locator('button[data-delete-work-log]').click();
    const response = await responsePromise;
    const body = await response.json();
    assert.equal(response.status(), 201, body.error || '');
    await row.waitFor({state: 'hidden'});
    const after = await readLog(id);
    assert.ok(after.deleted_at);
    assert.equal(after.row_version, before.row_version + 1);
    for (const field of ['pending_completions','pending_sources','pending_content','completed_content','summary']) {
      assert.deepEqual(after[field], before[field], 'preserved '+field);
    }
    assert.deepEqual(await readEvents(id), events);
    await load();
    assert.equal(await row.count(),0,'archived row must stay gone after reload');
    report.push(label+'可由操作選單封存，重新載入後仍移出清單');
  }
  assert.deepEqual(errors,[]);
  const result = JSON.stringify({passed: true, checks: report, javascriptErrors: errors, productionWrites: false},null,2);
  await writeFile(typeof output === 'string' ? output+'/browser-result.json' : new URL('browser-result.json',output),result);
  console.log(result);
} finally {
  if (browser) await browser.close();
  server.close();
  await db.close();
}
