// Explicit sibling path; no credentials or deployment commands. Run --check in CI.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const erp=fileURLToPath(new URL('../',import.meta.url));
const target=process.env.QUOTATION_REPO_PATH;
if(!target)throw Error('Set QUOTATION_REPO_PATH to the Accounting checkout.');
for(const file of ['work-content-report.js','work-content-report.css']){
 const source=await readFile(resolve(erp,file)),destination=resolve(target,'shared',file);
 if(process.argv.includes('--check')){
  if(!(await readFile(destination)).equals(source))throw Error('Shared report asset drift: '+file);
 }else{await mkdir(resolve(target,'shared'),{recursive:true});await writeFile(destination,source);}
}
console.log('ERP / Accounting report assets match.');
