// Shared synthetic ERP database + unchanged quotation list view/RPC. No network.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {definition,ids} from './worklog-save-fixture.mjs';
export async function attachQuotationList(db){
 const root=process.env.QUOTATION_REPO;if(!root)throw Error('QUOTATION_REPO is required');
 const read=name=>readFile(path.join(root,'supabase/migrations',name),'utf8');
 await db.exec(`
  alter table project_workers add column if not exists granted_by uuid,add column if not exists granted_at timestamptz;
  alter table quotations add quotation_number text,add billing_status text,add current_version_id uuid,add owner_user_id uuid,add updated_at timestamptz default now();
  create table quotation_versions(id uuid primary key,quote_date date,total_twd bigint,note text);
  create table quotation_access_users(app_user_id uuid primary key);
 `);
 await db.query('insert into quotation_access_users values($1)',[ids.actor]);
 await db.exec(definition(await read('20260902180000_quotation_management_system.sql'),'quotation_require_access_v1'));
 const inline=await read('20260915150411_quotation_inline_workflow.sql');
 await db.exec(definition(inline,'quotable_work_types_v1'));
 const view=inline.match(/create or replace view public\.quotation_work_content_rows_v1[\s\S]*?;/i)?.[0];
 if(!view)throw Error('Quotation view not found');await db.exec(view);
 await db.exec(definition(await read('20260911083331_work_content_quotation_sync.sql'),'quotation_work_list_v1'));
 // Execute the actual list-filter amendments, not a test rewrite of the query.
 for(const source of [await read('20260914120819_quotation_customer_departments.sql'),inline]){
  const blocks=source.match(/do \$\$[\s\S]*?end \$\$;/gi)||[];
  for(const block of blocks)if(block.includes("pg_get_functiondef('public.quotation_work_list_v1"))await db.exec(block);
 }
 await db.exec("revoke all on function quotation_work_list_v1(uuid,jsonb) from public,anon,authenticated;grant execute on function quotation_work_list_v1(uuid,jsonb) to service_role");
 return async(filters={})=>(await db.query('select quotation_work_list_v1($1,$2) data',[ids.actor,JSON.stringify(filters)])).rows[0].data;
}
