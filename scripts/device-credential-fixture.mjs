import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
export const deviceIds={user:'10000000-0000-4000-8000-000000000001',auth:'10000000-0000-4000-8000-000000000002',customer:'20000000-0000-4000-8000-000000000001',service:'20000000-0000-4000-8000-000000000002',system:'30000000-0000-4000-8000-000000000001'};
export function deviceCredentialFixture(){
 let handler; const calls=[],state={role:'admin',permissions:[],signedIn:true,wrongIdentity:false,revokeFails:false,wrongScope:false};
 const context=vm.createContext({AsyncLocalStorage,performance,URL,URLSearchParams,Request,Response,Headers,AbortController,setTimeout,clearTimeout,crypto,console,
 Deno:{env:{get:name=>name==='SUPABASE_URL'?'https://fixture.supabase.co':''},serve:fn=>handler=fn}});
 const source=readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8').replace(/^import .*node:async_hooks.*;\r?\n/m,'');
 vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'}),context);
 context.currentUser=async()=>state.signedIn?{id:deviceIds.user,auth_user_id:deviceIds.auth,username:'synthetic-admin',display_name:'隔離驗證員',role:state.role,permissions:state.permissions,is_active:true}:null;
 context.timedFetch=async(url,init)=>{
  calls.push({kind:'auth',path:new URL(url).pathname+new URL(url).search});
  if(url.includes('grant_type=password')){const body=JSON.parse(init.body);if(body.email!=='synthetic-admin@inventory.local'||body.password!=='Synthetic-only-0915')return Response.json({error:'invalid'},{status:400});
   return Response.json({access_token:'temporary-synthetic-auth-token',user:{id:state.wrongIdentity?deviceIds.user:deviceIds.auth}});
  }
  if(url.endsWith('/logout?scope=local'))return new Response(null,{status:state.revokeFails?503:204});
  throw Error('Fixture forbids external request');
 };
 context.get=context.getAll=async(path)=>{
  calls.push({kind:'read',path});
  if(path.startsWith('customer_contract_services?'))return [{customer_id:deviceIds.customer}];
  if(path.startsWith('contract_service_types?'))return [{id:deviceIds.service}];
  if(path.startsWith('phone_systems?'))return state.wrongScope?[]:[{id:deviceIds.system}];
  throw Error('Unexpected test read');
 };
 context.rpc=async(name,args)=>{
  calls.push({kind:'rpc',name,args});
  if(name==='reveal_phone_system_credential_v1')return [{login_username:'synthetic-device-user',login_password:'Synthetic-device-secret'}];
  throw Error('Unexpected test RPC');
 };
 const write=(payload={},preview=false)=>handler(new Request('https://fixture.supabase.co/functions/v1/inventory-gateway'+(preview?'-preview':''),{method:'POST',headers:{Authorization:'Bearer synthetic-session'},body:JSON.stringify({operation:'reveal_phone_system_credential',payload:{phone_system_id:deviceIds.system,customer_id:deviceIds.customer,service_id:deviceIds.service,...payload}})}));
 return {handler,context,state,calls,write};
}
