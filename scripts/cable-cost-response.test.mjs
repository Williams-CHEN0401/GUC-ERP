import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
const gateway=fs.readFileSync(new URL('../supabase/functions/inventory-gateway/index.ts',import.meta.url),'utf8');
const code=gateway.split(/\r?\n/).find(line=>line.startsWith('function publicMutationResult(')).replace('value: unknown): unknown','value)');
test('legacy composite mutation responses preserve stock identity but omit internal cost provenance',()=>{
 const context=vm.createContext({});vm.runInContext(code,context);
 const payload={id:'pickup',quantity:200,quantity_unit:'meter',row_version:2,cable_unit_cost_snapshot:9,cable_cost_source_receipt_ids:['private-receipt'],lines:[{id:'nested',cable_cost_project_id_snapshot:'project',quantity:50}]};
 const result=JSON.parse(JSON.stringify(context.publicMutationResult(payload)));
 assert.deepEqual(result,{id:'pickup',quantity:200,quantity_unit:'meter',row_version:2,lines:[{id:'nested',quantity:50}]});
 assert.equal(context.publicMutationResult(null),null);assert.equal(context.publicMutationResult(2),2);
});
