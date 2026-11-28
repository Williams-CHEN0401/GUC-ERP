// 在隔離 PostgreSQL 容器（預設測試站 guc-test-supabase-db，已含第二版結構）以單一交易套用第三版 migration
// 並執行驗證，結束一律 ROLLBACK，不留下任何資料或結構變更。
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const docker=process.env.DOCKER_EXE||'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
const container=process.env.V3_DB_CONTAINER||'guc-test-supabase-db';
if(/^supabase-db$/.test(container))throw Error('Refusing to run verification against the production database container.');
const migration=readFileSync(new URL('../supabase/migrations/20261128120000_construction_roster_transfer_drawing_devices.sql',import.meta.url),'utf8')
  .replace(/^begin;\s*/,'').replace(/notify pgrst,'reload schema';\s*commit;\s*$/,'');
const verify=readFileSync(new URL('./verify-construction-roster-v3.sql',import.meta.url),'utf8');
const script=`\\set ON_ERROR_STOP on\nbegin;\nset local lock_timeout='5s';\n${migration}\n${verify}\nrollback;\n`;
const run=spawnSync(docker,['exec','-i',container,'psql','-U','supabase_admin','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1'],{input:script,encoding:'utf8',windowsHide:true,maxBuffer:20e6});
process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
if(run.status!==0||!/construction roster v3 checks passed/.test(run.stderr))process.exit(1);
console.log('construction roster v3 database verification passed (rolled back).');
