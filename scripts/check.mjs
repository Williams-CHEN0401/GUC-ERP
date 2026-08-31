import { readFileSync } from "node:fs";

const files = ["index.html", "styles.css", "app.js", "api/inventory.js", "api/nas.mjs", "api/public-config.js", ".env.example", "vercel.json", "supabase/migrations/20260827000200_formal_site_crud_and_work_type.sql", "supabase/migrations/20260828000100_work_log_workers_pickups_and_nas_folders.sql", "supabase/migrations/20260828000200_standalone_work_logs_contracts_accounts_nas.sql", "supabase/migrations/20260828000300_contract_centric_sites.sql", "supabase/migrations/20260828000400_lock_down_work_log_project_trigger.sql", "supabase/migrations/20260829000100_contract_attachment_project_path.sql", "supabase/migrations/20260830082440_create_secure_phone_data_module.sql", "supabase/migrations/20260830083755_harden_phone_module_service_role_grants.sql", "supabase/migrations/20260831000100_project_workers_and_work_log_defaults.sql"];
for (const file of files) {
  const content = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  if (!content.trim()) throw new Error(`${file} is empty`);
}

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
for (const marker of ["data-page=\"dashboard\"", "data-page=\"transactions\"", "data-page=\"inventory\"", "data-page=\"crm\"", "data-page=\"worklogs\""]) {
  if (!html.includes(marker)) throw new Error(`Missing page marker: ${marker}`);
}
for (const marker of ["id=\"worklogCustomerCategoryFilter\"", "id=\"worklogCustomerFilter\"", "id=\"materialCustomerCategory\"", "id=\"customerCategoryFilter\"", "id=\"itemBatchForm\"", "id=\"inventoryPagination\"", "id=\"userTable\"", "id=\"logTable\"", "data-open=\"accountModal\"", "id=\"systemChooser\"", "data-system-choice=\"erp\"", "data-system-choice=\"sites\""]) {
  if (!html.includes(marker)) throw new Error(`Missing preview feature marker: ${marker}`);
}
if (html.includes("批次修改") || html.includes("bulkItemForm")) throw new Error("Bulk edit feature was not removed");
if (html.includes("現場照片") || html.includes('data-pane="photos"')) throw new Error("Site photo tab was not removed");
if (html.includes('data-tab="maintenance"') || html.includes('data-pane="maintenance"') || html.includes('data-site-module="logs"')) throw new Error("Work log or maintenance tab remains under sites");
if (html.includes('data-page="sites"') || html.includes('id="siteCustomerCategory"') || html.includes('data-site-module="floors"')) throw new Error("Internal ERP site-data page was not removed");
if (html.includes("安全預覽模式") || html.includes("預覽資料來源") || html.includes("dataNoticeLabel")) throw new Error("Preview notices were not removed");

const js = readFileSync(new URL("../app.js", import.meta.url), "utf8");
if (js.includes("現場照片") || !js.includes("select:工程施工,工程施工|維修紀錄,維修紀錄|維護保養,維護保養")) throw new Error("Site tabs or work type options are incorrect");
if (!js.includes("GUC_ERP_ACCESS_TOKEN")) throw new Error("Session namespace missing");
if (!js.includes('operation:"login"')) throw new Error("Protected login flow missing");
if (!js.includes('scope:"session"') || !js.includes("PAGE_SCOPES")) throw new Error("Lazy page loading flow missing");
if (!js.includes("AbortController") || !js.includes("loadedScopes")) throw new Error("Client timeout or scope isolation missing");
if (!js.includes("PREVIEW_MODE")) throw new Error("Preview-mode isolation missing");
for (const operation of ["create_account", "update_account", "delete_account"]) {
  if (!js.includes(operation)) throw new Error(`User CRUD flow missing: ${operation}`);
}
for (const marker of ["inferCustomerCategory", "create_inventory_item_batch", "collectTransactionBatchRows", "customer_category"]) {
  if (!js.includes(marker)) throw new Error(`2026-08-25 specification flow missing: ${marker}`);
}
for (const marker of ["NAS_TARGET_ROOT", "attachmentModal", "preview_attachment_upload", "MAX_ATTACHMENT_FILES", "MAX_ATTACHMENT_BYTES", "attachmentTargetPath", "workerPickerField", "workLogPickupModal", "work_log_id", "request_id"]) {
  if (!js.includes(marker)) throw new Error(`NAS attachment preview flow missing: ${marker}`);
}
for (const marker of ["create_contract_site_attachment_batch", "上傳日期/檔名", "完整 NAS 路徑", "preflight", "conflict_actions"]) {
  if (!js.includes(marker)) throw new Error(`Production NAS attachment flow missing: ${marker}`);
}
for (const marker of ["upsert_contract_site_entry", "delete_contract_site_entry", "selectedSiteContext", "contract_service_type_id"]){
  if (!js.includes(marker)) throw new Error(`Contract-centric site CRUD flow missing: ${marker}`);
}
for (const marker of ["workLogActionMenu", "worklog-content-action", "syncModalCustomerOptions", "syncAttachmentOptions", "SITE_SYSTEM_TARGET_URL", "Preview 不載入正式 NAS 帳密", "Preview 不使用正式 NAS 環境變數"]) {
  if (!js.includes(marker)) throw new Error(`Correction V1 flow missing: ${marker}`);
}
for (const marker of ["projectOwnerPickerField", "projectWorkerIds", "syncWorkLogWorkersFromProject", "const form=event.currentTarget", "form.reset();renderInventory()"]){
  if (!js.includes(marker)) throw new Error(`Project-owner or inventory-adjustment fix missing: ${marker}`);
}
if (js.includes("preview_site_upsert") || js.includes("preview_site_delete")) throw new Error("Preview-only site CRUD operation remains");
if (js.includes("updateMaterialCustomers(false);updateSiteCustomers(false)")) throw new Error("Removed site-data page is still invoked from master-data rendering");
if (!js.includes("state.siteData.assets=assets.map")) throw new Error("NAS attachment hydration is missing");
if (js.includes("preview_bulk_inventory") || js.includes("selectedInventoryIds")) throw new Error("Bulk edit JavaScript was not removed");

