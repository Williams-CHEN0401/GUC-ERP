import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceCredentialFixture} from './device-credential-fixture.mjs';
test('credential API requires fresh existing-user password; client flags cannot unlock',async()=>{
 for(const payload of [{},{verified:true},{password_confirmation:'incorrect'}]){
  const h=deviceCredentialFixture(),response=await h.write(payload);
  assert.equal(response.status,403);assert.equal((await response.json()).code,'DEVICE_VERIFICATION_REQUIRED');
  assert.equal(h.calls.filter(x=>x.kind==='rpc').length,0);
 }
});
test('valid step-up revokes only its temporary session before revealing; never returns Auth tokens',async()=>{
 const h=deviceCredentialFixture(),response=await h.write({password_confirmation:'Synthetic-only-0915',username:'ignored-user'});
 assert.equal(response.status,200);const body=await response.text();
 assert.ok(body.includes('synthetic-device-user'));assert.ok(!body.includes('temporary-synthetic-auth-token'));assert.ok(!body.includes('Synthetic-only-0915'));
 assert.equal(response.headers.get('Cache-Control'),'no-store');
 assert.ok(h.calls.findIndex(x=>x.path==='/auth/v1/logout?scope=local')<h.calls.findIndex(x=>x.kind==='rpc'));
 assert.equal(h.calls.filter(x=>x.kind==='rpc').length,1);
});
test('anonymous, preview, unauthorized, changed identity/scope and failed auth cleanup cannot reveal',async()=>{
 for(const variant of ['anonymous','preview','permission','identity','scope','revoke']){
  const h=deviceCredentialFixture();
  if(variant==='anonymous')h.state.signedIn=false;
  if(variant==='permission'){h.state.role='custom';h.state.permissions=[{module:'site',can_view:true},{module:'phone',can_view:true}];}
  if(variant==='identity')h.state.wrongIdentity=true;
  if(variant==='scope')h.state.wrongScope=true;
  if(variant==='revoke')h.state.revokeFails=true;
  const response=await h.write({password_confirmation:'Synthetic-only-0915'},variant==='preview');
  assert.ok(response.status>=400,variant);assert.equal(h.calls.filter(x=>x.kind==='rpc').length,0,variant);
 }
});
