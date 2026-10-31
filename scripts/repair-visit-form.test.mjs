import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const named=name=>app.split(/\r?\n/).find(line=>line.startsWith('function '+name+'('));
function context(){
 const payload={id:null,project_id:null,project_name:'電話查修',customer_id:'customer',department_id:'dept',log_date:'2026-09-15',time_period:'上午',work_type:'維修紀錄',status:'in_progress',summary:'檢查',worker_user_ids:['worker'],maintenance_events:[]};
 const saved={id:'log',projectId:'new',title:'電話查修260915-2',log_date:payload.log_date,time_period:payload.time_period,work_type:payload.work_type,status:payload.status,summary:payload.summary,workerIds:['worker']};
 const result={work_log:{id:'log'},project:{id:'new',name:saved.title,customer_id:'customer',department_id:'dept'},new_work_created:true};
 const ctx=vm.createContext({state:{siteData:{logs:[saved]},projects:['new','original'].map(id=>({id,customerId:'customer',departmentId:'dept'}))},savedWorkLogId:r=>r.work_log.id,byId:(rows,id)=>rows.find(row=>row.id===id),maintenanceSaveMatches:()=>true,PREVIEW_MODE:true});
 vm.runInContext(named('workLogDepartmentId')+'\n'+named('workLogMatchesSave')+'\n'+named('repairVisitName')+'\n'+app.slice(app.indexOf('async function verifySavedWorkLog('),app.indexOf('function nasFormRequest(')),ctx);
 return {ctx,payload,saved,result};
}
test('manual work suffix passes save reread for every daily type; source payload is not mutated',async()=>{
 for(const type of ['維修紀錄','送貨','工程施工','文書作業','場勘','維護保養']){const {ctx,payload,result,saved}=context();payload.work_type=type;saved.work_type=type;assert.equal((await ctx.verifySavedWorkLog(result,payload)).title,'電話查修260915-2');assert.equal(payload.project_id,null);assert.equal(payload.project_name,'電話查修');}
});
test('repair save rejects wrong customer, department, naming, workers and reread identity',async()=>{
 for(const mutate of [r=>r.result.project.customer_id='other',r=>r.result.project.department_id='other',r=>r.result.project.name='電話查修260914',r=>r.result.project.name='電話查修260915-1',r=>r.saved.workerIds=[],r=>r.saved.projectId='original']){
  const row=context();mutate(row);await assert.rejects(row.ctx.verifySavedWorkLog(row.result,row.payload),/不一致/);
 }
});
test('manual creation requires the new backend contract; explicit existing work retains strict ID checks',async()=>{
 const {ctx,payload,saved,result}=context();delete result.new_work_created;await assert.rejects(ctx.verifySavedWorkLog(result,payload),/不一致/);
 payload.project_id='original';saved.projectId='original';saved.title=payload.project_name;await ctx.verifySavedWorkLog(result,payload);
 await assert.rejects(ctx.verifySavedWorkLog(result,{...payload,project_name:'other'}),/不一致/);
});
test('preview naming mirrors backend date and same-day suffix rules',()=>{
 const {ctx}=context(),names=['電話查修','電話查修260915','電話查修260915-2'];
 assert.equal(ctx.repairVisitName('電話查修','2026-09-15',names),'電話查修260915-3');
 assert.equal(ctx.repairVisitName('新工作','2026-09-15',names),'新工作');
 const long='長'.repeat(119);assert.throws(()=>ctx.repairVisitName(long,'2026-09-15',[long]),/120/);
});
