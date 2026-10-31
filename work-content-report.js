// Shared, framework-neutral report presentation. All business statistics come
// from work_content_report_v1; this module only formats authorized API values.
(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const num=v=>Number(v||0).toLocaleString('zh-TW',{maximumFractionDigits:2});
 const pct=v=>v==null?'未設定':Number(v).toLocaleString('zh-TW',{maximumFractionDigits:1})+'%';
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
 function categoryReport(report){const key=selectedMaterialCategory;return !key?report:{...report,materialCategoryStats:(report.materialCategoryStats||[]).filter(r=>categoryKey(r.id)===key),materialStats:(report.materialStats||[]).filter(r=>categoryKey(r.categoryId)===key),materialRows:(report.materialRows||[]).filter(r=>categoryKey(r.categoryId)===key),returnRows:(report.returnRows||[]).filter(r=>categoryKey(r.categoryId)===key)};}
 function categoryPicker(report){return `<label class="gr-category-picker">貨品種類 <select data-gr-material-category aria-label="用料貨品種類"><option value="">全部貨品種類</option>${(report.materialCategoryStats||[]).map(r=>`<option value="${esc(categoryKey(r.id))}"${selectedMaterialCategory===categoryKey(r.id)?' selected':''}>${esc(r.name)}</option>`).join('')}</select></label>`;}

 const color=i=>colors[i%colors.length];
 const short=(value,length=12)=>{const chars=Array.from(String(value||''));return chars.length>length?chars.slice(0,length-1).join('')+'…':chars.join('');};
 const chartCard=(title,body,note='',extra='')=>card(title,body,note,'gr-chart-card '+extra);
 function columns(series,{label,unit,project,workers=false,items=false,accounting=false}){
  accounting=true; // Both systems now use the same 12pt chart geometry.
  const signed=v=>Number.isFinite(Number(v))?Number(v):0;
  const max=Math.max(1,...series.map(r=>signed(r.value))),min=Math.min(0,...series.map(r=>signed(r.value))),range=max-min,money=unit==='元';
  const value=v=>(money?'$':'')+num(v)+(money?'':' '+unit);
  const caption=r=>r.missing?'未定價':value(r.value);
  const labelWidth=text=>Array.from(text).reduce((n,c)=>n+(c.charCodeAt(0)>255?(accounting?16:12):(accounting?9:7)),0);
  // Accounting uses 12pt text; reserve real label space without shrinking the font.
  const slot=Math.max(accounting?(items?136:workers?116:90):(items?88:workers?86:70),...series.map(r=>labelWidth(caption(r))+14));
  const left=accounting?Math.max(42,...[0,.25,.5,.75,1].map(t=>labelWidth(num(min+t*range))+20)):42;
  const width=Math.max(items?220:360,series.length*slot+left+14),base=items?(accounting?170:184):207,plot=items?(accounting?114:128):151,span=(width-left-14)/Math.max(series.length,1);
  const y=v=>base-(v-min)/range*plot,zero=y(0);
  const itemLabel=(name,x)=>{const chars=Array.from(String(name)),lines=[0,1,2].map(i=>chars.slice(i*7,(i+1)*7).join('')).filter(Boolean);if(chars.length>21)lines[2]=Array.from(lines[2]).slice(0,6).join('')+'…';return `<text class="gr-column-label" x="${x}" y="${accounting?197:207}" text-anchor="middle">${lines.map((line,i)=>`<tspan x="${x}" dy="${i?(accounting?25:15):0}">${esc(line)}</tspan>`).join('')}</text>`;};
  const legends=workers?[{name:'施工天數',color:'#4b6047'}]:series;
  return `<div class="gr-chart-with-legend${workers?' gr-personnel-chart':items?' gr-item-chart':''}"><div class="gr-plot-scroll" tabindex="0" role="region" aria-label="${esc(label)}"><svg class="gr-columns" width="${width}" height="258" viewBox="0 0 ${width} 258" role="img" aria-label="${esc(label)}"><title>${esc(label)}：${series.map(r=>esc(r.name+' '+caption(r))).join('；')}</title>${[0,.25,.5,.75,1].map(t=>`<line class="gr-gridline" x1="${left}" y1="${base-t*plot}" x2="${width-10}" y2="${base-t*plot}"/><text class="gr-axis-tick" x="${left-7}" y="${base-t*plot+4}" text-anchor="end">${num(min+t*range)}</text>`).join('')}<text class="gr-axis-unit" x="${left}" y="20">${esc(unit)}</text>${series.map((r,i)=>{const v=signed(r.value),h=Math.abs(v)/range*plot,top=Math.min(zero,y(v)),x=left+span*(i+.5),bw=Math.min(workers?44:52,span*.65);return `<g class="gr-column"${items?` data-gr-item-id="${esc(r.id)}"`:''} data-chart-value="${r.missing?'':v}"><title>${esc(r.name+'：'+caption(r))}</title><rect class="gr-column-bar" x="${x-bw/2}" y="${top}" width="${bw}" height="${h}" fill="${r.color||color(i)}"/><text class="gr-column-value" x="${x}" y="${v<0?y(v)+17:top-9}" text-anchor="middle">${esc(caption(r))}</text>${items?itemLabel(r.name,x):workers?`<text class="gr-column-label" x="${x}" y="230" text-anchor="middle">${esc(short(r.name,6))}</text>`:''}</g>`;}).join('')}<line class="gr-baseline" x1="${left}" y1="${zero}" x2="${width-10}" y2="${zero}"/>${!workers&&!items?`<text class="gr-project-label" x="${(left+width-10)/2}" y="236" text-anchor="middle">${esc(short(project||'工作內容',26))}</text>`:''}</svg></div>${items?'':`<ul class="gr-chart-legend">${legends.map(r=>`<li><svg width="9" height="9" aria-hidden="true"><rect width="9" height="9" fill="${r.color}"/></svg><span>${esc(r.name)}</span></li>`).join('')}</ul>`}</div>`;
 }
 function workerChart(rows,options){
  return rows.length?columns(rows.map(r=>({name:r.name||r.label,value:r.constructionDays,color:'#4b6047'})),{label:'人員施工天數直式長條圖',unit:'天',workers:true,accounting:!!options?.accounting}):blank('此日期區間沒有施工人員紀錄。');
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
   return units.map(unit=>{
    const items=priced?entries:entries.filter(r=>(r.unit||'未標示單位')===unit);
    return `<section class="gr-material-category" data-gr-material-category-group="${esc(categoryKey(c.id))}"><h3>${esc(c.name)}</h3><section class="gr-material-unit" data-gr-unit="${esc(unit)}"><p class="gr-material-unit-label">${priced?'淨用料金額':'淨用量'}（${esc(unit)}）</p>${columns(items.map(r=>({id:r.id,name:itemName(r),value:priced?r.amount:r.quantity,missing:priced&&r.amount==null,color:color(i)})),{label:c.name+'各品項'+(priced?'參考金額':'用量')+'直式長條圖（'+unit+'）',unit,items:true,accounting:!!options.accounting})}</section></section>`;
   }).join('');
  }).join('');
  if(!groups)return blank('此日期區間沒有用料紀錄。');
  const missing=priced?rows.filter(r=>r.amount==null).length:0;
  return '<div class="gr-material-facets">'+groups+'</div><p class="gr-chart-note">'+(priced?`各品項分別呈現參考金額${missing?'；'+num(missing)+' 個品項未設定價格，未計入金額':'；非實際結算成本'}。`:'各品項呈現領用扣除退料後的淨用量；不同單位分圖顯示。區間退料多於領用時顯示負值。')+'</p>';

 }
 function materialChart(report,options){return categoryPicker(report)+'<div data-gr-category-chart>'+materialChartData(categoryReport(report),options)+'</div>';}
 function semicircle(percent,accounting=false){
  const angle=Math.PI*(1-Math.min(100,positive(percent))/100),x=160+100*Math.cos(angle),y=145-100*Math.sin(angle);
  const height=accounting?165:230,value=percent==null?'—':num(percent)+'%';
  return `<svg class="gr-gauge" width="320" height="${height}" viewBox="0 0 320 ${height}" role="img" aria-label="施工完成進度 ${percent==null?'未設定':num(percent)+'%'}"><path d="M 38 145 A 122 122 0 0 1 73.73 58.73" fill="none" stroke="#4b6047" stroke-width="40"/><path d="M 73.73 58.73 A 122 122 0 0 1 246.27 58.73" fill="none" stroke="#a08059" stroke-width="40"/><path d="M 246.27 58.73 A 122 122 0 0 1 282 145" fill="none" stroke="#dcded2" stroke-width="40"/>${percent==null?'':`<line x1="160" y1="145" x2="${x}" y2="${y}" stroke="#303b34" stroke-width="3"/><circle cx="160" cy="145" r="4" fill="#303b34"/>`}${accounting?'':`<text x="160" y="181" text-anchor="middle" class="gr-gauge-value">${value}</text><text x="160" y="215" text-anchor="middle" class="gr-gauge-caption">施工完成進度</text>`}</svg>${accounting?`<div class="gr-gauge-readout"><span class="gr-gauge-value">${value}</span><span class="gr-gauge-caption">施工完成進度</span></div>`:''}`;
 }
 function materialDonut(report,options){
  options={...options,accounting:true}; // Keep 12pt center text outside scaled SVG geometry on every site.
  report=categoryReport(report);
  if(options.pricePermissions?.view&&(report.materialCategoryStats||[]).some(r=>Number(r.amount)<0))return chartCard('材料參考金額占比',blank('此區間含負淨用料金額，不計算圓餅占比；請參閱用料明細與直條圖。'));
  const priced=!!options.pricePermissions?.view,categories=report.materialCategoryStats||[],series=categories.map((r,i)=>({name:r.name,value:positive(priced?r.amount:r.recordCount),missing:priced&&r.amount==null,color:color(i)})),sum=series.reduce((n,r)=>n+r.value,0);
  let angle=-Math.PI/2;
  const slices=series.filter(r=>r.value>0).map(r=>{const start=angle,extent=r.value/sum*Math.PI*2;angle+=extent;const x=a=>150+102*Math.cos(a),y=a=>140+102*Math.sin(a),mid=start+extent/2;return `${extent>Math.PI*2-.00001?`<circle cx="150" cy="140" r="102" fill="none" stroke="${r.color}" stroke-width="45"/>`:`<path d="M ${x(start)} ${y(start)} A 102 102 0 ${extent>Math.PI?1:0} 1 ${x(angle)} ${y(angle)}" fill="none" stroke="${r.color}" stroke-width="45"/>`}${r.value/sum>=.06?`<text x="${150+102*Math.cos(mid)}" y="${144+102*Math.sin(mid)}" class="gr-donut-label" text-anchor="middle">${num(100*r.value/sum)}%</text>`:''}`;}).join('');
  const total=(priced?'$':'')+num(sum),totalLabel=priced?'已定價參考金額':'領用紀錄（筆）';
  return chartCard(priced?'材料參考金額占比':'材料種類領用占比',sum?`<div class="gr-donut-layout">${options.accounting?'<div class="gr-donut gr-donut-figure">':''}<svg class="${options.accounting?'gr-donut-svg':'gr-donut'}" width="300" height="280" viewBox="0 0 300 280" role="img" aria-label="${esc(series.map(r=>r.name+' '+(r.missing?'未定價':num(100*r.value/sum)+'%')).join('；'))}">${slices}${options.accounting?'':`<text x="150" y="138" text-anchor="middle" class="gr-donut-total">${total}</text><text x="150" y="161" text-anchor="middle">${totalLabel}</text>`}</svg>${options.accounting?`<div class="gr-donut-center"><span class="gr-donut-total">${total}</span><span>${totalLabel}</span></div></div>`:''}<ul class="gr-chart-legend">${series.map(r=>`<li><svg width="9" height="9" aria-hidden="true"><rect width="9" height="9" fill="${r.color}"/></svg>${esc(r.name)} · ${r.missing?'未定價':num(r.value)+(priced?' 元':' 筆')}</li>`).join('')}</ul></div>`:blank('沒有可計算占比的資料。'),priced?'已定價材料小計占比；未定價材料與人事成本未計入。':'按領用紀錄筆數計算；不混加不同材料單位。','gr-distribution');
 }
 function planProgress(row){
  const count=Number(row.item_count??row.items?.length??0),done=Number(row.completed_item_count||0),percent=count?row.progress_percent??row.completion_percent:null;
  return {count,done,percent,planned:Number(row.planned_days)||0,worked:Number(row.worked_days)||0};
 }
 function progress(row){
  const p=planProgress(row),over=Number(row.overrun_days)||0;
  return `<div class="gr-progress${row.progress_alert?' gr-alert':''}"><div class="gr-meter-label"><span>施工項目完成度</span><strong>${pct(p.percent)}</strong></div>${p.percent==null?'<p>尚未設定施工項目，無法計算完成度。</p>':`<progress max="100" value="${Math.max(0,Math.min(100,Number(p.percent)))}" aria-label="${esc(row.title||row.content)}施工項目完成度"></progress>`}<p>工期執行：${num(p.worked)}天/${p.planned?num(p.planned):'未設定'}天${over?` · <b>已超出預計施工天數 ${num(over)} 天</b>`:''}</p></div>`;
 }
 function progressWarning(row){
  if(!row.progress_alert)return '';
  return `<div class="gr-monitor-warning" role="status"><strong>⚠ 施工進度未達目標</strong><p>設定：${num(row.warning_work_days??row.warning_after_days)} 天內應完成 ${pct(row.warning_min_progress)}。目前已施工 ${num(row.worked_days)} 天，完成 ${pct(row.progress_percent??row.completion_percent)}，落後 ${num(row.progress_gap)} 個百分點。</p></div>`;
 }
 function logsTable(logs,accounting){return table(['日期','工作摘要','狀態','原始資料'],logs.map(l=>`<tr><td>${esc(l.date)}</td><td>${esc(l.summary||'—')}</td><td>${esc(status(l.status))}</td><td>${l.can_open?`<button type="button" ${accounting?'data-gr-open-log':'data-edit-work-log'}="${esc(l.id)}">查看原日誌</button>`:'—'}</td></tr>`));}
 function planDetailsBody(p,accounting){return `<div class="gr-plan-body"><p>施工日期：${esc(p.construction_date||'—')} · ${esc(status(p.status))}</p><p>指派施工人員：${esc((p.assignees||[]).map(a=>a.name).join('、')||'未指派')}</p>${p.notes?`<p>${esc(p.notes)}</p>`:''}${(p.items||[]).map(i=>`<details class="gr-item"><summary>${esc(i.title)} <span>${i.is_completed?'已勾選完成':'未勾選完成'}</span></summary><div><p>預計第 ${num(i.start_day)} 工作日起 · ${num(i.planned_days)} 天；實際施工 ${num(i.worked_days)} 天</p>${i.assignees?.length?`<p>指派施工人員：${esc(i.assignees.map(a=>a.name).join('、'))}</p>`:''}${logsTable(i.logs||[],accounting)}</div></details>`).join('')}${p.can_open?`<button type="button" ${accounting?'data-gr-open-plan':'data-construction-project'}="${esc(p.project_id)}">開啟施工規劃</button>`:''}<h3>相關工作日誌（${p.logs?.length||0}）</h3>${logsTable(p.logs||[],accounting)}</div>`;}
 function plansDetail(plans,accounting,project){return card('施工規劃明細',plans.length?plans.map(p=>{const n=planProgress(p);return `<article class="gr-monitor-plan${p.progress_alert?' gr-progress-warning':''}" data-gr-plan-card="${esc(p.id)}"><header class="gr-monitor-header"><div><h3>${esc(p.content)}</h3><p>${esc([project.customer,project.name].filter(Boolean).join('｜'))}</p></div><span class="gr-status${p.progress_alert?' gr-alert-badge':''}">${p.progress_alert?'施工進度落後':esc(status(p.status))}</span></header><div class="gr-monitor-metrics"><div><span>施工項目</span><strong>${num(n.done)} / ${num(n.count)}</strong><small>已完成 ${num(n.done)} 項</small></div><div><span>工程完成度</span><strong>${pct(n.percent)}</strong><small>${p.warning_min_progress==null?'尚未設定進度告警門檻':'目標 '+pct(p.warning_min_progress)}</small></div><div><span>工期執行</span><strong>${num(n.worked)} / ${n.planned?num(n.planned):'未設定'}</strong><small>已施工 ${num(n.worked)} 天</small></div></div>${progress(p)}${progressWarning(p)}<details class="gr-plan" data-report-plan="${esc(p.id)}"><summary><span>施工規劃明細</span></summary>${planDetailsBody(p,accounting)}</details></article>`;}).join(''):blank('尚未建立施工規劃。'),'完成度依有效施工項目數；工期依實際施工日期去重。展開可查看指派人員、項目及日誌。','gr-plans-card');}
 function ganttChart(plans){
  const rows=plans.flatMap(p=>(p.items?.length?p.items.map(i=>({...i,label:p.content+' / '+i.title})): [{...p,label:p.content,start_day:1}]));
  const max=Math.max(1,...rows.map(r=>Number(r.start_day||1)-1+Number(r.planned_days||0)));
  const width=1000,left=400,plot=580,height=50+rows.length*42,ticks=Math.min(max,6);
  return card('排程圖',rows.length?`<div class="gr-gantt" tabindex="0" role="region" aria-label="各規劃起始工作日排程"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="施工項目工作日甘特圖">${Array.from({length:ticks+1},(_,i)=>{const day=Math.round(i*max/ticks),x=left+day/max*plot;return `<line x1="${x}" y1="38" x2="${x}" y2="${height-5}" stroke="#dcded2"/><text x="${x}" y="23" text-anchor="middle">第 ${day+1} 日</text>`;}).join('')}${rows.map((r,i)=>{const y=48+i*42,x=left+positive(Number(r.start_day||1)-1)/max*plot,w=positive(r.planned_days)/max*plot;return `<g><title>${esc(r.label)}：第 ${num(r.start_day||1)} 工作日起，${r.planned_days?num(r.planned_days)+' 天':'未設定天數'}</title><text x="${left-12}" y="${y+16}" text-anchor="end">${esc(short(r.label,18))}（${r.planned_days?num(r.planned_days)+'天':'未設定'}）</text>${w?`<rect class="gr-gantt-bar" x="${x}" y="${y+4}" width="${w}" height="14" fill="#4b6047"/>`:`<text x="${x+5}" y="${y+16}">未設定</text>`}</g>`;}).join('')}</svg></div>`:blank('尚無施工排程。'),'預計工作日排程；各規劃起始日為第 1 日，不代表實際施工日期。','gr-gantt-card');
 }
 function gantt(plans,accounting){return card('施工項目排程',plans.length?plans.map(p=>`<details class="gr-plan${p.progress_alert?' gr-progress-warning':''}" data-gr-schedule="${esc(p.id)}"><summary><span>${esc(p.content)}</span><b>預計${p.planned_days?num(p.planned_days):'未設定'}天完成｜已完成${num(p.completed_item_count)}項</b></summary><div class="gr-plan-body">${ganttChart([p])}${progress(p)}${progressWarning(p)}${planDetailsBody(p,accounting)}</div></details>`).join(''):blank('尚無施工排程。'),'點選 ＋ 展開施工項目、排程圖、指派人員與日誌，再按 − 收合。','gr-gantt-card');}
 function materialTableData(report,options){
  const price=!!options.pricePermissions?.view;
  return table(['品項名稱','貨品種類','品牌／型號','領用數量','餘料退回','淨用料','領用次數','首次／最近',...(price?['單價（元）','金額（元）','價格來源／日期','價格操作']:[])],report.materialStats.map(r=>`<tr><td><strong>${esc(r.name)}</strong></td><td>${esc(r.categoryName||'未分類')}</td><td>${esc([r.brand,r.model].filter(Boolean).join('｜')||'—')}</td><td>${num(r.issuedQuantity??r.quantity)} ${esc(r.unit)}</td><td>${num(r.returnedQuantity||0)} ${esc(r.unit)}</td><td>${num(r.quantity)} ${esc(r.unit)}</td><td>${num(r.recordCount)}</td><td>${esc(r.firstDate||'—')}<small>${esc(r.recentDate||'—')}</small></td>${price?`<td>${r.unit_price==null?'未設定':r.meters_per_unit>1?Number(r.unit_price).toLocaleString('zh-TW',{maximumFractionDigits:6}):num(r.unit_price)}${r.meters_per_unit>1&&r.package_unit_price!=null?`<small>${num(r.package_unit_price)} 元／${esc(r.package_unit)} ÷ ${num(r.meters_per_unit)} 米</small>`:''}</td><td>${r.amount==null?'—':num(r.amount)}</td><td>${r.price_source==='manual'?'人工參考價格':r.price_source==='snapshot'?'領用時未稅參考成本':r.price_source==='receipt'?(r.source_tax_mode==='inclusive'?'最近進貨（折扣後分攤未稅）':r.source_tax_mode==='exclusive'?'最近進貨（折扣後未稅）':'最近進貨（歷史計稅未設定）'):'沒有價格'}<small>${esc(r.price_date||'—')}</small></td><td>${(r.price_source==='manual'?options.pricePermissions.update:options.pricePermissions.create)?`<button type="button" data-gr-edit-price="${esc(r.id)}" ${options.readOnly?'disabled':''}>修改參考單價</button>`:''}${r.price_source==='manual'&&options.pricePermissions.delete?`<button type="button" data-gr-clear-price="${esc(r.id)}" ${options.readOnly?'disabled':''}>恢復原參考成本</button>`:''}</td>`:''}</tr>`),'materialStatsTable');
 }
 function materialTable(report,options){return '<div data-gr-category-table>'+materialTableData(categoryReport(report),options)+'</div>';}
 function returnRowsTable(report){return table(['入庫日期','入庫單號','品項名稱','退回數量','入庫人員'],(categoryReport(report).returnRows||[]).map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.documentNo)}</td><td>${esc(r.item?.name)}</td><td>${num(r.quantity)} ${esc(r.item?.unit)}</td><td>${esc(r.account)}</td></tr>`),'returnRowsTable');}
 function materialRowsTable(report){return table(['日期','品項名稱','品牌／型號','數量','取貨帳號'],(categoryReport(report).materialRows||[]).map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.item?.name)}</td><td>${esc([r.item?.brand,r.item?.model].filter(Boolean).join('｜'))}</td><td>${num(r.quantity)} ${esc(r.item?.unit)}</td><td>${esc(r.account)}</td></tr>`),'materialRowsTable');}
 function receiptHistory(report,options){
  if(!options.pricePermissions?.view||!report.receiptDocuments)return '';
  const t=report.receiptTotals||{},money=v=>v==null?'未設定':num(v),mode=v=>v==='inclusive'?'含稅':v==='exclusive'?'未稅':'歷史未設定';
  return card('關聯進貨歷史',`<p>${num(t.documentCount)} 張進貨單｜折扣 ${money(t.discountAmount||0)} 元｜未稅 ${money(t.netAmount)} 元｜稅額 ${money(t.taxAmount)} 元｜含稅 ${money(t.totalAmount)} 元</p>${t.unpricedDocumentCount?'<p>'+num(t.unpricedDocumentCount)+' 張計稅或價格未完整設定，未計入總額。</p>':''}${report.receiptDocuments.map(d=>`<details class="gr-plan"><summary><span>${esc(d.documentNo||d.id)} · ${esc(d.date)}<small>${mode(d.financials?.mode)} · ${d.financials?.tax_rate_basis_points==null?'稅率未設定':num(d.financials.tax_rate_basis_points/100)+'%'}</small></span><b>含稅 ${money(d.financials?.total_amount)} 元</b></summary><div class="gr-plan-body"><p>折扣 ${money(d.financials?.discount_amount||0)} 元 · 未稅 ${money(d.financials?.net_amount)} 元 · 稅額 ${money(d.financials?.tax_amount)} 元 · 含稅 ${money(d.financials?.total_amount)} 元</p>${table(['品項名稱','數量','原始進貨單價','原始品項小計'],(d.lines||[]).map(l=>`<tr><td>${esc(l.name)}</td><td>${num(l.quantity)} ${esc(l.unit)}</td><td>${money(l.unit_price)}</td><td>${money(l.input_amount)}</td></tr>`))}</div></details>`).join('')}`,report.receiptAssociationNote||'進貨歷史與材料參考金額分開呈現。');
 }
 function materials(report,options){return chartCard('用料統計',materialChart(report,options),'依貨品種類分組，各品項分別呈現直式柱狀圖。')+card('材料品項彙總',materialTable(report,options),'淨用料＝領用－有效退料。金額以淨用料 × 參考單價計算；人工價格保留。')+card('用料明細','<div data-gr-category-rows>'+materialRowsTable(report)+'</div>')+card('餘料退回明細','<div data-gr-return-rows>'+returnRowsTable(report)+'</div>')+receiptHistory(report,options);}
 function laborSummary(report,options){if(!options.accounting||!options.pricePermissions?.view||!report.laborTotals)return '';const t=report.laborTotals;return card('逐日工資參考',`<p>已設定逐日工資參考：<strong>${num(t.knownAmount)} 元</strong> · 施工投入 ${num(t.personDays)} 天</p><p>${num(t.unpricedDayCount)} 筆人員／日期尚未設定工資（${num(t.unpricedPersonDays)} 天），未計入金額。個人同日計一次；代工同日採最高人數 × 當日每人日薪。請至施工人員頁籤逐日設定。此處不含完整雇主負擔，跨案日薪尚未分攤；完整損益以薪資分攤來源為準，不重複加計本表。</p>`);}
 function wageCells(r,options){if(!options.accounting||!options.pricePermissions?.view)return '';const present=r.daily_wage!=null;return `<td>${present?num(r.daily_wage):'未設定'}</td><td>${r.labor_amount==null?'—':num(r.labor_amount)}</td><td>${(present?options.pricePermissions.update:options.pricePermissions.create)?`<button type="button" data-gr-edit-wage="${esc(r.id)}" ${options.readOnly?'disabled':''} aria-label="設定 ${esc(r.date)} ${esc(r.name)} 工資">設定當日工資</button>`:''}${present&&options.pricePermissions.delete?`<button type="button" data-gr-clear-wage="${esc(r.id)}" ${options.readOnly?'disabled':''} aria-label="清除 ${esc(r.date)} ${esc(r.name)} 工資">清除當日工資</button>`:''}</td>`;}
 function dailyWages(report,options){if(!options.accounting||!options.pricePermissions?.view)return '';return card('逐人逐日工資',table(['施工日期','施工人員','當日人數','每人日薪（元）','當日成本（元）','工資操作'],(report.laborDailyRows||[]).map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.name)}</td><td>${num(r.headcount)} 人</td>${wageCells(r,options)}</tr>`),'laborDailyTable'),'依目前日期篩選列出實際施工紀錄；各人員、各日期可設定不同工資。');}
 function workers(report,options){return laborSummary(report,options)+ chartCard('人員施工統計',workerChart(report.workerStats,options),'同人、同工作內容、同日計一次；代工按每日最高人數累計施工投入天數。')+card('施工人員明細',table(['施工人員','施工天數','日誌筆數','首次施工','最近施工','帳號狀態',...(options.accounting&&options.pricePermissions?.view?['已設定成本（元）','未設定日期數']:[])],report.workerStats.map(r=>`<tr><td>${esc(r.label||r.name)}</td><td>${num(r.constructionDays)} ${esc("天")}</td><td>${num(r.recordCount)}</td><td>${esc(r.firstDate||'—')}</td><td>${esc(r.recentDate||'—')}</td><td>${r.id==='subcontractor'?'—':r.active===false?'已停用':'啟用'}</td>${options.accounting&&options.pricePermissions?.view?`<td>${r.labor_amount==null?'未設定':num(r.labor_amount)}</td><td>${num(r.unpricedDayCount)}</td>`:''}</tr>`),'workerStatsTable'))+dailyWages(report,options)+card('每日施工明細',table(['日期／時段','本筆施工人員','當日去重人數','工作摘要','狀態','原始資料'],(report.dailyRows||[]).map(r=>`<tr><td>${esc(r.date)}<small>${esc(r.timePeriod||'—')}</small></td><td>${esc([...(r.workerNames||[]),...(r.subcontractorCount?[`代工 ${num(r.subcontractorCount)} 人`]:[])].join('、')||'未指定')}</td><td>${num(r.dailyHeadcount)}</td><td>${esc(r.summary)}</td><td>${esc(status(r.status))}</td><td><button type="button" ${options.accounting?'data-gr-open-log':'data-edit-work-log'}="${esc(r.id)}">查看原日誌</button></td></tr>`),'dailyRowsTable'));}
 function overview(report,options){
  const plans=report.constructionPlans||[],s=report.constructionSummary,k=report.kpis;
  if(!s)return card('施工規劃資料尚未載入',blank('報表服務尚未提供施工統計，請確認本次增量更新已套用。'))+materials(report,options)+workers(report,options);
  const percent=s.progressPercent??null;
  const gauge=chartCard('專案進度',semicircle(percent,true)+`<p class="gr-chart-note">已完成 ${num(s.completedItemCount)} / ${num(s.totalItemCount)} 項<br>實際施工 ${num(s.projectDays)} 天（跨規劃日期去重）</p>`,'','gr-gauge-card');
  return `<section class="gr-kpis">${kpi('施工規劃',num(s.planCount)+' 筆','包含尚未開始的規劃')}${kpi('預計施工',num(s.plannedDays)+' 天','規劃天數總和')}${kpi('已完成項目',num(s.completedItemCount)+' / '+num(s.totalItemCount)+' 項','全部有效施工項目合計')}${kpi('實際施工',num(s.projectDays)+' 天','跨規劃有效施工日期去重')}${kpi('落後施工規劃',num(s.delayedPlanCount)+' 筆','已達告警天數但完成度未達門檻',s.delayedPlanCount>0)}</section><p class="gr-note">工程完成度依已勾選完成項目數 ÷ 全部有效項目數；未設定項目時不推算完成度。工期與進度告警採全部有效且已實際施工的不同日期，履約期限則依日曆日期判斷；用料與人員明細仍套用查詢日期。</p><div class="gr-dashboard">${gantt(plans,options.accounting)}${plansDetail(plans,options.accounting,report.project||{})}${chartCard('人員施工統計',workerChart(report.workerStats,options),`${num(k.workerCount)} 位施工人員 · ${num(k.workerDays)} 天`,'gr-workers-card')}${gauge}${chartCard('用料統計',materialChart(report,options),`${num(report.materialCategoryStats?.length)} 種材料分類 · ${num(k.materialTypeCount)} 個品項`,'gr-materials-card')}<div class="gr-distribution" data-gr-category-donut>${materialDonut(report,options)}</div>${card('材料品項彙總',materialTable(report,options),'領用、餘料退回與淨用料；日期篩選同時套用領料及退料日期。','gr-summary-card')}</div>${laborSummary(report,options)}${receiptHistory(report,options)}`;
 }
 function render(options){
  const {report,tab='overview'}=options,p=report.project||options.project||{};
  if(currentProject!==p.id){selectedMaterialCategory='';currentProject=p.id;}
  if(selectedMaterialCategory&&!(report.materialCategoryStats||[]).some(r=>categoryKey(r.id)===selectedMaterialCategory))selectedMaterialCategory='';
  currentOptions=options;
  const heading=`<article class="gr-heading"><div><span class="gr-code">${esc(p.code||'未編號')}</span><h2>${esc(p.name)}</h2><p>${esc(p.customer||'')} · ${esc(p.type||'工程施工')} · 工作內容負責人：${esc(p.owner||'未指派')}</p><p>建立：${date(p.createdAt)}${p.date?' · 工作日期：'+date(p.date):''} · 結案：${date(p.completedOn)}</p><div class="gr-contract${p.contractOverdue?' gr-contract-overdue':''}"><p>履約期限：${date(p.contractStartDate)} 至 ${date(p.contractEndDate)}</p><p>${p.contractOverdue?'⚠ 履約期限已逾期，工程尚未完成':p.contractEndDate?(p.remainingContractDays==null?'剩餘履約日曆天數未提供':p.remainingContractDays<0?'履約截止日已過 '+num(Math.abs(p.remainingContractDays))+' 個日曆天':'剩餘履約日曆天數 '+num(p.remainingContractDays)+' 天'):'尚未設定履約截止日期'}</p></div></div><span class="gr-status">${esc(status(p.status))}</span></article>`;
  return heading+(tab==='materials'?materials(report,options):tab==='workers'?workers(report,options):overview(report,options));
 }

 // Server-provided rows are already scoped by the existing project/report RBAC.
 // The filter changes presentation only and never fetches a wider project set.
 let performanceRows=[],selectedManager='';
 function performanceBody(rows){
  const selected=selectedManager?rows.filter(r=>String(r.managerId??'unassigned')===selectedManager):rows;
  return table(['專案負責人','負責專案','已完成專案','進行中專案','履約逾期專案','進度落後規劃','如期完成率'],selected.map(r=>`<tr><td>${esc(r.name||'未指派')}</td><td>${num(r.projectCount)} 筆</td><td>${num(r.completedProjectCount)} 筆</td><td>${num(r.inProgressProjectCount)} 筆</td><td>${num(r.overdueProjectCount)} 筆</td><td>${num(r.delayedPlanCount)} 筆</td><td>${r.onTimeCompletionRate==null?'資料不足':pct(r.onTimeCompletionRate)}<small>${num(r.onTimeCompletedCount)} / ${num(r.onTimeEligibleCount)} 筆具有效日期</small></td></tr>`))+
   selected.map(r=>`<details class="gr-plan"><summary><span>${esc(r.name||'未指派')}：專案來源明細</span><b>${num(r.projects?.length||0)} 筆</b></summary><div class="gr-plan-body">${table(['工作內容編號','工作內容名稱','客戶名稱','工作狀態','工程完成度','履約截止日期','履約狀態','進度落後規劃','實際完工日期'],(r.projects||[]).map(p=>`<tr><td>${esc(p.code||'—')}</td><td>${esc(p.name)}</td><td>${esc(p.customer||'—')}</td><td>${esc(status(p.status))}</td><td>${pct(p.progressPercent)}</td><td>${date(p.contractEndDate)}</td><td>${p.contractOverdue?'履約逾期':p.contractEndDate?'未逾期':'未設定'}</td><td>${num(p.delayedPlanCount)} 筆</td><td>${date(p.completedOn)}</td></tr>`))}</div></details>`).join('');
 }
 function renderPerformance(rows,visible=true){
  if(!visible){performanceRows=[];selectedManager='';return '';}
  performanceRows=rows||[];
  if(selectedManager&&!performanceRows.some(r=>String(r.managerId??'unassigned')===selectedManager))selectedManager='';
  return card('專案負責人執行統計',performanceRows.length?`<label class="gr-category-picker">專案負責人<select data-gr-manager-filter aria-label="執行統計專案負責人"><option value="">全部負責人</option>${performanceRows.map(r=>`<option value="${esc(r.managerId??'unassigned')}"${String(r.managerId??'unassigned')===selectedManager?' selected':''}>${esc(r.name||'未指派')}</option>`).join('')}</select></label><div data-gr-manager-results>${performanceBody(performanceRows)}</div>`:blank('目前沒有可查看的專案執行統計。'),'僅統計目前權限可見的工程施工專案，不受單一專案與用料日期篩選影響。多人負責的專案分別列入各負責人，跨人合計可能重複。工程完成以有效項目全數勾選為準，無清單者沿用原工作狀態。如期完成率僅採已完成且有履約截止與實際完工日期的專案；不作個人評分。','gr-performance-card');
 }

 if(root.document&&!root.__gucReportSortInstalled){
  root.__gucReportSortInstalled=true;
  root.document.addEventListener('change',event=>{
   const manager=event.target.closest('[data-gr-manager-filter]');
   if(manager){selectedManager=manager.value;const host=manager.closest('.gr-performance-card')?.querySelector('[data-gr-manager-results]');if(host)host.innerHTML=performanceBody(performanceRows);return;}
   const select=event.target.closest('[data-gr-material-category]');if(!select||!currentOptions)return;
   selectedMaterialCategory=select.value;
   const host=select.closest('.guc-report')||select.closest('.gr-report-content'),{report}=currentOptions;
   host.querySelectorAll('[data-gr-category-chart]').forEach(el=>el.innerHTML=materialChartData(categoryReport(report),currentOptions));
   host.querySelectorAll('[data-gr-category-table]').forEach(el=>el.innerHTML=materialTableData(categoryReport(report),currentOptions));
   host.querySelectorAll('[data-gr-category-rows]').forEach(el=>el.innerHTML=materialRowsTable(report));host.querySelectorAll('[data-gr-return-rows]').forEach(el=>el.innerHTML=returnRowsTable(report));
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
 root.GUCWorkContentReport=Object.freeze({render,renderPerformance,escape:esc});
})(globalThis);
