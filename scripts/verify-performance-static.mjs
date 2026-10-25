import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),base='http://localhost:4268';
const checks=[];
const response=await fetch(base+'/assets/performance-weights-v1.json');
assert.equal(response.status,200);
assert.match(response.headers.get('content-type'),/application\/json/);
assert.deepEqual(await response.json(),JSON.parse(await readFile(path.join(root,'assets/performance-weights-v1.json'),'utf8')));
checks.push('Exact public weight template returns application/json and matches source');
for(const resource of ['/package.json','/tmp/performance/test-credentials.json','/tmp/performance/runtime.json','/assets/nonexistent.json']){
 const denied=await fetch(base+resource);assert.equal(denied.status,404,resource);await denied.arrayBuffer();
}
checks.push('Package metadata, test credentials, test sessions and unlisted JSON remain inaccessible');
await writeFile(path.join(root,'tmp/performance/static-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),status:'PASS',checks},null,2));
console.log('PASS static resource boundary: approved weight template only; private JSON denied.');
