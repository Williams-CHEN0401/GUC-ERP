import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const sandbox={};
vm.runInNewContext(readFileSync(new URL('../project-report.js',import.meta.url),'utf8'),sandbox);
const {projectDateRange,nextCompletionDate,taipeiDate}=sandbox.GUCProjectReport;
const range=p=>JSON.parse(JSON.stringify(projectDateRange(p)));
test('report dates use creation and completion, not editable project date or last update',()=>{
  assert.deepEqual(range({createdAt:'2026-09-01T16:10:00Z',projectDate:'2026-08-01',updatedRaw:'2026-09-12T12:00:00Z',completedOn:'2026-09-09',status:'completed'}),{from:'2026-09-02',to:'2026-09-09'});
});
test('unfinished, unknown legacy completion and no selection leave the end unbounded',()=>{
  assert.equal(range({status:'in_progress',completedOn:'2026-09-03'}).to,'');
  assert.deepEqual(range({createdAt:'2026-08-01T00:00:00Z',status:'completed',updatedRaw:'2026-09-12T00:00:00Z'}),{from:'2026-08-01',to:''});
  assert.deepEqual(range(null),{from:'',to:''});
  assert.equal(taipeiDate('invalid'),'');
});
test('completion is stable across edits, resets on reopening, and dates use Taipei midnight',()=>{
  const completed=nextCompletionDate({status:'in_progress'},'completed','2026-09-11T16:01:00Z');
  assert.equal(completed,'2026-09-12');
  assert.equal(nextCompletionDate({status:'completed',completedOn:completed},'completed','2026-09-20T00:00:00Z'),completed);
  assert.equal(nextCompletionDate({status:'completed',completedOn:completed},'in_progress'),'');
  assert.equal(nextCompletionDate({status:'in_progress'},'completed','2026-09-20T00:00:00Z'),'2026-09-20');
  assert.equal(nextCompletionDate(null,'completed','2026-09-11T15:59:59Z'),'2026-09-11');
  assert.equal(nextCompletionDate({status:'completed'},'completed','2026-09-20T00:00:00Z'),'');
});
test('date defaults reset on selection/status changes but survive tab switches and manual filtering',()=>{
  const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  const code=app.slice(app.indexOf('let projectReportDateContext='),app.indexOf('function reportUnitTotals'));
  const controls={'#materialProject':{value:'p1'},'#materialDateFrom':{value:''},'#materialDateTo':{value:''}};
  const projects=[{id:'p1',status:'completed',createdAt:'2026-09-01T16:01:00Z',completedOn:'2026-09-10'},{id:'p2',status:'in_progress',createdAt:'2026-09-03T00:00:00Z'}];
  const context=vm.createContext({GUCProjectReport:sandbox.GUCProjectReport,document:{querySelector:id=>controls[id]},state:{projects},byId:(rows,id)=>rows.find(r=>r.id===id)});
  vm.runInContext(code,context);
  const sync=()=>vm.runInContext('syncProjectReportDates()',context);
  sync();assert.equal(controls['#materialDateFrom'].value,'2026-09-02');assert.equal(controls['#materialDateTo'].value,'2026-09-10');
  controls['#materialDateFrom'].value='2026-09-05';sync();assert.equal(controls['#materialDateFrom'].value,'2026-09-05');
  projects[0].status='in_progress';sync();assert.equal(controls['#materialDateTo'].value,'');
  projects[0].status='completed';projects[0].completedOn='2026-09-12';sync();assert.equal(controls['#materialDateTo'].value,'2026-09-12');
  controls['#materialProject'].value='p2';sync();assert.equal(controls['#materialDateFrom'].value,'2026-09-03');assert.equal(controls['#materialDateTo'].value,'');
  controls['#materialProject'].value='';sync();assert.equal(controls['#materialDateFrom'].value,'');
  assert.match(app,/completedOn:r\.completed_on\|\|""/);
});
