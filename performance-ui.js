function canOpenPerformance(){return globalThis.GUC_PUBLIC_CONFIG?.performanceEnabled===true&&canModule('performance');}
function renderPerformance(){const root=document.querySelector('#performanceRoot');if(!root)return;root.innerHTML=canOpenPerformance()?'<article class="panel"><h2>績效管理已移至會計系統</h2><button class="primary" type="button" data-open-performance-accounting>前往會計系統績效管理</button></article>':'';}
document.addEventListener('click',event=>{if(event.target.closest('[data-open-performance-accounting]'))openQuotationSystem(null,true);});
renderPerformance();
