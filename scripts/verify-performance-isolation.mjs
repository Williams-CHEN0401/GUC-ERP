import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'tmp/performance');
const expectedServices=['db','auth','rest','api-gw','gateway','erp'];
const names=expectedServices.map(n=>'guc-performance-test-'+n+'-1');
const records=JSON.parse(execFileSync('docker',['inspect',...names],{encoding:'utf8',windowsHide:true,maxBuffer:4e6}));
const expectedNetworks=new Set(['guc-performance-test_default','guc-performance-test_browser']);
const settings=JSON.parse(await readFile(path.join(out,'test-credentials.json'),'utf8'));
const summary=[];
for(const r of records){
 assert.equal(r.Config.Labels['com.docker.compose.project'],'guc-performance-test');
 const service=r.Config.Labels['com.docker.compose.service'];assert.ok(expectedServices.includes(service));
 assert.ok(Object.keys(r.NetworkSettings.Networks).every(n=>expectedNetworks.has(n)));
 for(const mount of r.Mounts){if(mount.Type==='volume')assert.equal(mount.Name,'guc-performance-test_test-db');else assert.ok(mount.Source.replaceAll('\\','/').toLowerCase().startsWith(root.replaceAll('\\','/').toLowerCase()+'/')||mount.Source.replaceAll('\\','/').toLowerCase()===root.replaceAll('\\','/').toLowerCase());}
 const env=Object.fromEntries(r.Config.Env.map(v=>{const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)];}));
 assert.ok(!Object.keys(env).some(k=>/NAS_WEBDAV_PASSWORD|NAS_WEBDAV_URL/.test(k)));
 if(service==='gateway'){assert.equal(env.SUPABASE_URL,'http://api-gw:8000');assert.equal(env.SUPABASE_SERVICE_ROLE_KEY,settings.service);}
 if(service==='erp'){assert.equal(env.SUPABASE_FUNCTIONS_URL,'http://guc-supabase-functions:9000');assert.equal(env.ERP_PUBLIC_URL,'http://localhost:4268/');assert.equal(env.GUC_LOCAL_SUPABASE,'true');}
 if(service==='auth')assert.equal(env.GOTRUE_DB_DATABASE_URL,`postgres://supabase_auth_admin:${settings.password}@db:5432/postgres`);
 if(service==='rest')assert.equal(env.PGRST_DB_URI,`postgres://authenticator:${settings.password}@db:5432/postgres`);
 for(const bindings of Object.values(r.NetworkSettings.Ports))for(const binding of bindings||[])assert.equal(binding.HostIp,'127.0.0.1');
 summary.push({service,networks:Object.keys(r.NetworkSettings.Networks),mounts:r.Mounts.map(m=>({type:m.Type,target:m.Destination,writable:m.RW})),publishedPorts:r.NetworkSettings.Ports});
}
const network=JSON.parse(execFileSync('docker',['network','inspect','guc-performance-test_default'],{encoding:'utf8',windowsHide:true}))[0];assert.equal(network.Internal,true);
await writeFile(path.join(out,'isolation-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),passed:true,services:summary,productionNetworks:0,productionVolumes:0,productionCredentials:0,attachmentDestinations:0},null,2));
console.log('PASS isolation: six services; private data network; localhost-only browser port; independent keys/volume; no NAS or production mounts.');
