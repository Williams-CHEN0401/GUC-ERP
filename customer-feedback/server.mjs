import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {normalizeSubmission,SCORE_FIELDS,csvCell} from './public/survey-shared.js';

const publicRoot=fileURLToPath(new URL('./public/',import.meta.url));
const MAX_BODY=20_000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
export function createFeedbackServer(options={}) {
 const rest=(options.restUrl||process.env.SUPABASE_REST_URL||'').replace(/\/$/,'');
 const gateway=(options.gatewayUrl||process.env.GUC_GATEWAY_URL||'').replace(/\/$/,'');
 const key=options.serviceKey||process.env.SUPABASE_SERVICE_ROLE_KEY;
 const authUrl=(options.authUrl||process.env.SUPABASE_AUTH_URL||new URL(rest||'http://localhost').origin+'/auth/v1').replace(/\/$/,'');
 const origins=new Set(options.origins||String(process.env.FEEDBACK_ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean));
 const secure=options.secureCookies??process.env.FEEDBACK_COOKIE_SECURE!=='false';
 if(!rest||!gateway||!key||!origins.size)throw Error('Feedback requires explicit local API targets, credentials and allowed origins.');
 const limiter=new Map(),csrfTokens=new Map();
 const cookieName='guc_feedback_session';
 function rate(req,kind,limit,windowMs) {
  const now=Date.now();for(const[k,v]of limiter)if(v.until<=now)limiter.delete(k);
  if(limiter.size>10000)throw new HttpError(503,'目前填寫人數較多，請稍後再試。');
  const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim().slice(0,80),id=kind+':'+ip;
  const r=limiter.get(id)||{count:0,until:now+windowMs};r.count++;limiter.set(id,r);
  if(r.count>limit)throw new HttpError(429,'操作次數較多，請稍候再試。');
 }
 const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
 async function jsonBody(req) {
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw new HttpError(415,'請使用網站表單送出。');
  if(Number(req.headers['content-length']||0)>MAX_BODY){req.resume();throw new HttpError(413,'填寫內容超過允許大小。');}
  const buffers=[];let bytes=0;
  for await(const b of req){bytes+=b.length;if(bytes>MAX_BODY){req.resume();throw new HttpError(413,'填寫內容超過允許大小。');}buffers.push(b);}
  try{const value=JSON.parse(Buffer.concat(buffers).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw new HttpError(400,'表單格式不正確。');}
 }
 async function upstream(url,init={}) {
  try{return await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new HttpError(503,'資料服務暫時無法連線，請稍後重試。');}
 }
 async function rpc(name,args) {
  const r=await upstream(rest+'/rpc/'+name,{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(args)});
  const data=await r.json().catch(()=>({}));
  if(!r.ok){
   if(data.code==='42501')throw new HttpError(403,'此 ERP 帳號沒有意見管理或匯出權限。');
   if(data.code==='23505')throw new HttpError(409,'這份表單已送出；如需填寫另一份，請重新整理頁面。');
   if(['22023','23514','22P02'].includes(data.code))throw new HttpError(400,'填寫內容不完整或超過允許範圍，請檢查後再送出。');
   throw new HttpError(503,'目前無法儲存或讀取資料，請稍後重試。');
  }
  return data;
 }
 const cookieToken=req=>{const m=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='));return m?m.slice(cookieName.length+1):'';};
 const cookie=(token,age=3600)=>`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${age}${secure?'; Secure':''}`;
 async function actor(req) {
  const token=cookieToken(req);if(!/^[A-Za-z0-9_.-]{20,8192}$/.test(token))throw new HttpError(401,'請使用 ERP 帳號登入。');
  const r=await upstream(gateway+'?scope=session',{headers:{Authorization:'Bearer '+token,'x-guc-system':'erp'}}),data=await r.json().catch(()=>({}));
  if(!r.ok||!UUID.test(data.current_user?.id||''))throw new HttpError(401,'登入已失效，請重新登入。');
  return data.current_user;
 }
 function filters(url,pageSize=50,exporting=false) {
  const q=(url.searchParams.get('q')||'').trim(),from=url.searchParams.get('from')||'',to=url.searchParams.get('to')||'',page=Number(url.searchParams.get('page')||1);
  const validDate=v=>!v||/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
  if(q.length>160||!validDate(from)||!validDate(to)||from&&to&&from>to||!Number.isInteger(page)||page<1||page>100000)throw new HttpError(400,'請確認關鍵字與日期範圍。');
  return {p_query:q,p_from:from||null,p_to:to||null,p_page:page,p_page_size:pageSize,p_export:exporting};
 }
 function checkOrigin(req){if(!origins.has(req.headers.origin))throw new HttpError(403,'請從原網站重新開啟表單。');}
 const files={'/':['index.html','text/html'],'/admin':['admin.html','text/html'],'/admin/':['admin.html','text/html'],'/styles.css':['styles.css','text/css'],'/survey.js':['survey.js','text/javascript'],'/admin.js':['admin.js','text/javascript'],'/survey-shared.js':['survey-shared.js','text/javascript']};
 return createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'");
  try{
   const url=new URL(req.url,'http://feedback.internal'),path=url.pathname;
   if(path==='/healthz'&&req.method==='GET')return send(res,200,{ok:true,service:'guc-customer-feedback',version:process.env.FEEDBACK_VERSION||'development'});
   if(req.method==='GET'&&path==='/api/form'){
    rate(req,'form',60,60*1000);for(const[k,v]of csrfTokens)if(v<Date.now())csrfTokens.delete(k);
    if(csrfTokens.size>10000)throw new HttpError(503,'目前填寫人數較多，請稍後再試。');
    const token=randomBytes(24).toString('base64url');csrfTokens.set(token,Date.now()+2*60*60*1000);
    return send(res,200,{form_token:token});
   }
   if(path==='/api/feedback'&&req.method==='POST'){
    checkOrigin(req);rate(req,'submit',10,10*60*1000);const body=await jsonBody(req);
    if(typeof body.form_token!=='string'||!csrfTokens.has(body.form_token)||csrfTokens.get(body.form_token)<Date.now())throw new HttpError(403,'表單已過期，請重新整理頁面後再試。');
    if(body.website)throw new HttpError(400,'無法送出，請重新開啟表單。');
    if(!UUID.test(body.request_id||''))throw new HttpError(400,'表單識別碼不正確，請重新整理。');
    let answers;try{answers=normalizeSubmission(body);}catch(e){throw new HttpError(400,e.message);}
    const data=await rpc('customer_feedback_submit_v1',{p_request_id:body.request_id,p_answers:answers});return send(res,200,{ok:true,...data});
   }
   if(path==='/api/admin/login'&&req.method==='POST'){
    checkOrigin(req);rate(req,'login',10,15*60*1000);const b=await jsonBody(req);
    if(typeof b.username!=='string'||typeof b.password!=='string'||b.username.length>64||b.password.length>128)throw new HttpError(400,'請輸入 ERP 帳號與密碼。');
    const r=await upstream(gateway,{method:'POST',headers:{'Content-Type':'application/json','x-guc-system':'erp'},body:JSON.stringify({operation:'login',payload:{username:b.username,password:b.password}})}),data=await r.json().catch(()=>({}));
    if(!r.ok||!data.session?.access_token||!UUID.test(data.current_user?.id||''))throw new HttpError(401,'帳號或密碼錯誤，或帳號尚未啟用。');
    try{await rpc('customer_feedback_admin_v1',{p_actor_user_id:data.current_user.id,p_page_size:1});}
    catch(e){await upstream(authUrl+'/logout?scope=local',{method:'POST',headers:{apikey:key,Authorization:'Bearer '+data.session.access_token}}).catch(()=>{});throw e;}
    res.setHeader('Set-Cookie',cookie(data.session.access_token));return send(res,200,{ok:true,display_name:data.current_user.display_name});
   }
   if(path==='/api/admin/logout'&&req.method==='POST'){
    checkOrigin(req);const token=cookieToken(req);res.setHeader('Set-Cookie',cookie('',0));if(token)await upstream(authUrl+'/logout?scope=local',{method:'POST',headers:{apikey:key,Authorization:'Bearer '+token}}).catch(()=>{});return send(res,200,{ok:true});
   }
   if(path==='/api/admin/responses'&&req.method==='GET'){
    const user=await actor(req),data=await rpc('customer_feedback_admin_v1',{p_actor_user_id:user.id,...filters(url)});return send(res,200,{...data,display_name:user.display_name});
   }
   if(path==='/api/admin/export'&&req.method==='GET'){
    const user=await actor(req),f=filters(url,200,true),rows=[];let total=null;
    for(let page=1;page<=25;page++){
     const data=await rpc('customer_feedback_admin_v1',{p_actor_user_id:user.id,...f,p_page:page});
     if(total!==null&&total!==data.total)throw new HttpError(409,'回覆資料於匯出期間變動，請重新匯出。');
     total=data.total;if(total>5000)throw new HttpError(400,'資料超過 5,000 筆，請縮小日期範圍再匯出。');
     rows.push(...data.records);if(rows.length>=total)break;
    }
    if(rows.length!==total)throw new HttpError(409,'匯出資料未完整回傳，請重新匯出。');
    const columns=[['reference','收件編號'],['submitted_at','填寫時間'],['customer_name','客戶名稱'],['contract_content','承攬內容'],['respondent_name','填寫人姓名'],...SCORE_FIELDS.map(f=>[f.key,f.label]),['average_score','平均評分'],['comments','改善建議'],['request_followup','希望聯繫'],['contact','聯絡方式']];
    const csv='\uFEFF'+[columns.map(c=>csvCell(c[1])).join(','),...rows.map(row=>columns.map(([key])=>csvCell(key==='request_followup'?(row[key]?'是':'否'):key==='submitted_at'?new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',dateStyle:'short',timeStyle:'short'}).format(new Date(row[key])):row[key])).join(','))].join('\r\n');
    res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="customer-feedback.csv"'});return res.end(csv);
   }
   if(files[path]&&['GET','HEAD'].includes(req.method)){
    const[file,type]=files[path],data=await readFile(resolve(publicRoot,file));res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Content-Length':data.length});return res.end(req.method==='HEAD'?undefined:data);
   }
   return send(res,404,{error:'找不到此頁面。'});
  }catch(e){if(res.headersSent)return res.destroy();return send(res,e.status||500,{error:e.status?e.message:'系統暫時無法處理，請稍後再試。'});}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const server=createFeedbackServer();server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log('GUC customer feedback ready'));
 for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>server.close(()=>process.exit(0)));
}
