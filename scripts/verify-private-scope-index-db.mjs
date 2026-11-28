// 在隔離 PostgreSQL（預設測試站 guc-test-supabase-db）以單一交易：記錄結果 → 套用 migration → 比對與量測，最後一律 ROLLBACK。
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const docker=process.env.DOCKER_EXE||'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
const container=process.env.PRIVATE_SCOPE_DB_CONTAINER||'guc-test-supabase-db';
if(/^supabase-db$/.test(container))throw Error('Refusing to run verification against the production database container.');
const migration=readFileSync(new URL('../supabase/migrations/20261128170000_private_scope_audit_reference_index.sql',import.meta.url),'utf8')
  .replace(/^begin;\s*/m,'').replace(/notify pgrst,'reload schema';\s*commit;\s*$/,'');
const before=readFileSync(new URL('./verify-private-scope-index.sql',import.meta.url),'utf8'),after=readFileSync(new URL('./verify-private-scope-index-after.sql',import.meta.url),'utf8');
const script=`\\set ON_ERROR_STOP on\nbegin;\nset local lock_timeout='5s';\n${before}\n${migration}\n${after}\nrollback;\n`;
const run=spawnSync(docker,['exec','-i',container,'psql','-U','supabase_admin','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1'],{input:script,encoding:'utf8',windowsHide:true,maxBuffer:20e6});
process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
if(run.status!==0||!/private scope index checks passed/.test(run.stderr))process.exit(1);
console.log('private scope index database verification passed (rolled back).');
