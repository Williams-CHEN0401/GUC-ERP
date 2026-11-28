import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {constructionPermissionsServer} from './construction-permissions-fixture.mjs';
import {planUsers} from './construction-plan-fixture.mjs';
import {sql,definition} from './worklog-save-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';

const f=await constructionPermissionsServer(), {db,plan}=f;
const rpc=(name,...args)=>callAsService(db,name,args);
const save=(payload,actor=planUsers.A)=>rpc('save_construction_work_log_v1',actor,plan.id,JSON.stringify(payload));
const read=async()=> (await rpc('construction_scope_v1',planUsers.A,plan.project_id)).construction_plans[0];
try {
  // Bring the historical fixture's item writer and report signature up to the release baseline.
  const assignments=await sql('20261016102818_worklog_plan_assignment.sql');
  for (const name of ['save_construction_work_log_v1','preserve_construction_item_v1','preserve_construction_log_v1']) await db.exec(definition(assignments,name));
  const workforce=await sql('20261015153853_worklog_workforce_pending_costs.sql');
  await db.exec(workforce.slice(0,workforce.indexOf('-- Wages are project-specific')).replaceAll('add column ','add column if not exists '));
  await db.exec('grant select,update on work_log_save_requests to service_role');
  f.additionalRpcs.push('save_work_log_workforce_v1','pending_work_log_items_v1');
  const report=await sql('20261117150501_dashboard_calendar_duplicate_transaction_rows.sql');
  await db.exec(definition(report,'work_content_report_v1'));
  await db.exec(await sql('20261124000130_construction_log_progress.sql'));
  await db.exec(await sql('20261125073532_equipment_matrix_workbook.sql'));
  f.additionalRpcs.push('import_construction_matrix_v1');
  const points=[{code:'暫編-CAM-001',location:'1F'},{code:'暫編-CAM-002',location:'1F'}];
  const configure=async(drawing_points,actor=planUsers.owner)=>{
    const row=(await db.query('select * from construction_plans where id=$1',[plan.id])).rows[0];
    return rpc('save_construction_plan_v1',actor,JSON.stringify({...row,items:plan.items,assignee_user_ids:[planUsers.A,planUsers.B],drawing_points}),false);
  };
  await configure(points);
  await assert.rejects(configure([...points,points[0]]),/重複/);
  await assert.rejects(configure([],planUsers.C));
  const [one,two]=plan.items.map(i=>i.id);
  const payload={...f.logPayload('A','2026-11-12'),construction_item_ids:[one,two],
    equipment_progress:[{code:points[0].code,item:one,status:'done'},{code:points[0].code,item:two,status:'working'}]};
  await assert.rejects(save(payload),/權限/);
  await f.grant();
  const first=(await save(payload)).work_log, replay=(await save(payload)).work_log;
  assert.equal(first.id,replay.id);
  assert.deepEqual(first.construction_item_ids,[one,two]);
  const current=await read();
  assert.deepEqual(current.drawing_points,points);
  assert.equal(current.work_dates.filter(d=>d===payload.log_date).length,1);
  assert(current.items.every(i=>i.log_dates.includes(payload.log_date)));
  assert.equal(current.completed_item_count,0);
  await f.grant({construction_logs_all:{can_view:false}});
  const others=await rpc('construction_scope_v1',planUsers.B,plan.project_id);
  assert(others.construction_plans[0].equipment_state.every(e=>!e.log_id && !e.log_date));
  await f.grant();
  assert(current.equipment_state.every(e=>e.log_id===first.id));
  assert.deepEqual(current.equipment_state.map(({code,item,status})=>({code,item,status})).sort((a,b)=>a.status.localeCompare(b.status)),payload.equipment_progress);
  assert.equal((await db.query('select count(*)::int n from site_work_logs where log_date=$1',[payload.log_date])).rows[0].n,1);
  await assert.rejects(save({...payload,construction_item_ids:[one],equipment_progress:[]}));
  await assert.rejects(save({...payload,request_id:randomUUID(),construction_item_ids:[randomUUID()]}),/子項目/);
  await assert.rejects(save({...payload,request_id:randomUUID(),equipment_progress:[{code:'unknown',item:one,status:'done'}]}),/設備編號/);
  await assert.rejects(configure([]),/保留/);
  const later={...payload,request_id:randomUUID(),log_date:'2026-11-13',equipment_progress:[{...payload.equipment_progress[1],status:'done'}]};
  const second=(await save(later)).work_log;
  assert((await read()).equipment_state.every(e=>e.status==='done'));
  await db.query('update site_work_logs set deleted_at=now() where id=$1',[second.id]);
  assert((await read()).equipment_state.some(e=>e.status==='working'));
  await assert.rejects(db.query('update construction_plan_items set deleted_at=now() where id=$1',[two]),/保留/);
  assert.equal((await db.query("select has_function_privilege('authenticated','save_construction_work_log_v1(uuid,uuid,jsonb)','execute') allowed")).rows[0].allowed,false);
  console.log('PASS legacy days, point import, authorization, replay, two items/one log, cell history, invalid scope, archive and private RPC');
  const payloadForImport=async(names,changes=[])=>({row_version:(await read()).row_version,request_id:randomUUID(),log_date:'2026-11-24',names,changes});
  const importMatrix=(actor,input)=>rpc('import_construction_matrix_v1',actor,plan.id,JSON.stringify(input));
  const rosterEdit=await payloadForImport([{code:'0007',name:'試作設備'}]);
  await assert.rejects(importMatrix(planUsers.A,rosterEdit),/權限/);
  await assert.rejects(importMatrix(planUsers.C,rosterEdit),/權限|找不到/);
  const namesOnly=await importMatrix(planUsers.owner,rosterEdit);
  assert.equal(namesOnly.log_id,null);
  const updated=await read();assert(updated.drawing_points.some(p=>p.code==='0007'&&p.name==='試作設備'));
  await configure(updated.drawing_points.map(({code,location})=>({code,location})));
  assert.equal((await read()).drawing_points.find(p=>p.code==='0007').name,'試作設備');
  const conflicting=await payloadForImport([{code:'0007',name:'不同名稱'}],[{code:points[0].code,item:one,status:'working',before:null}]);
  await assert.rejects(importMatrix(planUsers.owner,conflicting),/變更/);
  assert.equal((await read()).drawing_points.find(p=>p.code==='0007').name,'試作設備');
  const progress=await payloadForImport([],[{code:points[0].code,item:one,status:'working',before:'done'}]);
  const logCount=async()=>(await db.query('select count(*)::int n from site_work_logs')).rows[0].n;
  const beforeCount=await logCount();
  assert((await importMatrix(planUsers.A,progress)).log_id);
  await assert.rejects(importMatrix(planUsers.A,progress),/變更/);
  assert.equal(await logCount(),beforeCount+1);
  assert.equal((await db.query("select has_function_privilege('authenticated','import_construction_matrix_v1(uuid,uuid,jsonb)','execute') allowed")).rows[0].allowed,false);
  console.log('PASS matrix import: text codes, names without attendance, old-client preservation, scoped writes, atomic rollback and duplicate retry');
  if(process.argv.includes('--preview')){
    // Prepare an empty classroom demo after exercising the synthetic historical logs.
    await db.query('update site_work_logs set deleted_at=now() where construction_plan_id=$1 and deleted_at is null',[plan.id]);
    await db.exec('alter table work_assignments add column if not exists assigned_date date, add column if not exists appointment_date date, add column if not exists customer_id uuid');
    await db.exec(definition(report,'dashboard_calendar_v1'));
    f.additionalRpcs.push('dashboard_calendar_v1');
    await db.query("insert into role_permissions(role_code,module,can_view,can_create,can_update,can_delete) values('plan_owner','data_export',true,false,false,false) on conflict(role_code,module) do update set can_view=true");
    const serve=f.server.listeners('request')[0];
    f.server.removeListener('request',serve);
    f.server.on('request',(req,res)=>{
      if (req.url.split('?')[0]==='/'){
        const end=res.end.bind(res);
        res.end=(body,...args)=>end(typeof body==='string'?body.replace('隔離測試：國立高雄大學／應用數學系','隔離測試：土庫國小一樓攝影機（暫編清冊）'):body,...args);
      }
      return serve(req,res);
    });
    await db.exec("alter table customers add column if not exists deleted_at timestamptz; alter table contract_service_types add column if not exists equipment_import_template jsonb");
    await db.query("update customers set name='土庫國小（示範）' where id=(select customer_id from projects where id=$1)",[plan.project_id]);
    await db.query("update construction_plans set content='配管作業' where id=$1",[plan.id]);
    await db.query("update construction_plan_items set title=case when id=$1 then '配管作業' else '設備安裝' end where construction_plan_id=$2",[one,plan.id]);
    const demoPoints=Array.from({length:61},(_,i)=>({code:'暫編-CAM-'+String(i+1).padStart(3,'0'),name:'一樓攝影機 '+String(i+1).padStart(3,'0'),location:'1F'}));
    const latest=(await db.query('select * from construction_plans where id=$1',[plan.id])).rows[0];
    await db.query("update projects set name='一樓攝影機工程（隔離示範）' where id=$1",[plan.project_id]);
    const columns=(await db.query('select * from construction_plan_items where construction_plan_id=$1 order by sort_order',[plan.id])).rows;
    await rpc('save_construction_plan_v1',planUsers.owner,JSON.stringify({...latest,items:columns,assignee_user_ids:[planUsers.A,planUsers.B],drawing_points:demoPoints}),false);
    const {constructionDrawingsServer}=await import('./construction-drawings-fixture.mjs');
    await constructionDrawingsServer(f,[latest]);
    await db.exec(await sql('20261124151410_construction_drawing_markers.sql'));
    await db.exec(await sql('20261126022719_construction_project_roster.sql'));
    f.additionalRpcs.push('save_construction_drawing_marker_v1','save_construction_roster_v1');
    // 工作管理第二版：子項目指派、批次建立與工程圖管理。
    await db.exec(await sql('20261127140000_construction_equipment_v2.sql'));
    f.additionalRpcs.push('assign_construction_item_equipment_v1','batch_construction_roster_v1','manage_construction_drawing_v1');
    // 工作管理第三版：設備轉移與工程圖指定顯示設備。另建第二個施工主項目與第二種承攬類型，供轉移與分類查看。
    await db.exec(await sql('20261128120000_construction_roster_transfer_drawing_devices.sql'));
    f.additionalRpcs.push('assign_construction_drawing_equipment_v1','transfer_construction_equipment_v1');
    const secondPlan=await rpc('save_construction_plan_v1',planUsers.owner,JSON.stringify({id:randomUUID(),project_id:plan.project_id,construction_date:latest.construction_date,content:'設備安裝（二樓）',status:'pending',planned_days:5,notes:'隔離示範：轉移與分類測試',assignee_user_ids:[planUsers.A],items:[{id:randomUUID(),title:'二樓攝影機安裝',sort_order:0,start_day:1,planned_days:3},{id:randomUUID(),title:'二樓廣播喇叭安裝',sort_order:1,start_day:2,planned_days:3}],drawing_points:[...Array.from({length:8},(_,i)=>({code:'CAM2F-'+String(i+1).padStart(2,'0'),name:'二樓攝影機 '+(i+1),type:'監視攝影機',location:'2F'})),...Array.from({length:4},(_,i)=>({code:'SPK-'+String(i+1).padStart(2,'0'),name:'二樓廣播喇叭 '+(i+1),type:'廣播喇叭',location:'2F'}))]}),false);
    const customer=(await db.query('select customer_id from projects where id=$1',[plan.project_id])).rows[0].customer_id;
    const services=(await db.query('select id,name from contract_service_types where is_active order by sort_order,name')).rows;
    console.log('preview services',JSON.stringify(services.map(s=>s.name)),'second plan',secondPlan?.id||'');
    for(const [code,name,order] of [['surveillance','監視系統（隔離）',91],['broadcast','廣播系統（隔離）',92]]){
      if(services.some(s=>s.name===name))continue;
      const id=randomUUID();
      await db.query('insert into contract_service_types(id,code,name,is_active,sort_order) values($1,$2,$3,true,$4)',[id,code,name,order]).catch(e=>console.log('service type',e.message));
      await db.query('insert into customer_contract_services(customer_id,service_type_id,is_active) values($1,$2,true)',[customer,id]).catch(e=>console.log('service link',e.message));
    }
    f.server.listen(Number(process.env.PROGRESS_PORT||4635),'127.0.0.1',()=>console.log('Isolated preview listening'));
    await new Promise(resolve=>f.server.once('close',resolve));
  }
} finally { await db.close(); }
