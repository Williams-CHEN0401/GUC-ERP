// Shared, framework-neutral report presentation. All business statistics come
// from work_content_report_v1; this module only formats authorized API values.
(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const num=v=>Number(v||0).toLocaleString('zh-TW',{maximumFractionDigits:2});
 const status=v=>({pending:'未開始',in_progress:'施工中',completed:'已完成',cancelled:'已取消'}[v]||v||'—');
 const date=v=>{if(!v)return '—';if(/^\d{4}-\d{2}-\d{2}$/.test(v))return esc(v);const d=new Date(v);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(d):'—';};
 const blank=message=>`<p class="gr-empty">${esc(message)}</p>`;
 const card=(title,content,note='',extra='')=>`<article class="gr-card ${extra}"><header><h2>${esc(title)}</h2>${note?`<p>${esc(note)}</p>`:''}</header>${content}</article>`;
 const kpi=(label,value,note='',warn=false)=>`<article class="gr-kpi${warn?' gr-alert':''}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`;
 function table(headers,rows,id=''){return `<div class="gr-table" tabindex="0" role="region" aria-label="${esc(headers[0])}明細"><table><thead><tr>${headers.map((v,i)=>`<th scope="col" aria-sort="none"><button type="button" data-gr-sort="${i}">${esc(v)} <span aria-hidden="true">↕</span></button></th>`).join('')}</tr></thead><tbody${id?` id="${esc(id)}"`:''}>${rows.join('')||`<tr><td colspan="${headers.length}">目前沒有紀錄</td></tr>`}</tbody></table></div>`;}
 function workerChart(rows){
  const max=Math.max(1,...rows.map(r=>Number(r.constructionDays)||0));
  return rows.length?`<p class="gr-note">縱軸：施工天數（天）／橫軸：施工人員</p><div class="gr-worker-bars" role="img" aria-label="人員施工天數直式長條圖">${rows.map(r=>`<figure><strong>${num(r.constructionDays)} 天</strong><div class="gr-bar-track"><i style="height:${100*Number(r.constructionDays||0)/max}%"></i></div><figcaption>${esc(r.label||r.name)}</figcaption></figure>`).join('')}</div>`:blank('此日期區間沒有施工人員紀錄。');
 }
 function materialChart(rows){
  const units=[...new Set(rows.map(r=>r.unit||'未標示單位'))];
  return units.length?units.map(unit=>{const members=rows.filter(r=>(r.unit||'未標示單位')===unit).sort((a,b)=>b.quantity-a.quantity),max=Math.max(1,...members.map(r=>Number(r.quantity)||0));return `<section class="gr-material-unit"><h3>用量排行（${esc(unit)}）</h3>${members.slice(0,10).map(r=>`<div class="gr-meter-label"><span>${esc(r.name)}</span><strong>${num(r.quantity)} ${esc(unit)}</strong></div><progress max="${max}" value="${Number(r.quantity)||0}" aria-label="${esc(r.name)}用量"></progress>`).join('')}${members.length>10?'<p class="gr-note">顯示前 10 項，完整資料見下方明細。</p>':''}</section>`;}).join(''):blank('此日期區間沒有用料紀錄。');
 }
 function progress(row){
  const planned=Number(row.planned_days)||0,percent=Number(row.progress_percent)||0,over=Number(row.overrun_days)||0;
  return `<div class="gr-progress${over?' gr-alert':''}"><div class="gr-meter-label"><span>已完成 ${num(row.completed_days)} 天</span><strong>${planned?num(percent)+'%':'未設定天數'}</strong></div>${planned?`<progress max="100" value="${Math.max(0,Math.min(100,percent))}" aria-label="${esc(row.title||row.content)}天數進度"></progress><p>預計 ${num(planned)} 天 · 剩餘 ${num(row.remaining_days)} 天${over?` · <b>超出預計施工天數 ${num(over)} 天</b>`:''}</p>`:''}</div>`;
 }
 function logsTable(logs,accounting){return table(['日期','工作摘要','狀態','原始資料'],logs.map(l=>`<tr><td>${esc(l.date)}</td><td>${esc(l.summary||'—')}</td><td>${esc(status(l.status))}</td><td>${l.can_open?`<button type="button" ${accounting?'data-gr-open-log':'data-edit-work-log'}="${esc(l.id)}">查看原日誌</button>`:'—'}</td></tr>`));}
 function plansDetail(plans,accounting){return card('施工規劃明細',plans.length?plans.map(p=>`<details class="gr-plan" data-report-plan="${esc(p.id)}"><summary><span>${esc(p.content)}<small>${esc(p.construction_date)} · ${esc(status(p.status))}</small></span><b class="${p.overrun_days?'gr-alert':''}">${num(p.completed_days)} / ${p.planned_days?num(p.planned_days):'未設定'} 天</b></summary><div class="gr-plan-body"><p>指派施工人員：${esc((p.assignees||[]).map(a=>a.name).join('、')||'未指派')}</p>${progress(p)}${p.notes?`<p>${esc(p.notes)}</p>`:''}${p.items?.length?`<p>清單勾選完成：${num(p.completed_item_count)} / ${p.items.length} 項（與天數進度分開計算）</p>`:''}${(p.items||[]).map(i=>`<details class="gr-item"><summary>${esc(i.title)} <span>${i.is_completed?'已勾選完成':'未勾選完成'}</span></summary><div><p>預計第 ${num(i.start_day)} 工作日起 · ${num(i.planned_days)} 天</p>${progress(i)}${logsTable(i.logs||[],accounting)}</div></details>`).join('')}${p.can_open?`<button type="button" ${accounting?'data-gr-open-plan':'data-construction-project'}="${esc(p.project_id)}">開啟施工規劃</button>`:''}<h3>相關工作日誌（${p.logs?.length||0}）</h3>${logsTable(p.logs||[],accounting)}</div></details>`).join(''):blank('尚未建立施工規劃。'),'列出全部規劃；展開項目可查看進度、指派人員及相關日誌。');}
 function gantt(plans){
  const rows=plans.flatMap(p=>(p.items?.length?p.items.map(i=>({...i,label:p.content+' / '+i.title})): [{...p,label:p.content,start_day:1}]));
  const max=Math.max(1,...rows.map(r=>Number(r.start_day||1)-1+Number(r.planned_days||0)));
  return card('施工項目排程',rows.length?`<div class="gr-gantt" role="img" aria-label="各規劃起始工作日排程"><div class="gr-gantt-axis"><span>各規劃起始日 = 第 1 工作日</span><span>第 ${max} 工作日</span></div>${rows.map(r=>`<div class="gr-gantt-row"><span title="${esc(r.label)}">${esc(r.label)}</span><div class="gr-gantt-track"><i class="${r.overrun_days?'gr-over':''}" style="margin-left:${100*(Number(r.start_day||1)-1)/max}%;width:${100*Number(r.planned_days||0)/max}%">${r.planned_days?num(r.planned_days)+'天':'未設定'}</i></div></div>`).join('')}</div>`:blank('尚無施工排程。'),'預計工作日排程；不是實際施工日期。','gr-span-two');
 }
 function materialTable(report,options){
  const price=!!options.pricePermissions?.view;
  return table(['品項','品牌／型號','總量','領用次數','首次／最近',...(price?['單價（元）','金額（元）','價格來源／日期','價格操作']:[])],report.materialStats.map(r=>`<tr><td><strong>${esc(r.name)}</strong></td><td>${esc([r.brand,r.model].filter(Boolean).join('｜')||'—')}</td><td>${num(r.quantity)} ${esc(r.unit)}</td><td>${num(r.recordCount)}</td><td>${esc(r.firstDate||'—')}<small>${esc(r.recentDate||'—')}</small></td>${price?`<td>${r.unit_price==null?'未設定':num(r.unit_price)}</td><td>${r.amount==null?'—':num(r.amount)}</td><td>${r.price_source==='manual'?'人工參考價格':r.price_source==='receipt'?'最近有效進貨':'沒有價格'}<small>${esc(r.price_date||'—')}</small></td><td>${(r.price_source==='manual'?options.pricePermissions.update:options.pricePermissions.create)?`<button type="button" data-gr-edit-price="${esc(r.id)}" ${options.readOnly?'disabled':''}>修改參考單價</button>`:''}${r.price_source==='manual'&&options.pricePermissions.delete?`<button type="button" data-gr-clear-price="${esc(r.id)}" ${options.readOnly?'disabled':''}>恢復進貨參考價</button>`:''}</td>`:''}</tr>`),'materialStatsTable');
 }
 function materials(report,options){return card('用料統計',materialChart(report.materialStats)+materialTable(report,options),'依品項 ID 彙總取貨；不同材料單位分開統計。')+card('用料明細',table(['日期','品項','品牌／型號','數量','取貨帳號'],(report.materialRows||[]).map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.item?.name)}</td><td>${esc([r.item?.brand,r.item?.model].filter(Boolean).join('｜'))}</td><td>${num(r.quantity)} ${esc(r.item?.unit)}</td><td>${esc(r.account)}</td></tr>`),'materialRowsTable'));}
 function workers(report,options){return card('人員施工統計',workerChart(report.workerStats),'同人、同工作內容、同日計一次；沿用既有施工投入口徑。')+card('施工人員明細',table(['人員','施工天數','日誌筆數','首次施工','最近施工','帳號狀態'],report.workerStats.map(r=>`<tr><td>${esc(r.label||r.name)}</td><td>${num(r.constructionDays)} 天</td><td>${num(r.recordCount)}</td><td>${esc(r.firstDate||'—')}</td><td>${esc(r.recentDate||'—')}</td><td>${r.active===false?'已停用':'啟用'}</td></tr>`),'workerStatsTable'))+card('每日施工明細',table(['日期／時段','本筆施工人員','當日去重人數','工作摘要','狀態','原始資料'],(report.dailyRows||[]).map(r=>`<tr><td>${esc(r.date)}<small>${esc(r.timePeriod||'—')}</small></td><td>${esc((r.workerNames||[]).join('、')||'未指定')}</td><td>${num(r.dailyHeadcount)}</td><td>${esc(r.summary)}</td><td>${esc(status(r.status))}</td><td><button type="button" ${options.accounting?'data-gr-open-log':'data-edit-work-log'}="${esc(r.id)}">查看原日誌</button></td></tr>`),'dailyRowsTable'));}
 function overview(report,options){
  const plans=report.constructionPlans||[],s=report.constructionSummary,k=report.kpis;
  if(!s)return card('施工規劃資料尚未載入',blank('報表服務尚未提供施工統計，請確認本次增量更新已套用。'))+materials(report,options)+workers(report,options);
  const percent=s.plannedDays>0?100*s.completedDays/s.plannedDays:null;
  const gauge=card('施工天數進度',`<div class="gr-gauge" style="--gr-percent:${Math.min(percent||0,100)}"><div><strong>${percent==null?'—':num(percent)+'%'}</strong><span>${percent==null?'未設定預計天數':'已完成 / 預計天數'}</span></div></div><p class="gr-note">${num(s.projectDays)} 個專案實際完成日（跨規劃去重）</p>${s.unsetPlanCount?`<p class="gr-alert">${num(s.unsetPlanCount)} 筆規劃未設定天數；比率僅作參考。</p>`:''}`);
  const progressRows=plans.flatMap(p=>p.items?.length?p.items.map(i=>({...i,label:p.content+' / '+i.title})): [{...p,label:p.content}]);
  return `<section class="gr-kpis">${kpi('施工規劃',num(s.planCount)+' 筆','包含尚未開始的規劃')}${kpi('預計施工',num(s.plannedDays)+' 天','規劃天數總和')}${kpi('已完成施工',num(s.completedDays)+' 天','各規劃完成日數總和')}${kpi('剩餘施工',num(s.remainingDays)+' 天','各規劃剩餘天數總和')}${kpi('超期項目',num(s.overdueItemCount)+' 項','未拆子項目者以整筆規劃計',s.overdueItemCount>0)}</section><p class="gr-note">完成天數僅計已完成、未刪除、非未來日期的工程施工日誌；同規劃／子項目、同日期去重。已取消規劃保留明細，不列入天數摘要。</p><div class="gr-dashboard">${card('人員施工統計',workerChart(report.workerStats),`${num(k.workerCount)} 位施工人員 · ${num(k.workerDays)} 人天`)}${card('材料使用排行',materialChart(report.materialStats),`${num(k.materialTypeCount)} 個品項 · 按材料單位分組`)}${gauge}${gantt(plans)}${card('各施工項目進度',progressRows.length?progressRows.map(r=>`<section class="gr-item-progress"><h3>${esc(r.label)}</h3>${progress(r)}</section>`).join(''):blank('尚無施工項目。'))}</div>${plansDetail(plans,options.accounting)}${card('材料品項彙總',materialTable(report,options),'完整用料、數量與領用期間。')}`;
 }
 function render(options){
  const {report,tab='overview'}=options,p=report.project||options.project||{};
  const heading=`<article class="gr-heading"><div><span class="gr-code">${esc(p.code||'未編號')}</span><h2>${esc(p.name)}</h2><p>${esc(p.customer||'')} · ${esc(p.type||'工程施工')} · 負責人：${esc(p.owner||'未指派')}</p><p>建立：${date(p.createdAt)}${p.date?' · 工作日期：'+date(p.date):''} · 結案：${date(p.completedOn)}</p></div><span class="gr-status">${esc(status(p.status))}</span></article>`;
  return heading+(tab==='materials'?materials(report,options):tab==='workers'?workers(report,options):overview(report,options));
 }

 if(root.document&&!root.__gucReportSortInstalled){
  root.__gucReportSortInstalled=true;
  root.document.addEventListener('click',event=>{
   const button=event.target.closest('[data-gr-sort]');if(!button)return;
   const table=button.closest('table'),header=button.closest('th'),index=Number(button.dataset.grSort),descending=header.getAttribute('aria-sort')==='ascending';
   table.querySelectorAll('th').forEach(th=>th.setAttribute('aria-sort','none'));header.setAttribute('aria-sort',descending?'descending':'ascending');
   const value=cell=>{const text=cell.textContent.trim();return /^-?[\d,.]+(?:\s+[^\d]+)?$/.test(text)?Number.parseFloat(text.replaceAll(',','')):text;};
   const rows=[...table.tBodies[0].rows].filter(row=>row.cells.length>index);
   rows.sort((a,b)=>{const left=value(a.cells[index]),right=value(b.cells[index]);return (typeof left==='number'&&typeof right==='number'?left-right:String(left).localeCompare(String(right),'zh-Hant',{numeric:true}))*(descending?-1:1);});
   table.tBodies[0].append(...rows);
  });
 }
 root.GUCWorkContentReport=Object.freeze({render,escape:esc});
})(globalThis);
