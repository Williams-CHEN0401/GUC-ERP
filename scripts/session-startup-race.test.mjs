import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
test('late cross-tab session discovery cannot clear a successful native login',async()=>{
 let resolveDiscovery;const writes=[];
 const context=vm.createContext({accessToken:'',requestSessionFromOtherTab:()=>new Promise(resolve=>resolveDiscovery=resolve),storeAccessToken:token=>writes.push(token),showLogin:()=>writes.push('login-gate'),apiRequest:()=>{throw Error('Duplicate login bootstrap');}});
 const start=source.lastIndexOf('(async()=>{if(!accessToken)'),end=source.indexOf('})();',start)+5;
 assert.ok(start>=0&&end>start);
 const pending=vm.runInContext(source.slice(start,end),context);
 context.accessToken='newly-authenticated-token';resolveDiscovery('');await pending;
 assert.deepEqual(writes,[]);assert.equal(context.accessToken,'newly-authenticated-token');
});
