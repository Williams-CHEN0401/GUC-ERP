// Isolated PostgreSQL-WASM verification; never connects to a remote database.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;

    create table public.customers(id uuid primary key);
    create table public.site_work_logs(id uuid primary key, summary text);
    create table public.customer_contract_services(customer_id uuid, service_type_id uuid);
    create table public.product_categories(id uuid primary key, is_active boolean not null default true);
    create table public.inventory_items(id uuid primary key, category_id uuid references public.product_categories);
    create table public.app_users(id uuid primary key, display_name text, is_active boolean not null default true);
    create table public.phone_terminal_versions(id uuid primary key, version_no integer not null);
    create table public.equipment_registry(
      id uuid primary key,
      customer_id uuid not null,
      service_id uuid not null,
      source_table text not null,
      source_id uuid not null,
      status text not null default 'active'
    );
    create table public.maintenance_events(
      id uuid primary key default gen_random_uuid(),
      work_log_id uuid not null references public.site_work_logs,
      service_id uuid not null,
      event_type text not null,
      occurred_at date not null,
      description text not null,
      cause text,
      result text not null,
      notes text,
      inventory_category_id uuid references public.product_categories,
      inventory_item_id uuid references public.inventory_items,
      phone_terminal_version_id uuid references public.phone_terminal_versions,
      status text not null default 'active',
      row_version integer not null default 1,
      created_by uuid,
      updated_by uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table public.maintenance_event_equipment(
      event_id uuid references public.maintenance_events,
      equipment_id uuid references public.equipment_registry,
      primary key(event_id,equipment_id)
    );
    create table public.maintenance_event_workers(
      event_id uuid references public.maintenance_events,
      user_id uuid references public.app_users,
      primary key(event_id,user_id)
    );
    create table public.repair_items(
      id uuid primary key default gen_random_uuid(),
      customer_id uuid,
      inventory_item_id uuid,
      notes text,
      received_on date,
      quantity numeric,
      status text,
      issue_description text,
      source_maintenance_event_id uuid,
      source text,
      updated_by text
    );
    create table public.audit_logs(
      id bigint generated always as identity primary key,
      entity_type text,
      entity_id uuid,
      action text,
      before_data jsonb,
      after_data jsonb,
      source text,
      actor text
    );

    create function public.assert_work_log_access_v1(uuid,uuid,uuid,text)
    returns void language plpgsql as $$ begin return; end; $$;
    create function public.upsert_customer_project_work_log_v3(
      uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,text
    ) returns jsonb language plpgsql as $$
    declare v_id uuid := coalesce($1,gen_random_uuid());
    begin
      insert into public.site_work_logs(id,summary) values(v_id,$8)
      on conflict(id) do update set summary=excluded.summary;
      return jsonb_build_object('work_log',jsonb_build_object('id',v_id));
    end;
    $$;
    create function public.test_increment_event_version()
    returns trigger language plpgsql as $$
    begin new.row_version=old.row_version+1; return new; end;
    $$;
    create trigger test_increment_event_version
    before update on public.maintenance_events
    for each row execute function public.test_increment_event_version();
  `);

  const migration=await readFile(new URL('../supabase/migrations/20260914130833_add_maintenance_handling_process.sql',import.meta.url),'utf8');
  await db.exec(migration);

  const customer=randomUUID(),service=randomUUID(),actor=randomUUID(),equipment=randomUUID();
  await db.query('insert into public.customers values($1)',[customer]);
  await db.query('insert into public.customer_contract_services values($1,$2)',[customer,service]);
  await db.query("insert into public.app_users values($1,'測試員',true)",[actor]);
  await db.query("insert into public.equipment_registry values($1,$2,$3,'site_devices',$1,'active')",[equipment,customer,service]);

  const call=`select public.upsert_customer_project_work_log_with_maintenance_v1(
    $1,$2,null,$3,'處理流程測試','2026-09-14','維修紀錄','檢查異常','','in_progress',
    array[$4::uuid],$4,$5::jsonb,'fixture'
  ) result`;
  const event={
    service_id:service,
    event_type:'LINE_REPAIR',
    occurred_at:'2026-09-14',
    description:'檢查異常',
    cause:'線路接觸不良',
    handling_process:'重新壓接並逐線測試',
    result:'檢查異常',
    notes:'測試',
    equipment_ids:[equipment],
    worker_user_ids:[]
  };
  const save=async(id,rowVersion,value)=>(await db.query(call,[id,rowVersion,customer,actor,JSON.stringify([value])])).rows[0].result;
  const created=await save(null,null,event);
  const eventId=created.maintenance_event_ids[0],workLogId=created.work_log.id;
  let stored=(await db.query('select * from public.maintenance_events where id=$1',[eventId])).rows[0];
  assert.equal(stored.cause,'線路接觸不良');
  assert.equal(stored.handling_process,'重新壓接並逐線測試');
  assert.equal(stored.row_version,1);

  const updated={...event,id:eventId,row_version:stored.row_version,handling_process:'更換接頭後複測'};
  await save(workLogId,null,updated);
  stored=(await db.query('select * from public.maintenance_events where id=$1',[eventId])).rows[0];
  assert.equal(stored.handling_process,'更換接頭後複測');
  assert.equal(stored.row_version,2);

  const legacy={...event,id:eventId,row_version:stored.row_version};
  delete legacy.handling_process;
  await save(workLogId,null,legacy);
  stored=(await db.query('select * from public.maintenance_events where id=$1',[eventId])).rows[0];
  assert.equal(stored.handling_process,'更換接頭後複測','older clients must not clear the new field');

  const history=(await db.query("select public.get_equipment_history_v1('site_devices',$1) result",[equipment])).rows[0].result;
  assert.equal(history.events[0].cause,'線路接觸不良');
  assert.equal(history.events[0].handling_process,'更換接頭後複測');
  assert.ok((await db.query("select after_data->>'handling_process' value from public.audit_logs where entity_type='maintenance_events' order by id desc limit 1")).rows[0].value);

  await assert.rejects(
    save(workLogId,null,{...legacy,row_version:stored.row_version,handling_process:'x'.repeat(2001)}),
    /設備維修事件內容/
  );
  assert.equal((await db.query('select handling_process from public.maintenance_events where id=$1',[eventId])).rows[0].handling_process,'更換接頭後複測');
  assert.equal((await db.query("select has_function_privilege('anon','public.upsert_customer_project_work_log_with_maintenance_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text)','EXECUTE') allowed")).rows[0].allowed,false);
  assert.equal((await db.query("select has_function_privilege('service_role','public.upsert_customer_project_work_log_with_maintenance_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text)','EXECUTE') allowed")).rows[0].allowed,true);

  console.log('PASS migration stores, updates, preserves, audits and exposes handling_process with existing RPC security');
} finally {
  await db.close();
}
