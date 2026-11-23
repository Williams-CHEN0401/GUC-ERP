/* Monthly view and agenda reuse the existing assignment completion workflow. */
let assignmentCalendarRows=[],assignmentCalendarMonth='',assignmentCalendarDay='',assignmentCalendarPerson='',assignmentCalendarView='month',assignmentCalendarOwner='',assignmentCalendarPermissions='',assignmentCalendarLoading=false,assignmentCalendarError='',assignmentCalendarGeneration=0,assignmentCalendarLoadedAt=0;
function calendarToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function calendarMonthRange(month){const [y,m]=month.split('-').map(Number);return {from:month+'-01',to:month+'-'+new Date(Date.UTC(y,m,0)).getUTCDate()};}
function calendarShiftMonth(month,delta){const [y,m]=month.split('-').map(Number),d=new Date(Date.UTC(y,m-1+delta,1));return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');}
function calendarVisibleRows(){return assignmentCalendarRows.filter(r=>!assignmentCalendarPerson||(r.assignee_user_id===assignmentCalendarPerson||r.assignee_user_ids?.includes(assignmentCalendarPerson)));}
function calendarDayRows(day){return groupPendingAssignments(calendarVisibleRows().filter(r=>r.calendar_date===day));}
async function refreshAssignmentCalendar(force=false){
 const host=document.querySelector('#assignmentCalendar');if(!host)return;
 const owner=state.currentUser?.id||'';
 if(!owner||!accessToken){assignmentCalendarGeneration++;assignmentCalendarRows=[];assignmentCalendarOwner='';assignmentCalendarLoading=false;host.innerHTML='';return;}
 const permissions=JSON.stringify(state.currentUser);
 if(assignmentCalendarOwner!==owner||assignmentCalendarPermissions!==permissions){assignmentCalendarPermissions=permissions;assignmentCalendarOwner=owner;assignmentCalendarMonth=calendarToday().slice(0,7);assignmentCalendarDay='';assignmentCalendarPerson='';assignmentCalendarRows=[];assignmentCalendarLoadedAt=0;assignmentCalendarLoading=false;assignmentCalendarGeneration++;}
 if(!force&&(assignmentCalendarLoading||Date.now()-assignmentCalendarLoadedAt<25000)){renderAssignmentCalendar();return;}
 const generation=++assignmentCalendarGeneration,month=assignmentCalendarMonth,token=accessToken;
 assignmentCalendarLoading=true;assignmentCalendarError='';renderAssignmentCalendar();
 try{
  const range=calendarMonthRange(month),data=PREVIEW_MODE?{records:(state.dashboard.assignments?.pending||[]).filter(r=>r.assignment_type!=='construction').map(r=>({...r,calendar_date:r.appointment_date||r.assigned_date||String(r.created_at||'').slice(0,10)})).filter(r=>r.calendar_date>=range.from&&r.calendar_date<=range.to)}:await apiRequest({method:'GET',scope:'dashboard_calendar',...range});
  if(generation!==assignmentCalendarGeneration||owner!==state.currentUser?.id||token!==accessToken)return;
  if(data.current_user&&invalidatePrivateCache(data)===false)throw Error('權限已變更，請重新整理。');
  assignmentCalendarRows=data.records||[];assignmentCalendarLoadedAt=Date.now();
 }catch(error){if(generation!==assignmentCalendarGeneration)return;assignmentCalendarRows=[];assignmentCalendarError=error.message||'行事曆讀取失敗';}
 finally{if(generation===assignmentCalendarGeneration){assignmentCalendarLoading=false;renderAssignmentCalendar();}}
}
function renderAssignmentCalendar(){
 const host=document.querySelector('#assignmentCalendar');if(!host||!assignmentCalendarMonth)return;
 const range=calendarMonthRange(assignmentCalendarMonth),today=calendarToday(),[year,month]=assignmentCalendarMonth.split('-').map(Number),firstDay=new Date(Date.UTC(year,month-1,1)).getUTCDay(),days=Number(range.to.slice(-2));
 const people=[...new Map(assignmentCalendarRows.flatMap(r=>r.calendar_people?r.calendar_people.map(p=>[p.id,p.name]):[[r.assignee_user_id,r.assignee||'未指定']])).entries()].sort((a,b)=>a[1].localeCompare(b[1],'zh-TW'));
 if(assignmentCalendarPerson&&!people.some(([id])=>id===assignmentCalendarPerson))assignmentCalendarPerson='';
 const rows=calendarVisibleRows(),dates=[...new Set(rows.map(r=>r.calendar_date))].sort(),agendaDates=assignmentCalendarDay?[assignmentCalendarDay]:dates;
 const status=r=>{const members=r.assignment_members||[r];return members.every(m=>m.status==='completed')?'已完成':members.some(m=>m.status==='completed')?'部分完成':'未完成';};
 const cards=agendaDates.map(day=>{const events=calendarDayRows(day);return `<section class="calendar-agenda-day"><h4>${esc(day)}${day===today?' · 今天':''}</h4>${events.length?events.map(r=>`<div class="calendar-agenda-event"><span class="calendar-event-status">${esc(r.date_source||'指派日期')} · ${status(r)}</span>${assignmentPendingCard(r)}</div>`).join(''):'<p class="dashboard-empty">這一天沒有工作指派或預約事項</p>'}</section>`;}).join('');
 const cells=Array.from({length:Math.ceil((firstDay+days)/7)*7},(_,i)=>{const day=i-firstDay+1;if(day<1||day>days)return '<div class="calendar-empty-day" aria-hidden="true"></div>';const date=assignmentCalendarMonth+'-'+String(day).padStart(2,'0'),events=calendarDayRows(date);return `<button type="button" class="calendar-day ${date===today?'is-today':''} ${date===assignmentCalendarDay?'is-selected':''}" data-calendar-day="${date}" aria-label="${date}，${events.length} 筆工作與預約" aria-pressed="${date===assignmentCalendarDay}"><span class="calendar-day-number">${day}</span>${events.slice(0,3).map(r=>`<span class="calendar-event ${r.assignment_type==='appointment'?'is-appointment':''} ${status(r)==='已完成'?'is-complete':''}" title="${esc((r.assignee||'')+' · '+(r.customer||'')+' · '+(r.project||''))}">${esc((r.assignee||'')+' · '+(r.customer||r.project||'工作指派'))}</span>`).join('')}${events.length>3?`<small class="calendar-more">另 ${events.length-3} 筆</small>`:''}${events.length?`<span class="calendar-mobile-count">${events.length} 筆</span>`:''}</button>`;}).join('');
 host.innerHTML=`<div class="calendar-toolbar"><div class="calendar-navigation"><button type="button" class="outline" data-calendar-shift="-1" aria-label="上一個月">‹</button><h3>${year} 年 ${month} 月</h3><button type="button" class="outline" data-calendar-shift="1" aria-label="下一個月">›</button><button type="button" class="outline" data-calendar-today>今天</button></div><div class="calendar-controls"><label>人員<select id="assignmentCalendarPerson"><option value="">所有可查看人員</option>${people.map(([id,name])=>`<option value="${esc(id)}"${id===assignmentCalendarPerson?' selected':''}>${esc(name)}</option>`).join('')}</select></label><button type="button" class="outline" data-calendar-view="month" aria-pressed="${assignmentCalendarView==='month'}">月曆</button><button type="button" class="outline" data-calendar-view="agenda" aria-pressed="${assignmentCalendarView==='agenda'}">行事曆</button><button type="button" class="outline" data-calendar-reload>重新讀取</button></div></div><p class="calendar-status" role="status">${assignmentCalendarLoading?'正在載入行事曆…':assignmentCalendarError?esc(assignmentCalendarError):`${dates.reduce((sum,d)=>sum+calendarDayRows(d).length,0)} 筆工作與預約；同次多人指派合併顯示。`}</p>${assignmentCalendarError?'<button type="button" class="outline" data-calendar-reload>重試</button>':''}<div class="calendar-grid"${assignmentCalendarView==='month'?'':' hidden'}>${['日','一','二','三','四','五','六'].map(d=>`<div class="calendar-weekday">${d}</div>`).join('')}${cells}</div><div class="calendar-agenda-heading"><h3>${assignmentCalendarDay?'當日行程':'本月行程'}</h3>${assignmentCalendarDay?'<button type="button" class="text-button" data-calendar-all>顯示整月</button>':''}</div><div class="calendar-agenda">${cards||'<p class="dashboard-empty">這個月份沒有符合條件的工作或預約事項</p>'}</div>`;
}
document.addEventListener('click',event=>{
 const target=event.target.closest('#assignmentCalendar button');if(!target)return;
 if(target.hasAttribute('data-calendar-shift')){assignmentCalendarMonth=calendarShiftMonth(assignmentCalendarMonth,Number(target.dataset.calendarShift));assignmentCalendarDay='';assignmentCalendarRows=[];void refreshAssignmentCalendar(true);}
 else if(target.hasAttribute('data-calendar-today')){assignmentCalendarMonth=calendarToday().slice(0,7);assignmentCalendarDay=calendarToday();assignmentCalendarRows=[];void refreshAssignmentCalendar(true);}
 else if(target.dataset.calendarDay){assignmentCalendarDay=target.dataset.calendarDay;renderAssignmentCalendar();}
 else if(target.hasAttribute('data-calendar-all')){assignmentCalendarDay='';renderAssignmentCalendar();}
 else if(target.dataset.calendarView){assignmentCalendarView=target.dataset.calendarView;assignmentCalendarDay='';renderAssignmentCalendar();}
 else if(target.hasAttribute('data-calendar-reload'))void refreshAssignmentCalendar(true);
});
document.addEventListener('change',event=>{if(event.target.id==='assignmentCalendarPerson'){assignmentCalendarPerson=event.target.value;renderAssignmentCalendar();}});
