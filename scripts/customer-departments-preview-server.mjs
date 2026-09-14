// Explicit synthetic fixture; POST and every external service remain unavailable.
import {createPreviewServer,fixture} from './report-dates-preview-server.mjs';
fixture.customer_categories=[['school','學校機關'],['government','政府機關'],['social_welfare','社福機關'],['cleaning_team','清潔隊']].map(([code,name])=>({id:'category-'+code,code,name,row_version:1}));
fixture.customers=[
 {id:'c1',customer_code:'TEST001',customer_category:'government',name:'環境保護局（模擬資料）',row_version:1},
 {id:'c2',customer_code:'TEST002',customer_category:'school',name:'高中（模擬資料）',row_version:1},
 {id:'c3',customer_code:'TEST003',customer_category:'government',name:'尚無科室客戶（模擬資料）',row_version:1}
];
fixture.customer_departments=[
 {id:'d1',customer_id:'c1',name:'土水科',is_active:true,row_version:1},
 {id:'d2',customer_id:'c1',name:'資訊室',is_active:true,row_version:1},
 {id:'d3',customer_id:'c2',name:'資訊室',is_active:true,row_version:1},
 {id:'d4',customer_id:'c1',name:'歷史停用科室',is_active:false,row_version:1}
];
fixture.projects=[
 {id:'p1',customer_id:'c1',department_id:'d1',name:'電話系統查修',project_code:'TEST001',project_type:'repair',status:'in_progress',project_date:'2026-09-14',created_at:'2026-09-14T00:00:00Z',row_version:1},
 {id:'p2',customer_id:'c1',department_id:'d2',name:'資訊設備維護',project_code:'TEST002',project_type:'maintenance',status:'in_progress',project_date:'2026-09-14',created_at:'2026-09-14T00:00:00Z',row_version:1},
 {id:'p3',customer_id:'c1',department_id:null,name:'歷史未設科室',project_code:'TEST003',project_type:'construction',status:'in_progress',project_date:'2026-09-14',row_version:1},
 {id:'p4',customer_id:'c1',department_id:'d4',name:'歷史停用科室工作',project_code:'TEST004',project_type:'construction',status:'in_progress',project_date:'2026-09-14',row_version:1},
 {id:'p5',customer_id:'c1',department_id:'d1',name:'已完成不供新增選擇',project_code:'TEST005',project_type:'repair',status:'completed',project_date:'2026-09-14',row_version:1}
];
fixture.categories=[{id:'i-category',name:'線材',code_prefix:'TEST',is_active:true,row_version:1}];
fixture.items=[{id:'i1',category_id:'i-category',inventory_code:'TEST001',item_name:'測試線材',brand:'測試',model:'TEST',unit:'條',opening_quantity:20,row_version:1}];
fixture.suppliers=[{id:'s1',name:'模擬供應商',row_version:1}];
fixture.site_workers=[{id:'u1',display_name:'本機測試員',is_active:true}];
fixture.site_work_log_workers=[{work_log_id:'l1',user_id:'u1'}];
fixture.site_work_logs=[{id:'l1',project_id:'p1',title:'電話系統查修',log_date:'2026-09-14',time_period:'上午',work_type:'維修紀錄',summary:'模擬工作日誌',status:'in_progress',row_version:1}];
fixture.repair_items=[{id:'r1',repair_no:'TEST-R001',customer_id:'c1',department_id:null,inventory_item_id:'i1',quantity:1,received_on:'2026-09-14',status:'received',issue_description:'歷史維修資料',row_version:1}];
fixture.receipts=[{id:'receipt1',receipt_date:'2026-09-14',supplier_id:'s1',inventory_item_id:'i1',quantity:1,stock_receipt_customers:[{customer_id:'c1',department_id:null}],row_version:1}];
fixture.contract_service_types=[{id:'svc1',code:'phone_system',name:'電話系統',is_active:true,sort_order:1}];
fixture.customer_contract_services=[{customer_id:'c1',service_type_id:'svc1'}];
export {createPreviewServer,fixture};
if(process.argv[1]?.endsWith('customer-departments-preview-server.mjs'))createPreviewServer().listen(4195,'127.0.0.1',()=>console.log('http://127.0.0.1:4195/?page=crm — synthetic departments only'));
