import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const ui=vm.createContext({document:{addEventListener(){}},esc:s=>String(s)});
vm.runInContext(await readFile(new URL('../construction-equipment.js',import.meta.url),'utf8'),ui);
test('UTF-8 BOM, quoted commas, Excel paste and leading zero codes round trip',()=>{
  const points=ui.parseDrawingPoints('\uFEFF設備編號,位置\r\n"001","1F,東側"\r\nA-2\t1F');
  assert.equal(points[0].code,'001');
  assert.equal(points[0].location,'1F,東側');
  assert.deepEqual(ui.parseDrawingPoints(ui.pointsText(points)),points);
  assert.throws(()=>ui.parseDrawingPoints('cam-1,1F\nCAM-1,2F'),/重複/);
});
test('old logs, multi-item logs and uncategorized logs retain their selections',()=>{
  assert.deepEqual([...ui.constructionItemIds({construction_item_id:'A'})],['A']);
  assert.deepEqual([...ui.constructionItemIds({construction_item_id:'A',construction_item_ids:['A','B']})],['A','B']);
  assert.equal(ui.constructionItemIds({}).length,0);
});
test('a matrix excludes non-applicable cells and links only authorized log IDs',()=>{
  const html=ui.equipmentMatrix({items:[{id:'i',title:'設備安裝'}],drawing_points:[{code:'A',location:'1F'},{code:'B',location:'1F'}],
    equipment_state:[{code:'A',item:'i',status:'done',log_id:'visible'},{code:'B',item:'i',status:'na'}]});
  assert.match(html,/1／1/);
  assert.equal(html.match(/data-construction-open-log=/g).length,1);
  assert.match(html,/不適用/);
});
