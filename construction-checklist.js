// Workday positions are the sorted distinct logged dates, not elapsed calendar days.
// SQL supplies these aggregates; the browser does not infer progress from partial logs.
let activeConstructionItemId="";
function constructionChecklistProgress(plan){
 const worked=Number(plan.worked_days||0),planned=Number(plan.planned_days||0),total=Number(plan.item_count||0),done=Number(plan.completed_item_count||0),percent=Number(plan.completion_percent||0),over=Math.max(worked-planned,0);
 return `<div class="construction-progress ${planned&&over?"overrun":""}"><p>預計 ${planned||"未設定"} 天｜已執行 ${worked} 天${planned?`｜剩餘 ${Math.max(planned-worked,0)} 天`:""}</p>${total?`<progress max="100" value="${Math.min(Math.max(percent,0),100)}" aria-label="子項目完成率">${percent}%</progress><strong>${percent}%（${done}/${total} 項完成）</strong>`:'<small>尚無子項目；新增清單後顯示完成率。</small>'}${planned&&over?`<p>已超出預計施工天數 ${over} 天</p>`:""}</div>`;
}
function constructionWarning(plan){
 if(!plan.needs_attention)return "";
 return `<div class="construction-warning" role="status"><strong>施工進度提醒：仍有子項目未開始</strong><p>已執行 ${Number(plan.worked_days)}／${Number(plan.planned_days)} 天，已達 80% 警示門檻（第 ${Number(plan.warning_after_days)} 天）。</p><p>尚無工作日誌：${(plan.unstarted_items||[]).map(i=>esc(i.title)).join("、")}。請確認施工安排。</p></div>`;
}
function constructionItemEditorRow(item={},index=0){
 return `<div class="construction-item-editor" data-item-id="${esc(item.id||uid())}"><label class="construction-item-title">子項目名稱<input data-item-title maxlength="200" required value="${esc(item.title||"")}" placeholder="例如：A 棟配管施工" aria-label="子項目 ${index+1} 名稱"></label><label>起始工作日<input data-item-start type="number" min="1" max="3650" required value="${Number(item.start_day)||1}" aria-label="子項目 ${index+1} 起始工作日"></label><label>預計天數<input data-item-days type="number" min="1" max="3650" required value="${Number(item.planned_days)||1}" aria-label="子項目 ${index+1} 預計天數"></label><button type="button" class="outline danger" data-remove-construction-item ${item.is_completed||item.worked_days?'disabled title="已有日誌或已完成的子項目須保留"':""}>移除</button></div>`;
}
function constructionChecklistEditor(plan){
 return `<section class="span-2 construction-checklist-editor"><div class="panel-head"><h3>施工子項目清單</h3><button type="button" class="outline" data-add-construction-item>＋ 新增子項目</button></div><p class="form-sync-hint">每項可分別填寫日誌、勾選完成。起始工作日是第幾個工作日；預計安排須在總工期內，最多 100 項。</p><div data-construction-items>${(plan.items||[]).map(constructionItemEditorRow).join("")}</div></section>`;
}
function collectConstructionItems(form){
 const rows=[...form.querySelectorAll('[data-construction-items] [data-item-id]')],planned=Number(form.elements.plannedDays.value);
 if(rows.length>100)throw new Error("子項目最多 100 項。");
 if(rows.length&&(!Number.isInteger(planned)||planned<1||planned>3650))throw new Error("請設定 1 至 3650 天的總工期。");
 return rows.map(row=>{
  const item={id:row.dataset.itemId,title:row.querySelector('[data-item-title]').value.trim(),start_day:Number(row.querySelector('[data-item-start]').value),planned_days:Number(row.querySelector('[data-item-days]').value)};
  if(!item.title||item.title.length>200)throw new Error("請填寫子項目名稱（最多 200 字）。");
  if(!Number.isInteger(item.start_day)||!Number.isInteger(item.planned_days)||item.start_day<1||item.planned_days<1||item.start_day+item.planned_days-1>planned)throw new Error(`「${item.title}」的安排超出總工期，請調整起始日或天數。`);
  return item;
 });
}
function constructionChecklist(plan){
 if(!plan.items?.length)return "";
 return `<ul class="construction-checklist" aria-label="施工子項目">${plan.items.map(item=>`<li class="${item.is_completed?"is-complete":""}"><div><label class="construction-item-check"><input type="checkbox" data-complete-construction-item="${esc(item.id)}" data-plan-id="${esc(plan.id)}" ${item.is_completed?"checked":""} ${plan.can_complete_items?"":"disabled"}><strong>${esc(item.title)}</strong></label><small>${item.is_completed?"已完成":item.worked_days?"施工中":"未開始"} · 已執行 ${Number(item.worked_days||0)} 天 · 預計第 ${Number(item.start_day)}～${Number(item.start_day)+Number(item.planned_days)-1} 工作日</small></div>${plan.can_create_log?`<button type="button" class="outline" data-construction-log="${esc(plan.id)}" data-construction-item="${esc(item.id)}" aria-label="填寫 ${esc(item.title)} 工作日誌">填寫日誌</button>`:""}</li>`).join("")}</ul>`;
}
function constructionGantt(plan){
 const items=plan.items||[],dates=plan.work_dates||[];
 if(!items.length)return "";
 const days=Math.max(Number(plan.planned_days)||1,dates.length),left=180,width=700,rowHeight=38,top=42,height=top+items.length*rowHeight+8,step=Math.max(1,Math.ceil(days/14)),cell=width/days;
 const dateIndex=new Map(dates.map((date,i)=>[date,i]));
 const ticks=[...new Set([1,...Array.from({length:Math.ceil(days/step)},(_,i)=>i*step+1),days])].filter(d=>d<=days);
 return `<details class="construction-gantt" open><summary>工期甘特圖（工作日序）</summary><p class="form-sync-hint">灰藍色：預計安排；綠色：有日誌的工作日。日期依所有日誌排序，同一天只佔一格；空檔不算工作天。進行中、已完成的日誌皆計入，未來日期不計入實際天數。</p><div class="construction-gantt-scroll" tabindex="0" aria-label="可左右捲動的工期甘特圖"><svg viewBox="0 0 ${left+width+12} ${height}" width="${left+width+12}" height="${height}" role="img" aria-label="${esc(plan.content)}，預計 ${Number(plan.planned_days)} 天，已執行 ${dates.length} 天"><title>${esc(plan.content)} 工期甘特圖</title>${ticks.map(day=>`<line x1="${left+(day-1)*cell}" x2="${left+(day-1)*cell}" y1="24" y2="${height}" class="gantt-grid"/><text x="${left+(day-1)*cell+2}" y="16" class="gantt-axis">${day}</text>`).join("")}${items.map((item,i)=>{
  const y=top+i*rowHeight;
  return `<text x="4" y="${y+16}" class="gantt-label"><title>${esc(item.title)}</title>${esc(item.title.length>13?item.title.slice(0,12)+"…":item.title)}</text><rect x="${left+(Number(item.start_day)-1)*cell}" y="${y}" width="${Number(item.planned_days)*cell}" height="24" rx="3" class="gantt-plan"><title>${esc(item.title)}：預計第 ${Number(item.start_day)} 天起，${Number(item.planned_days)} 天</title></rect>${(item.log_dates||[]).filter(date=>dateIndex.has(date)).map(date=>`<rect x="${left+dateIndex.get(date)*cell+Math.min(1,cell/4)}" y="${y+5}" width="${Math.max(cell-2,cell/2)}" height="14" rx="2" class="gantt-actual"><title>${esc(item.title)}：${esc(date)}（第 ${dateIndex.get(date)+1} 個工作日）</title></rect>`).join("")}`;
 }).join("")}</svg></div><p class="form-sync-hint">${dates.length?`實際工作日期：${dates.length>20?`${esc(dates[0])}～${esc(dates.at(-1))}，共 ${dates.length} 天`:dates.map(esc).join("、")}`:"尚無工作日誌。新增日誌後會顯示實際工作日。"}</p></details>`;
}
document.addEventListener("click",event=>{
 const add=event.target.closest('[data-add-construction-item]'),remove=event.target.closest('[data-remove-construction-item]');
 if(add){
  const host=document.querySelector('#modalForm [data-construction-items]');if(!host)return;
  if(host.children.length>=100){showToast("子項目最多 100 項。");return;}
  host.insertAdjacentHTML('beforeend',constructionItemEditorRow({},host.children.length));host.lastElementChild.querySelector('input').focus();
  host.dispatchEvent(new Event('input',{bubbles:true}));
 }
 if(remove&&!remove.disabled){const row=remove.closest('[data-item-id]'),host=row.parentElement;row.remove();host.dispatchEvent(new Event('input',{bubbles:true}));}
});
document.addEventListener("change",async event=>{
 const box=event.target.closest('[data-complete-construction-item]');if(!box)return;
 const plan=constructionPlanById(box.dataset.planId),item=plan?.items?.find(i=>i.id===box.dataset.completeConstructionItem),checked=box.checked;
 if(!item||!plan.can_complete_items){box.checked=!checked;return;}
 box.disabled=true;
 try{
  await apiRequest({operation:"set_construction_item_completed",payload:{id:item.id,row_version:item.row_version,is_completed:checked}});
  await refreshConstructionProgressViews();await openConstructionPlans(plan.project_id);
  showToast(checked?"子項目已標記完成":"已取消完成標記");
 }catch(error){box.checked=!checked;showToast(error.message,"更新未完成");}finally{box.disabled=false;}
});
