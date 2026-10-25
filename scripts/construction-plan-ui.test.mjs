import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../construction-plan-ui.js',import.meta.url),'utf8');
function fixture(){
 const c=vm.createContext({document:{addEventListener(){}},state:{currentUser:{id:'A'},projectWorkers:[],constructionPlans:[],siteData:{logs:[]}},byId:(rows,id)=>rows.find(r=>r.id===id),canModule:()=>true,canAdmin:()=>false,esc:String,invalidatePrivateCache:()=>true,lastSnapshot:{}});
 c.hydrateSnapshot=value=>c.merged=value;vm.runInContext(readFileSync(new URL('../construction-checklist.js',import.meta.url),'utf8'),c);vm.runInContext(source,c);return c;
}
test('item completion is separate from actual days and exceeding duration does not complete a plan',()=>{
 const c=fixture();
 const normal=c.constructionProgress({planned_days:7,worked_days:3,item_count:7,completed_item_count:1,completion_percent:14.3});
 assert.match(normal,/3 \/ 7 天/);assert.match(normal,/14.3%/);assert.match(normal,/1 \/ 7/);
 const over=c.constructionProgress({planned_days:7,worked_days:8,item_count:7,completed_item_count:1,completion_percent:14.3});
 assert.match(over,/value="14.3"/);assert.doesNotMatch(over,/100%/);assert.match(over,/超出預計施工天數 1 天/);
 assert.doesNotMatch(c.constructionProgress({}),/<progress/);
});
test('contract dates accept optional fields and reject impossible or inverted dates',()=>{
 const c=fixture();
 for(const pair of [['',''],['','2026-12-31'],['2026-10-01',''],['2026-10-01','2026-12-31']])assert.doesNotThrow(()=>c.validateProjectContractDates(...pair));
 for(const pair of [['2026-02-30',''],['2026-11-01','2026-10-31']])assert.throws(()=>c.validateProjectContractDates(...pair),/履約/);
 const form={elements:{contractStartDate:{value:'2026-10-01'},contractEndDate:{value:'2026-12-31'}}};
 const project={contractStartDate:'2026-10-01',contractEndDate:'2026-12-31',rowVersion:4};
 assert.deepEqual(JSON.parse(JSON.stringify(c.collectProjectContractChange(form,project,true))),{});
 form.elements.contractEndDate.value='2026-11-30';assert.equal(c.collectProjectContractChange(form,project,true).project_row_version,4);
});
test('warning input requires both valid fields or neither; zero-percent target is valid',()=>{
 const c=fixture(),form=(d,p)=>({elements:{warningWorkDays:{value:d},warningMinProgress:{value:p}}});
 assert.equal(c.collectConstructionWarning(form('','')).warning_work_days,null);
 assert.equal(c.collectConstructionWarning(form('3','0')).warning_min_progress,0);
 assert.equal(c.collectConstructionWarning(form('3','30')).warning_work_days,3);
 for(const [d,p]of [['3',''],['','30'],['0','30'],['1.5','30'],['3651','30'],['3','101'],['3','NaN']])assert.throws(()=>c.collectConstructionWarning(form(d,p)));
});
test('construction eligibility uses stable enums, not display text',()=>{
 const c=fixture();
 for(const category of ['small_purchase','tender'])assert.equal(c.constructionEligible({rawType:'construction',constructionCategory:category}),true);
 for(const p of [{rawType:'repair',constructionCategory:'tender'},{rawType:'construction',constructionCategory:''},{rawType:'工程施工',constructionCategory:'小額採購'}])assert.equal(c.constructionEligible(p),false);
 assert.equal(c.constructionPlanButton({rawType:'repair'}),'');
});
test('plan affordances require existing project owner and module permissions',()=>{
 const c=fixture(),project={id:'P'};assert.equal(c.canManageConstruction(project),false);
 c.state.projectWorkers=[{projectId:'P',userId:'A'}];assert.equal(c.canManageConstruction(project),true);
 c.canModule=(_module,action)=>action!=='UPDATE';assert.equal(c.canManageConstruction(project),false);
});
test('new plan logs inherit date and project without prefilled notes or reporter attendance',()=>{
 const c=fixture();c.state.constructionPlans=[{id:'plan',project_id:'P',construction_date:'2026-10-10',content:'一樓配管'}];
 vm.runInContext('activeConstructionLogPlanId="plan"',c);
 assert.deepEqual(JSON.parse(JSON.stringify(c.constructionLogDefaults())),{projectId:'P',log_date:'2026-10-10',work_type:'工程施工',status:'in_progress',pending_content:'',completed_content:'',summary:'',workerIds:[],subcontractor_count:0});
});
test('reread removes archived/unauthorized logs and obsolete owners from cached project',()=>{
 const c=fixture();c.lastSnapshot={site_work_logs:[{id:'old',project_id:'P',construction_plan_id:'plan'},{id:'ordinary',project_id:'P',construction_plan_id:null},{id:'other',project_id:'Q',construction_plan_id:'other-plan'}],site_work_log_workers:[{work_log_id:'old',user_id:'A'}],project_workers:[{project_id:'P',user_id:'former-owner'},{project_id:'Q',user_id:'B'}]};
 c.mergeConstructionContext({projects:[{id:'P'}],site_work_logs:[{id:'new',project_id:'P',construction_plan_id:'plan'}],site_work_log_workers:[{work_log_id:'new',user_id:'A'}],project_workers:[{project_id:'P',user_id:'owner'}]});
 assert.deepEqual(Array.from(c.merged.site_work_logs,r=>r.id),['ordinary','other','new']);
 assert.deepEqual(Array.from(c.merged.site_work_log_workers,r=>r.work_log_id),['new']);
 assert.deepEqual(Array.from(c.merged.project_workers,r=>r.user_id),['B','owner']);
 c.invalidatePrivateCache=()=>false;assert.throws(()=>c.mergeConstructionContext({}),/權限已變更/);
});
