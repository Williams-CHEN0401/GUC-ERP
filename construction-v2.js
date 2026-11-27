// 工作管理第二版共用功能：設備圖示、子項目日期排程與甘特圖、子項目設備指派。
// 資料仍以既有施工規劃（主項目）、子項目與清冊為唯一來源；權限由 Gateway 與 RPC 驗證。

/* ---------- 設備圖示：沿用案場承攬系統的承攬項目圖示（透明背景版本） ---------- */
const EQUIPMENT_ICON_KEYS=['monitoring','audio','phone','network','barrier','emergency','access'];
const EQUIPMENT_TYPE_SUGGESTIONS=['監視攝影機','廣播喇叭','門禁讀卡機','網路設備','對講設備','電話','柵欄機','緊急求救按鈕'];
// 與案場系統 serviceNavigationIcon 相同的判斷順序，另加入常見設備類型關鍵字。
function equipmentIconKey(text){
  const value=String(text||'').toLocaleLowerCase('zh-Hant');
  if(!value.trim())return '';
  if(value.includes('籃球場投幣機'))return 'access';
  if(/(emergency|\bsos\b|求救|緊急)/.test(value))return 'emergency';
  if(/(barrier|parking|柵欄|栅栏|停車|閘門)/.test(value))return 'barrier';
  if(/(phone|telephone|電話|話機)/.test(value))return 'phone';
  if(/(surveillance|monitor|cctv|camera|監控|監視|攝影)/.test(value))return 'monitoring';
  if(/(cabling|network|switch|弱電|網路|佈線|布線|交換器|集線器)/.test(value))return 'network';
  if(/(audio|speaker|broadcast|音響|廣播|喇叭|擴音)/.test(value))return 'audio';
  if(/(access|door|card|門禁|刷卡|讀卡|卡機)/.test(value))return 'access';
  return '';
}
function equipmentIconUrl(key){return key?`/assets/equipment-icons/${key}.png`:'/assets/equipment-icons/default.svg';}
// 優先順序：設備類型 → 工程圖的承攬內容（工程類型）→ 施工規劃標題 → 預設圖示。
function equipmentIconFor(point,service,planTitle){
  return equipmentIconUrl(equipmentIconKey(point?.type)||equipmentIconKey(service?`${service.code||''} ${service.name||''}`:'')||equipmentIconKey(planTitle));
}
function equipmentLabel(point){return [point.code,point.name,point.type,point.location].filter(Boolean).join(' · ');}

/* ---------- 子項目指派 ---------- */
// equipment_codes 為 null：未指派，沿用舊行為（本規劃清冊全部設備）。
function itemEquipmentCodes(plan,item){
  const roster=(plan?.drawing_points||[]).map(p=>p.code);
  return Array.isArray(item?.equipment_codes)?item.equipment_codes.filter(code=>roster.includes(code)):roster;
}
function itemAppliesTo(item,code){return !Array.isArray(item?.equipment_codes)||item.equipment_codes.includes(code);}
function itemsForCode(plan,code){return (plan?.items||[]).filter(item=>Array.isArray(item.equipment_codes)&&item.equipment_codes.includes(code));}
// 依設備編號區間選取（例如 CAM10～CAM20）：同前綴且數字落在區間內，或依清冊順序。
function equipmentCodeRange(codes,from,to){
  const parse=code=>{const m=String(code).trim().match(/^(.*?)(\d+)$/);return m?{prefix:m[1].toLowerCase(),number:Number(m[2])}:null;};
  const a=parse(from),b=parse(to);
  if(a&&b&&a.prefix===b.prefix){
    const low=Math.min(a.number,b.number),high=Math.max(a.number,b.number);
    return codes.filter(code=>{const c=parse(code);return c&&c.prefix===a.prefix&&c.number>=low&&c.number<=high;});
  }
  const lower=codes.map(c=>c.toLowerCase()),i=lower.indexOf(String(from).trim().toLowerCase()),j=lower.indexOf(String(to).trim().toLowerCase());
  if(i<0||j<0)throw Error('找不到起訖設備編號，請確認清冊內有這兩個編號。');
  return codes.slice(Math.min(i,j),Math.max(i,j)+1);
}
// 系統自動編號：前綴 + 起始編號 + 位數，例如 CAM + 01 + 2 位 × 79 = CAM01～CAM79。
function generateEquipmentCodes({prefix,start,count,digits}){
  prefix=String(prefix||'').trim();start=Number(start);count=Number(count);digits=Number(digits);
  if(!prefix||prefix.length>60||/[\u0000-\u001f\u007f]/.test(prefix))throw Error('請填寫設備編號前綴（60 字內）。');
  if(!Number.isInteger(start)||start<0||start>999999)throw Error('起始編號須為 0 以上的整數。');
  if(!Number.isInteger(count)||count<1||count>1000)throw Error('設備數量須為 1 至 1000。');
  if(!Number.isInteger(digits)||digits<1||digits>8)throw Error('編號位數須為 1 至 8。');
  return Array.from({length:count},(_,i)=>prefix+String(start+i).padStart(digits,'0'));
}

