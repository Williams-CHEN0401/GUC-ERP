import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function load(...files){
  const c=vm.createContext({document:{addEventListener(){}},window:{addEventListener(){}},esc,uid:()=>'id',state:{},canModule:()=>true});
  for(const file of files)vm.runInContext(readFileSync(new URL(file,import.meta.url),'utf8'),c);
  return c;
}
test('acceptance 3: automatic numbering builds CAM01～CAM79 without duplicates',()=>{
  const c=load('../construction-v2.js'),codes=c.generateEquipmentCodes({prefix:'CAM',start:1,count:79,digits:2});
  assert.equal(codes.length,79);assert.equal(codes[0],'CAM01');assert.equal(codes.at(-1),'CAM79');assert.equal(new Set(codes).size,79);
  assert.equal(c.generateEquipmentCodes({prefix:'SP-',start:8,count:3,digits:3}).join(','),'SP-008,SP-009,SP-010');
  assert.throws(()=>c.generateEquipmentCodes({prefix:'',start:1,count:2,digits:2}),/前綴/);
  assert.throws(()=>c.generateEquipmentCodes({prefix:'C',start:1,count:1001,digits:2}),/1 至 1000/);
});
test('acceptance 4: CAM10～CAM20 range selection returns 11 devices, numerically, in any order',()=>{
  const c=load('../construction-v2.js'),roster=c.generateEquipmentCodes({prefix:'CAM',start:1,count:79,digits:2});
  assert.equal(c.equipmentCodeRange(roster,'CAM10','CAM20').length,11);
  assert.deepEqual([...c.equipmentCodeRange(roster,'cam20','CAM10')].slice(0,2),['CAM10','CAM11']);
  assert.deepEqual([...c.equipmentCodeRange(['A','B-1','C'],'B-1','C')],['B-1','C']);
  assert.throws(()=>c.equipmentCodeRange(['A'],'X','Y'),/找不到起訖/);
});
test('acceptance 1: equipment icons follow the site contract service icons and fall back to a default',()=>{
  const c=load('../construction-v2.js');
  assert.equal(c.equipmentIconFor({type:'監視攝影機'}),'/assets/equipment-icons/monitoring.png');
  assert.equal(c.equipmentIconFor({type:'廣播喇叭'}),'/assets/equipment-icons/audio.png');
  assert.equal(c.equipmentIconFor({type:'讀卡機'}),'/assets/equipment-icons/access.png');
  assert.equal(c.equipmentIconFor({},{code:'basketball_coin_machine',name:'門禁系統'}),'/assets/equipment-icons/access.png');
  assert.equal(c.equipmentIconFor({},{code:'custom_6286',name:'廣播系統'}),'/assets/equipment-icons/audio.png');
  assert.equal(c.equipmentIconFor({},{code:'emergency_call',name:'緊急求救系統'}),'/assets/equipment-icons/emergency.png');
  assert.equal(c.equipmentIconFor({},null,'設備安裝'),'/assets/equipment-icons/default.svg');
  for(const key of ['monitoring','audio','phone','network','barrier','emergency','access'])assert.ok(readFileSync(new URL(`../assets/equipment-icons/${key}.png`,import.meta.url)).length>1000);
});
test('acceptance 5/6: once any sub-item is assigned, unassigned sub-items cover no equipment',()=>{
  const c=load('../construction-v2.js'),plan={drawing_points:[{code:'CAM10'},{code:'CAM11'},{code:'CAM30'}],items:[{id:'office',equipment_codes:['CAM10','CAM11','GONE']},{id:'parking',equipment_codes:null}]};
  assert.deepEqual([...c.itemEquipmentCodes(plan,plan.items[0])],['CAM10','CAM11']);
  assert.deepEqual([...c.itemEquipmentCodes(plan,plan.items[1])],[]);
  assert.equal(c.itemAppliesTo(plan.items[0],'CAM30',plan),false);assert.equal(c.itemAppliesTo(plan.items[1],'CAM10',plan),false);
});
test('legacy plans without any assignment keep every sub-item on the whole roster',()=>{
  const c=load('../construction-v2.js'),plan={drawing_points:[{code:'A'},{code:'B'}],items:[{id:'x',equipment_codes:null},{id:'y'}]};
  assert.deepEqual([...c.itemEquipmentCodes(plan,plan.items[1])],['A','B']);assert.equal(c.itemAppliesTo(plan.items[0],'B',plan),true);
});
test('device note on the drawing grid lists only sub-items assigned to that device',()=>{
  const c=load('../construction-v2.js');
  const plan={drawing_points:[{code:'B1F'},{code:'1F'}],equipment_state:[],items:[{id:'net1',title:'1號梯網路配線',equipment_codes:['B1F','1F']},{id:'net2',title:'2號梯網路配線',equipment_codes:null},{id:'hub',title:'校史室集線器安裝',equipment_codes:null}]};
  assert.deepEqual(plan.items.filter(i=>c.itemAppliesTo(i,'B1F',plan)).map(i=>i.title),['1號梯網路配線']);
});
test('Gantt keeps labels to one compact line and drops the long explanation',()=>{
  const c=load('../construction-v2.js');
  const plan={id:'p',content:'行政大樓讀卡機施工',construction_date:'2026-11-12',drawing_points:[],equipment_state:[],items:[{id:'i',title:'網路配線',start_day:1,planned_days:4,log_dates:['2026-11-14']}]};
  const html=c.constructionScheduleGantt([plan],{key:'k'});
  assert.doesNotMatch(html,/form-sync-hint|預計完成日期＝/);
  assert.match(html,/<small>11\/12～11\/15・4天<\/small>/);
  assert.match(html,/class="v2-gantt-period"[^>]*>2026\/11</);
  assert.doesNotMatch(html,/<b>11\/1[0-9]<\/b>/);
  assert.match(html,/實際 2026-11-14～—/);
});
test('schedule status, overdue and progress use equipment cells when assigned',()=>{
  const c=load('../construction-v2.js');
  const plan={construction_date:'2020-01-01',drawing_points:[{code:'A'},{code:'B'}],equipment_state:[{code:'A',item:'i',status:'done'}],items:[]};
  const s=c.itemSchedule(plan,{id:'i',start_day:3,planned_days:2,log_dates:['2020-01-03'],equipment_codes:['A','B']});
  assert.equal(s.start,'2020-01-03');assert.equal(s.end,'2020-01-04');assert.equal(s.status,'overdue');assert.equal(s.progress,50);
  assert.equal(c.itemSchedule(plan,{id:'i',start_day:1,planned_days:1,is_completed:true,completed_at:'2020-01-01T10:00:00Z',log_dates:[]}).status,'done');
});
test('matrix marks cells outside a sub-item assignment and keeps their totals out',()=>{
  const c=load('../construction-v2.js','../construction-equipment.js');
  const html=c.equipmentMatrix({items:[{id:'i',title:'總務處大樓配管施工',equipment_codes:['A']}],drawing_points:[{code:'A',location:''},{code:'B',location:''}],equipment_state:[{code:'A',item:'i',status:'done'}]});
  assert.match(html,/data-cell-status="unassigned"/);assert.match(html,/1／1/);
});
test('roster import follows the file main item, finds a header below a title row and keeps parenthesised names distinct',()=>{
  const c=load('../construction-v2.js','../construction-equipment.js','../construction-roster.js');
  const plans=[{id:'one',content:'設備安裝（一樓）',can_manage:true,drawing_points:[],items:[]},{id:'two',content:'設備安裝（二樓）',can_manage:true,drawing_points:[],items:[{id:'i2',title:'二樓攝影機安裝'}]}];
  const rows=[['土庫國小二樓設備清冊'],['設備編號','設備名稱','施工主項目（請填寫）','子項目'],['CAM2F-09','二樓攝影機','設備安裝 （二樓）','二樓攝影機安裝'],['CAM1F-01','一樓','',''],['X','x','設備安裝','']];
  const result=c.validateRosterImport(rows,{plans,current:plans[0]});
  assert.equal(result.headerRow,2);assert.equal(result.planColumn,true);
  assert.equal(result[0].plan.id,'two');assert.equal(result[0].items[0].id,'i2');assert.equal(result[0].line,3);
  assert.equal(result[1].plan.id,'one','blank main item falls back to the selected one');
  assert.match(result[2].errors.join(),/找不到施工主項目「設備安裝」/);
  const noPlan=c.validateRosterImport([['設備編號'],['A1']],{plans,current:plans[1]});assert.equal(noPlan.planColumn,false);assert.equal(noPlan[0].plan.id,'two');
});
test('roster import links devices to drawings by title within the drawing owner roster',()=>{
  const c=load('../construction-v2.js','../construction-equipment.js','../construction-roster.js');
  const plans=[{id:'p',content:'配管作業',can_manage:true,drawing_points:[{code:'CAM10',location:''}],items:[]},{id:'q',content:'設備安裝',can_manage:true,drawing_points:[],items:[]}];
  const drawings=[{id:'d1',title:'1F 平面圖',original_name:'1f.png',construction_plan_id:'p'}];
  const r=c.validateRosterImport([['設備編號','對應施工主項目','對應工程圖'],['CAM10','配管作業','1F平面圖'],['CAM20','設備安裝','1F 平面圖'],['CAM30','配管作業','2F 平面圖']],{plans,current:plans[0],drawings});
  assert.equal(r[0].drawings[0].id,'d1');assert.match(r[1].errors.join(),/不在該清冊內/);assert.match(r[2].errors.join(),/找不到工程圖/);
});
test('drawing device lists: explicit codes plus markers, legacy drawings show the whole roster, services inferred from type',()=>{
  const c=load('../construction-v2.js','../construction-drawings.js');
  vm.runInContext(`constructionDrawingContext={plans:[{id:'p',content:'監視配管',drawing_points:[{code:'CAM10',type:'監視攝影機'},{code:'CAM11'},{code:'CAM60'},{code:'SPK1',type:'廣播喇叭'}],items:[]}],
    contract_service_types:[{id:'mon',code:'monitoring',name:'監視系統'},{id:'pa',code:'broadcast',name:'廣播系統'}],
    drawings:[{id:'f1',construction_plan_id:'p',original_name:'1F.png',contract_service_type_id:'mon',drawing_codes:['CAM10'],drawing_markers:{CAM11:{x:.5,y:.5}}},
      {id:'f2',construction_plan_id:'p',original_name:'2F.png',contract_service_type_id:'mon',drawing_codes:null,drawing_markers:{}}]};`,c);
  const [f1,f2]=vm.runInContext('constructionDrawingContext.drawings',c);
  assert.deepEqual([...c.drawingCodes(f1)],['CAM10','CAM11']);assert.deepEqual([...c.drawingCodes(f2)],['CAM10','CAM11','CAM60','SPK1']);
  assert.deepEqual([...c.unplacedCodes(vm.runInContext('constructionDrawingContext.plans',c))],['CAM60','SPK1'],'legacy drawings do not count as placement');
  assert.deepEqual([...c.deviceServiceIds('CAM10')],['mon']);assert.deepEqual([...c.deviceServiceIds('SPK1')],['pa']);assert.deepEqual([...c.deviceServiceIds('CAM60')],[]);
});
test('roster import validates headers, duplicate codes, unknown plans and sub-items before writing',()=>{
  const c=load('../construction-v2.js','../construction-equipment.js','../construction-roster.js');
  const plans=[{id:'p',content:'配管作業',can_manage:true,drawing_points:[{code:'CAM10',location:'1F',name:'舊名'}],items:[{id:'o',title:'總務處大樓配管施工'}]}];
  const rows=[['設備編號','設備名稱','設備類型','對應施工主項目','對應施工子項目'],['CAM10','總務處走廊','監視攝影機','配管作業','總務處大樓配管施工'],['CAM80','新設備','','','']];
  const result=c.validateRosterImport(rows,{plans,current:plans[0]});
  assert.equal(result[0].action,'更新');assert.equal(result[0].point.location,'1F');assert.equal(result[0].items[0].id,'o');
  assert.equal(result[1].action,'新增');
  const partial=c.validateRosterImport([['設備編號','設備類型'],['CAM10','監視攝影機']],{plans,current:plans[0]});
  assert.equal(partial[0].point.name,'舊名');assert.equal(partial[0].point.type,'監視攝影機');
  const bad=c.validateRosterImport([...rows,['cam80','dup'],['X1','','','不存在的主項目',''],['X2','','','配管作業','不存在的子項目']],{plans,current:plans[0]});
  assert.match(bad[2].errors.join(),/重複/);assert.match(bad[3].errors.join(),/找不到施工主項目/);assert.match(bad[4].errors.join(),/找不到施工子項目/);
  assert.throws(()=>c.validateRosterImport([['名稱'],['x']],{plans,current:plans[0]}),/設備編號/);
});
