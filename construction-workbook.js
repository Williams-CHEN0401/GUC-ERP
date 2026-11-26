// Equipment rows and progress are read from the existing authorized plan projection.
function equipmentWorkbookColumns(plan) {
  const used=new Set(['設備編號','設備名稱']);
  return plan.items.map(item=>{
    let label=item.title, suffix=2;
    while(used.has(label)){label=item.title+'（'+suffix+'）';suffix+=1;}
    used.add(label);
    return {key:item.id,label};
  });
}

const workbookStatuses={pending:'未開始',working:'施工中',done:'已完成',na:'不適用'};
function equipmentWorkbookCells(plan){
  return new Map((plan.equipment_state||[]).map(e=>[JSON.stringify([e.code,e.item]),e.status]));
}

async function equipmentSheetName(plan){
  const snapshot=[plan.id,plan.items.map(i=>[i.id,i.title]),(plan.drawing_points||[]).map(p=>[p.code,p.name||'']),
    [...equipmentWorkbookCells(plan)].sort(([a],[b])=>a<b?-1:a>b?1:0)];
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(snapshot)));
  const digest=Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
  return '施工_'+plan.id.slice(0,8)+'_'+digest.slice(0,16);
}

async function loadEquipmentImportContext(id){
  const known=constructionPlanById(id);
  if(!known)throw Error('請重新開啟施工規劃。');
  const scope=await apiRequest({method:'GET',scope:'construction_plans',projectId:known.project_id});
  const plan=scope.construction_plans?.find(p=>p.id===id);
  if(!plan)throw Error('找不到可查看的施工規劃。');
  const versions=Object.fromEntries(scope.construction_plans.map(p=>[p.id,p.row_version]));
  return {plan,versions};
}

async function exportEquipmentWorkbook(id){
  if(!canModule('data_export'))throw Error('沒有資料匯出權限。');
  const source=constructionPlanById(id);
  if(!source)throw Error('請重新開啟施工規劃。');
  const {plan}=await apiRequest({operation:'export_data',payload:{resource:'construction_equipment_matrix',project_id:source.project_id,plan_id:id}});
  const cells=equipmentWorkbookCells(plan);
  const columns=[{label:'設備編號'},{label:'設備名稱'},...equipmentWorkbookColumns(plan)];
  const rows=(plan.drawing_points||[]).map(p=>[p.code,p.name||'',...plan.items.map(i=>workbookStatuses[cells.get(JSON.stringify([p.code,i.id]))]||'未填報')]);
  const file=GucExcelExport.filenameFor((byId(state.projects,plan.project_id)?.code||'施工規劃')+'_'+plan.content+'_設備施工進度');
  await GucExcelExport.saveBytes(GucExcelExport.buildWorkbook(columns,rows,await equipmentSheetName(plan)),file);
}

async function equipmentWorkbookDiff(file,plan){
  const {sheetName,rows}=await GucWorkbookReader.readSheet(file,{maxRows:1001,maxColumns:102,maxBytes:20*1024*1024});
  const headers=Array.from(rows[0]||[],v=>String(v??'').trim());
  const codeAt=headers.indexOf('設備編號'),nameAt=headers.indexOf('設備名稱');
  if(codeAt<0 || nameAt<0 || headers.some(h=>!h) || new Set(headers).size!==headers.length)throw Error('第一列須包含「設備編號」「設備名稱」，各欄標題須唯一。');
  const items=new Map(equipmentWorkbookColumns(plan).map(c=>[c.label,c.key]));
  const titles=headers.map((h,i)=>{
    if(i===codeAt||i===nameAt)return null;
    if(!items.has(h))throw Error('這筆規劃找不到子項目「'+h+'」，請核對範本。');
    return items.get(h);
  });
  const stamp=await equipmentSheetName(plan);
  if(sheetName.startsWith('施工_')&&sheetName.split('_')[1]!==plan.id.slice(0,8))throw Error('此活頁簿屬於其他施工規劃。');
  const points=new Map((plan.drawing_points||[]).map(p=>[p.code.toLowerCase(),p])), cells=equipmentWorkbookCells(plan);
  const seen=new Set(),names=[],changes=[],preview=[],labels=new Map();
  for(const [key,label] of Object.entries(workbookStatuses)){
    labels.set(label,key);labels.set(equipmentStates[key],key);
  }
  for(const [i,row] of rows.slice(1).entries()){
    if(!row.some(v=>String(v??'').trim()))continue;
    if(row.slice(headers.length).some(v=>String(v??'').trim()))throw Error('第 '+(i+2)+' 列有資料缺少欄名。');
    const code=String(row[codeAt]??'').trim(),name=String(row[nameAt]??'').trim(),key=code.toLowerCase();
    if(!code||code.length>80||name.length>160||/[\u0000-\u001f\u007f]/.test(code+name)||seen.has(key))throw Error('第 '+(i+2)+' 列的編號重複、空白或文字格式錯誤。');
    seen.add(key);
    const old=points.get(key);
    if(old && old.code!==code)throw Error('設備編號大小寫與清冊不同：'+code);
    if(!old || (name && name!==(old.name||''))){
      names.push({code,name});
      preview.push([code,'設備名稱',old?old.name||'（空白）':'（新增設備）',name||'（空白）']);
    }
    for(const [j,item] of titles.entries()){
      if(!item)continue;
      const value=String(row[j]??'').trim();
      if(!value||value==='未填報')continue;
      const status=labels.get(value),before=cells.get(JSON.stringify([code,item]))||null;
      if(!status)throw Error(code+'／'+headers[j]+' 的狀態「'+value+'」無法辨識。');
      if(status!==before){
        changes.push({code,item,status,before});
        preview.push([code,headers[j],workbookStatuses[before]||'未填報',workbookStatuses[status]]);
      }
    }
  }
  if(preview.length && sheetName.startsWith('施工_') && stamp!==sheetName)throw Error('匯出後清冊、工項或進度已變更，請重新匯出後再修改。');
  if(names.length&&!plan.can_manage)throw Error('檔案包含設備清冊變更，需要施工規劃管理權限。');
  if(changes.length&&!(plan.can_create_log&&plan.can_complete_items))throw Error('檔案包含進度變更，需要填報施工日誌及子項目權限。');
  if(changes.length>2000||points.size+names.filter(n=>!points.has(n.code.toLowerCase())).length>1000)throw Error('每筆規劃最多 1000 台設備，每篇日誌最多填報 2000 格。');
  return {names,changes,preview};
}

