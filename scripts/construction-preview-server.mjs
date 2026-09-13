// Loopback-only synthetic data. All edits remain in browser memory.
import {createPreviewServer,fixture} from './report-dates-preview-server.mjs';
fixture.customers[0].name='分類驗證學校（模擬資料）';
fixture.projects[1].project_date='2026-09-12';
fixture.projects[0].construction_category='small_purchase';
fixture.projects[2].construction_category='tender';
fixture.projects.push({id:'p4',name:'維修測試',project_code:'TEST004',customer_id:'c1',project_type:'repair',status:'in_progress',row_version:1});
export {createPreviewServer};
if(process.argv[1]?.endsWith('construction-preview-server.mjs')){
 createPreviewServer().listen(4193,'127.0.0.1',()=>console.log('http://127.0.0.1:4193/?page=crm — synthetic data only'));
}
