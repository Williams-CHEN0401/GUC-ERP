import test from 'node:test';
import assert from 'node:assert/strict';
import {siteSpreadsheetRow,spreadsheetColumns,spreadsheetFields} from '../supabase/functions/inventory-gateway/site-spreadsheet.ts';

test('blank spreadsheet business values stay optional; typed values stay validated',()=>{
  assert.equal(siteSpreadsheetRow({source_row:2},'devices').device_name,null);
  assert.equal(siteSpreadsheetRow({source_row:2,worker_names_text:'test'},'history').occurred_at,null);
  assert.equal(siteSpreadsheetRow({source_row:2,http_port:443},'devices').http_port,443);
  assert.throws(()=>siteSpreadsheetRow({source_row:2,http_port:65536},'devices'));
  assert.throws(()=>siteSpreadsheetRow({source_row:2,fps:0},'devices'));
  assert.throws(()=>siteSpreadsheetRow({source_row:2,installed_on:'2026-02-30'},'devices'));
  assert.throws(()=>siteSpreadsheetRow({source_row:2,device_name:{}},'devices'));
  assert.throws(()=>siteSpreadsheetRow({source_row:2,manual_url:'javascript:alert(1)'},'devices'));
});
test('sensitive source labels cannot be mapped to ordinary or custom fields',()=>{
  for(const columns of [
    [{key:'notes',label:'密碼'}],
    [{key:'description',label:'password'}],
    [{key:'custom:帳號',label:'測試'}],
    [{key:'custom:test',label:'API key'}],
    [{key:'device_name',label:'name'},{key:'device_name',label:'name2'}],
  ])assert.throws(()=>spreadsheetColumns('devices',columns));
  assert.equal(spreadsheetColumns('devices',[{key:'login_password',label:'密碼'}]).length,1);
  assert.throws(()=>spreadsheetFields(JSON.parse('{"__proto__":"bad"}')));
  assert.throws(()=>spreadsheetFields({constructor:'bad'}));
  assert.throws(()=>spreadsheetFields({username:'no plaintext'}));
  assert.throws(()=>spreadsheetFields({密碼:'no plaintext'}));
  assert.deepEqual(spreadsheetFields({安裝區域:'A',同名欄值:'A'}),{安裝區域:'A',同名欄值:'A'});
});
