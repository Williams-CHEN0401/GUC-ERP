import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Run against an isolated PostgreSQL WASM database, with a supplied read-only snapshot.
const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.resolve(process.env.FIELD_TEST_DATA_DIR || '../.tmp/field-terminals-20260911');
const siteDir = path.resolve(process.env.FIELD_TEST_SITE_DIR || '../GUC-Site-Data-field-0911');
const modulePath = process.env.PGLITE_MODULE || '../.tmp/optimization-tools/node_modules/@electric-sql/pglite/dist/index.js';
const {PGlite} = await import(pathToFileURL(path.resolve(modulePath)).href);
const {parseTerminalWorkbook,buildImportPreview} = await import(pathToFileURL(path.join(siteDir,'lib/phone-import.ts')).href);
const {fieldTerminalRows,compareFieldRows} = await import(pathToFileURL(path.join(siteDir,'lib/field-terminal-rows.ts')).href);
const {createTerminalWorkbook} = await import(pathToFileURL(path.join(siteDir,'lib/phone-export.ts')).href);
const snapshot = JSON.parse(await fs.readFile(path.join(dataDir,'system-snapshot.json'),'utf8'));
const fileName = 'A棟2樓_現場端端子資料.xlsx';
const file = await fs.readFile(path.join(dataDir,fileName));
const parsed = parseTerminalWorkbook(file,fileName);
assert.equal(parsed.rows.length,100);
assert.deepEqual(parsed.rows.map(row=>+row.slot),Array.from({length:100},(_,i)=>i+1));
assert.equal(parsed.rows.filter(row=>!row.extensionNumber).length,59);
assert.match(parsed.rows.find(row=>row.slot==='100').extensionNumber,/^0\d{9}$/);
const preview = buildImportPreview('field',parsed.rows,snapshot.extensions,snapshot.points);
assert.equal(preview.filter(row=>row.status==='error'||row.status==='skip').length,0);
const rows = preview.map(row=>({frame_name:row.frameName,board:row.board,slot:row.slot,terminal_position:row.terminalPosition,terminal_type:row.terminalType,
  extension_number:row.extensionNumber,building:row.building,floor:row.floor,installation_location:row.installationLocation,
  preview_status:row.status,phone_type:row.phoneType,existing_extension_id:row.existingExtensionId,
  source_sheet:row.sourceSheet,source_row:row.sourceRow,source_column:row.sourceColumn,raw:row.raw}));
