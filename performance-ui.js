// Scores, grades, scope and state transitions come exclusively from Gateway/SQL.
const performanceView={tab:'self',detail:null,candidates:[],quarter:null,busy:false,error:'',request:null,actor:null,templateDraft:null,selfEvidence:null};
const performanceStatus={DRAFT:'草稿',SUBMITTED:'待員工回覆',EMPLOYEE_RESPONDED:'員工已回覆',ACK_TIMEOUT:'回覆逾期（不代表同意）',APPROVED:'已核定',PUBLISHED:'已發布'};
const performanceRoleNames={construction:'工程施工',maintenance:'維修保養',lead:'主管職務',project_management:'專案管理'};
const performanceTaskNames={ASSIGNED:'待完成',COMPLETED:'待驗證',VERIFIED:'已驗證',CANCELLED:'已取消'};
const performanceSourceNames={site_work_log:'工作日誌',work_assignment:'工作指派',construction_plan:'施工規劃',maintenance_event:'維修紀錄',shared_task:'共同任務'};
function performanceData(){return state.performance||{reviews:[],tasks:[],periods:[],templates:[],people:[],skills:[],pending_reviews:[]};}
function performanceScore(review){return review.score==null?(review.calculation?.status==='NO_DATA'?'資料不足':'待補評分'):`${Number(review.score).toFixed(2)} · ${review.grade}`;}
function performanceButton(action,label,extra=''){return `<button type="button" data-performance-action="${action}" ${extra}>${esc(label)}</button>`;}
function performanceOptions(rows,key='id',label='display_name'){return rows.map(r=>[r[key],r[label]]);}
function performanceCards(rows){return rows.map(r=>`<article class="panel perf-card"><div><h3>${esc(r.employee_name)} · ${esc(r.month?.slice(0,7))}</h3><p>${esc(performanceStatus[r.status])} · 第 ${r.revision} 版${r.is_current?' · 目前有效':''}</p></div><strong class="perf-score">${esc(performanceScore(r))}</strong>${performanceButton('detail','查看評核',`data-id="${esc(r.id)}"`)}</article>`).join('')||'<p class="perf-empty">目前沒有可查閱的評核。</p>';}
function renderPerformance(){
 const root=document.querySelector('#performanceRoot');if(!root)return;
 if(globalThis.GUC_PUBLIC_CONFIG?.performanceEnabled!==true||!canModule('performance')){root.replaceChildren();performanceView.detail=null;performanceView.templateDraft=null;performanceView.selfEvidence=null;performanceView.source=null;return;}
 const actor=state.currentUser.id;if(performanceView.actor!==actor){Object.assign(performanceView,{actor,detail:null,quarter:null,candidates:[],tab:'self',request:null,error:'',templateDraft:null,selfEvidence:null,source:null});}
 const d=performanceData(),v=performanceView,admin=canAdmin(),reviewer=canModule('performance','UPDATE');
 const expanded=root.querySelector('[data-performance-form=review_score]')?.dataset.id===v.detail?.id?new Set([...root.querySelectorAll('[data-perf-item][open]')].map(e=>e.dataset.perfItem)):new Set();
 const tabs=[['self','我的績效'],['tasks','我的共同任務'],...(reviewer?[['reviews','主管評核']]:[]),...(admin?[['settings','考核設定'],['approval','核定與紀錄']]:[]),['skills','技術矩陣'],['quarter','季度報表']];
 if(!tabs.some(([key])=>key===v.tab))v.tab='self';
 root.innerHTML=`<div class="perf-toolbar"><div class="perf-tabs" role="tablist" aria-label="績效功能">${tabs.map(([key,label])=>`<button type="button" role="tab" aria-selected="${key===v.tab}" data-performance-tab="${key}">${label}</button>`).join('')}</div>${performanceButton('refresh','重新整理')}${performanceButton('export','匯出 CSV')}${performanceButton('excel','匯出 Excel')}</div><div role="status" class="perf-message" id="performanceMessage">${esc(v.error||(v.busy?'處理中…':''))}</div><div id="performanceContent">${v.detail?renderPerformanceDetail(v.detail):renderPerformanceTab(d,v,actor,admin)}</div>`;
 if(v.templateDraft)root.querySelector('#performanceTemplateEditor').innerHTML=renderPerformanceTemplateEditor(v.templateDraft.config,v.templateDraft.name);
 if(v.selfEvidence)root.querySelector('#performanceContent').innerHTML=`${performanceButton('back','返回清單')}<h3>本月候選佐證</h3>${renderPerformanceCandidates(v.selfEvidence)||'<p>本月沒有可見的參與紀錄。</p>'}`;
 if(v.source){const s=v.source,dialog=document.createElement('dialog');dialog.className='perf-source-dialog';dialog.innerHTML=`<h3>目前來源紀錄</h3><p>${esc(performanceSourceNames[s.source_type])} · ${esc(s.date)} · 版本 ${esc(s.source_version??'')}</p><p>${esc(s.summary)}</p><small>來源識別：${esc(s.source_id)}</small><button type="button" data-performance-source-close>關閉</button>`;root.append(dialog);dialog.addEventListener('cancel',()=>{v.source=null;});dialog.showModal();}
 root.querySelectorAll('[data-perf-item]').forEach(e=>e.open=expanded.has(e.dataset.perfItem));
 root.querySelectorAll('button').forEach(b=>b.disabled=v.busy);
}
function renderPerformanceTab(d,v,actor,admin){
 if(v.tab==='self'){
  const rows=d.reviews.filter(r=>r.employee_id===actor),published=rows.filter(r=>r.status==='PUBLISHED'&&r.is_current),years=[...new Set(published.map(r=>r.month.slice(0,4)))];
  return `${d.pending_reviews.map(r=>`<article class="panel perf-card"><h3>${esc(r.month.slice(0,7))} · 草稿準備中</h3>${performanceButton('self-evidence','提交佐證',`data-id="${r.id}" data-version="${r.row_version}"`)}</article>`).join('')}<div class="perf-grid">${performanceCards(rows)}</div>${years.map(year=>`<article class="panel"><h3>${esc(year)} 年有效月份 · ${published.filter(r=>r.month.startsWith(year)).length} 個樣本</h3><div class="perf-trend">${published.filter(r=>r.month.startsWith(year)).sort((a,b)=>a.month.localeCompare(b.month)).map(r=>`<div><span>${esc(r.month.slice(5,7))} 月</span><meter min="0" max="100" value="${r.score}" aria-label="${esc(r.month)} 分數"></meter><b>${Number(r.score).toFixed(2)}</b></div>`).join('')}</div></article>`).join('')}`;
 }
 if(v.tab==='reviews')return `<div class="perf-grid">${performanceCards(d.reviews.filter(r=>r.reviewer_id===actor))}</div>`;
 if(v.tab==='approval')return `<div class="perf-grid">${performanceCards(d.reviews)}</div>`;
 if(v.tab==='settings')return renderPerformanceSettings(d);
 if(v.tab==='tasks')return `${canModule('performance','CREATE')&&d.people.length?`<form class="panel perf-form" data-performance-form="task_create"><h3>新增共同任務</h3>${inputField('title','工作內容','text',true)}${selectField('category','類型',[['tools','工具清點'],['vehicle','車輛巡檢'],['materials','材料整理'],['handover','交接'],['other','其他']])}${selectField('assignee_id','負責人',performanceOptions(d.people))}${inputField('due_date','完成期限','date',true)}<button class="primary">建立任務</button></form>`:''}<div class="perf-grid">${d.tasks.map(t=>`<article class="panel perf-card"><h3>${esc(t.title)}</h3><p>${esc(performanceTaskNames[t.status])} · 期限 ${esc(t.due_date)}</p><p>${esc(t.completion_note||'尚未填寫完成證明')}</p>${t.reason?`<p>退回／取消原因：${esc(t.reason)}</p>`:''}${t.assignee_id===actor&&t.status==='ASSIGNED'?`<form class="perf-form" data-performance-form="task_complete" data-id="${t.id}" data-version="${t.row_version}">${inputField('completion_note','完成證明','textarea',true)}<button class="primary">回報完成</button></form>`:''}${(admin||t.assigned_by===actor)&&t.assignee_id!==actor&&t.status==='COMPLETED'?performanceButton('task_verify','驗證完成',`data-id="${t.id}" data-version="${t.row_version}"`):''}${(admin||t.assigned_by===actor)&&t.assignee_id!==actor&&t.status!=='CANCELLED'?`<form class="perf-form" data-performance-form="task_change" data-id="${t.id}" data-version="${t.row_version}">${selectField('operation','處理方式',[['task_return','退回補充'],['task_cancel','取消任務']])}${inputField('reason','處理原因','text',true)}<button>確認處理</button></form>`:''}</article>`).join('')||'<p>目前沒有共同任務。</p>'}</div>`;
 if(v.tab==='skills'){
  const latest=new Map();for(const s of d.skills||[]){const key=s.employee_id+s.skill_code;if(!latest.has(key)||latest.get(key).version<s.version)latest.set(key,s);}
  return `<div class="perf-grid">${[...latest.values()].map(s=>`<article class="panel perf-card"><h3>${esc(d.people.find(p=>p.id===s.employee_id)?.display_name||d.reviews.find(r=>r.employee_id===s.employee_id)?.employee_name||'本人')} · ${esc(d.skill_catalog.find(c=>c.code===s.skill_code)?.label)}</h3><strong>L${s.level} · 第 ${s.version} 版</strong><p>${esc(s.evidence)}</p><p>評核人：${esc(d.people.find(p=>p.id===s.assessor_id)?.display_name||d.reviews.find(r=>r.reviewer_id===s.assessor_id)?.reviewer_name||s.assessor_id)}</p></article>`).join('')||'<p>尚無核定技術能力。</p>'}</div>`;
 }
 if(v.tab==='quarter')return `<form class="panel perf-form" data-performance-form="quarter">${inputField('year','年份','number',true,new Date().getFullYear())}${selectField('quarter','季度',[['1','第一季'],['2','第二季'],['3','第三季'],['4','第四季']],Math.floor(new Date().getMonth()/3)+1)}<button class="primary">查詢季度</button></form>${v.quarter?`<h3>${v.quarter.year} 年第 ${v.quarter.quarter} 季</h3><div class="perf-grid">${v.quarter.results.map(r=>`<article class="panel perf-card"><h3>${esc(r.display_name)}</h3><strong>${Number(r.average_score).toFixed(2)}</strong><p>有效樣本 ${r.sample_count} 月／缺少 ${r.missing_months} 月；每月有效比重 ${r.effective_month_weight}%</p>${r.months.map(m=>`<details><summary>${esc(m.month.slice(0,7))} · ${Number(m.score).toFixed(2)} ${m.grade}</summary>${m.effective_role_weights.map(j=>`<p>${esc(performanceRoleNames[j.job_role])}：配比 ${j.percent}%，有效指標權重 ${j.effective_weight}</p>`).join('')}</details>`).join('')}</article>`).join('')||'<p>此季度沒有有效已發布樣本。</p>'}</div>`:''}`;
 return '';
}
function renderPerformanceSettings(d){return `<div class="perf-grid"><article class="panel perf-card"><h3>版本化權重</h3>${performanceButton('template-new','建立權重版本')}<div id="performanceTemplateEditor"></div>${renderPerformanceTemplateVersions(d.templates)}</article><form class="panel perf-form" data-performance-form="period_create"><h3>建立考核月份</h3>${inputField('month','月份','month',true)}${selectField('template_id','權重版本',performanceOptions(d.templates,'id','name'))}${inputField('trial_start','90 天試評起日（選填）','date')}${inputField('effective_date','正式生效日（選填）','date')}<details><summary>回覆期限</summary>${inputField('response_workdays','工作日數（選填）','number')}${inputField('weekdays','工作日（1=週一，7=週日）','text',false,'1,2,3,4,5')}${inputField('holidays','假日日期，以逗號分隔','text')}</details><button class="primary">建立月份</button></form><form class="panel perf-form" data-performance-form="review_create"><h3>指派評核及核定職務配比</h3>${selectField('period_id','月份',performanceOptions(d.periods,'id','month'))}${selectField('employee_id','受評員工',performanceOptions(d.people))}${selectField('reviewer_id','指定評核主管',performanceOptions(d.people.filter(p=>p.can_review)))}${selectField('approver_id','核定管理員',performanceOptions(d.people.filter(p=>p.can_approve)))}${Object.entries(performanceRoleNames).map(([code,label])=>inputField('allocation_'+code,label+'配比 %','number',false,code==='construction'?100:0)).join('')}<button class="primary">核定配比並建立草稿</button></form></div>`;}
function renderPerformanceDetail(r){
 const actor=state.currentUser.id,scorer=r.status==='DRAFT'&&r.reviewer_id===actor&&actor!==r.employee_id,admin=canAdmin(),approver=admin&&r.approver_id===actor&&actor!==r.employee_id;
 const command=(op,label)=>performanceButton(op,label,`data-id="${r.id}" data-version="${r.row_version}"`);
 return `${performanceButton('back','返回清單')}<article class="panel perf-detail"><header><h2>${esc(r.employee_name||'本人')} · ${esc(r.period.month.slice(0,7))} · 第 ${r.revision} 版</h2><p>${esc(performanceStatus[r.status])}</p><strong class="perf-score">${esc(performanceScore(r))}</strong></header><p>計分版本 ${esc(r.template.calculation_version)} · 權重版本 ${esc(r.template.name)}</p>${r.revision_reason?`<p>修訂原因：${esc(r.revision_reason)}</p>`:''}<div class="perf-allocations">${r.allocations.map(a=>`<span>${esc(performanceRoleNames[a.job_role])} ${a.percent}%</span>`).join('')}</div>${admin&&r.status==='DRAFT'?renderPerformanceReviewTemplate(r):''}<form data-performance-form="review_score" data-id="${r.id}" data-version="${r.row_version}">${renderPerformanceItems(r,scorer)}${scorer?'<button class="primary">保存評級並重新計算</button>':''}</form>${scorer?command('review_submit','送出給員工回覆'):''}<h3>來源佐證</h3>${r.evidence.map(e=>e.redacted?'<p>來源已失效或目前無權限。</p>':`<article class="perf-evidence"><b>${esc(performanceSourceNames[e.source_type])} · ${esc(e.snapshot.date)}</b><p>${esc(e.snapshot.summary)}</p>${performanceButton('source','查看目前來源',`data-id="${r.id}" data-evidence-id="${e.id}"`)}<small>${e.confirmed_by?'主管已確認':'等待主管逐人確認'} · 擷取 ${esc(e.snapshot.captured_at)}</small>${scorer&&!e.confirmed_by?performanceButton('evidence_confirm','確認此人參與佐證',`data-id="${r.id}" data-version="${r.row_version}" data-evidence-id="${e.id}"`):''}</article>`).join('')||'<p>尚無連結佐證。</p>'}${r.status==='DRAFT'&&[r.employee_id,r.reviewer_id].includes(actor)?command('candidates','選擇本月佐證'):''}<div id="performanceCandidates">${renderPerformanceCandidates(r)}</div><h3>改善行動</h3>${r.goals.map(g=>`<p>${esc(g.description)} · 期限 ${esc(g.due_date)}</p>`).join('')||'<p>尚未安排改善行動。</p>'}${scorer?`<form class="perf-form" data-performance-form="goal_add" data-id="${r.id}" data-version="${r.row_version}">${inputField('description','具體改善目標','textarea',true)}${inputField('due_date','目標期限','date',true)}<button>新增改善行動</button></form>`:''}<h3>員工回覆</h3>${r.responses.map(s=>`<p>${esc({acknowledged:'已知悉（未表示同意）',agreed:'同意',concern:'提出意見'}[s.response_type])} · ${esc(s.message)} · ${esc(s.created_at)}</p>`).join('')||'<p>尚無員工回覆。</p>'}${r.response_due_at?`<p>回覆期限：${esc(new Date(r.response_due_at).toLocaleString('zh-TW'))}</p>`:'<p>尚未啟用工作日逾期核定。</p>'}${r.status==='SUBMITTED'&&r.employee_id===actor?`<form class="perf-form" data-performance-form="review_respond" data-id="${r.id}" data-version="${r.row_version}">${selectField('response_type','回覆意向',[['acknowledged','已知悉（未表示同意）'],['agreed','同意'],['concern','提出意見']])}${inputField('message','本人意見','textarea')}<button class="primary">送出本人回覆</button></form>`:''}${approver&&['EMPLOYEE_RESPONDED','ACK_TIMEOUT'].includes(r.status)?command('review_approve','核定此版本'):''}${approver&&r.status==='APPROVED'?command('review_publish','發布此版本'):''}${admin&&r.status==='SUBMITTED'&&r.response_due_at?command('review_timeout','檢查工作日回覆期限'):''}${admin&&r.status==='PUBLISHED'&&r.is_current?`<form class="perf-form" data-performance-form="review_revise" data-id="${r.id}" data-version="${r.row_version}">${inputField('reason','修訂原因','textarea',true)}<button>建立新修訂</button></form>`:''}${admin&&r.status==='DRAFT'?`<details><summary>重新核定職務配比（清除草稿評級）</summary><form class="perf-form" data-performance-form="review_allocate" data-id="${r.id}" data-version="${r.row_version}">${Object.entries(performanceRoleNames).map(([code,label])=>inputField('allocation_'+code,label+' %','number',false,r.allocations.find(a=>a.job_role===code)?.percent||0)).join('')}${inputField('reason','變更原因','textarea',true)}<button>重新核定配比</button></form></details>`:''}<h3>管理員答覆</h3>${r.management_replies.map(m=>`<p>${esc(m.message)} · ${esc(m.created_at)}</p>`).join('')||'<p>尚無答覆。</p>'}${admin?`<form class="perf-form" data-performance-form="appeal_reply" data-id="${r.id}" data-version="${r.row_version}">${inputField('message','答覆內容','textarea',true)}<button>保存答覆</button></form>`:''}${r.status==='PUBLISHED'&&actor!==r.employee_id&&(admin||r.reviewer_id===actor)?`<details><summary>核定技術能力</summary><form class="perf-form" data-performance-form="skill_set" data-id="${r.id}" data-version="${r.row_version}">${selectField('skill_code','技術類別',performanceOptions(performanceData().skill_catalog,'code','label'))}${selectField('level','等級',[1,2,3,4].map(n=>[n,'L'+n]))}${inputField('evidence','實作證明','textarea',true)}<button>核定並保存技能版本</button></form></details>`:''}</article>`;
}
function performanceRatingText(config,item){return item.rating_state==='RATED'?`${config.rating_levels.find(l=>l.value===item.rating)?.label||'評級'}（${item.rating}）`:item.rating_state==='NA'?'N/A 不適用':'未評分';}
function performanceRoleLabel(role){return performanceRoleNames[role.code]||role.label;}
function performanceRoleCriteria(config,role){return [...config.criteria,...(role.code==='lead'?role.additional_criteria||[]:[])];}
function renderPerformanceItems(r,scorer){
 const config=r.template.config;
 return `<div class="perf-item-list">${config.job_roles.flatMap(role=>performanceRoleCriteria(config,role).map(criterion=>({role,criterion,item:r.items.find(i=>i.job_role===role.code&&i.criterion===criterion.code)})).filter(x=>x.item)).map(({role,criterion,item:i})=>`<details class="construction-plan-fold perf-item-fold" data-perf-item="${esc(i.job_role+'_'+i.criterion)}"><summary><span>${esc(performanceRoleLabel(role))} · ${esc(criterion.label)}</span><small data-rating-summary>${esc(performanceRatingText(config,i))} · 權重 ${role.weights[i.criterion]}%</small></summary><div class="construction-plan-body">${criterion.evidence_guide?`<p class="perf-criterion-guide">${esc(criterion.evidence_guide)}</p>`:''}<fieldset class="perf-item" data-role="${i.job_role}" data-criterion="${i.criterion}" data-weight="${role.weights[i.criterion]}" ${scorer?'':'disabled'}><legend class="sr-only">${esc(performanceRoleLabel(role))} · ${esc(criterion.label)}</legend><div class="perf-rating-fields">${selectField('rating','評級',[['UNRATED','未評分'],['NA','N/A 不適用'],...[1,2,3,4,5].map(n=>[String(n),config.rating_levels.find(l=>l.value===n)?.label+'（'+n+'）'])],i.rating_state==='RATED'?i.rating:i.rating_state)}${selectField('na_kind','N/A 類別',[['','不適用時請選擇'],['unassigned','未指派'],['unobservable','客觀不可觀察']],i.na_kind||'',false)}</div>${inputField('reason','具體說明／達標依據／N/A 原因','textarea',false,i.reason)}<label><input type="checkbox" name="assigned" ${i.assigned?'checked':''}> 此項曾安排工作或訓練</label></fieldset></div></details>`).join('')}</div>`;
}
function performanceResetConfirmation(){return '<label class="perf-reset-confirm"><input type="checkbox" name="confirm_reset" required>確認清除本草稿的評級與評分說明，套用新版後重新評分</label>';}
function renderPerformanceTemplateEditor(config,name,review=null){
 const op=review?'review_template':'template_create';
 return `<form class="perf-form perf-template-editor" data-performance-form="${op}" ${review?`data-id="${review.id}" data-version="${review.row_version}"`:''}>${inputField('name','版本名稱','text',true,name)}<div class="perf-template-items">${config.criteria.map(c=>`<details class="construction-plan-fold perf-item-fold"><summary><span>${esc(c.label)}</span></summary><div class="construction-plan-body">${inputField('criterion_'+c.code+'_label','項目名稱','text',true,c.label)}${inputField('criterion_'+c.code+'_guide','項目說明','textarea',false,c.evidence_guide||'')}<div class="perf-weight-fields">${config.job_roles.map(role=>inputField(role.code+'_'+c.code,performanceRoleLabel(role)+'權重 %','number',true,role.weights[c.code])).join('')}</div></div></details>`).join('')}</div><section class="perf-lead-editor"><h4>主管職務新增子項目</h4><div data-lead-items>${(config.job_roles.find(r=>r.code==='lead').additional_criteria||[]).map(c=>renderPerformanceLeadItem(c,config.job_roles.find(r=>r.code==='lead').weights[c.code])).join('')}</div>${performanceButton('lead-item-add','新增主管子項目')}</section><input type="hidden" name="base" value="${esc(JSON.stringify(config))}">${review?inputField('reason','變更原因','textarea',true)+performanceResetConfirmation():''}<div class="perf-editor-actions"><button class="primary">${review?'保存新版並套用本草稿':'保存新權重版本'}</button>${review?'':performanceButton('template-cancel','取消修改')}</div></form>`;
}
function renderPerformanceLeadItem(c,weight=0){return `<details class="construction-plan-fold perf-item-fold" data-lead-code="${esc(c.code)}"><summary><span>${esc(c.label)}</span></summary><div class="construction-plan-body">${inputField('criterion_'+c.code+'_label','子項目名稱','text',true,c.label)}${inputField('criterion_'+c.code+'_guide','子項目說明','textarea',false,c.evidence_guide||'')}${inputField('lead_'+c.code,'主管職務權重 %','number',true,weight)}${performanceButton('lead-item-remove','移除此新增子項目')}</div></details>`;}
function renderPerformanceTemplateVersions(templates){return templates.map(t=>`<details class="construction-plan-fold perf-template-version"><summary><span>${esc(t.name)}</span><small>${esc(t.created_at.slice(0,10))}</small></summary><div class="construction-plan-body">${performanceButton('template-edit','修改項目／建立新版',`data-id="${esc(t.id)}"`)}${t.config.criteria.map(c=>`<details class="construction-plan-fold"><summary><span>${esc(c.label)}</span></summary><p>${esc(c.evidence_guide||'')}</p>${t.config.job_roles.map(role=>`<p>${esc(performanceRoleLabel(role))}：${role.weights[c.code]}%</p>`).join('')}</details>`).join('')}${(t.config.job_roles.find(r=>r.code==='lead').additional_criteria||[]).map(c=>`<details class="construction-plan-fold"><summary><span>主管職務 · ${esc(c.label)}</span></summary><p>${esc(c.evidence_guide)}</p><p>權重 ${t.config.job_roles.find(r=>r.code==='lead').weights[c.code]}%</p></details>`).join('')}</div></details>`).join('');}
function renderPerformanceReviewTemplate(r){
 const choices=performanceData().templates.filter(t=>t.id!==r.template.id);
 return `<details class="construction-plan-fold perf-review-template"><summary><span>修改評核項目</span></summary><div class="construction-plan-body">${choices.length?`<details class="construction-plan-fold"><summary><span>套用既有版本</span></summary><form class="perf-form" data-performance-form="review_template_apply" data-id="${r.id}" data-version="${r.row_version}">${selectField('template_id','評核項目版本',performanceOptions(choices,'id','name'))}${inputField('reason','變更原因','textarea',true)}${performanceResetConfirmation()}<button class="primary">套用版本至本草稿</button></form></details>`:''}<h3>建立新版本</h3>${renderPerformanceTemplateEditor(r.template.config,(r.template.name+' 修訂').slice(0,120),r)}</div></details>`;
}
document.addEventListener('input',event=>{
 const item=event.target.closest('#performanceRoot [data-criterion]');if(!item)return;
 const rating=item.querySelector('[name=rating]');item.closest('details').querySelector('[data-rating-summary]').textContent=`${rating.selectedOptions[0].textContent} · 權重 ${item.dataset.weight}% · 未保存`;
});
document.addEventListener('invalid',event=>{
 if(!event.target.closest('#performanceRoot'))return;
 for(let parent=event.target.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
},true);

function renderPerformanceCandidates(r){return performanceView.candidates.map((c,i)=>`<article class="perf-evidence"><b>${esc(performanceSourceNames[c.source_type])} · ${esc(c.date)}</b><p>${esc(c.summary)}</p>${performanceButton('evidence_add','加入佐證',`data-id="${r.id}" data-version="${r.row_version}" data-candidate="${i}"`)}</article>`).join('');}
async function performanceRead(mode='list',options={}){return (await apiRequest({method:'GET',scope:'performance',performanceMode:mode,...options})).performance;}
async function performanceRefresh(id=''){
 state.performance=await performanceRead();performanceView.detail=id?await performanceRead('detail',{reviewId:id}):null;performanceView.candidates=[];performanceView.templateDraft=null;performanceView.selfEvidence=null;
}
async function performanceCommand(op,payload){
 const fingerprint=JSON.stringify({op,payload});
 if(performanceView.request?.fingerprint!==fingerprint)performanceView.request={fingerprint,id:crypto.randomUUID()};
 const response=await apiRequest({operation:'performance.'+op,payload:{...payload,request_id:performanceView.request.id}});performanceView.request=null;return response.result;
}
async function performanceRun(work){
 if(performanceView.busy)return;performanceView.busy=true;performanceView.error='';
 document.querySelectorAll('#performanceRoot button').forEach(b=>b.disabled=true);
 try{await work();}catch(error){performanceView.error=error.status===409?'資料版本已更新，請按「重新整理」後再保存。':error.message;if(error.status===401)logout();}
 finally{performanceView.busy=false;if(performanceView.error){const message=document.querySelector('#performanceMessage');if(message)message.textContent=performanceView.error;document.querySelectorAll('#performanceRoot button').forEach(b=>b.disabled=false);}else renderPerformance();}
}
function performanceExportRows(data){return [['月份','員工','版本','狀態','分數','等級'],...data.reviews.map(r=>[r.month,r.employee_name,r.revision,performanceStatus[r.status],r.score??'',r.grade??''])];}
function performanceSafeCell(value){const s=String(value??'');return /^[\s]*[=+\-@\t\r]/.test(s)?"'"+s:s;}
document.addEventListener('click',event=>{
 if(event.target.closest('[data-performance-source-close]')){performanceView.source=null;renderPerformance();return;}
 const tab=event.target.closest('[data-performance-tab]');if(tab){performanceView.tab=tab.dataset.performanceTab;performanceView.detail=null;performanceView.error='';performanceView.templateDraft=null;performanceView.selfEvidence=null;renderPerformance();return;}
 const button=event.target.closest('[data-performance-action]');if(!button)return;
 const op=button.dataset.performanceAction,id=button.dataset.id,row_version=Number(button.dataset.version);
 if(op==='lead-item-add'||op==='lead-item-remove'){
  const form=button.closest('.perf-template-editor');if(!form||!canAdmin())return;
  const list=form.querySelector('[data-lead-items]');
  if(op==='lead-item-remove')button.closest('[data-lead-code]').remove();
  else if(list.children.length<20){
   const code='LEAD_'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();
   list.insertAdjacentHTML('beforeend',renderPerformanceLeadItem({code,label:'新增子項目',evidence_guide:''}));
   list.lastElementChild.open=true;list.lastElementChild.querySelector('input').focus();
  }
  form.querySelector('[data-performance-action=lead-item-add]').disabled=list.children.length>=20;return;
 }
 void performanceRun(async()=>{
  if(op==='back'){performanceView.detail=null;performanceView.candidates=[];performanceView.selfEvidence=null;return;}
  if(op==='refresh')return performanceRefresh(performanceView.detail?.id);
  if(op==='detail'){performanceView.detail=await performanceRead('detail',{reviewId:id});performanceView.candidates=[];return;}
  if(op==='source'){const result=await performanceRead('source',{reviewId:id,evidenceId:button.dataset.evidenceId});performanceView.source=result.source;return;}
  if(op==='candidates'){performanceView.candidates=(await performanceRead('candidates',{reviewId:id})).candidates;return;}
  if(op==='self-evidence'){
   const candidates=(await performanceRead('candidates',{reviewId:id})).candidates;performanceView.candidates=candidates;
   // Restricted draft view contains no supervisor ratings or comments.
   performanceView.detail=null;performanceView.selfEvidence={id,row_version};return;
  }
  if(op==='template-edit'){
   const template=performanceData().templates.find(t=>t.id===id);if(!template||!canAdmin())return;
   performanceView.templateDraft={config:structuredClone(template.config),name:(template.name+' 修訂').slice(0,120)};return;
  }
  if(op==='template-cancel'){performanceView.templateDraft=null;return;}
  if(op==='template-new'){
   performanceView.templateDraft={config:await (await fetch('/assets/performance-weights-v1.json')).json(),name:'月度考核 v1.0'};return;
  }
  if(op==='export'||op==='excel'){
   const rows=performanceExportRows(await performanceRead('export')).map(row=>row.map(performanceSafeCell));
   if(op==='excel'){await GucExcelExport.saveBytes(GucExcelExport.buildWorkbook(rows[0].map((label,i)=>({key:String(i),label})),rows.slice(1)),'績效紀錄.xlsx',null);return;}
   const blob=new Blob(['\ufeff'+rows.map(row=>row.map(s=>'"'+String(s).replaceAll('"','""')+'"').join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='績效紀錄.csv';a.click();URL.revokeObjectURL(url);return;
  }
  const payload={id,row_version};
  if(op==='evidence_add'){const c=performanceView.candidates[Number(button.dataset.candidate)];Object.assign(payload,{source_type:c.source_type,source_id:c.source_id});}
  if(op==='evidence_confirm')payload.evidence_id=button.dataset.evidenceId;
  await performanceCommand(op,payload);await performanceRefresh(op.startsWith('task_')?'':performanceView.detail?.id||'');
 });
});
document.addEventListener('submit',event=>{
 const form=event.target.closest('[data-performance-form]');if(!form)return;event.preventDefault();
 let op=form.dataset.performanceForm;const data=Object.fromEntries(new FormData(form));
 void performanceRun(async()=>{
  if(op==='quarter'){performanceView.quarter=await performanceRead('quarter',{year:data.year,quarter:data.quarter});return;}
  let payload={...data};if(form.dataset.id)Object.assign(payload,{id:form.dataset.id,row_version:Number(form.dataset.version)});
  if(['review_create','review_allocate'].includes(op)){
   payload.allocations=Object.keys(performanceRoleNames).filter(k=>Number(data['allocation_'+k])>0).map(job_role=>({job_role,percent:Number(data['allocation_'+job_role])}));
   for(const key of Object.keys(performanceRoleNames))delete payload['allocation_'+key];
  }
  if(op==='review_score')payload={id:form.dataset.id,row_version:Number(form.dataset.version),items:[...form.querySelectorAll('[data-criterion]')].map(item=>{const rating=item.querySelector('[name="rating"]').value;return {job_role:item.dataset.role,criterion:item.dataset.criterion,rating_state:['NA','UNRATED'].includes(rating)?rating:'RATED',rating:['NA','UNRATED'].includes(rating)?null:Number(rating),reason:item.querySelector('[name="reason"]').value,na_kind:rating==='NA'?item.querySelector('[name="na_kind"]').value||null:null,assigned:item.querySelector('[name="assigned"]').checked};})};
  if(op==='template_create'||op==='review_template'){
   const config=JSON.parse(data.base);
   for(const c of config.criteria){c.label=data['criterion_'+c.code+'_label'].trim();c.evidence_guide=data['criterion_'+c.code+'_guide'].trim();}
   for(const r of config.job_roles)for(const c of config.criteria)r.weights[c.code]=Number(data[r.code+'_'+c.code]);
   const lead=config.job_roles.find(r=>r.code==='lead');lead.label='主管職務';
   lead.additional_criteria=[...form.querySelectorAll('[data-lead-code]')].map(row=>({code:row.dataset.leadCode,label:data['criterion_'+row.dataset.leadCode+'_label'].trim(),evidence_guide:data['criterion_'+row.dataset.leadCode+'_guide'].trim()}));
   const baseCodes=new Set(config.criteria.map(c=>c.code));for(const code of Object.keys(lead.weights))if(!baseCodes.has(code))delete lead.weights[code];
   for(const c of lead.additional_criteria)lead.weights[c.code]=Number(data['lead_'+c.code]);
   payload={name:data.name.trim(),config,...op==='review_template'?{id:form.dataset.id,row_version:Number(form.dataset.version),reason:data.reason,confirm_reset:data.confirm_reset==='on'}:{}};
  }
  if(op==='review_template_apply'){op='review_template';payload={id:form.dataset.id,row_version:Number(form.dataset.version),template_id:data.template_id,reason:data.reason,confirm_reset:data.confirm_reset==='on'};}
  if(op==='period_create'){
   payload={month:data.month+'-01',template_id:data.template_id,trial_start:data.trial_start||null,effective_date:data.effective_date||null,response_workdays:data.response_workdays?Number(data.response_workdays):null,business_calendar:data.response_workdays?{weekdays:data.weekdays.split(',').map(Number),holidays:data.holidays.split(',').map(s=>s.trim()).filter(Boolean)}:null};
  }
  if(op==='task_change'){op=data.operation;delete payload.operation;}
  if(op==='skill_set')payload.level=Number(payload.level);
  const result=await performanceCommand(op,payload);
  await performanceRefresh(op==='review_revise'?result.id:performanceView.detail?.id||'');
 });
});
renderPerformance();