function importEquipmentWorkbook(id){
  const dialog=document.createElement('dialog');
  dialog.className='matrix-import-dialog';
  dialog.innerHTML=`<h3>匯入設備施工進度表</h3><p>第一列使用設備編號、設備名稱及子項目名稱。空白和「未填報」會保留原值。</p>
    <p>可填進度：未開始、施工中、已完成、不適用。</p>
    <label>Excel 活頁簿<input type="file" accept=".xlsx"></label><output role="status"></output>
    <div class="construction-gantt-scroll" data-diff></div><label data-log-date hidden>施工日誌日期<input type="date"></label>
    <div class="construction-plan-actions"><button type="button" class="outline" data-close>關閉</button><button type="button" class="primary" data-save disabled>確認匯入</button></div>`;
  document.body.append(dialog);dialog.showModal();
  const file=dialog.querySelector('[type=file]'),save=dialog.querySelector('[data-save]'),close=dialog.querySelector('[data-close]'),date=dialog.querySelector('[type=date]'),out=dialog.querySelector('output'),table=dialog.querySelector('[data-diff]');
  let generation=0, prepared, busy=false;
  const end=()=>dialog.close();
  window.addEventListener('guc:session-changed',end);
  dialog.onclose=()=>{generation++;window.removeEventListener('guc:session-changed',end);dialog.remove();};
  dialog.oncancel=e=>{if(busy)e.preventDefault();};close.onclick=event=>{event.stopPropagation();end();};
  date.value=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  file.onchange=async()=>{
    const seq=++generation, selected=file.files[0];
    prepared=null;save.disabled=true;table.replaceChildren();date.parentElement.hidden=true;out.textContent='';
    if(!selected)return;
    try {
      const {plan,versions}=await loadEquipmentImportContext(id),diff=await equipmentWorkbookDiff(selected,plan);
      if(seq!==generation||!dialog.open)return;
      prepared={plan,versions,diff,request:uid()};
      out.textContent=diff.preview.length?`設備清冊 ${diff.names.length} 筆，工項進度 ${diff.changes.length} 格。${diff.changes.length?'確認後會以目前登入人員新增一篇施工日誌。':''}`:'資料與系統相同，沒有需要匯入的變更。';
      if(diff.preview.length)table.innerHTML='<table><thead><tr><th>設備編號</th><th>欄位</th><th>原值</th><th>匯入值</th></tr></thead><tbody>'+diff.preview.map(r=>'<tr>'+r.map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
      date.parentElement.hidden=!diff.changes.length;save.disabled=!diff.preview.length;
    }catch(error){if(seq===generation)out.textContent=error.message;}
  };
  save.onclick=async()=>{
    if(!prepared||busy)return;
    const {plan,versions,diff,request}=prepared;
    if(diff.changes.length&&!date.value){out.textContent='請選擇施工日誌日期。';return;}
    busy=true;save.disabled=file.disabled=close.disabled=true;
    try {
      const result=await apiRequest({operation:'import_construction_matrix',payload:{plan_id:id,row_version:plan.row_version,versions,request_id:request,log_date:date.value,names:diff.names,changes:diff.changes}});
      if(!dialog.open)return;
      dialog.close();showToast(`已匯入 ${result.result.point_count} 筆清冊、${result.result.cell_count} 格進度。`);
      await refreshConstructionProgressViews();await openConstructionPlans(plan.project_id);
    }catch(error){if(dialog.open){out.textContent=error.message;save.disabled=false;}else showToast(error.message);}
    finally{busy=false;file.disabled=close.disabled=false;}
  };
}

document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-matrix-export],[data-matrix-import]');
  if(!button)return;
  try{if(button.dataset.matrixExport)await exportEquipmentWorkbook(button.dataset.matrixExport);
    else importEquipmentWorkbook(button.dataset.matrixImport);}
  catch(error){showToast(error.message,'設備施工進度表');}
});
