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
 // SVG geometry uses presentation attributes, never inline styles. Production
 // CSP permits same-origin stylesheets but intentionally blocks style attrs.
 const positive=v=>Number.isFinite(Number(v))?Math.max(0,Number(v)):0;
 const colors=['#4b6047','#8b6747','#527571','#7b6757','#657746','#756477','#596d7a','#89605f'];
 let selectedMaterialCategory='',currentOptions=null,currentProject='';
 const categoryKey=id=>id==null?'__uncategorized':String(id);
 function categoryReport(report){const key=selectedMaterialCategory;return !key?report:{...report,materialCategoryStats:(report.materialCategoryStats||[]).filter(r=>categoryKey(r.id)===key),materialStats:(report.materialStats||[]).filter(r=>categoryKey(r.categoryId)===key),materialRows:(report.materialRows||[]).filter(r=>categoryKey(r.categoryId)===key)};}
 function categoryPicker(report){return `<label class="gr-category-picker">貨品種類 <select data-gr-material-category aria-label="用料貨品種類"><option value="">全部貨品種類</option>${(report.materialCategoryStats||[]).map(r=>`<option value="${esc(categoryKey(r.id))}"${selectedMaterialCategory===categoryKey(r.id)?' selected':''}>${esc(r.name)}</option>`).join('')}</select></label>`;}

 const color=i=>colors[i%colors.length];
 const short=(value,length=12)=>{const chars=Array.from(String(value||''));return chars.length>length?chars.slice(0,length-1).join('')+'…':chars.join('');};
 const chartCard=(title,body,note='',extra='')=>card(title,body,note,'gr-chart-card '+extra);
 function columns(series,{label,unit,project,workers=false,items=false}){
  const max=Math.max(1,...series.map(r=>positive(r.value))),money=unit==='元';
  const value=v=>(money?'$':'')+num(v)+(money?'':' '+unit);
  const caption=r=>r.missing?'未定價':value(r.value);
  const labelWidth=text=>Array.from(text).reduce((n,c)=>n+(c.charCodeAt(0)>255?12:7),0);
  const slot=Math.max(items?88:workers?86:70,...series.map(r=>labelWidth(value(r.value))+14));
  const width=Math.max(items?220:360,series.length*slot+56),base=items?184:207,plot=items?128:151,left=42,span=(width-left-14)/Math.max(series.length,1);
  const itemLabel=(name,x)=>{const chars=Array.from(String(name)),lines=[0,1,2].map(i=>chars.slice(i*7,(i+1)*7).join('')).filter(Boolean);if(chars.length>21)lines[2]=Array.from(lines[2]).slice(0,6).join('')+'…';return `<text class="gr-column-label" x="${x}" y="207" text-anchor="middle">${lines.map((line,i)=>`<tspan x="${x}" dy="${i?15:0}">${esc(line)}</tspan>`).join('')}</text>`;};
  const legends=workers?[{name:'施工天數',color:'#4b6047'}]:series;
  return `<div class="gr-chart-with-legend${workers?' gr-personnel-chart':items?' gr-item-chart':''}"><div class="gr-plot-scroll" tabindex="0" role="region" aria-label="${esc(label)}"><svg class="gr-columns" width="${width}" height="258" viewBox="0 0 ${width} 258" role="img" aria-label="${esc(label)}"><title>${esc(label)}：${series.map(r=>esc(r.name+' '+caption(r))).join('；')}</title>${[0,.25,.5,.75,1].map(t=>`<line class="gr-gridline" x1="${left}" y1="${base-t*plot}" x2="${width-10}" y2="${base-t*plot}"/><text class="gr-axis-tick" x="${left-7}" y="${base-t*plot+4}" text-anchor="end">${num(t*max)}</text>`).join('')}<text class="gr-axis-unit" x="${left}" y="20">${esc(unit)}</text>${series.map((r,i)=>{const h=positive(r.value)/max*plot,x=left+span*(i+.5),bw=Math.min(workers?44:52,span*.65);return `<g class="gr-column"${items?` data-gr-item-id="${esc(r.id)}"`:''} data-chart-value="${r.missing?'':positive(r.value)}"><title>${esc(r.name+'：'+caption(r))}</title><rect class="gr-column-bar" x="${x-bw/2}" y="${base-h}" width="${bw}" height="${h}" fill="${r.color||color(i)}"/><text class="gr-column-value" x="${x}" y="${base-h-9}" text-anchor="middle">${esc(caption(r))}</text>${items?itemLabel(r.name,x):workers?`<text class="gr-column-label" x="${x}" y="230" text-anchor="middle">${esc(short(r.name,6))}</text>`:''}</g>`;}).join('')}<line class="gr-baseline" x1="${left}" y1="${base}" x2="${width-10}" y2="${base}"/>${!workers&&!items?`<text class="gr-project-label" x="${(left+width-10)/2}" y="236" text-anchor="middle">${esc(short(project||'工作內容',26))}</text>`:''}</svg></div>${items?'':`<ul class="gr-chart-legend">${legends.map(r=>`<li><svg width="9" height="9" aria-hidden="true"><rect width="9" height="9" fill="${r.color}"/></svg><span>${esc(r.name)}</span></li>`).join('')}</ul>`}</div>`;
 }
 function workerChart(rows){
  return rows.length?columns(rows.map(r=>({name:r.name||r.label,value:r.constructionDays,color:'#4b6047'})),{label:'人員施工天數直式長條圖',unit:'天',workers:true}):blank('此日期區間沒有施工人員紀錄。');
 }
 function materialChartData(report,options){
  const categories=report.materialCategoryStats;
  if(!categories)return blank('材料分類統計尚未載入，請確認報表更新已套用。');
  if(!categories.length)return blank('此日期區間沒有用料紀錄。');
  const priced=!!options.pricePermissions?.view,rows=report.materialStats||[];
  const itemName=r=>[r.name,r.model&&!String(r.name||'').includes(r.model)?r.model:''].filter(Boolean).join('／');
  const groups=categories.map((c,i)=>{
   const entries=rows.filter(r=>categoryKey(r.categoryId)===categoryKey(c.id));if(!entries.length)return '';
   const units=priced?['元']:[...new Set(entries.map(r=>r.unit||'未標示單位'))];
   return `<section class="gr-material-category" data-gr-material-category-group="${esc(categoryKey(c.id))}"><h3>${esc(c.name)}</h3>${units.map(unit=>{
    const items=priced?entries:entries.filter(r=>(r.unit||'未標示單位')===unit);
    return `<section class="gr-material-unit" data-gr-unit="${esc(unit)}"><p class="gr-material-unit-label">${priced?'參考金額':'用量'}（${esc(unit)}）</p>${columns(items.map(r=>({id:r.id,name:itemName(r),value:priced?r.amount:r.quantity,missing:priced&&r.amount==null,color:color(i)})),{label:c.name+'各品項'+(priced?'參考金額':'用量')+'直式長條圖（'+unit+'）',unit,items:true})}</section>`;
   }).join('')}</section>`;
  }).join('');
  if(!groups)return blank('此日期區間沒有用料紀錄。');
  const missing=priced?rows.filter(r=>r.amount==null).length:0;
  return '<div class="gr-material-facets">'+groups+'</div><p class="gr-chart-note">'+(priced?`各品項分別呈現參考金額${missing?'；'+num(missing)+' 個品項未設定價格，未計入金額':'；非實際結算成本'}。`:'各品項分別呈現領用量；不同單位分圖顯示，不合併加總。')+'</p>';

 }
 function materialChart(report,options){return categoryPicker(report)+'<div data-gr-category-chart>'+materialChartData(categoryReport(report),options)+'</div>';}
 function semicircle(percent){
  const angle=Math.PI*(1-Math.min(100,positive(percent))/100),x=160+100*Math.cos(angle),y=145-100*Math.sin(angle);
  return `<svg class="gr-gauge" width="320" height="230" viewBox="0 0 320 230" role="img" aria-label="施工天數進度 ${percent==null?'未設定':num(percent)+'%'}"><path d="M 38 145 A 122 122 0 0 1 73.73 58.73" fill="none" stroke="#4b6047" stroke-width="40"/><path d="M 73.73 58.73 A 122 122 0 0 1 246.27 58.73" fill="none" stroke="#a08059" stroke-width="40"/><path d="M 246.27 58.73 A 122 122 0 0 1 282 145" fill="none" stroke="#dcded2" stroke-width="40"/>${percent==null?'':`<line x1="160" y1="145" x2="${x}" y2="${y}" stroke="#303b34" stroke-width="3"/><circle cx="160" cy="145" r="4" fill="#303b34"/>`}<text x="160" y="181" text-anchor="middle" class="gr-gauge-value">${percent==null?'—':num(percent)+'%'}</text><text x="160" y="215" text-anchor="middle" class="gr-gauge-caption">施工天數進度</text></svg>`;
 }
 function materialDonut(report,options){
  report=categoryReport(report);
  const priced=!!options.pricePermissions?.view,categories=report.materialCategoryStats||[],series=categories.map((r,i)=>({name:r.name,value:positive(priced?r.amount:r.recordCount),missing:priced&&r.amount==null,color:color(i)})),sum=series.reduce((n,r)=>n+r.value,0);
  let angle=-Math.PI/2;
  const slices=series.filter(r=>r.value>0).map(r=>{const start=angle,extent=r.value/sum*Math.PI*2;angle+=extent;const x=a=>150+102*Math.cos(a),y=a=>140+102*Math.sin(a),mid=start+extent/2;return `${extent>Math.PI*2-.00001?`<circle cx="150" cy="140" r="102" fill="none" stroke="${r.color}" stroke-width="45"/>`:`<path d="M ${x(start)} ${y(start)} A 102 102 0 ${extent>Math.PI?1:0} 1 ${x(angle)} ${y(angle)}" fill="none" stroke="${r.color}" stroke-width="45"/>`}${r.value/sum>=.06?`<text x="${150+102*Math.cos(mid)}" y="${144+102*Math.sin(mid)}" class="gr-donut-label" text-anchor="middle">${num(100*r.value/sum)}%</text>`:''}`;}).join('');
  return chartCard(priced?'材料參考金額占比':'材料種類領用占比',sum?`<div class="gr-donut-layout"><svg class="gr-donut" width="300" height="280" viewBox="0 0 300 280" role="img" aria-label="${esc(series.map(r=>r.name+' '+(r.missing?'未定價':num(100*r.value/sum)+'%')).join('；'))}">${slices}<text x="150" y="138" text-anchor="middle" class="gr-donut-total">${priced?'$':''}${num(sum)}</text><text x="150" y="161" text-anchor="middle">${priced?'已定價參考金額':'領用紀錄（筆）'}</text></svg><ul class="gr-chart-legend">${series.map(r=>`<li><svg width="9" height="9" aria-hidden="true"><rect width="9" height="9" fill="${r.color}"/></svg>${esc(r.name)} · ${r.missing?'未定價':num(r.value)+(priced?' 元':' 筆')}</li>`).join('')}</ul></div>`:blank('沒有可計算占比的資料。'),priced?'已定價材料小計占比；未定價材料與人事成本未計入。':'按領用紀錄筆數計算；不混加不同材料單位。','gr-distribution');
 }
 function progress(row){
  const planned=Number(row.planned_days)||0,percent=Number(row.progress_percent)||0,over=Number(row.overrun_days)||0;
  return `<div class="gr-progress${over?' gr-alert':''}"><div class="gr-meter-label"><span>已完成 ${num(row.completed_days)} 天</span><strong>${planned?num(percent)+'%':'未設定天數'}</strong></div>${planned?`<progress max="100" value="${Math.max(0,Math.min(100,percent))}" aria-label="${esc(row.title||row.content)}天數進度"></progress><p>預計 ${num(planned)} 天 · 剩餘 ${num(row.remaining_days)} 天${over?` · <b>超出預計施工天數 ${num(over)} 天</b>`:''}</p>`:''}</div>`;
 }
 function logsTable(logs,accounting){return table(['日期','工作摘要','狀態','原始資料'],logs.map(l=>`<tr><td>${esc(l.date)}</td><td>${esc(l.summary||'—')}</td><td>${esc(status(l.status))}</td><td>${l.can_open?`<button type="button" ${accounting?'data-gr-open-log':'data-edit-work-log'}="${esc(l.id)}">查看原日誌</button>`:'—'}</td></tr>`));}
 function plansDetail(plans,accounting){return card('施工規劃明細',plans.length?plans.map(p=>`<details class="gr-plan" data-report-plan="${esc(p.id)}"><summary><span>${esc(p.content)}<small>${esc(p.construction_date)} · ${esc(status(p.status))}</small></span><b class="${p.overrun_days?'gr-alert':''}">${num(p.completed_days)} / ${p.planned_days?num(p.planned_days):'未設定'} 天</b></summary><div class="gr-plan-body"><p>指派施工人員：${esc((p.assignees||[]).map(a=>a.name).join('、')||'未指派')}</p>${progress(p)}${p.notes?`<p>${esc(p.notes)}</p>`:''}${p.items?.length?`<p>清單勾選完成：${num(p.completed_item_count)} / ${p.items.length} 項（與天數進度分開計算）</p>`:''}${(p.items||[]).map(i=>`<details class="gr-item"><summary>${esc(i.title)} <span>${i.is_completed?'已勾選完成':'未勾選完成'}</span></summary><div><p>預計第 ${num(i.start_day)} 工作日起 · ${num(i.planned_days)} 天</p>${progress(i)}${logsTable(i.logs||[],accounting)}</div></details>`).join('')}${p.can_open?`<button type="button" ${accounting?'data-gr-open-plan':'data-construction-project'}="${esc(p.project_id)}">開啟施工規劃</button>`:''}<h3>相關工作日誌（${p.logs?.length||0}）</h3>${logsTable(p.logs||[],accounting)}</div></details>`).join(''):blank('尚未建立施工規劃。'),'列出全部規劃；展開項目可查看進度、指派人員及相關日誌。','gr-plans-card');}
 function ganttChart(plans){
  const rows=plans.flatMap(p=>(p.items?.length?p.items.map(i=>({...i,label:p.content+' / '+i.title})): [{...p,label:p.content,start_day:1}]));
  const max=Math.max(1,...rows.map(r=>Number(r.start_day||1)-1+Number(r.planned_days||0)));
  const width=820,left=260,plot=530,height=50+rows.length*42,ticks=Math.min(max,10);
  return card('排程圖',rows.length?`<div class="gr-gantt" tabindex="0" role="region" aria-label="各規劃起始工作日排程"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="施工項目工作日甘特圖">${Array.from({length:ticks+1},(_,i)=>{const day=Math.round(i*max/ticks),x=left+day/max*plot;return `<line x1="${x}" y1="38" x2="${x}" y2="${height-5}" stroke="#dcded2"/><text x="${x}" y="23" text-anchor="middle">第 ${day+1} 日</text>`;}).join('')}${rows.map((r,i)=>{const y=48+i*42,x=left+positive(Number(r.start_day||1)-1)/max*plot,w=positive(r.planned_days)/max*plot;return `<g><title>${esc(r.label)}：第 ${num(r.start_day||1)} 工作日起，${r.planned_days?num(r.planned_days)+' 天':'未設定天數'}</title><text x="${left-12}" y="${y+16}" text-anchor="end">${esc(short(r.label,18))}（${r.planned_days?num(r.planned_days)+'天':'未設定'}）</text>${w?`<rect class="gr-gantt-bar" x="${x}" y="${y+4}" width="${w}" height="14" fill="#4b6047"/>`:`<text x="${x+5}" y="${y+16}">未設定</text>`}</g>`;}).join('')}</svg></div>`:blank('尚無施工排程。'),'預計工作日排程；各規劃起始日為第 1 日，不代表實際施工日期。','gr-gantt-card');
 }
 function gantt(plans){return card('施工項目排程',plans.length?plans.map(p=>`<details class="gr-plan" data-gr-schedule="${esc(p.id)}"><summary><span>${esc(p.content)}</span><b>預計 ${p.planned_days?num(p.planned_days):'未設定'} 天｜已完成 ${num(p.completed_days)} 天</b></summary><div class="gr-plan-body">${ganttChart([p])}${progress(p)}<p>${esc(p.construction_date)} · ${esc(status(p.status))}</p></div></details>`).join(''):blank('尚無施工排程。'),'點選 ＋ 展開排程圖與進度，再按 − 收合。','gr-gantt-card');}
 function materialTableData(report,options){
  const price=!!options.pricePermissions?.view;
  return table(['品項','材料種類','品牌／型號','總量','領用次數','首次／最近',...(price?['單價（元）','金額（元）','價格來源／日期','價格操作']:[])],report.materialStats.map(r=>`<tr><td><strong>${esc(r.name)}</strong></td><td>${esc(r.categoryName||'未分類')}</td><td>${esc([r.brand,r.model].filter(Boolean).join('｜')||'—')}</td><td>${num(r.quantity)} ${esc(r.unit)}</td><td>${num(r.recordCount)}</td><td>${esc(r.firstDate||'—')}<small>${esc(r.recentDate||'—')}</small></td>${price?`<td>${r.unit_price==null?'未設定':num(r.unit_price)}</td><td>${r.amount==null?'—':num(r.amount)}</td><td>${r.price_source==='manual'?'人工參考價格':r.price_source==='receipt'?(r.source_tax_mode==='inclusive'?'最近進貨（含稅價換算未稅）':r.source_tax_mode==='exclusive'?'最近進貨（未稅）':'最近進貨（歷史計稅未設定）'):'沒有價格'}<small>${esc(r.price_date||'—')}</small></td><td>${(r.price_source==='manual'?options.pricePermissions.update:options.pricePermissions.create)?`<button type="button" data-gr-edit-price="${esc(r.id)}" ${options.readOnly?'disabled':''}>修改參考單價</button>`:''}${r.price_source==='manual'&&options.pricePermissions.delete?`<button type="button" data-gr-clear-price="${esc(r.id)}" ${options.readOnly?'disabled':''}>恢復進貨參考價</button>`:''}</td>`:''}</tr>`),'materialStatsTable');
 }
 function materialTable(report,options){return '<div data-gr-category-table>'+materialTableData(categoryReport(report),options)+'</div>';}
 function materialRowsTable(report){return table(['日期','品項','品牌／型號','數量','取貨帳號'],(categoryReport(report).materialRows||[]).map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.item?.name)}</td><td>${esc([r.item?.brand,r.item?.model].filter(Boolean).join('｜'))}</td><td>${num(r.quantity)} ${esc(r.item?.unit)}</td><td>${esc(r.account)}</td></tr>`),'materialRowsTable');}
 function receiptHistory(report,options){
  if(!options.pricePermissions?.view||!report.receiptDocuments)return '';
  const t=report.receiptTotals||{},money=v=>v==null?'未設定':num(v),mode=v=>v==='inclusive'?'含稅':v==='exclusive'?'未稅':'歷史未設定';
  return card('關聯進貨歷史',`<p>${num(t.documentCount)} 張進貨單｜未稅 ${money(t.netAmount)} 元｜稅額 ${money(t.taxAmount)} 元｜含稅 ${money(t.totalAmount)} 元</p>${t.unpricedDocumentCount?'<p>'+num(t.unpricedDocumentCount)+' 張計稅或價格未完整設定，未計入總額。</p>':''}${report.receiptDocuments.map(d=>`<details class="gr-plan"><summary><span>${esc(d.documentNo||d.id)} · ${esc(d.date)}<small>${mode(d.financials?.mode)} · ${d.financials?.tax_rate_basis_points==null?'稅率未設定':num(d.financials.tax_rate_basis_points/100)+'%'}</small></span><b>含稅 ${money(d.financials?.total_amount)} 元</b></summary><div class="gr-plan-body"><p>未稅 ${money(d.financials?.net_amount)} 元 · 稅額 ${money(d.financials?.tax_amount)} 元 · 含稅 ${money(d.financials?.total_amount)} 元</p>${table(['貨品','數量','原始進貨單價','原始品項小計'],(d.lines||[]).map(l=>`<tr><td>${esc(l.name)}</td><td>${num(l.quantity)} ${esc(l.unit)}</td><td>${money(l.unit_price)}</td><td>${money(l.input_amount)}</td></tr>`))}</div></details>`).join('')}`,report.receiptAssociationNote||'進貨歷史與材料參考金額分開呈現。');
 }
 function materials(report,options){return chartCard('用料統計',materialChart(report,options),'依貨品種類分組，各品項分別呈現直式柱狀圖。')+card('材料品項彙總',materialTable(report,options),'領用量 × 參考單價；人工價格優先，不覆寫進貨歷史。')+card('用料明細','<div data-gr-category-rows>'+materialRowsTable(report)+'</div>')+receiptHistory(report,options);}
 function workers(report,options){return chartCard('人員施工統計',workerChart(report.workerStats),'同人、同工作內容、同日計一次；縱軸為施工天數，橫軸為施工人員。')+card('施工人員明細',table(['人員','施工天數','日誌筆數','首次施工','最近施工','帳號狀態'],report.workerStats.map(r=>`<tr><td>${esc(r.label||r.name)}</td><td>${num(r.constructionDays)} 天</td><td>${num(r.recordCount)}</td><td>${esc(r.firstDate||'—')}</td><td>${esc(r.recentDate||'—')}</td><td>${r.active===false?'已停用':'啟用'}</td></tr>`),'workerStatsTable'))+card('每日施工明細',table(['日期／時段','本筆施工人員','當日去重人數','工作摘要','狀態','原始資料'],(report.dailyRows||[]).map(r=>`<tr><td>${esc(r.date)}<small>${esc(r.timePeriod||'—')}</small></td><td>${esc((r.workerNames||[]).join('、')||'未指定')}</td><td>${num(r.dailyHeadcount)}</td><td>${esc(r.summary)}</td><td>${esc(status(r.status))}</td><td><button type="button" ${options.accounting?'data-gr-open-log':'data-edit-work-log'}="${esc(r.id)}">查看原日誌</button></td></tr>`),'dailyRowsTable'));}
 function overview(report,options){
  const plans=report.constructionPlans||[],s=report.constructionSummary,k=report.kpis;
  if(!s)return card('施工規劃資料尚未載入',blank('報表服務尚未提供施工統計，請確認本次增量更新已套用。'))+materials(report,options)+workers(report,options);
  const percent=s.plannedDays>0?100*s.completedDays/s.plannedDays:null;
  const gauge=chartCard('專案進度',semicircle(percent)+`<p class="gr-chart-note">已完成 ${num(s.completedDays)} / 預計 ${num(s.plannedDays)} 天<br>${num(s.projectDays)} 個專案實際完成日（跨規劃去重）</p>${s.unsetPlanCount?`<p class="gr-chart-note">${num(s.unsetPlanCount)} 筆規劃未設定天數；比率僅作參考。</p>`:''}`,'','gr-gauge-card');
  return `<section class="gr-kpis">${kpi('施工規劃',num(s.planCount)+' 筆','包含尚未開始的規劃')}${kpi('預計施工',num(s.plannedDays)+' 天','規劃天數總和')}${kpi('已完成施工',num(s.completedDays)+' 天','各規劃完成日數總和')}${kpi('剩餘施工',num(s.remainingDays)+' 天','各規劃剩餘天數總和')}${kpi('超期項目',num(s.overdueItemCount)+' 項','未拆子項目者以整筆規劃計',s.overdueItemCount>0)}</section><p class="gr-note">完成天數僅計已完成、未刪除、非未來日期的工程施工日誌；同規劃／子項目、同日期去重。已取消規劃保留明細，不列入天數摘要。</p><div class="gr-dashboard">${gantt(plans)}${plansDetail(plans,options.accounting)}${chartCard('人員施工統計',workerChart(report.workerStats),`${num(k.workerCount)} 位施工人員 · ${num(k.workerDays)} 人天`,'gr-workers-card')}${gauge}${chartCard('用料統計',materialChart(report,options),`${num(report.materialCategoryStats?.length)} 種材料分類 · ${num(k.materialTypeCount)} 個品項`,'gr-materials-card')}<div class="gr-distribution" data-gr-category-donut>${materialDonut(report,options)}</div>${card('材料品項彙總',materialTable(report,options),'完整用料、數量與領用期間。','gr-summary-card')}</div>${receiptHistory(report,options)}`;
 }
 function render(options){
  const {report,tab='overview'}=options,p=report.project||options.project||{};
  if(currentProject!==p.id){selectedMaterialCategory='';currentProject=p.id;}
  if(selectedMaterialCategory&&!(report.materialCategoryStats||[]).some(r=>categoryKey(r.id)===selectedMaterialCategory))selectedMaterialCategory='';
  currentOptions=options;
  const heading=`<article class="gr-heading"><div><span class="gr-code">${esc(p.code||'未編號')}</span><h2>${esc(p.name)}</h2><p>${esc(p.customer||'')} · ${esc(p.type||'工程施工')} · 負責人：${esc(p.owner||'未指派')}</p><p>建立：${date(p.createdAt)}${p.date?' · 工作日期：'+date(p.date):''} · 結案：${date(p.completedOn)}</p></div><span class="gr-status">${esc(status(p.status))}</span></article>`;
  return heading+(tab==='materials'?materials(report,options):tab==='workers'?workers(report,options):overview(report,options));
 }

 if(root.document&&!root.__gucReportSortInstalled){
  root.__gucReportSortInstalled=true;
  root.document.addEventListener('change',event=>{
   const select=event.target.closest('[data-gr-material-category]');if(!select||!currentOptions)return;
   selectedMaterialCategory=select.value;
   const host=select.closest('.guc-report')||select.closest('.gr-report-content'),{report}=currentOptions;
   host.querySelectorAll('[data-gr-category-chart]').forEach(el=>el.innerHTML=materialChartData(categoryReport(report),currentOptions));
   host.querySelectorAll('[data-gr-category-table]').forEach(el=>el.innerHTML=materialTableData(categoryReport(report),currentOptions));
   host.querySelectorAll('[data-gr-category-rows]').forEach(el=>el.innerHTML=materialRowsTable(report));
   host.querySelectorAll('[data-gr-category-donut]').forEach(el=>el.innerHTML=materialDonut(report,currentOptions));

  });
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