/* ---------- 日期排程：預計開始日期＝施工日期＋(起始日−1)，天數以日曆天且含開工當日計算 ---------- */
const DAY_MS=86400000;
function scheduleDate(value){return value?new Date(String(value).slice(0,10)+'T00:00:00Z'):null;}
function scheduleText(date){return date?date.toISOString().slice(0,10):'';}
function addScheduleDays(value,days){const date=scheduleDate(value);return date?scheduleText(new Date(date.getTime()+days*DAY_MS)):'';}
function scheduleDiff(from,to){return Math.round((scheduleDate(to)-scheduleDate(from))/DAY_MS);}
function taipeiToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function taipeiDate(timestamp){return timestamp?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(timestamp)):'';}
function shortDate(value){return value?value.slice(5).replace('-','/'):'—';}
function itemSchedule(plan,item){
  const start=addScheduleDays(plan.construction_date,Number(item.start_day||1)-1),days=Number(item.planned_days||1),end=addScheduleDays(start,days-1);
  const logs=(item.log_dates||[]).slice().sort(),actualStart=logs[0]||'';
  const actualEnd=item.is_completed?(taipeiDate(item.completed_at)||logs.at(-1)||''):'';
  const today=taipeiToday();
  const status=item.is_completed?'done':end<today?'overdue':logs.length?'working':'pending';
  const codes=itemEquipmentCodes(plan,item),cells=new Map((plan.equipment_state||[]).filter(e=>e.item===item.id).map(e=>[e.code,e.status]));
  let applicable=0,done=0;
  for(const code of codes){const s=cells.get(code);if(s==='na')continue;applicable++;if(s==='done')done++;}
  const progress=item.is_completed?100:applicable&&cells.size?Math.round(done/applicable*100):Math.min(99,Math.round(Number(item.worked_days||0)/days*100));
  return {start,end,days,actualStart,actualEnd,status,progress,equipment:{done,applicable,assigned:Array.isArray(item.equipment_codes)}};
}
const SCHEDULE_STATUS={done:'已完成',working:'施工中',pending:'未開始',overdue:'逾期'};
function planSchedule(plan){
  const items=(plan.items||[]).map(item=>({item,...itemSchedule(plan,item)}));
  const start=items.length?items.map(i=>i.start).sort()[0]:plan.construction_date;
  const end=items.length?items.map(i=>i.end).sort().at(-1):addScheduleDays(plan.construction_date,Math.max(1,Number(plan.planned_days||1))-1);
  const done=items.filter(i=>i.status==='done').length;
  const status=plan.status==='completed'||items.length&&done===items.length?'done':items.some(i=>i.status==='overdue')?'overdue':items.some(i=>i.status==='working')||(plan.worked_days>0)?'working':'pending';
  const progress=items.length?Math.round(items.reduce((sum,i)=>sum+i.progress,0)/items.length):Number(plan.completion_percent||0);
  return {start,end,items,status,progress};
}