const api = readFileSync(new URL("../api/inventory.js", import.meta.url), "utf8");
if (api.includes("chatgpt.site")) throw new Error("Legacy cross-site proxy is still configured");
if (!api.includes("supabase.co/functions/v1") || !api.includes("inventory-gateway-preview")) throw new Error("Direct Supabase gateway routing is missing");
if (api.includes("VERCEL_OIDC_TOKEN") || api.includes("x-vercel-oidc-token")) throw new Error("Optional Vercel OIDC dependency was not removed");
if (!api.includes("UPSTREAM_TIMEOUT_MS") || !api.includes("AbortController")) throw new Error("Vercel upstream timeout guard missing");

const nas = readFileSync(new URL("../api/nas.mjs", import.meta.url), "utf8");
for (const marker of ["NAS_WEBDAV_URL", "NAS_WEBDAV_USERNAME", "NAS_WEBDAV_PASSWORD", "NAS_WEBDAV_ROOT", "PROPFIND", "MKCOL", '"PUT", nasPath', "currentUser(request)"]) {
  if (!nas.includes(marker)) throw new Error(`NAS upload gateway marker missing: ${marker}`);
}
if (!nas.includes('["preview", "production"]') || !nas.includes('inventory-gateway" : "inventory-gateway-preview')) throw new Error("NAS environment routing is missing");
for (const marker of ["ensureNestedFolder", "allocateRenamedFile", "customerName", "contractServiceName", "projectName", "project_id", "logDate", "If-None-Match", "If-Match", "verifyUploadedFile", "EMPTY_FILE", "Asia/Taipei", "preflight_completed", "request_id", "missing.join"]) {
  if (!nas.includes(marker)) throw new Error(`NAS deterministic-path marker missing: ${marker}`);
}
if (!nas.includes('["admin", "operator"]')) throw new Error("NAS upload role guard missing");
if (!nas.includes('root !== "/GUC-ERP"')) throw new Error("NAS root path guard missing");

const edge = readFileSync(new URL("../supabase/functions/inventory-gateway/index.ts", import.meta.url), "utf8");
if (!edge.includes("const user = await currentUser(request)")) throw new Error("Supabase user-token verification is missing");
if (!edge.includes('requireRole(user,["admin","operator"])')) throw new Error("Supabase role verification is missing");
if (!edge.includes("scopedSnapshot") || !edge.includes("Promise.allSettled")) throw new Error("Scoped data isolation missing");
if (!edge.includes("UPSTREAM_TIMEOUT_MS") || !edge.includes("timedFetch")) throw new Error("Supabase upstream timeout guard missing");
if (!edge.includes('operation === "create_contract_site_attachment_batch"')) throw new Error("Contract attachment index persistence is missing");
for (const marker of ['operation === "upsert_contract_site_entry"', 'operation === "delete_contract_site_entry"', 'operation === "delete_standalone_work_log"', "ensure_customer_contract_site_v1", "register_contract_site_attachments_v2"]) {
  if (!edge.includes(marker)) throw new Error(`Contract-centric gateway marker missing: ${marker}`);
}
for (const marker of ['operation === "upsert_project_site_entry"', 'operation === "delete_project_site_entry"', "ensure_project_site_v1", '["工程施工","維修紀錄","維護保養"]']) {
  if (!edge.includes(marker)) throw new Error(`Formal site gateway marker missing: ${marker}`);
}
for (const marker of ["site_work_log_workers", "site_workers", "upsert_project_site_work_log_v1", "create_pickup_records_batch_v2", "p_work_log_id", "p_request_id"]) {
  if (!edge.includes(marker)) throw new Error(`Work-log worker or shared pickup marker missing: ${marker}`);
}
for (const marker of ["contract_service_types", "customer_contract_services", "upsert_customer_project_work_log_v2", "register_site_attachments_v2", "password_confirmation"]) {
  if (!edge.includes(marker)) throw new Error(`Standalone work-log or account marker missing: ${marker}`);
}
for (const marker of ["phone_systems", "phone_extensions", "phone_terminal_points", 'operation === "upsert_phone_system"', 'operation === "upsert_phone_extension"', 'operation === "set_phone_system_credential"', 'operation === "reveal_phone_system_credential"']) {
  if (!edge.includes(marker)) throw new Error(`Phone data gateway marker missing: ${marker}`);
}
for (const marker of ["project_workers", "upsert_erp_project_with_workers_v1", "worker_user_ids"]){
  if (!edge.includes(marker)) throw new Error(`Project-owner gateway marker missing: ${marker}`);
}
if (edge.includes("login_username_ciphertext") || edge.includes("login_password_ciphertext")) throw new Error("Encrypted phone credentials must not be included in the gateway snapshot.");
if (edge.includes("...(await snapshot(logged.user))")) throw new Error("Login still loads the full database snapshot");

