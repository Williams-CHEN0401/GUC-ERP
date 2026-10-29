import assert from 'node:assert/strict';import {auditFixture,id} from './system-audit-fixture.mjs';import {randomUUID} from 'node:crypto';
const legacy={id:1,entity_type:'customers',entity_id:id(99),action:'delete',actor:null,created_at:'2026-08-16T02:26:54Z',before_data:{name:'已刪除客戶（隔離）'},after_data:null};
const f=await auditFixture({history:[legacy]}),{db}=f;const checks=[];
try{
 const old=(await db.query('select * from audit_logs where id=1')).rows[0];assert.equal(old.event_kind,'legacy');assert.equal(old.actor,null);assert.equal(old.before_data.name,legacy.before_data.name);checks.push('舊紀錄、刪除快照、缺失操作者原樣保留');
 const context={actor:'隔離管理員',actorId:id(1),requestId:randomUUID(),operation:'test_forms',system:'erp'};
 await db.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false),set_config('request.headers',$1,false)",[JSON.stringify({'x-guc-audit-context':JSON.stringify(context)})]);
 for(const table of f.schema){
  const keys=table.columns.filter(c=>c.type==='uuid').map(c=>c.name),row=Object.fromEntries(keys.map(k=>[k,randomUUID()]));
  const editable=table.columns.find(c=>c.type==='text'&&!['id','source','updated_by'].includes(c.name))||table.columns.find(c=>c.type==='boolean');
  if(editable)row[editable.name]=editable.type==='boolean'?false:'原內容';
  if(table.name==='accounting_worker_wages')row.daily_wage=12345;
  const names=Object.keys(row),values=Object.values(row),before=Number((await db.query('select count(*) n from audit_logs')).rows[0].n);
  await db.query('insert into '+table.name+'('+names.join(',')+') values('+names.map((_,i)=>'$'+(i+1)).join(',')+')',values);
  if(editable)await db.query('update '+table.name+' set '+editable.name+'=$1',[editable.type==='boolean'?true:'新內容']);
  else if(keys.length)await db.query('update '+table.name+' set '+keys[0]+'=$1',[randomUUID()]);
  await db.exec('delete from '+table.name);
  const r=(await db.query('select * from audit_logs order by id offset $1',[before])).rows;
  assert.deepEqual(r.map(r=>r.action),['insert','update','delete'],table.name);
  for(const e of r){assert.equal(e.actor_user_id,id(1));assert.equal(e.operation,'test_forms');assert.equal(e.request_id,context.requestId);assert(e.entity_key);assert.equal(e.event_kind,'change');}
  if(table.name==='accounting_worker_wages')assert(!JSON.stringify(r).includes('12345'));
 }
 checks.push('44 張表逐一新增、修改、刪除：132 筆實際 PostgreSQL 觸發器紀錄');
 const count=()=>db.query('select count(*) n from audit_logs').then(r=>Number(r.rows[0].n)),before=await count();
 await db.exec('begin');await db.query('insert into customers(id,name) values($1,$2)',[randomUUID(),'回復測試']);await db.exec('rollback');assert.equal(await count(),before);checks.push('交易回復不留下成功異動');
 await db.query("select set_config('request.jwt.claims','{\"role\":\"authenticated\"}',false)");await db.query('insert into customers(id,name) values($1,$2)',[id(500),'偽造者測試']);const forged=(await db.query('select * from audit_logs order by id desc limit 1')).rows[0];assert.equal(forged.actor_user_id,null);assert.equal(forged.actor,null);
 await db.exec('set role authenticated');await assert.rejects(db.exec("insert into audit_logs(action) values('insert')"));await assert.rejects(db.exec("delete from audit_logs"));await assert.rejects(db.exec('select audit_internal.capture_form()'));await db.exec('reset role');checks.push('偽造操作者標頭不可信；一般帳號不可偽造／刪除日誌');
 const req=(role,operation,payload)=>f.handler(new Request('http://isolated.invalid/functions/v1/inventory-gateway',{method:'POST',headers:{Authorization:'Bearer audit-test-'+role,'x-guc-audit-context':'forged'},body:JSON.stringify({operation,payload})}));
 let r=await req('admin','create_supplier',{name:'隔離供應商',note:'password=never-log-this'});assert.equal(r.status,201);const created=(await r.json()).result[0];assert(created.id);
 r=await req('admin','update_supplier',{id:created.id,row_version:1,name:'更新供應商'});assert.equal(r.status,201);
 r=await req('admin','update_supplier',{id:created.id,row_version:1,name:'舊版本'});assert.equal(r.status,409);
 f.users.worker.permissions[0].can_delete=false;
 r=await req('worker','delete_supplier',{id:created.id,row_version:2});assert.equal(r.status,403);
 const entries=(await db.query("select * from audit_logs where event_kind='request' order by id")).rows;assert.deepEqual(entries.map(x=>x.outcome),['completed','completed','failed','failed']);assert.equal(entries[3].actor_user_id,id(2));assert(!JSON.stringify(await db.query('select * from audit_logs')).includes('never-log-this'));
 checks.push('真實 Gateway 新增／修改供應商、舊版本衝突、拒絕刪除均記錄已驗證使用者及結果');
 for(const [role,status]of [['admin',200],['auditor',200],['worker',403],['unknown',401]]){const res=await f.handler(new Request('http://isolated.invalid/functions/v1/inventory-gateway?entity=audit_logs&include_history=1',{headers:{Authorization:'Bearer audit-test-'+role}}));assert.equal(res.status,status,role);if(status===200){const body=await res.json();assert(body.pagination.total>100);assert.equal(Date.parse(body.history.first_at),Date.parse('2026-08-16T02:26:54Z'));}}
 checks.push('管理員及既有 audit 權限可查所有使用者；無權限／未登入拒絕');
 const filtered=await f.handler(new Request('http://isolated.invalid/functions/v1/inventory-gateway?entity=audit_logs&outcome=failed&page_size=1',{headers:{Authorization:'Bearer audit-test-admin'}}));const page=await filtered.json();assert.equal(page.records.length,1);assert.equal(page.pagination.total,2);assert.equal(page.pagination.page_count,2);checks.push('執行結果篩選與分頁由資料庫執行');
 console.log(JSON.stringify({passed:true,tables:44,checks},null,2));
}finally{await f.close();}