/* ---------- 甘特圖：日／週／月時間尺度、主項目展開收合、今日標示、狀態與進度 ---------- */
const ganttState={scale:'day',collapsed:new Set()};
const GANTT_SCALES={day:{width:40,label:'日'},week:{width:14,label:'週'},month:{width:4,label:'月'}};
function ganttTicks(start,days,scale){
  const ticks=[];
  for(let i=0;i<days;i++){
    const date=addScheduleDays(start,i),d=scheduleDate(date),weekday=d.getUTCDay();
    if(scale==='day')ticks.push({i,label:i===0||d.getUTCDate()===1?`${d.getUTCMonth()+1}/${d.getUTCDate()}`:String(d.getUTCDate()),sub:'日一二三四五六'[weekday],weekend:weekday===0||weekday===6});
    else if(scale==='week'&&(weekday===1||i===0))ticks.push({i,label:`${d.getUTCMonth()+1}/${d.getUTCDate()}`,sub:'週'});
    else if(scale==='month'&&(d.getUTCDate()===1||i===0))ticks.push({i,label:`${d.getUTCFullYear()}/${d.getUTCMonth()+1}`,sub:''});
  }
  return ticks;
}
function ganttBar(range,origin,width,status,progress,title,kind){
  const left=scheduleDiff(origin,range.start)*width,size=(scheduleDiff(range.start,range.end)+1)*width;
  return `<div class="v2-gantt-bar is-${kind}" data-status="${status}" data-gx="${left}" data-gw="${Math.max(size,4)}" title="${esc(title)}"><span class="v2-gantt-fill" data-gp="${Math.max(0,Math.min(100,progress))}"></span><span class="v2-gantt-text">${progress}%</span></div>`;
}
function constructionScheduleGantt(plans,{key,title='工程排程甘特圖',open=true}={}){
  const rows=plans.map(plan=>({plan,schedule:planSchedule(plan)}));
  if(!rows.some(r=>r.schedule.items.length))return '';
  const today=taipeiToday();
  const actual=rows.flatMap(r=>r.schedule.items.flatMap(i=>i.item.log_dates||[]));
  const starts=[...rows.map(r=>r.schedule.start),...actual].sort(),ends=[...rows.map(r=>r.schedule.end),...actual].sort();
  const origin=addScheduleDays(starts[0],-1),last=addScheduleDays(ends.at(-1),2);
  const days=scheduleDiff(origin,last)+1,scale=ganttState.scale,width=GANTT_SCALES[scale].width,total=days*width;
  const todayOffset=scheduleDiff(origin,today);
  const ticks=ganttTicks(origin,days,scale);
  const todayMark=todayOffset>=0&&todayOffset<days?`<i class="v2-gantt-today" data-gx="${todayOffset*width+width/2}" title="今日 ${today}"></i>`:'';
  const header=`<div class="v2-gantt-row v2-gantt-head"><div class="v2-gantt-label">施工項目</div><div class="v2-gantt-track" data-gw="${total}">${todayMark}${ticks.map(t=>`<span class="v2-gantt-tick${t.weekend?' is-weekend':''}" data-gx="${t.i*width}" ${scale==='day'?`data-gw="${width}"`:''}><b>${esc(t.label)}</b>${t.sub?`<small>${esc(t.sub)}</small>`:''}</span>`).join('')}</div></div>`;
  const body=rows.map(({plan,schedule})=>{
    const collapsed=ganttState.collapsed.has(plan.id);
    const planRow=`<div class="v2-gantt-row is-plan" data-status="${schedule.status}"><div class="v2-gantt-label"><button type="button" class="v2-gantt-toggle" data-gantt-toggle="${esc(plan.id)}" aria-expanded="${!collapsed}" aria-label="${collapsed?'展開':'收合'} ${esc(plan.content)}">${collapsed?'▸':'▾'}</button><span><b>${esc(plan.content)}</b><small>${shortDate(schedule.start)}～${shortDate(schedule.end)}・${SCHEDULE_STATUS[schedule.status]}</small></span></div><div class="v2-gantt-track" data-gw="${total}">${todayMark}${ganttBar(schedule,origin,width,schedule.status,schedule.progress,`${plan.content}：${schedule.start}～${schedule.end}，進度 ${schedule.progress}%`,'plan')}</div></div>`;
    const itemRows=collapsed?'':schedule.items.map(s=>`<div class="v2-gantt-row is-item" data-status="${s.status}"><div class="v2-gantt-label"><span><b>${esc(s.item.title)}</b><small>預計 ${shortDate(s.start)}～${shortDate(s.end)}（${s.days} 天）・實際 ${shortDate(s.actualStart)}～${s.actualEnd?shortDate(s.actualEnd):'—'}・${SCHEDULE_STATUS[s.status]}</small></span></div><div class="v2-gantt-track" data-gw="${total}">${todayMark}${ganttBar(s,origin,width,s.status,s.progress,`${s.item.title}：預計 ${s.start}～${s.end}（${s.days} 天），實際 ${s.actualStart||'未開始'}～${s.actualEnd||'—'}，${SCHEDULE_STATUS[s.status]}，進度 ${s.progress}%${s.equipment.applicable?`，設備完成 ${s.equipment.done}／${s.equipment.applicable}`:''}`,'item')}${(s.item.log_dates||[]).map(date=>`<i class="v2-gantt-log" data-gx="${scheduleDiff(origin,date)*width+width/2}" title="${esc(s.item.title)}：${esc(date)} 有施工日誌"></i>`).join('')}</div></div>`).join('');
    return planRow+itemRows;
  }).join('');
  return `<details class="v2-gantt" data-v2-gantt="${esc(key||'')}" ${open?'open':''}><summary>${esc(title)}</summary>
    <div class="v2-gantt-toolbar"><div role="group" aria-label="時間尺度">${Object.entries(GANTT_SCALES).map(([value,{label}])=>`<button type="button" class="outline" data-gantt-scale="${value}" aria-pressed="${value===scale}">${label}</button>`).join('')}</div><button type="button" class="outline" data-gantt-today>跳到今日</button>
    <div class="v2-gantt-legend">${Object.entries(SCHEDULE_STATUS).map(([value,label])=>`<span data-status="${value}">${label}</span>`).join('')}<span class="is-log">施工日誌</span></div></div>
    <p class="form-sync-hint">預計完成日期＝預計開始日期＋施工天數−1（日曆天，含開工當日；週末與國定假日照常計入）。長條內深色為完成進度：有指派設備時依設備完成比例，否則依子項目完成或已施工天數估算。</p>
    <div class="v2-gantt-scroll" tabindex="0" aria-label="可左右捲動的工程排程甘特圖" data-gantt-scroll><div class="v2-gantt-grid">${header}${body}</div></div></details>`;
}
function rerenderGantt(host){
  const key=host.dataset.v2Gantt,plans=(state.constructionPlans||[]).filter(p=>key.startsWith('plan:')?p.id===key.slice(5):p.project_id===key);
  const scroll=host.querySelector('[data-gantt-scroll]')?.scrollLeft||0;
  const html=constructionScheduleGantt(plans.sort((a,b)=>a.construction_date.localeCompare(b.construction_date)||a.id.localeCompare(b.id)),{key,title:host.querySelector('summary')?.textContent,open:true});
  if(!html)return;
  host.insertAdjacentHTML('afterend',html);
  const next=host.nextElementSibling;host.remove();
  next.querySelector('[data-gantt-scroll]').scrollLeft=scroll;
  return next;
}
function scrollGanttToToday(host){
  const scroll=host.querySelector('[data-gantt-scroll]'),line=host.querySelector('.v2-gantt-today');
  if(scroll&&line)scroll.scrollLeft=Math.max(0,Number(line.dataset.gx)-scroll.clientWidth/2+(host.querySelector('.v2-gantt-label')?.offsetWidth||0));
}
document.addEventListener('click',event=>{
  const host=event.target.closest('[data-v2-gantt]');if(!host)return;
  const scale=event.target.closest('[data-gantt-scale]'),toggle=event.target.closest('[data-gantt-toggle]');
  if(scale){ganttState.scale=scale.dataset.ganttScale;const next=rerenderGantt(host);if(next)scrollGanttToToday(next);}
  else if(toggle){const id=toggle.dataset.ganttToggle;ganttState.collapsed.has(id)?ganttState.collapsed.delete(id):ganttState.collapsed.add(id);rerenderGantt(host);}
  else if(event.target.closest('[data-gantt-today]'))scrollGanttToToday(host);
});
// 網站 CSP 不允許 HTML 內的 style 屬性，甘特圖位置以 data 屬性輸出，加入頁面後再由程式設定。
function applyGanttLayout(root){
  for(const el of root.querySelectorAll('[data-gx]:not([data-laid]),[data-gw]:not([data-laid]),[data-gp]:not([data-laid])')){
    if(el.dataset.gx!==undefined)el.style.left=el.dataset.gx+'px';
    if(el.dataset.gw!==undefined)el.style.width=el.dataset.gw+'px';
    if(el.dataset.gp!==undefined)el.style.width=el.dataset.gp+'%';
    el.dataset.laid='1';
  }
}
if(typeof MutationObserver!=='undefined'&&document.documentElement)new MutationObserver(records=>{
  for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1&&(node.matches?.('.v2-gantt')||node.querySelector?.('.v2-gantt')))applyGanttLayout(node);
}).observe(document.documentElement,{childList:true,subtree:true});