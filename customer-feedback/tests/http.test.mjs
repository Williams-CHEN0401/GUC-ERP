import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createFeedbackServer} from '../server.mjs';
const actorId='a1111111-1111-4111-8111-111111111111';
const token='synthetic-http-test-session-token';
const answers={customer_name:'合成客戶',contract_content:'合成施工',respondent_name:'',comments:'',contact:'',request_followup:false,service_attitude:5,construction_quality:4,handling_speed:3,engineer_expertise:2};
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r('http://127.0.0.1:'+s.address().port)));
test('HTTP boundaries, secure sessions, validation, throttling and upstream failures',async t=>{
 let rpcCalls=0,upstreamFail=false;
 const upstream=createServer(async(req,res)=>{
  let text='';for await(const b of req)text+=b;
  const body=text?JSON.parse(text):{};res.setHeader('Content-Type','application/json');
  if(req.url==='/rpc/customer_feedback_submit_v1'){rpcCalls++;if(upstreamFail){res.statusCode=500;return res.end('{"secret":"must not leak"}');}return res.end('{"reference":"GUC-FB-SYNTHETIC","submitted_at":"2026-10-21T00:00:00Z"}');}
  if(req.url==='/rpc/customer_feedback_admin_v1')return res.end('{"total":0,"records":[],"stats":{},"can_export":true}');
  if(req.url==='/gateway'&&body.payload?.password==='synthetic-test')return res.end(JSON.stringify({session:{access_token:token,refresh_token:'must-not-leak'},current_user:{id:actorId,display_name:'合成管理者'}}));
  if(req.url==='/gateway?scope=session'&&req.headers.authorization==='Bearer '+token)return res.end(JSON.stringify({current_user:{id:actorId,display_name:'合成管理者'}}));
  if(req.url.startsWith('/auth/logout')){res.statusCode=204;return res.end();}
  res.statusCode=401;res.end('{}');
 });
 const upstreamUrl=await listen(upstream),app=createFeedbackServer({restUrl:upstreamUrl,gatewayUrl:upstreamUrl+'/gateway',authUrl:upstreamUrl+'/auth',serviceKey:'synthetic-service-key',origins:['https://survey.example.invalid'],secureCookies:true});
 const url=await listen(app);
 t.after(async()=>{await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>upstream.close(r))]);});
 const call=(path,body,headers={})=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://survey.example.invalid','Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 assert.equal((await call('/api/admin/responses')).status,401);
 assert.equal((await call('/api/admin/export')).status,401);
 assert.equal((await call('/.env')).status,404);
 assert.equal((await call('/../server.mjs')).status,404);
 const form=await(await call('/api/form')).json(),body={...answers,...form,request_id:crypto.randomUUID()};
 assert.equal((await call('/api/feedback',body,{Origin:'https://attacker.invalid'})).status,403);
 assert.equal((await call('/api/feedback',{...body,form_token:'invalid'})).status,403);
 assert.equal((await call('/api/feedback',{...body,website:'bot'})).status,400);
 assert.equal((await call('/api/feedback',{...body,service_attitude:0})).status,400);
 assert.equal((await call('/api/feedback',{...body,comments:'x'.repeat(21000)})).status,413);
 assert.equal((await call('/api/feedback',body,{'Content-Type':'text/plain'})).status,415);
 assert.equal(rpcCalls,0);
 const saved=await call('/api/feedback',body);assert.equal(saved.status,200);assert.equal((await saved.json()).reference,'GUC-FB-SYNTHETIC');
 upstreamFail=true;const failed=await call('/api/feedback',body);assert.equal(failed.status,503);assert(!JSON.stringify(await failed.json()).includes('must not leak'));
 upstreamFail=false;
 for(let i=0;i<4;i++)await call('/api/feedback',body);
 assert.equal((await call('/api/feedback',body)).status,429);
 const login=await call('/api/admin/login',{username:'admin',password:'synthetic-test'});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie');for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/api/admin'])assert(cookie.includes(flag));
 const loginData=await login.json();assert(!JSON.stringify(loginData).includes(token));assert(!JSON.stringify(loginData).includes('refresh_token'));
 assert.equal((await call('/api/admin/responses',undefined,{Cookie:cookie.split(';')[0]})).status,200);
 assert.equal((await call('/api/admin/export',undefined,{Cookie:cookie.split(';')[0]})).status,200);
 assert.equal((await call('/api/admin/responses?from=2026-02-30',undefined,{Cookie:cookie.split(';')[0]})).status,400);
 const logout=await call('/api/admin/logout',{}, {Cookie:cookie.split(';')[0]});assert.equal(logout.status,200);assert(logout.headers.get('set-cookie').includes('Max-Age=0'));
});
