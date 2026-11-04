import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const fixture=()=>{
 const c=vm.createContext({document:{addEventListener(){}},state:{currentUser:{id:'A',role:'plan_worker',permissions:[]},siteData:{logs:[]}},byId:(rows,id)=>rows.find(r=>r.id===id),canAdmin:()=>false});
 vm.runInContext(readFileSync(new URL('../permissions-ui.js',import.meta.url),'utf8'),c);return c;
};
const permission=(module,...actions)=>({module,...Object.fromEntries(['view','create','update','delete'].map(a=>['can_'+a,actions.includes(a)]))});
test('construction role settings are separate and retain missing legacy entries until opted in',()=>{
 const c=fixture(),legacy=c.renderConstructionPermissionGroup({code:'worker'},[]);
 assert.match(legacy,/data-construction-entry disabled/);assert.doesNotMatch(legacy,/data-construction-override checked/);
 const configured=c.renderConstructionPermissionGroup({code:'worker'},[{role_code:'worker',module:'construction_items',can_view:true,can_update:true}]);
 assert.match(configured,/data-construction-override checked/);assert.match(configured,/子項目完成勾選/);assert.match(configured,/其他人的施工日誌/);
 assert.match(configured,/name="construction_items_update"[^>]*checked/);
});
test('server log flags control other-author mutations with dedicated grants, independent of normal logs',()=>{
 const c=fixture();c.state.currentUser.permissions=[permission('construction_logs','view','update','delete')];
 c.state.siteData.logs=[{id:'L',construction_plan_id:'P',access_creator_user_id:'B',can_update_log:true,can_delete_log:false}];
 assert.equal(c.canWorkLog('UPDATE','L'),true);assert.equal(c.canWorkLog('DELETE','L'),false);
 c.state.currentUser.permissions=[permission('worklogs','view','update','delete'),permission('construction_logs','view')];
 assert.equal(c.canWorkLog('UPDATE','L'),false);
});
test('explicit construction deny wins over ordinary module allow and legacy roles retain defaults',()=>{
 const c=fixture();c.state.currentUser.permissions=[permission('worklogs','view','update')];
 assert.equal(c.canConstructionPermission('construction_plans'),true);assert.equal(c.canConstructionPermission('construction_logs','UPDATE'),true);
 c.state.currentUser.permissions.push(permission('construction_plans'),permission('construction_logs'));
 assert.equal(c.canConstructionPermission('construction_plans'),false);assert.equal(c.canConstructionPermission('construction_logs','UPDATE'),false);
});