const db = new PGlite();
const readSql = name=>fs.readFile(path.join(root,'supabase/migrations',name),'utf8');
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create table public.customers(id uuid primary key);
  create table public.contract_service_types(id uuid primary key,code text,is_active boolean);
  create table public.customer_contract_services(customer_id uuid references customers(id), service_type_id uuid references contract_service_types(id),primary key(customer_id,service_type_id));`);
const base=await readSql('20260830082440_create_secure_phone_data_module.sql');
await db.exec(base.slice(base.indexOf('create table if not exists public.phone_systems'),base.indexOf('create table if not exists public.phone_system_credentials')));
const optional=await readSql('20260831000200_phone_building_and_optional_extension.sql');
await db.exec(optional.slice(0,optional.indexOf('create or replace function'))+'commit;');
await db.exec(await readSql('20260831043000_phone_terminal_excel_import.sql'));
await db.exec(`alter table phone_terminal_points enable row level security; alter table phone_extensions enable row level security;
  revoke all on phone_terminal_points,phone_extensions from public,anon,authenticated;
  grant select,insert,update,delete on phone_terminal_points,phone_extensions to service_role;
  grant select,update on customer_contract_services to service_role; grant select on contract_service_types to service_role;`);
const customerId=snapshot.points[0].customer_id,serviceId=snapshot.points[0].contract_service_type_id;
await db.query('insert into customers values ($1)',[customerId]);
await db.query("insert into contract_service_types values ($1,'phone_system',true)",[serviceId]);
await db.query('insert into customer_contract_services values ($1,$2)',[customerId,serviceId]);
for(const [table,data] of [['phone_extensions',snapshot.extensions],['phone_terminal_points',snapshot.points]]) {
  for(const row of data) {
    const names=Object.keys(row);
    await db.query(`insert into ${table} (${names.join(',')}) values (${names.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));
  }
}
const beforeExtensions=JSON.stringify((await db.query('select * from phone_extensions order by id')).rows);
const beforeSystem=JSON.stringify((await db.query("select * from phone_terminal_points where endpoint_side='system' order by id")).rows);
await db.exec(await readSql('20260911092521_preserve_field_terminal_slots.sql'));
const invoke=async(input,customer=customerId)=> (await db.query('select import_phone_field_rows_v1($1,$2,$3,$4::jsonb,$5) as result',[customer,serviceId,fileName,JSON.stringify(input),'field-test'])).rows[0].result;
await db.exec('set role anon');
await assert.rejects(()=>invoke(rows),/permission denied/);
await assert.rejects(()=>db.query('select * from phone_terminal_points'),/permission denied/);
await db.exec('reset role; set role authenticated');
await assert.rejects(()=>invoke(rows),/permission denied/);
await db.exec('reset role; set role service_role');
await assert.rejects(()=>invoke(rows,'00000000-0000-4000-8000-000000000099'),/有效的電話系統承攬/);
const first=await invoke(rows);
assert.equal(first.failed,0,JSON.stringify(first.failure_reasons));
assert.equal(first.total,100); assert.equal(first.inserted+first.updated,100); assert.equal(first.empty_slots,59);
for(const result of first.rows) {
  const expected=preview.find(row=>+row.slot===result.slot);
  assert.equal(result.field_match_status,expected.fieldMatchStatus,`FIELD ${result.slot} preview/database status`);
  assert.equal(result.phone_type,expected.phoneType,`FIELD ${result.slot} handset type`);
}
const second=await invoke(rows);
assert.equal(second.inserted,0);assert.equal(second.updated,100);assert.equal(second.failed,0);
assert.deepEqual(second.rows.map(row=>row.terminal_id),first.rows.map(row=>row.terminal_id));
await db.exec('reset role');
assert.equal(JSON.stringify((await db.query('select * from phone_extensions order by id')).rows),beforeExtensions,'master extension data stays unchanged');
const systemAfter=(await db.query("select * from phone_terminal_points where endpoint_side='system' order by id")).rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['building_name','source_extension_number','source_phone_type','resolved_phone_type','field_match_status','field_match_message'].includes(key))));
assert.equal(JSON.stringify(systemAfter),beforeSystem,'system terminal data stays unchanged');
const stored=(await db.query("select * from phone_terminal_points where endpoint_side='field' and frame_name=$1 order by frame_position",[rows[0].frame_name])).rows;
assert.equal(stored.length,100);
const views=fieldTerminalRows(snapshot.extensions,stored).sort(compareFieldRows);
assert.deepEqual(views.map(item=>+item.point.slot_identifier),Array.from({length:100},(_,i)=>i+1));
const exported=parseTerminalWorkbook(createTerminalWorkbook(views,'field'),fileName);
assert.equal(exported.rows.length,100);assert.deepEqual(exported.rows.map(row=>row.extensionNumber),parsed.rows.map(row=>row.extensionNumber));
await fs.writeFile(path.join(dataDir,'verified-field-data.json'),JSON.stringify({customerId,serviceId,fileName,sourceSha256:'3C8F7E7781D908FC1974B2A58A7887118BD6AD6F67EE2CE620ADA5C69378C07D',first,second,preview,points:stored,extensions:snapshot.extensions}));

// Non-destructive transaction tests cover conflicts, blanks, repairs and forged client mappings.
await db.exec('begin; set role service_role');
const sample={...rows[1],frame_name:'測試棟 1樓 現場端',building:'測試棟',floor:'1樓',board:'1-1'};
const extra=await invoke([{...sample,slot:'1',extension_number:'999999',existing_extension_id:snapshot.extensions[0].id},
  {...sample,slot:'2',extension_number:''}, {...sample,slot:'3',extension_number:sample.extension_number}, {...sample,slot:'4',extension_number:sample.extension_number}]);
assert.equal(extra.failed,0);assert.equal(extra.inserted,4);assert.equal(extra.flagged,3);assert.equal(extra.empty_slots,1);
assert.equal((await db.query("select count(*)::int n from phone_terminal_points where frame_name=$1 and phone_extension_id is null",[sample.frame_name])).rows[0].n,4);
const invalid=await invoke([{...sample,slot:'0'}]);assert.equal(invalid.failed,1);
const duplicateLocation=await invoke([{...sample,slot:'5'},{...sample,slot:'05'}]);assert.equal(duplicateLocation.failed,2);assert.equal(duplicateLocation.inserted,0);
await db.exec('rollback;');
console.log(JSON.stringify({total:first.total,inserted:first.inserted,updated:first.updated,empty:first.empty_slots,flagged:first.flagged,filledTypes:first.phone_type_matched,
  failed:first.failed,reimport:{inserted:second.inserted,updated:second.updated},flaggedRows:preview.filter(row=>['conflict','unmatched'].includes(row.fieldMatchStatus)).map(row=>({slot:row.slot,number:row.extensionNumber,reason:row.message})),checks:'100 slots, original numbers, DB/preview parity, repeat import, export round-trip, RLS, scope, malformed slots, duplicate numbers and locations, unchanged system masters'},null,2));
if(process.argv.includes('--serve')) {
  const {serveFieldRehearsal}=await import('./field-terminal-rehearsal-server.mjs');
  serveFieldRehearsal(db,snapshot,customerId,serviceId);
} else await db.close();
