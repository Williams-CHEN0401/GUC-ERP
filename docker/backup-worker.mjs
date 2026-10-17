// Run on the Docker Desktop host; the ERP container reaches this loopback-only
// worker via host.docker.internal. Never expose this port through NAT.
import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {resolve} from 'node:path';
import {createBackupService} from './backup-service.mjs';
import * as engine from './backup-engine.mjs';
const configIndex=process.argv.indexOf('--config');
if(configIndex<0||!process.argv[configIndex+1])throw Error('Usage: node docker/backup-worker.mjs --config <private-profile.json>');
const config=JSON.parse(await readFile(resolve(process.argv[configIndex+1]),'utf8'));
if(config.nasEnvironmentFile){
 const env=parseEnv(await readFile(resolve(config.nasEnvironmentFile),'utf8'));
 config.nas={url:env.NAS_WEBDAV_URL,username:env.NAS_WEBDAV_USERNAME,password:env.NAS_WEBDAV_PASSWORD,root:env.NAS_WEBDAV_ROOT||'/GUC-ERP'};
 delete config.nasEnvironmentFile;
}
const port=Number(config.port||18970);if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('Invalid private worker port');
const server=await createBackupService(config,engine);
server.listen(port,'127.0.0.1',()=>console.log(`GUC backup worker: ${config.mode}, loopback port ${port}`));
