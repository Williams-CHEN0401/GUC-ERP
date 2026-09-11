/* Shared audit presentation from GUC-Site-Data/lib/audit-presentation.ts. */
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
exports.AUDIT_MODULES = {
    customers: ["customers", "customer_contacts", "customer_contract_services", "contract_service_types"],
    projects: ["project", "projects", "project_workers", "construction_details", "maintenance_details", "project_costs"],
    worklogs: ["site_work_logs", "site_work_log_workers", "site_assets"],
    repairs: ["repair_items", "repair_item", "maintenance_events", "maintenance_event_equipment", "maintenance_event_workers", "maintenance_event_result"],
    phone: ["phone_systems", "phone_extensions", "phone_terminal_points", "phone_terminal_import_logs", "phone_system_credentials"],
    monitoring: ["sites", "site_devices", "site_device_credentials", "monitoring_device_imports", "monitoring_devices"],
    inventory: ["inventory_item", "inventory_items", "product_categories", "pickup_record", "stock_receipt", "stock_adjustment", "suppliers", "bulk_update_batches", "bulk_update_batch_items"],
    accounts: ["app_user", "app_users", "session"],
};
exports.MODULE_LABELS = { customers: "客戶與承攬", projects: "工作內容", worklogs: "工作日誌", repairs: "維修履歷", phone: "電話設備", monitoring: "監控設備", inventory: "庫存與交易", accounts: "帳號與登入" };
const ENTITY_LABELS = { customers: "客戶", customer_contacts: "客戶聯絡人", customer_contract_services: "客戶承攬項目", contract_service_types: "承攬分類", project: "工作內容", projects: "工作內容", project_workers: "工作內容人員", site_work_logs: "工作日誌", site_work_log_workers: "施工人員", site_assets: "附件", repair_items: "維修品", repair_item: "維修品", maintenance_events: "設備維修履歷", maintenance_event_equipment: "維修設備", maintenance_event_workers: "維修人員", maintenance_event_result: "維修結果", phone_systems: "電話總機", phone_extensions: "電話分機", phone_terminal_points: "電話端子", phone_terminal_import_logs: "電話 Excel 匯入", phone_system_credentials: "電話登入資料", sites: "案場", site_devices: "監控設備", site_device_credentials: "設備登入資料", monitoring_device_imports: "監控 Excel 匯入", inventory_item: "商品", inventory_items: "商品", product_categories: "商品分類", pickup_record: "取貨紀錄", stock_receipt: "進貨紀錄", stock_adjustment: "庫存盤點", suppliers: "供應商", app_user: "使用者", app_users: "使用者", session: "工作階段", bulk_update_batches: "批次修改", bulk_update_batch_items: "批次修改項目" };
const FIELD_LABELS = { name: "名稱", title: "標題", summary: "日誌內容", description: "說明", notes: "備註", note: "備註", status: "狀態", worker_user_ids: "施工人員", user_id: "人員", workers: "施工人員", worker_labels: "施工人員", display_name: "顯示名稱", username: "帳號", role: "角色", is_active: "啟用狀態", customer_id: "客戶", service_type_id: "承攬項目", service_id: "承攬項目", contract_service_codes: "承攬項目", project_id: "工作內容", log_date: "工作日期", received_on: "收件日期", work_type: "工作類型", time_period: "工作時段", issue_description: "故障內容", cause: "故障原因", result: "處理結果", device_name: "設備名稱", device_brand: "品牌", device_model: "型號", ip_address: "IP 位址", quantity: "數量", inventory_item_id: "品項", extension_number: "分機號碼", frame_name: "端子箱", frame_block: "端子板", frame_position: "槽位", file_name: "檔案名稱", total_rows: "總筆數", success_rows: "成功筆數", row_version: "資料版本", created_at: "建立時間", updated_at: "更新時間", updated_by: "更新者", before_quantity: "原數量", after_quantity: "調整後數量", source: "來源", id: "資料 ID" };
function auditEntityLabel(value) { return ENTITY_LABELS[value] || "資料"; }
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
    const printable = (value) => value == null ? "未填" : Array.isArray(value) ? value.map(printable).join("、") : typeof value === "object" ? Object.values(value).map(printable).join("、") : String(value);
    return keys.filter(key => !['id', 'updated_at', 'updated_by', 'row_version', 'source'].includes(key) && JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])).map(key => ({ field: FIELD_LABELS[key] || "其他欄位", before: printable(before?.[key]), after: printable(after?.[key]) }));
}
function auditSummary(record) { return `${record.actor || "未記錄操作者"} ${auditActionLabel(record.action)}了「${auditEntityLabel(record.entity_type)}」`; }
function auditModuleLabel(record) { const key = Object.keys(exports.AUDIT_MODULES).find(key => exports.AUDIT_MODULES[key].includes(record.entity_type)); return key ? exports.MODULE_LABELS[key] : "其他模組"; }

globalThis.GUCAudit=exports;})();
