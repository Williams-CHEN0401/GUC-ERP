import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../construction-plan-ui.js',import.meta.url),'utf8');
function fixture(){
 const c=vm.createContext({document:{addEventListener(){}},state:{currentUser:{id:'A'},projectWorkers:[],constructionPlans:[],siteData:{logs:[]}},byId:(rows,id)=>rows.find(r=>r.id===id),canModule:()=>true,canAdmin:()=>false,esc:String,invalidatePrivateCache:()=>true,lastSnapshot:{}});
 c.hydrateSnapshot=value=>c.merged=value;vm.runInContext(source,c);return c;
}
test('progress shows accurate days and caps overrun bar without completing the plan',()=>{
 const c=fixture();
 const normal=c.constructionProgress({planned_days:7,completed_days:1,remaining_days:6,progress_percent:14.3,overrun_days:0});
 assert.match(normal,/已完成 1 天｜剩餘 6 天/);assert.match(normal,/14.3%/);
 const over=c.constructionProgress({planned_days:2,completed_days:3,remaining_days:0,progress_percent:150,overrun_days:1});
 assert.match(over,/overrun/);assert.match(over,/value="100"/);assert.match(over,/150%/);assert.match(over,/超出預計施工天數 1 天/);
 assert.doesNotMatch(c.constructionProgress({}),/<progress/);
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
test('existing log defaults inherit construction date, project and content',()=>{
 const c=fixture();c.state.constructionPlans=[{id:'plan',project_id:'P',construction_date:'2026-10-10',content:'一樓配管'}];
 vm.runInContext('activeConstructionLogPlanId="plan"',c);
 assert.deepEqual(JSON.parse(JSON.stringify(c.constructionLogDefaults())),{projectId:'P',log_date:'2026-10-10',work_type:'工程施工',status:'in_progress',pending_content:'一樓配管',completed_content:'',summary:'一樓配管',workerIds:['A']});
});
test('reread removes archived/unauthorized logs and obsolete owners from cached project',()=>{
 const c=fixture();c.lastSnapshot={site_work_logs:[{id:'old',project_id:'P',construction_plan_id:'plan'},{id:'ordinary',project_id:'P',construction_plan_id:null},{id:'other',project_id:'Q',construction_plan_id:'other-plan'}],site_work_log_workers:[{work_log_id:'old',user_id:'A'}],project_workers:[{project_id:'P',user_id:'former-owner'},{project_id:'Q',user_id:'B'}]};
 c.mergeConstructionContext({projects:[{id:'P'}],site_work_logs:[{id:'new',project_id:'P',construction_plan_id:'plan'}],site_work_log_workers:[{work_log_id:'new',user_id:'A'}],project_workers:[{project_id:'P',user_id:'owner'}]});
 assert.deepEqual(Array.from(c.merged.site_work_logs,r=>r.id),['ordinary','other','new']);
 assert.deepEqual(Array.from(c.merged.site_work_log_workers,r=>r.work_log_id),['new']);
 assert.deepEqual(Array.from(c.merged.project_workers,r=>r.user_id),['B','owner']);
 c.invalidatePrivateCache=()=>false;assert.throws(()=>c.mergeConstructionContext({}),/權限已變更/);
});