const formalMigration = readFileSync(new URL("../supabase/migrations/20260827000200_formal_site_crud_and_work_type.sql", import.meta.url), "utf8");
for (const marker of ["sites_project_id_uidx", "site_work_logs_work_type_check", "ensure_project_site_v1", "grant execute"]) {
  if (!formalMigration.includes(marker)) throw new Error(`Formal site migration marker missing: ${marker}`);
}

const workLogMigration = readFileSync(new URL("../supabase/migrations/20260828000100_work_log_workers_pickups_and_nas_folders.sql", import.meta.url), "utf8");
for (const marker of ["site_work_log_workers", "pickup_records_work_log_id_fkey", "pickup_records_request_row_uidx", "upsert_project_site_work_log_v1", "create_pickup_records_batch_v2", "pg_advisory_xact_lock", "grant execute"]) {
  if (!workLogMigration.includes(marker)) throw new Error(`Work-log migration marker missing: ${marker}`);
}

const standaloneMigration = readFileSync(new URL("../supabase/migrations/20260828000200_standalone_work_logs_contracts_accounts_nas.sql", import.meta.url), "utf8");
for (const marker of ["contract_service_types", "customer_contract_services", "customer_contract_services_service_type_id_idx", "仍有專案未關聯客戶", "同一客戶內仍有重複專案名稱", "site_work_logs_project_id_fkey", "projects_customer_normalized_name_uidx", "create_customer_with_contracts_v1", "upsert_customer_project_work_log_v2", "register_site_attachments_v2"]) {
  if (!standaloneMigration.includes(marker)) throw new Error(`Standalone work-log migration marker missing: ${marker}`);
}

const contractSiteMigration = readFileSync(new URL("../supabase/migrations/20260828000300_contract_centric_sites.sql", import.meta.url), "utf8");
for (const marker of ["contract_service_type_id", "sites_customer_contract_service_fkey", "sites_customer_contract_service_uidx", "ensure_customer_contract_site_v1", "register_contract_site_attachments_v1", "not valid"]) {
  if (!contractSiteMigration.includes(marker)) throw new Error(`Contract-centric site migration marker missing: ${marker}`);
}

const triggerSecurityMigration = readFileSync(new URL("../supabase/migrations/20260828000400_lock_down_work_log_project_trigger.sql", import.meta.url), "utf8");
if (!triggerSecurityMigration.includes("set_site_work_log_project_id_v1") || !triggerSecurityMigration.includes("from public, anon, authenticated")) {
  throw new Error("Work-log project trigger RPC privilege revocation is missing");
}

const attachmentProjectMigration = readFileSync(new URL("../supabase/migrations/20260829000100_contract_attachment_project_path.sql", import.meta.url), "utf8");
for (const marker of ["register_contract_site_attachments_v2", "p_project_id uuid", "project_id = p_project_id", "work_log_id = null", "from public, anon, authenticated"]) {
  if (!attachmentProjectMigration.includes(marker)) throw new Error(`Project-aware attachment migration marker missing: ${marker}`);
}

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
if (!css.includes(".modal-card .form-submit{position:sticky")) throw new Error("Sticky modal save action missing");
if (!css.includes(".nas-status-card") || !css.includes(".attachment-dropzone") || !css.includes(".worker-picker") || !css.includes(".work-log-pickup-summary") || !css.includes(".worklog-action-menu") || !css.includes(".system-gate")) throw new Error("NAS attachment, work-log, or system chooser UI styles missing");

const { default: handler } = await import("../api/inventory.js");
const request = { method: "POST", headers: { "content-length": "70" }, body: { operation: "update_customer", payload: {} }, url: "/api/inventory" };
let statusCode = 200;
let responseBody = null;
const response = {
  status(code) { statusCode = code; return this; },
  json(body) { responseBody = body; return body; },
  setHeader() {},
  send(body) { responseBody = body; return body; }
};
const oldEnvironment = process.env.VERCEL_ENV;
process.env.VERCEL_ENV = "preview";
await handler(request, response);
if (oldEnvironment === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = oldEnvironment;
if (statusCode !== 403 || !String(responseBody?.error).includes("禁止寫入")) throw new Error("Preview API write guard failed");

console.log("ERP preview verification passed.");
