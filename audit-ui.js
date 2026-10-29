/* ERP audit presentation; retain the existing presentation contract. */
(function(){const exports={};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MODULE_LABELS = exports.AUDIT_MODULES = void 0;
exports.auditEntityLabel = auditEntityLabel;
exports.auditActionLabel = auditActionLabel;
exports.redactAudit = redactAudit;
exports.auditChanges = auditChanges;
exports.auditSummary = auditSummary;
exports.auditModuleLabel = auditModuleLabel;
exports.AUDIT_MODULES = {"customers":["customer_departments","customer_categories","customers","customer_contacts","customer_contract_services","contract_service_types"],"projects":["project","projects","project_workers","construction_plans","construction_plan_items","construction_plan_assignees","construction_details","maintenance_details","project_costs"],"assignments":["work_assignment","work_assignments"],"worklogs":["site_work_logs","site_work_log_workers","site_assets","attachments","work_log_access_requests"],"repairs":["repair_items","repair_item","maintenance_events","maintenance_event_equipment","maintenance_event_workers","maintenance_event_result"],"phone":["phone_systems","phone_extensions","phone_terminal_points","phone_terminal_import_logs","phone_system_credentials","phone_terminal_versions"],"monitoring":["sites","site_devices","site_device_credentials","monitoring_device_imports","access_device_imports","site_spreadsheet_imports","site_spreadsheet_templates"],"inventory":["inventory_item","inventory_items","product_categories","stock_adjustment","stock_adjustments","suppliers","bulk_update_batches","bulk_update_batch_items"],"transactions":["stock_receipt","stock_receipts","stock_receipt_customers","stock_transaction_documents","pickup_record","pickup_records","supplier_return_documents","supplier_return_lines","supplier_return_customers","site_return_documents","site_return_lines"],"accounts":["app_user","app_users","session","app_roles","role_permissions","project_access","erp_private_access"],"accounting":["accounting_material_prices","accounting_worker_wages","supplier_payment_terms","accounting_payroll","accounting_payables"],"performance":["performance_access","performance_reviews","performance_periods","performance_templates","performance_shared_tasks"],"system":["system_operation","system_backup"]};
exports.MODULE_LABELS = {"customers":"客戶與承攬","projects":"工作內容與施工規劃","assignments":"工作指派與預約","worklogs":"工作日誌與附件","repairs":"維修品與履歷","phone":"電話設備","monitoring":"案場設備與匯入","inventory":"商品、庫存與供應商","transactions":"進貨、取貨與退貨","accounts":"帳號與權限","accounting":"會計作業","performance":"績效作業","system":"系統操作"};
const ENTITY_LABELS = { customer_departments: "客戶科室", customer_categories: "客戶分類", customers: "客戶", customer_contacts: "客戶聯絡人", customer_contract_services: "客戶承攬項目", contract_service_types: "承攬分類", project: "工作內容", projects: "工作內容", project_workers: "工作內容人員", site_work_logs: "工作日誌", site_work_log_workers: "施工人員", site_assets: "附件", repair_items: "維修品", repair_item: "維修品", maintenance_events: "設備維修履歷", maintenance_event_equipment: "維修設備", maintenance_event_workers: "維修人員", maintenance_event_result: "維修結果", phone_systems: "電話總機", phone_extensions: "電話分機", phone_terminal_points: "電話端子", phone_terminal_import_logs: "電話 Excel 匯入", phone_system_credentials: "電話登入資料", sites: "案場", site_devices: "監控設備", site_device_credentials: "設備登入資料", monitoring_device_imports: "監控 Excel 匯入", inventory_item: "商品", inventory_items: "商品", product_categories: "商品分類", pickup_record: "取貨紀錄", stock_receipt: "進貨紀錄", stock_adjustment: "庫存盤點", suppliers: "供應商", app_user: "使用者", app_users: "使用者", session: "工作階段", bulk_update_batches: "批次修改", bulk_update_batch_items: "批次修改項目" };
const FIELD_LABELS = { department_id: "科室名稱", customer_departments: "客戶科室", name: "名稱", title: "標題", summary: "工作摘要", description: "說明", notes: "備註", note: "備註", status: "狀態", worker_user_ids: "施工人員", user_id: "人員", workers: "施工人員", worker_labels: "施工人員", display_name: "顯示名稱", username: "帳號", role: "角色", is_active: "啟用狀態", customer_id: "客戶名稱", service_type_id: "承攬內容", service_id: "承攬內容", contract_service_codes: "承攬內容", project_id: "工作內容名稱", log_date: "工作日期", received_on: "收件日期", work_type: "工作類型", time_period: "時段", issue_description: "故障內容", cause: "故障原因", result: "處理結果", device_name: "設備名稱", device_brand: "品牌", device_model: "型號", ip_address: "IP 位址", quantity: "數量", inventory_item_id: "品項名稱", extension_number: "分機號碼", frame_name: "來源端子群組", frame_block: "端子板", frame_position: "端子槽位", file_name: "檔案名稱", total_rows: "總筆數", success_rows: "成功筆數", row_version: "資料版本", created_at: "建立時間", updated_at: "更新時間", updated_by: "更新者", before_quantity: "原數量", after_quantity: "校正後數量", source: "來源", id: "資料 ID" };
Object.assign(ENTITY_LABELS,{"construction_plans":"施工規劃","construction_plan_items":"施工子項目","construction_plan_assignees":"施工規劃人員","construction_details":"工程資料","maintenance_details":"維修工作資料","project_costs":"工作成本","work_assignment":"工作指派／客戶預約","work_assignments":"工作指派／客戶預約","work_log_access_requests":"日誌存取申請","attachments":"附件","stock_transaction_documents":"進貨／取貨單","stock_receipt_customers":"進貨訂貨客戶","site_return_documents":"案場餘料入庫單","site_return_lines":"餘料入庫品項","supplier_return_documents":"供應商退貨單","supplier_return_lines":"退貨品項","supplier_return_customers":"退貨客戶","app_roles":"角色","role_permissions":"角色權限","project_access":"工作內容授權","erp_private_access":"私有資料授權","accounting_worker_wages":"施工人員工資","accounting_material_prices":"材料計價","accounting_payroll":"薪資單","supplier_payment_terms":"供應商付款條件","performance_reviews":"績效評核","performance_access":"績效存取","performance_periods":"績效期間","performance_shared_tasks":"共同工作","performance_templates":"績效範本","system_operation":"系統操作","system_backup":"系統備份"});
Object.assign(FIELD_LABELS,{"document_no":"單號","receipt_document_no":"進貨單號","pickup_document_no":"取貨單號","project_code":"工作編號","customer_code":"客戶編號","inventory_code":"貨品編號","item_name":"品項名稱","unit":"單位","model":"型號","receipt_date":"進貨日期","pickup_date":"取貨日期","return_date":"退貨／入庫日期","supplier_id":"供應商","document_id":"單據","assignee_user_id":"被指派人","created_by_user_id":"建立者","construction_plan_id":"施工規劃","construction_item_id":"施工子項目","planned_days":"預計天數","start_day":"開始日","is_completed":"完成狀態","deleted_at":"刪除時間","delete_reason":"刪除原因","completed_at":"完成時間","content":"內容","instructions":"指派內容","role_code":"角色","module":"功能模組","can_view":"查看權限","can_create":"新增權限","can_update":"修改權限","can_delete":"刪除權限","operation":"表單操作","http_status":"回應狀態"});
function auditEntityLabel(value) { return ENTITY_LABELS[value] || value || "資料"; }
function auditActionLabel(value) {
    const code = String(value || "").toUpperCase();
    const direct = { LOGIN: "登入", LOGOUT: "登出", USER_UPDATE: "修改使用者", PROJECT_UPDATE: "修改工作內容", MAINTENANCE_CREATE: "新增維修紀錄", BATCH_UPDATE: "批次修改", BATCH_DELETE: "批次刪除", UPDATE_CREDENTIAL: "修改登入資料", REVEAL_CREDENTIAL: "查看登入資料", VOID: "作廢" };
    if (direct[code])
        return direct[code];
    if (/IMPORT/.test(code))
        return "匯入";
    if (/EXPORT/.test(code))
        return "匯出";
    if (/DELETE|REMOVE/.test(code))
        return "刪除";
    if (/UPDATE|EDIT|SET/.test(code))
        return "修改";
    if (/CREATE|INSERT|ADD/.test(code))
        return "新增";
    return "其他操作";
}
function redactAudit(value, depth = 0) {
    if (depth > 12)
        return "[已省略]";
    if (Array.isArray(value))
        return value.map(item => redactAudit(item, depth + 1));
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /password|passwd|pwd|token|authorization|cookie|secret|credential|cipher|encryption|private.?key|service.?role|api.?key|密碼|金鑰/i.test(key) ? "[已遮蔽]" : redactAudit(item, depth + 1)]));
    if (typeof value === "string")
        return value.replace(/Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:password|token|secret|密碼)\s*[:=]\s*[^\s,;]+/gi, "[已遮蔽]");
    return value;
}
function auditChanges(record) {
    const before = redactAudit(record.display_before ?? record.before_data), after = redactAudit(record.display_after ?? record.after_data);
    const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
    const comparable = value => value == null || value === "" ? null : value;
    const printable = (value) => comparable(value) == null ? "未填" : Array.isArray(value) ? value.map(printable).join("、") : typeof value === "object" ? Object.values(value).map(printable).join("、") : String(value);
    return keys.filter(key => !['id', 'updated_at', 'updated_by', 'row_version', 'source', 'references'].includes(key) && JSON.stringify(comparable(before?.[key])) !== JSON.stringify(comparable(after?.[key]))).map(key => ({ field: FIELD_LABELS[key] || key, before: printable(before?.[key]), after: printable(after?.[key]) }));
}
function auditSummary(record) { return `${record.actor || "未記錄操作者"} · ${auditActionLabel(record.action)}「${auditEntityLabel(record.entity_type)}」${record.record_label?" · "+record.record_label:""}`; }
exports.auditEvidence = record => record.actor_user_id?"帳號已記錄":record.actor?"僅原始操作者文字":"操作者未記錄";
exports.auditOutcome = record => ({completed:"送出完成",failed:"送出失敗",recorded:record.event_kind==="legacy"||!record.event_kind?"歷史紀錄":"資料異動"}[record.outcome||"recorded"]||"已記錄");
function auditModuleLabel(record) { const key = Object.keys(exports.AUDIT_MODULES).find(key => exports.AUDIT_MODULES[key].includes(record.entity_type)); return key ? exports.MODULE_LABELS[key] : "其他模組"; }

globalThis.GUCAudit=exports;})();
