import {titlePickerDatabase} from './worklog-title-fixture.mjs';
import {sql,ids,definition} from './worklog-save-fixture.mjs';
export const catalogMigration='20260916102132_contract_service_catalog_management.sql';
export async function contractCatalogDatabase({fixed=true}={}){
 const db=await titlePickerDatabase();
 await db.exec('alter table customer_contract_services add created_by uuid,add created_at timestamptz default now()');
 const baseline=await sql('20260828000200_standalone_work_logs_contracts_accounts_nas.sql');
 await db.exec(baseline.slice(0,baseline.indexOf('alter table public.site_work_logs')));
 await db.query("insert into contract_service_types(id,code,name,sort_order) values($1,'computer','電腦設備（測試承攬）',80)",[ids.service]);
 await db.exec(`
 alter table customers add phone text,add email text,add address text,add note text,add source text,add updated_by text,add row_version integer default 1;
 create trigger customer_version before update on customers for each row execute function test_version();
 alter table customer_contract_services add is_active boolean default true;
 alter table customer_contract_services add primary key(customer_id,service_type_id),add foreign key(service_type_id) references contract_service_types(id) on delete restrict;
 alter table sites add contract_service_type_id uuid references contract_service_types(id);
 alter table equipment_registry add foreign key(service_id) references contract_service_types(id) on delete restrict;
 alter table maintenance_events add foreign key(service_id) references contract_service_types(id) on delete restrict;
 alter table phone_terminal_versions add service_id uuid references contract_service_types(id);
 create table phone_terminal_import_logs(id uuid primary key default gen_random_uuid(),contract_service_type_id uuid references contract_service_types(id) on delete restrict);
 grant select on phone_terminal_import_logs to service_role;
 `);
 const audit=(await sql('20260906152432_audit_context_and_query_indexes.sql')).match(/create or replace function audit_internal.capture_links\(\)[\s\S]*?end \$\$;/)[0];
 await db.exec(audit);
 await db.exec('create trigger contract_service_types_context_audit after insert or update or delete on contract_service_types for each row execute function audit_internal.capture_links()');
 await db.exec(definition(baseline,'update_customer_with_contracts_v1'));
 await db.exec('revoke all on function update_customer_with_contracts_v1(uuid,integer,text,text,text,text,text,text,text[],text) from public,anon,authenticated;grant execute on function update_customer_with_contracts_v1(uuid,integer,text,text,text,text,text,text,text[],text) to service_role');
 if(fixed)await db.exec(await sql(catalogMigration));
 return db;
}
export async function catalogCall(db,action,row,name,order=1000){
 await db.exec('set role service_role');
 try{return(await db.query('select to_jsonb(manage_contract_service_type_v1($1,$2,$3,$4,$5,$6)) result',[action,row?.id??null,row?.row_version??null,name,order,'fixture-admin'])).rows[0].result;}
 finally{await db.exec('reset role');}
}
