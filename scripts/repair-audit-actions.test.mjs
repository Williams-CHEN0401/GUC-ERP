import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const migration=readFileSync(new URL('../supabase/migrations/20260905094955_repair_audit_actions.sql',import.meta.url),'utf8');
const sql=migration.replace(/--[^\n]*/g,'');
const existing=['insert','update','delete','import','export','UPDATE_CREDENTIAL','IMPORT_DEVICES','BATCH_UPDATE','BATCH_DELETE'];
const repair=['CREATE_REPAIR_ITEM','UPDATE_REPAIR_ITEM','DELETE_REPAIR_ITEM'];

test('audit action migration preserves existing actions and permits every repair RPC action',()=>{
  const list=sql.match(/check\s*\(\s*action\s+in\s*\(([\s\S]*?)\)\s*\)/i);
  assert.ok(list,'must retain an action allowlist');
  const allowed=[...list[1].matchAll(/'([^']+)'/g)].map(match=>match[1]);
  assert.deepEqual(allowed,[...existing,...repair]);
  for(const name of ['20260903090000_repair_item_management.sql','20260905081650_maintenance_event_types.sql']){
    const rpc=readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
    for(const [action] of rpc.matchAll(/(?:CREATE|UPDATE|DELETE)_REPAIR_ITEM/g))assert.ok(allowed.includes(action));
  }
});

test('audit constraint change is atomic, bounded and schema-only',()=>{
  assert.match(sql,/^\s*begin;/i);
  assert.match(sql,/set local lock_timeout = '5s'/i);
  assert.match(sql,/set local statement_timeout = '30s'/i);
  assert.match(sql,/alter table public\.audit_logs drop constraint audit_logs_action_check/i);
  assert.match(sql,/alter table public\.audit_logs add constraint audit_logs_action_check/i);
  assert.match(sql,/commit;\s*$/i);
  assert.doesNotMatch(sql,/\b(?:insert\s+into|update\s+public\.|delete\s+from|truncate|disable\s+trigger|disable\s+row\s+level)\b/i);
});
