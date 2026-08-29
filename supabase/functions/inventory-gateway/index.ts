type Row = Record<string, unknown>;
type Role = "admin" | "operator" | "viewer";
type AppUser = { id: string; auth_user_id: string; username: string; display_name: string; role: Role; is_active: boolean; row_version: number };
const url = Deno.env.get("SUPABASE_URL") ?? "";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const uuid = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text(value)) ? text(value) : null;
const date = (value: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? text(value) : null;
const limited = (value: unknown, max: number) => { const result = text(value); return result && result.length <= max ? result : null; };
const nullable = (value: unknown, max: number) => { const result = text(value); return result.length <= max ? result : null; };
const positive = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; };
const nonNegative = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; };
const username = (value: unknown) => { const result = text(value).toLowerCase(); return /^[a-z0-9][a-z0-9_-]{2,31}$/.test(result) ? result : null; };
const password = (value: unknown) => { const result = typeof value === "string" ? value : ""; return result.length >= 12 && result.length <= 128 ? result : null; };
const role = (value: unknown): Role | null => ["admin", "operator", "viewer"].includes(text(value)) ? text(value) as Role : null;
const customerCategory = (value: unknown) => ["school", "government"].includes(text(value)) ? text(value) : null;
const safePathPart = (value: unknown) => text(value).normalize("NFKC").replace(/[\\/:*?"<>|\x00-\x1F]/g,"_").replace(/\s+/g," ").trim().slice(0,100) || "未命名";
const optionalEmail = (value: unknown) => {
  const result = nullable(value, 160);
  if (result === null) return null;
  return !result || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result) ? result : null;
};
const internalEmail = (name: string) => `${name}@inventory.local`;
const UPSTREAM_TIMEOUT_MS = 12_000;
async function timedFetch(resource: string, init: RequestInit = {}, label = "資料服務") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(resource, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error(`${label}回應逾時，請稍後重試。`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function db(path: string, init: RequestInit = {}) { const headers = new Headers(init.headers); headers.set("apikey", key); headers.set("Authorization", `Bearer ${key}`); headers.set("Content-Type", "application/json"); return timedFetch(`${url}/rest/v1/${path}`, { ...init, headers }, "資料庫"); }
async function authApi(path: string, init: RequestInit = {}) { const headers = new Headers(init.headers); headers.set("apikey", key); headers.set("Authorization", `Bearer ${key}`); headers.set("Content-Type", "application/json"); return timedFetch(`${url}${path}`, { ...init, headers }, "身分驗證服務"); }
async function get(path: string) { const response = await db(path); if (!response.ok) throw new Error("讀取資料失敗。"); return response.json(); }
async function insert(table: string, row: Row) { const response = await db(table, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) }); if (!response.ok) { const failure = await response.json().catch(() => ({})) as { code?: string; message?: string }; if (failure.code === "23505") throw new Error("資料已存在，請確認後重試。"); if (failure.code === "42501") throw new Error("帳號資料服務尚未取得必要權限。"); if (failure.code === "PGRST204") throw new Error("帳號資料服務正在更新，請稍後重試。"); if (failure.code === "23503") throw new Error("登入帳號建立未完成，請稍後重試。"); throw new Error(`儲存失敗（代碼：${failure.code || "unknown"}）。`); } return response.json(); }
async function rpc(name: string, args: Row) { const response = await db(`rpc/${name}`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(args) }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message || "資料處理失敗，請確認輸入內容後重試。"); } return response.json(); }
async function updateVersioned(table: "customers" | "suppliers" | "projects" | "sites", id: string, rowVersion: number, values: Row, conflictMessage: string) {
  const response = await db(`${table}?id=eq.${id}&row_version=eq.${rowVersion}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(values) });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { code?: string };
    if (failure.code === "23505") throw new Error("編號或名稱已被使用，請確認後重試。");
    throw new Error("資料更新失敗，請確認輸入內容後重試。");
  }
  const rows = await response.json() as Row[];
  if (rows.length !== 1) throw new Error(conflictMessage);
  return rows[0];
}
async function deleteVersioned(table: string, id: string, rowVersion: number) {
  const response = await db(`${table}?id=eq.${id}&row_version=eq.${rowVersion}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
  const rows = response.ok ? await response.json() as Row[] : [];
  if (rows.length !== 1) throw new Error("資料已被其他使用者更新，請重新載入後再刪除。");
}
async function ensureProjectSite(projectId: string, actor: string) {
  await rpc("ensure_project_site_v1", { p_project_id: projectId, p_actor: actor });
  const rows = await get(`sites?project_id=eq.${projectId}&select=id,project_id,customer_id&limit=2`) as { id: string; project_id: string; customer_id: string }[];
  if (rows.length !== 1) throw new Error("案場與專案的關聯不完整，請重新整理後再試。");
  return rows[0];
}
async function ensureContractSite(customerId: string, serviceTypeId: string, actor: string) {
  await rpc("ensure_customer_contract_site_v1", { p_customer_id: customerId, p_service_type_id: serviceTypeId, p_actor: actor });
  const rows = await get(`sites?customer_id=eq.${customerId}&contract_service_type_id=eq.${serviceTypeId}&select=id,customer_id,contract_service_type_id&limit=2`) as { id: string; customer_id: string; contract_service_type_id: string }[];
  if (rows.length !== 1) throw new Error("案場與承攬內容的關聯不完整，請重新整理後再試。");
  return rows[0];
}
async function updateSiteDetail(table: string, id: string, rowVersion: number, siteId: string, values: Row) {
  const response = await db(`${table}?id=eq.${id}&site_id=eq.${siteId}&row_version=eq.${rowVersion}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(values) });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { code?: string };
    if (failure.code === "23505") throw new Error("案場編號或名稱已被使用，請確認後重試。");
    throw new Error("案場資料更新失敗，請確認輸入內容後重試。");
  }
  const rows = await response.json() as Row[];
  if (rows.length !== 1) throw new Error("案場資料已被其他使用者更新，請重新載入後再修改。");
  return rows[0];
}
async function deleteSiteDetail(table: string, id: string, rowVersion: number, siteId: string) {
  const response = await db(`${table}?id=eq.${id}&site_id=eq.${siteId}&row_version=eq.${rowVersion}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
  const rows = response.ok ? await response.json() as Row[] : [];
  if (rows.length !== 1) throw new Error("案場資料已被其他使用者更新，請重新載入後再刪除。");
}
const publicUser = (user: AppUser | null) => user ? { username: user.username, display_name: user.display_name, role: user.role } : null;
async function currentUser(request: Request): Promise<AppUser | null> {
  const token = request.headers.get("authorization") ?? "";
  if (!token.startsWith("Bearer ")) return null;
  const auth = await timedFetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: token } }, "登入工作階段驗證");
  if (!auth.ok) return null;
  const identity = await auth.json() as { id?: string };
  const authUserId = uuid(identity.id);
  if (!authUserId) return null;
  const users = await get(`app_users?auth_user_id=eq.${authUserId}&is_active=eq.true&select=id,auth_user_id,username,display_name,role,is_active,row_version`) as AppUser[];
  return users.length === 1 ? users[0] : null;
}
function requireRole(user: AppUser | null, allowed: Role[]) {
  if (!user) throw new Error("請先以有效帳號登入。");
  if (!allowed.includes(user.role)) throw new Error("您的帳號沒有執行此操作的權限。");
}
type DatasetDefinition = { path: string; adminOnly?: boolean };
const datasets: Record<string, DatasetDefinition> = {
  projects: { path: "projects?select=id,name,project_code,customer_id,project_type,status,assigned_to,description,estimated_cost,actual_cost,started_on,completed_on,note,created_at,updated_at,row_version,source,updated_by&order=updated_at.desc" },
  items: { path: "inventory_items?select=id,inventory_code,category_id,model,brand,item_name,item_type,unit,opening_quantity,cost_price,sale_price,inventory_status,default_supplier_id,note,created_at,updated_at,row_version,source,updated_by&order=inventory_code.asc" },
  pickups: { path: "pickup_records?select=id,pickup_date,project_id,inventory_item_id,quantity,row_version,created_at,updated_at,source,updated_by,created_by_user_id,created_by_username,work_log_id,request_id,request_row&order=pickup_date.desc,created_at.desc" },
  receipts: { path: "stock_receipts?select=id,receipt_date,inventory_item_id,quantity,supplier_id,supplier,note,row_version,created_at,updated_at,source,updated_by&order=receipt_date.desc,created_at.desc" },
  adjustments: { path: "stock_adjustments?select=id,inventory_item_id,before_quantity,after_quantity,difference_quantity,adjusted_at,reason,idempotency_key,source,updated_by,created_at&order=adjusted_at.desc,id.desc" },
  audit_logs: { path: "audit_logs?select=id,entity_type,entity_id,action,source,actor,created_at&order=created_at.desc&limit=100" },
  sync_runs: { path: "sync_runs?select=id,direction,status,source_name,total_records,processed_records,error_message,started_at,finished_at&order=started_at.desc&limit=20" },
  import_batches: { path: "import_batches?select=id,file_name,status,total_rows,valid_rows,error_rows,conflict_rows,created_at,completed_at&order=created_at.desc&limit=20" },
  conflicts: { path: "data_conflicts?select=id,entity_type,entity_id,status,created_at&status=eq.open&order=created_at.desc&limit=20" },
  suppliers: { path: "suppliers?select=id,name,contact_name,phone,email,address,note,created_at,updated_at,row_version&order=name.asc" },
  customers: { path: "customers?select=id,customer_code,customer_category,name,phone,email,address,note,created_at,updated_at,row_version&order=customer_code.asc" },
  contract_service_types: { path: "contract_service_types?select=id,code,name,sort_order,is_active,created_at,updated_at&order=sort_order.asc,name.asc" },
  customer_contract_services: { path: "customer_contract_services?select=customer_id,service_type_id,created_at&order=created_at.asc" },
  customer_contacts: { path: "customer_contacts?select=id,customer_id,name,title,phone,email,is_primary,note,created_at,updated_at,row_version&order=is_primary.desc,name.asc" },
  construction_details: { path: "construction_details?select=project_id,scope,planned_start_on,planned_end_on,actual_start_on,actual_end_on,acceptance_on,acceptance_note" },
  maintenance_details: { path: "maintenance_details?select=project_id,reported_at,scheduled_at,arrived_at,issue_description,resolution,warranty_status" },
  project_costs: { path: "project_costs?select=id,project_id,cost_type,amount,occurred_on,note&order=occurred_on.desc" },
  accounts: { path: "app_users?select=id,username,display_name,role,is_active,row_version,created_at,updated_at&order=username.asc", adminOnly: true },
  categories: { path: "product_categories?select=id,name,code_prefix,is_active,row_version,created_at,updated_at&order=name.asc" },
  sites: { path: "sites?select=id,site_code,site_name,customer_id,project_id,contract_service_type_id,contact_id,address,phone,status,notes,row_version,created_at,updated_at&order=site_code.asc" },
  site_floors: { path: "site_floors?select=*&order=site_id.asc,sort_order.asc,floor_code.asc" },
  site_locations: { path: "site_locations?select=*&order=site_id.asc,location_name.asc" },
  site_devices: { path: "site_devices?select=*&order=site_id.asc,device_no.asc" },
  site_routes: { path: "site_routes?select=*&order=site_id.asc,route_no.asc" },
  site_route_segments: { path: "site_route_segments?select=*&order=route_id.asc,sequence_no.asc" },
  site_work_logs: { path: "site_work_logs?select=*&order=log_date.desc,created_at.desc" },
  site_work_log_workers: { path: "site_work_log_workers?select=work_log_id,user_id,created_at&order=created_at.asc" },
  site_workers: { path: "app_users?select=id,display_name,is_active&order=display_name.asc" },
  site_notes: { path: "site_notes?select=*&order=importance.desc,created_at.desc" },
  site_assets: { path: "site_assets?select=*&order=created_at.desc" }
};
const scopes: Record<string, string[]> = {
  dashboard: ["customers", "projects", "items", "pickups", "receipts", "adjustments", "categories"],
  transactions: ["customers", "projects", "items", "pickups", "receipts", "suppliers", "categories"],
  inventory: ["items", "pickups", "receipts", "adjustments", "suppliers", "categories"],
  crm: ["customers", "contract_service_types", "customer_contract_services", "projects", "suppliers"],
  sites: ["customers", "contract_service_types", "customer_contract_services", "projects", "items", "categories", "pickups", "sites", "site_floors", "site_devices", "site_routes", "site_work_logs", "site_work_log_workers", "site_workers", "site_notes", "site_assets", "maintenance_details"],
  materials: ["customers", "projects", "items", "pickups"],
  settings: ["accounts", "audit_logs"],
  backup: Object.keys(datasets)
};
async function scopedSnapshot(user: AppUser, scopeName: string) {
  const names = scopes[scopeName];
  if (!names) throw new Error("不支援的資料載入範圍。");
  const requests = names.map(async name => {
    const definition = datasets[name];
    if (definition.adminOnly && user.role !== "admin") return [name, []] as const;
    return [name, await get(definition.path)] as const;
  });
  const settled = await Promise.allSettled(requests);
  const result: Row = { scope: scopeName, current_user: publicUser(user), refreshed_at: new Date().toISOString(), errors: [] };
  const errors: Row[] = [];
  settled.forEach((entry, index) => {
    const name = names[index];
    if (entry.status === "fulfilled") result[entry.value[0]] = entry.value[1];
    else errors.push({ dataset: name, message: entry.reason instanceof Error ? entry.reason.message : "資料載入失敗。" });
  });
  result.errors = errors;
  return result;
}

const queryDefinitions: Record<string, { table: string; select: string; search: string[]; sort: Record<string,string> }> = {
  inventory: { table: "inventory_items", select: "id,inventory_code,category_id,model,brand,item_name,item_type,unit,opening_quantity,cost_price,sale_price,inventory_status,default_supplier_id,note,created_at,updated_at,row_version", search: ["inventory_code","item_name","brand","model","item_type"], sort: { code:"inventory_code", name:"item_name", type:"item_type", date:"created_at" } },
  customers: { table: "customers", select: "id,customer_code,customer_category,name,phone,email,address,note,created_at,updated_at,row_version", search: ["customer_code","customer_category","name","phone","email","address"], sort: { code:"customer_code", category:"customer_category", name:"name", date:"created_at" } },
  projects: { table: "projects", select: "id,name,project_code,customer_id,project_type,status,assigned_to,description,estimated_cost,note,created_at,updated_at,row_version", search: ["project_code","name","assigned_to","status"], sort: { code:"project_code", name:"name", status:"status", date:"created_at" } },
  suppliers: { table: "suppliers", select: "id,name,contact_name,phone,email,address,note,created_at,updated_at,row_version", search: ["name","contact_name","phone","email","address"], sort: { name:"name", date:"created_at" } },
  pickups: { table: "pickup_records", select: "id,pickup_date,project_id,inventory_item_id,quantity,row_version,created_at,updated_at,created_by_username,work_log_id,request_id,request_row", search: ["pickup_date","created_by_username"], sort: { date:"pickup_date", created:"created_at" } },
  receipts: { table: "stock_receipts", select: "id,receipt_date,inventory_item_id,quantity,supplier_id,supplier,note,row_version,created_at,updated_at", search: ["receipt_date","supplier","note"], sort: { date:"receipt_date", supplier:"supplier", created:"created_at" } },
  sites: { table: "sites", select: "id,site_code,site_name,customer_id,project_id,contract_service_type_id,contact_id,address,phone,status,notes,row_version,created_at,updated_at", search: ["site_code","site_name","address","phone","status"], sort: { code:"site_code", name:"site_name", status:"status", date:"created_at" } }
};
async function queryRecords(params: URLSearchParams) {
  const definition = queryDefinitions[text(params.get("entity"))];
  if (!definition) throw new Error("不支援的查詢資料類型。");
  const sortField = definition.sort[text(params.get("sort"))] ?? Object.values(definition.sort)[0];
  const direction = params.get("direction") === "desc" ? "desc" : "asc";
  const term = text(params.get("search")).replace(/[,*()]/g, " ").slice(0,80);
  const limit = Math.min(Math.max(Number(params.get("limit")) || 200,1),500);
  let path = `${definition.table}?select=${definition.select}&order=${sortField}.${direction}&limit=${limit}`;
  const customerId = uuid(params.get("customer_id"));
  if (customerId && definition.table === "projects") path += `&customer_id=eq.${customerId}`;
  if (term) path += `&or=(${definition.search.map(field=>`${field}.ilike.*${encodeURIComponent(term)}*`).join(",")})`;
  return { records: await get(path), entity: params.get("entity"), sort: params.get("sort"), direction };
}
async function createAccount(payload: Row, actor: AppUser, firstAdmin = false) {
  const name = username(payload.username), displayName = limited(payload.display_name,80), userRole = role(payload.role), pass = password(payload.password);
  if (!name || !displayName || !userRole || !pass) throw new Error("請輸入帳號、名稱、角色與至少 12 碼的密碼。");
  if (typeof payload.password_confirmation === "string" && payload.password !== payload.password_confirmation) throw new Error("兩次輸入的密碼不一致。");
  if (!firstAdmin) requireRole(actor, ["admin"]);
  if (firstAdmin && userRole !== "admin") throw new Error("首位帳號必須為管理者。");
  const existing = await get(`app_users?username=eq.${encodeURIComponent(name)}&select=id`) as Row[];
  if (existing.length) throw new Error("此帳號名稱已被使用。");
  const auth = await authApi("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email: internalEmail(name), password: pass, email_confirm: true }) });
  const created = await auth.json().catch(() => ({})) as { id?: string; user?: { id?: string }; message?: string };
  const authUserId = uuid(created.id ?? created.user?.id);
  if (!auth.ok || !authUserId) throw new Error(created.message || "建立登入帳號失敗。");
  try {
    const rows = await insert("app_users", { auth_user_id: authUserId, username: name, display_name: displayName, role: userRole, is_active: true, created_by: firstAdmin ? null : actor.id }) as AppUser[];
    const profile = rows[0];
    await insert("audit_logs", { entity_type: "app_user", entity_id: profile.id, action: "insert", after_data: { username: name, display_name: displayName, role: userRole }, source: "web", actor: firstAdmin ? name : actor.display_name });
  } catch (error) {
    await authApi(`/auth/v1/admin/users/${authUserId}`, { method: "DELETE" });
    throw error;
  }
}
async function login(payload: Row) {
  const name = username(payload.username), pass = typeof payload.password === "string" ? payload.password : "";
  if (!name || !pass) throw new Error("請輸入帳號與密碼。");
  const profiles = await get(`app_users?username=eq.${encodeURIComponent(name)}&is_active=eq.true&select=id,auth_user_id,username,display_name,role,is_active,row_version`) as AppUser[];
  if (profiles.length !== 1) throw new Error("帳號或密碼錯誤。");
  const response = await timedFetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" }, body: JSON.stringify({ email: internalEmail(name), password: pass }) }, "帳號登入");
  const session = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_at?: number };
  if (!response.ok || !session.access_token) throw new Error("帳號或密碼錯誤。");
  return { session: { access_token: session.access_token, refresh_token: session.refresh_token ?? null, expires_at: session.expires_at ?? null }, user: profiles[0] };
}
async function updateAccount(payload: Row, actor: AppUser) {
  requireRole(actor, ["admin"]);
  const id = uuid(payload.id), name = username(payload.username), displayName = limited(payload.display_name,80), userRole = role(payload.role), version = Number(payload.row_version), active = typeof payload.is_active === "boolean" ? payload.is_active : null;
  if (!id || !name || !displayName || !userRole || active === null || !Number.isInteger(version) || version < 1) throw new Error("帳號資料不完整。");
  const profiles = await get(`app_users?id=eq.${id}&select=id,auth_user_id,username,display_name,role,is_active,row_version`) as AppUser[];
  if (profiles.length !== 1) throw new Error("找不到帳號資料。");
  const target = profiles[0];
  if (target.id === actor.id && (!active || userRole !== "admin")) throw new Error("不可移除目前登入管理者的最高權限。");
  if (target.role === "admin" && target.is_active && (!active || userRole !== "admin")) {
    const admins = await get("app_users?role=eq.admin&is_active=eq.true&select=id") as Row[];
    if (admins.length <= 1) throw new Error("系統至少必須保留一位啟用中的管理者。");
  }
  if (name !== target.username) {
    const duplicates = await get(`app_users?username=eq.${encodeURIComponent(name)}&id=neq.${id}&select=id`) as Row[];
    if (duplicates.length) throw new Error("此帳號名稱已被使用。");
  }
  const passwordRequested = payload.password !== "" && payload.password !== undefined;
  const maybePassword = passwordRequested ? password(payload.password) : null;
  if (passwordRequested && !maybePassword) throw new Error("新密碼至少需 12 碼。");
  if (passwordRequested && payload.password !== payload.password_confirmation) throw new Error("兩次輸入的新密碼不一致。");
  const response = await db(`app_users?id=eq.${id}&row_version=eq.${version}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ username: name, display_name: displayName, role: userRole, is_active: active }) });
  const rows = response.ok ? await response.json() as AppUser[] : [];
  if (rows.length !== 1) throw new Error("帳號已被其他管理者更新，請重新載入後再修改。");
  if (name !== target.username || maybePassword) {
    const authPatch: Row = {};
    if (name !== target.username) { authPatch.email = internalEmail(name); authPatch.email_confirm = true; }
    if (maybePassword) authPatch.password = maybePassword;
    const changed = await authApi(`/auth/v1/admin/users/${target.auth_user_id}`, { method: "PUT", body: JSON.stringify(authPatch) });
    if (!changed.ok) {
      await db(`app_users?id=eq.${id}&row_version=eq.${rows[0].row_version}`, { method: "PATCH", body: JSON.stringify({ username: target.username, display_name: target.display_name, role: target.role, is_active: target.is_active }) });
      throw new Error("登入帳號或密碼更新失敗，使用者資料已回復原值。");
    }
  }
  await insert("audit_logs", { entity_type: "app_user", entity_id: target.id, action: "update", before_data: { username: target.username, display_name: target.display_name, role: target.role, is_active: target.is_active }, after_data: { username: name, display_name: displayName, role: userRole, is_active: active, password_changed: !!maybePassword }, source: "web", actor: actor.display_name });
}
async function deleteAccount(payload: Row, actor: AppUser) {
  requireRole(actor, ["admin"]);
  const id = uuid(payload.id);
  if (!id) throw new Error("帳號資料不正確。");
  if (id === actor.id) throw new Error("不可刪除目前登入的管理者帳號。");
  const profiles = await get(`app_users?id=eq.${id}&select=id,auth_user_id,username,display_name,role,is_active,row_version`) as AppUser[];
  if (profiles.length !== 1) throw new Error("找不到帳號資料。");
  const target = profiles[0];
  if (target.role === "admin" && target.is_active) {
    const admins = await get("app_users?role=eq.admin&is_active=eq.true&select=id") as Row[];
    if (admins.length <= 1) throw new Error("系統至少必須保留一位啟用中的管理者。");
  }
  await insert("audit_logs", { entity_type: "app_user", entity_id: target.id, action: "delete", before_data: { username: target.username, display_name: target.display_name, role: target.role }, source: "web", actor: actor.display_name });
  const response = await authApi(`/auth/v1/admin/users/${target.auth_user_id}`, { method: "DELETE" });
  if (!response.ok) throw new Error("刪除帳號失敗。");
}
async function change(operation: string, payload: Row, user: AppUser | null) {
  const actor = user?.username || "site-owner";
  const meta = { source: "web", updated_by: actor };
  if (operation === "create_project") { requireRole(user,["admin","operator"]); const name = limited(payload.name,120); if (!name) throw new Error("請輸入 1 至 120 個字的專案名稱。"); return insert("projects", {name,...meta}); }
  if (operation === "create_supplier") { requireRole(user,["admin"]); const name=limited(payload.name,160),contact_name=nullable(payload.contact_name,120),phone=nullable(payload.phone,50),email=optionalEmail(payload.email),address=nullable(payload.address,500),note=nullable(payload.note,1000); if(!name||contact_name===null||phone===null||email===null||address===null||note===null) throw new Error("請完整填寫有效的供應商資料。"); return insert("suppliers",{name,contact_name:contact_name||null,phone:phone||null,email:email||null,address:address||null,note:note||null,...meta}); }
  if (operation === "update_supplier") { requireRole(user,["admin"]); const id=uuid(payload.id),rowVersion=Number(payload.row_version),name=limited(payload.name,160),contact_name=nullable(payload.contact_name,120),phone=nullable(payload.phone,50),email=optionalEmail(payload.email),address=nullable(payload.address,500),note=nullable(payload.note,1000); if(!id||!Number.isInteger(rowVersion)||rowVersion<1||!name||contact_name===null||phone===null||email===null||address===null||note===null) throw new Error("請完整填寫有效的供應商資料。"); return updateVersioned("suppliers",id,rowVersion,{name,contact_name:contact_name||null,phone:phone||null,email:email||null,address:address||null,note:note||null,...meta},"供應商資料已被其他使用者更新，請重新載入後再修改。"); }
  if (operation === "delete_supplier") { requireRole(user,["admin"]); const id=uuid(payload.id),rowVersion=Number(payload.row_version); if(!id||!Number.isInteger(rowVersion)||rowVersion<1) throw new Error("供應商資料或版本不正確。"); return rpc("delete_supplier_record",{p_id:id,p_row_version:rowVersion,p_actor:actor}); }
  if (operation === "create_customer") { requireRole(user,["admin"]); const category=customerCategory(payload.customer_category),name=limited(payload.name,160),phone=nullable(payload.phone,50),email=optionalEmail(payload.email),address=nullable(payload.address,500),note=nullable(payload.note,1000),service_codes=Array.isArray(payload.contract_service_codes)?payload.contract_service_codes.map(text):[]; if(!category||!name||phone===null||email===null||address===null||note===null||service_codes.some(code=>!/^[a-z0-9_]{2,64}$/.test(code))||new Set(service_codes).size!==service_codes.length) throw new Error("請完整填寫客戶分類、承攬內容及有效的客戶資料。"); return rpc("create_customer_with_contracts_v1",{p_customer_category:category,p_name:name,p_phone:phone||null,p_email:email||null,p_address:address||null,p_note:note||null,p_service_codes:service_codes,p_actor:actor}); }
  if (operation === "update_customer") { requireRole(user,["admin"]); const id=uuid(payload.id),rowVersion=Number(payload.row_version),category=customerCategory(payload.customer_category),name=limited(payload.name,160),phone=nullable(payload.phone,50),email=optionalEmail(payload.email),address=nullable(payload.address,500),note=nullable(payload.note,1000),service_codes=Array.isArray(payload.contract_service_codes)?payload.contract_service_codes.map(text):[]; if(!id||!Number.isInteger(rowVersion)||rowVersion<1||!category||!name||phone===null||email===null||address===null||note===null||service_codes.some(code=>!/^[a-z0-9_]{2,64}$/.test(code))||new Set(service_codes).size!==service_codes.length) throw new Error("請完整填寫客戶分類、承攬內容及有效的客戶資料。"); return rpc("update_customer_with_contracts_v1",{p_id:id,p_row_version:rowVersion,p_customer_category:category,p_name:name,p_phone:phone||null,p_email:email||null,p_address:address||null,p_note:note||null,p_service_codes:service_codes,p_actor:actor}); }
  if (operation === "delete_customer") { requireRole(user,["admin"]); const id=uuid(payload.id),rowVersion=Number(payload.row_version); if(!id||!Number.isInteger(rowVersion)||rowVersion<1) throw new Error("客戶資料或版本不正確。"); return rpc("delete_customer_record",{p_id:id,p_row_version:rowVersion,p_actor:actor}); }
  if (operation === "create_customer_contact") { requireRole(user,["admin"]); const customer_id=uuid(payload.customer_id),name=limited(payload.name,120),title=nullable(payload.title,120),phone=nullable(payload.phone,50),email=optionalEmail(payload.email),note=nullable(payload.note,500); if(!customer_id||!name||title===null||phone===null||email===null||note===null) throw new Error("請完整填寫有效的聯絡人資料。"); return insert("customer_contacts",{customer_id,name,title:title||null,phone:phone||null,email:email||null,note:note||null,is_primary:!!payload.is_primary,...meta}); }
  if (operation === "create_erp_project") { requireRole(user,["admin","operator"]); const name=limited(payload.name,120),customer_id=uuid(payload.customer_id),project_type=text(payload.project_type),status=limited(payload.status,40),assigned_to=nullable(payload.assigned_to,120),description=nullable(payload.description,2000),note=nullable(payload.note,1000),estimated_cost=payload.estimated_cost === "" ? null : nonNegative(payload.estimated_cost); if(!name||!customer_id||!["construction","maintenance"].includes(project_type)||!status||assigned_to===null||description===null||note===null||estimated_cost===undefined) throw new Error("請完整填寫專案資料。"); return rpc("create_project_auto_number_v1",{p_name:name,p_customer_id:customer_id,p_project_type:project_type,p_status:status,p_assigned_to:assigned_to||null,p_description:description||null,p_estimated_cost:estimated_cost,p_note:note||null,p_actor:actor}); }
  if (operation === "update_erp_project") { requireRole(user,["admin","operator"]); const id=uuid(payload.id),rowVersion=Number(payload.row_version),name=limited(payload.name,120),customer_id=uuid(payload.customer_id),project_type=text(payload.project_type),status=limited(payload.status,40),assigned_to=nullable(payload.assigned_to,120),description=nullable(payload.description,2000),note=nullable(payload.note,1000),estimated_cost=payload.estimated_cost === "" ? null : nonNegative(payload.estimated_cost); if(!id||!Number.isInteger(rowVersion)||rowVersion<1||!name||!customer_id||!["construction","maintenance"].includes(project_type)||!status||assigned_to===null||description===null||note===null||estimated_cost===undefined) throw new Error("請完整填寫專案資料。"); return updateVersioned("projects",id,rowVersion,{name,customer_id,project_type,status,assigned_to:assigned_to||null,description:description||null,note:note||null,estimated_cost,...meta},"專案資料已被其他使用者更新，請重新載入後再修改。"); }
  if (operation === "delete_erp_project") { requireRole(user,["admin","operator"]); const id=uuid(payload.id),rowVersion=Number(payload.row_version); if(!id||!Number.isInteger(rowVersion)||rowVersion<1) throw new Error("專案資料或版本不正確。"); return rpc("delete_project_record",{p_id:id,p_row_version:rowVersion,p_actor:actor}); }
  if (operation === "bulk_update_inventory_items") { requireRole(user,["admin"]); const ids=Array.isArray(payload.item_ids) ? payload.item_ids.map(uuid) : []; const patch=payload.patch; if(!ids.length||ids.some(id=>!id)||!patch||typeof patch!=="object"||Array.isArray(patch)) throw new Error("請選擇商品並填寫有效的批次修改內容。"); return rpc("apply_inventory_bulk_update_v2",{p_item_ids:ids,p_patch:patch,p_actor:actor}); }
  if (operation === "create_product_category") { requireRole(user,["admin"]); const name=limited(payload.name,80); if(!name) throw new Error("請輸入貨品種類名稱。"); return rpc("create_product_category_v1",{p_name:name,p_actor:actor}); }
  if (operation === "create_inventory_item") { requireRole(user,["admin"]); const category_id=uuid(payload.category_id),brand=limited(payload.brand,120),item_name=limited(payload.item_name,200),unit=limited(payload.unit,30),model=nullable(payload.model,120),opening_quantity=nonNegative(payload.opening_quantity); if (!category_id||!brand||!item_name||!unit||model===null||opening_quantity===null) throw new Error("請完整填寫品項資料，期初庫存不可小於 0。"); return rpc("create_inventory_item_auto_number_v1",{p_category_id:category_id,p_model:model||null,p_brand:brand,p_item_name:item_name,p_unit:unit,p_opening_quantity:opening_quantity,p_actor:actor}); }
  if (operation === "create_inventory_item_batch") { requireRole(user,["admin"]); if(!Array.isArray(payload.rows)||payload.rows.length<1||payload.rows.length>20) throw new Error("每次必須建立 1 至 20 筆品項。"); const rows=payload.rows.map((value,index)=>{ if(!value||typeof value!=="object"||Array.isArray(value)) throw new Error(`第 ${index+1} 筆品項格式不正確。`); const row=value as Row,category_id=uuid(row.category_id),brand=limited(row.brand,120),item_name=limited(row.item_name,200),unit=limited(row.unit,30),model=nullable(row.model,120),opening_quantity=nonNegative(row.opening_quantity); if(!category_id||!brand||!item_name||!unit||model===null||opening_quantity===null||!Number.isInteger(opening_quantity)) throw new Error(`第 ${index+1} 筆品項資料不完整，期初庫存須為 0 以上整數。`); return {category_id,brand,item_name,unit,model:model||null,opening_quantity}; }); const keys=rows.map(row=>[row.category_id,row.item_name,row.brand,row.model||""].map(value=>String(value).trim().toLocaleLowerCase("zh-Hant")).join("|")); if(new Set(keys).size!==keys.length) throw new Error("同一批次中有重複品項，請檢查種類、名稱、品牌與型號。"); return rpc("create_inventory_items_batch_v1",{p_rows:rows,p_actor:actor}); }
  if (operation === "update_inventory_item") { requireRole(user,["admin"]); const id=uuid(payload.id),category_id=uuid(payload.category_id),item_name=limited(payload.item_name,200),brand=limited(payload.brand,120),model=nullable(payload.model,120),unit=limited(payload.unit,30),opening_quantity=nonNegative(payload.opening_quantity),row_version=Number(payload.row_version); if (!id||!category_id||!item_name||!brand||model===null||!unit||opening_quantity===null||!Number.isInteger(opening_quantity)||!Number.isInteger(row_version)||row_version<1) throw new Error("請完整填寫品項資料，期初庫存須為 0 以上整數。"); const categories=await get(`product_categories?id=eq.${category_id}&is_active=eq.true&select=id,name`) as {id:string;name:string}[]; if(categories.length!==1) throw new Error("請選擇有效的貨品種類。"); const response=await db(`inventory_items?id=eq.${id}&row_version=eq.${row_version}`,{method:"PATCH",headers:{Prefer:"return=representation"},body:JSON.stringify({item_name,category_id,item_type:categories[0].name,brand,model:model||null,unit,opening_quantity,...meta})}); if (!response.ok) { const failure=await response.json().catch(()=>({})) as {code?:string}; if(failure.code==="23505") throw new Error("相同種類、名稱、品牌與型號的品項已存在。"); throw new Error("品項更新失敗。"); } const rows=await response.json(); if (!Array.isArray(rows)||rows.length!==1) throw new Error("此品項已被其他管理者更新，請重新載入後再編輯。"); return; }
  if (operation === "delete_inventory_item") { requireRole(user,["admin"]); const id=uuid(payload.id),row_version=Number(payload.row_version); if(!id||!Number.isInteger(row_version)||row_version<1) throw new Error("品項資料或版本不正確。"); return rpc("delete_inventory_item",{p_id:id,p_row_version:row_version,p_actor:actor}); }
  if (operation === "create_pickup") { requireRole(user,["admin","operator"]); const pickup_date=date(payload.pickup_date),project_id=uuid(payload.project_id),inventory_item_id=uuid(payload.inventory_item_id),quantity=positive(payload.quantity); if(!pickup_date||!project_id||!inventory_item_id||quantity===null) throw new Error("請填寫完整的取貨資料。"); return rpc("create_pickup_record_v2",{p_pickup_date:pickup_date,p_project_id:project_id,p_inventory_item_id:inventory_item_id,p_quantity:quantity,p_created_by_user_id:user!.id,p_created_by_username:user!.username,p_actor:actor}); }
  if (operation === "create_pickup_batch") {
    requireRole(user,["admin","operator"]);
    if(!Array.isArray(payload.rows)||payload.rows.length<1||payload.rows.length>20) throw new Error("每次必須登錄 1 至 20 筆取貨資料。");
    const work_log_id=text(payload.work_log_id)?uuid(payload.work_log_id):null,request_id=text(payload.request_id)?uuid(payload.request_id):null;
    if((text(payload.work_log_id)&&!work_log_id)||(text(payload.request_id)&&!request_id)||work_log_id&&!request_id) throw new Error("工作日誌取貨的關聯或防重複識別碼不正確。");
    const rows=payload.rows.map((value,index)=>{
      if(!value||typeof value!=="object"||Array.isArray(value)) throw new Error(`第 ${index+1} 筆取貨資料格式不正確。`);
      const row=value as Row,customer_id=uuid(row.customer_id),pickup_date=date(row.pickup_date),project_id=uuid(row.project_id),inventory_item_id=uuid(row.inventory_item_id),quantity=positive(row.quantity);
      if(!customer_id||!pickup_date||!project_id||!inventory_item_id||quantity===null||!Number.isInteger(quantity)) throw new Error(`第 ${index+1} 筆取貨資料不完整，數量須為正整數。`);
      return {customer_id,pickup_date,project_id,inventory_item_id,quantity};
    });
    const duplicateKeys=rows.map(row=>`${row.pickup_date}|${row.project_id}|${row.inventory_item_id}`); if(new Set(duplicateKeys).size!==duplicateKeys.length) throw new Error("同一批取貨有重複列，請合併數量。");
    const relations = [...new Map(rows.map(row=>[row.project_id,row.customer_id])).entries()];
    for (const [projectId,customerId] of relations) {
      const matched = await get(`projects?id=eq.${projectId}&customer_id=eq.${customerId}&select=id`) as Row[];
      if (matched.length !== 1) throw new Error("取貨專案與客戶不相符，請重新選擇。");
    }
    return rpc("create_pickup_records_batch_v2",{p_rows:rows.map(({customer_id:_,...row})=>row),p_created_by_user_id:user!.id,p_created_by_username:user!.username,p_work_log_id:work_log_id,p_request_id:request_id,p_actor:actor});
  }
  if (operation === "update_pickup") { requireRole(user,["admin","operator"]); const id=uuid(payload.id),row_version=Number(payload.row_version),pickup_date=date(payload.pickup_date),project_id=uuid(payload.project_id),inventory_item_id=uuid(payload.inventory_item_id),quantity=positive(payload.quantity); if(!id||!Number.isInteger(row_version)||row_version<1||!pickup_date||!project_id||!inventory_item_id||quantity===null) throw new Error("請填寫完整的取貨資料。"); return rpc("update_pickup_record",{p_id:id,p_row_version:row_version,p_pickup_date:pickup_date,p_project_id:project_id,p_inventory_item_id:inventory_item_id,p_quantity:quantity,p_actor:actor}); }
  if (operation === "delete_pickups") { requireRole(user,["admin"]); const ids=Array.isArray(payload.ids)?payload.ids.map(uuid):[]; if(!ids.length||ids.some(id=>!id)) throw new Error("請選擇有效的取貨紀錄。"); return rpc("delete_pickup_records",{p_ids:ids,p_actor:actor}); }
  if (operation === "create_stock_receipt_batch") { requireRole(user,["admin","operator"]); if(!Array.isArray(payload.rows)||payload.rows.length<1||payload.rows.length>20) throw new Error("每次必須登錄 1 至 20 筆進貨資料。"); const rows=payload.rows.map((value,index)=>{ if(!value||typeof value!=="object"||Array.isArray(value)) throw new Error(`第 ${index+1} 筆進貨資料格式不正確。`); const row=value as Row,receipt_date=date(row.receipt_date),inventory_item_id=uuid(row.inventory_item_id),quantity=positive(row.quantity),supplier_id=uuid(row.supplier_id),note=nullable(row.note,500); if(!receipt_date||!inventory_item_id||quantity===null||!Number.isInteger(quantity)||!supplier_id||note===null) throw new Error(`第 ${index+1} 筆進貨資料不完整，數量須為正整數。`); return {receipt_date,inventory_item_id,quantity,supplier_id,note:note||null}; }); const duplicateKeys=rows.map(row=>`${row.receipt_date}|${row.supplier_id}|${row.inventory_item_id}|${text(row.note).toLocaleLowerCase("zh-Hant")}`); if(new Set(duplicateKeys).size!==duplicateKeys.length) throw new Error("同一批進貨有重複列，請合併數量。"); return rpc("create_stock_receipt_records_batch_v2",{p_rows:rows,p_actor:actor}); }
  if (operation === "update_stock_receipt") { requireRole(user,["admin","operator"]); const id=uuid(payload.id),row_version=Number(payload.row_version),receipt_date=date(payload.receipt_date),inventory_item_id=uuid(payload.inventory_item_id),quantity=positive(payload.quantity),supplier_id=uuid(payload.supplier_id),note=nullable(payload.note,500); if(!id||!Number.isInteger(row_version)||row_version<1||!receipt_date||!inventory_item_id||quantity===null||!supplier_id||note===null) throw new Error("請填寫完整的進貨入庫資料。"); return rpc("update_stock_receipt_record_v2",{p_id:id,p_row_version:row_version,p_receipt_date:receipt_date,p_inventory_item_id:inventory_item_id,p_quantity:quantity,p_supplier_id:supplier_id,p_note:note||null,p_actor:actor}); }
  if (operation === "delete_stock_receipts") { requireRole(user,["admin"]); const ids=Array.isArray(payload.ids)?payload.ids.map(uuid):[]; if(!ids.length||ids.some(id=>!id)) throw new Error("請選擇有效的進貨紀錄。"); return rpc("delete_stock_receipt_records",{p_ids:ids,p_actor:actor}); }
  if (operation === "create_stock_adjustment") { requireRole(user,["admin"]); const inventory_item_id=uuid(payload.inventory_item_id),after_quantity=nonNegative(payload.after_quantity),reason=nullable(payload.reason,500),idempotency_key=uuid(payload.idempotency_key); if(!inventory_item_id||after_quantity===null||reason===null||!idempotency_key) throw new Error("請選擇品項並輸入 0 或正數的校正後庫存。"); return rpc("apply_stock_adjustment",{p_inventory_item_id:inventory_item_id,p_after_quantity:after_quantity,p_reason:reason||null,p_idempotency_key:idempotency_key,p_actor:actor}); }
  if (operation === "create_site") { requireRole(user,["admin","operator"]); const site_name=limited(payload.site_name,160),customer_id=uuid(payload.customer_id),project_id=text(payload.project_id)?uuid(payload.project_id):null,contact_id=text(payload.contact_id)?uuid(payload.contact_id):null,address=nullable(payload.address,500),phone=nullable(payload.phone,50),status=text(payload.status),notes=nullable(payload.notes,1000); if(!site_name||!customer_id||address===null||phone===null||notes===null||!["active","inactive","closed"].includes(status)) throw new Error("請完整填寫有效的案場資料。"); return rpc("create_site_auto_number_v1",{p_site_name:site_name,p_customer_id:customer_id,p_project_id:project_id,p_contact_id:contact_id,p_address:address||null,p_phone:phone||null,p_status:status,p_notes:notes||null,p_actor:actor}); }
  if (operation === "update_site") { requireRole(user,["admin","operator"]); const id=uuid(payload.id),rowVersion=Number(payload.row_version),site_name=limited(payload.site_name,160),customer_id=uuid(payload.customer_id),project_id=text(payload.project_id)?uuid(payload.project_id):null,contact_id=text(payload.contact_id)?uuid(payload.contact_id):null,address=nullable(payload.address,500),phone=nullable(payload.phone,50),status=text(payload.status),notes=nullable(payload.notes,1000); if(!id||!Number.isInteger(rowVersion)||rowVersion<1||!site_name||!customer_id||address===null||phone===null||notes===null||!["active","inactive","closed"].includes(status)) throw new Error("請完整填寫有效的案場資料。"); if(project_id){const rows=await get(`projects?id=eq.${project_id}&customer_id=eq.${customer_id}&select=id`) as Row[];if(rows.length!==1)throw new Error("所選專案不屬於此客戶。");} if(contact_id){const rows=await get(`customer_contacts?id=eq.${contact_id}&customer_id=eq.${customer_id}&select=id`) as Row[];if(rows.length!==1)throw new Error("所選聯絡人不屬於此客戶。");} return updateVersioned("sites",id,rowVersion,{site_name,customer_id,project_id,contact_id,address:address||null,phone:phone||null,status,notes:notes||null,...meta},"案場資料已被其他使用者更新，請重新載入後再修改。"); }
  if (operation === "delete_site") { requireRole(user,["admin"]); const id=uuid(payload.id),rowVersion=Number(payload.row_version); if(!id||!Number.isInteger(rowVersion)||rowVersion<1) throw new Error("案場資料或版本不正確。"); return rpc("delete_site_record_v1",{p_id:id,p_row_version:rowVersion,p_actor:actor}); }
  if (operation === "upsert_customer_project_work_log") {
    requireRole(user,["admin","operator"]);
    const id=text(payload.id)?uuid(payload.id):null,rowVersion=text(payload.id)?Number(payload.row_version):null,project_id=text(payload.project_id)?uuid(payload.project_id):null,customer_id=uuid(payload.customer_id),project_name=limited(payload.project_name,120),log_date=date(payload.log_date),work_type=text(payload.work_type),summary=nullable(payload.summary,2000),worker_user_ids=Array.isArray(payload.worker_user_ids)?payload.worker_user_ids.map(uuid):[];
    if((text(payload.id)&&!id)||(id&&(!Number.isInteger(rowVersion)||Number(rowVersion)<1))||(text(payload.project_id)&&!project_id)||!customer_id||!project_name||!log_date||!["工程施工","維修紀錄","維護保養"].includes(work_type)||summary===null||worker_user_ids.some(workerId=>!workerId)||new Set(worker_user_ids).size!==worker_user_ids.length||worker_user_ids.length>30) throw new Error("請完整填寫工作日誌、工作類型與有效的施工人員。");
    return rpc("upsert_customer_project_work_log_v2",{p_id:id,p_row_version:rowVersion,p_project_id:project_id,p_customer_id:customer_id,p_project_name:project_name,p_log_date:log_date,p_work_type:work_type,p_summary:summary||null,p_worker_user_ids:worker_user_ids,p_reporter_user_id:user!.id,p_actor:actor});
  }
  if (operation === "delete_standalone_work_log") {
    requireRole(user,["admin"]);
    const id=uuid(payload.id),rowVersion=Number(payload.row_version);
    if(!id||!Number.isInteger(rowVersion)||rowVersion<1) throw new Error("工作日誌資料或版本不正確。");
    return deleteVersioned("site_work_logs",id,rowVersion);
  }
  if (operation === "upsert_contract_site_entry") {
    requireRole(user,["admin","operator"]);
    const module=text(payload.module),customer_id=uuid(payload.customer_id),service_type_id=uuid(payload.contract_service_type_id),id=text(payload.id)?uuid(payload.id):null,rowVersion=Number(payload.row_version),values=payload.values&&typeof payload.values==="object"&&!Array.isArray(payload.values)?payload.values as Row:null;
    if(!customer_id||!service_type_id||!values||(text(payload.id)&&!id)||(id&&(!Number.isInteger(rowVersion)||rowVersion<1))) throw new Error("案場承攬明細資料不完整。");
    const site=await ensureContractSite(customer_id,service_type_id,actor);
    const save=(table:string,row:Row)=>id?updateSiteDetail(table,id,rowVersion,site.id,{...row,...meta}):insert(table,{site_id:site.id,...row,...meta});
    if(module==="floors"){
      const floor_code=limited(values.floor_code,20),floor_name=limited(values.floor_name,80),description=nullable(values.description,500),sort_order=text(values.sort_order)?Number(values.sort_order):0;
      if(!floor_code||!floor_name||description===null||!Number.isInteger(sort_order))throw new Error("請完整填寫樓層資料。");
      return save("site_floors",{floor_code,floor_name,description:description||null,sort_order});
    }
    if(module==="routes"){
      const route_no=limited(values.route_no,80),from_location=limited(values.from_location,160),to_location=limited(values.to_location,160),route_description=nullable(values.route_description,2000),cable_type=nullable(values.cable_type,120);
      if(!route_no||!from_location||!to_location||route_description===null||cable_type===null)throw new Error("請完整填寫走線資料。");
      return save("site_routes",{route_no,from_location,to_location,route_description:route_description||null,cable_type:cable_type||null});
    }
    if(module==="devices"){
      const device_no=limited(values.device_no,80),device_name=limited(values.device_name,160),inventory_item_id=text(values.inventory_item_id)?uuid(values.inventory_item_id):null,status=text(values.status)||"planned",notes=nullable(values.notes,1000);
      if(!device_no||!device_name||(text(values.inventory_item_id)&&!inventory_item_id)||!["planned","installed","tested"].includes(status)||notes===null)throw new Error("請完整填寫設備點位資料。");
      return save("site_devices",{project_id:null,inventory_item_id,device_no,device_name,status,notes:notes||null});
    }
    if(module==="notes"){
      const note_type=limited(values.note_type,80),title=limited(values.title,160),content=limited(values.content,4000),importance=text(values.importance);
      if(!note_type||!title||!content||!["normal","important","warning"].includes(importance))throw new Error("請完整填寫施工備忘。");
      return save("site_notes",{note_type,title,content,importance});
    }
    throw new Error("不支援的承攬案場明細類型。");
  }
  if (operation === "delete_contract_site_entry") {
    requireRole(user,["admin"]);
    const module=text(payload.module),customer_id=uuid(payload.customer_id),service_type_id=uuid(payload.contract_service_type_id),id=uuid(payload.id),rowVersion=Number(payload.row_version),tables:Record<string,string>={floors:"site_floors",routes:"site_routes",devices:"site_devices",notes:"site_notes"},table=tables[module];
    if(!customer_id||!service_type_id||!id||!table||!Number.isInteger(rowVersion)||rowVersion<1)throw new Error("案場承攬明細或版本不正確。");
    const sites=await get(`sites?customer_id=eq.${customer_id}&contract_service_type_id=eq.${service_type_id}&select=id&limit=2`) as {id:string}[];
    if(sites.length!==1)throw new Error("找不到案場與承攬內容的關聯。");
    return deleteSiteDetail(table,id,rowVersion,sites[0].id);
  }
  if (operation === "upsert_project_site_entry") {
    requireRole(user,["admin","operator"]);
    const module=text(payload.module),project_id=uuid(payload.project_id),id=text(payload.id)?uuid(payload.id):null,rowVersion=Number(payload.row_version),values=payload.values&&typeof payload.values==="object"&&!Array.isArray(payload.values)?payload.values as Row:null;
    if(!project_id||!values||(text(payload.id)&&!id)||(id&&(!Number.isInteger(rowVersion)||rowVersion<1))) throw new Error("案場明細資料不完整。");
    if(module==="maintenance"){
      const reported_at=date(values.reported_at),issue_description=limited(values.issue_description,4000),resolution=nullable(values.resolution,4000),rawWarranty=text(values.warranty_status),warrantyMap:Record<string,string>={"":"unknown","未知":"unknown","unknown":"unknown","保固內":"in_warranty","in_warranty":"in_warranty","保固外":"out_of_warranty","out_of_warranty":"out_of_warranty"},warranty_status=warrantyMap[rawWarranty];
      if(!reported_at||!issue_description||resolution===null||!warranty_status) throw new Error("請完整填寫維修紀錄。");
      const existing=await get(`maintenance_details?project_id=eq.${project_id}&select=project_id,row_version`) as {project_id:string;row_version:number}[];
      if(existing.length){
        if(!Number.isInteger(rowVersion)||rowVersion<1) throw new Error("維修紀錄版本不正確，請重新整理後再修改。");
        const response=await db(`maintenance_details?project_id=eq.${project_id}&row_version=eq.${rowVersion}`,{method:"PATCH",headers:{Prefer:"return=representation"},body:JSON.stringify({reported_at,issue_description,resolution:resolution||null,warranty_status,...meta})});
        const rows=response.ok?await response.json() as Row[]:[];if(rows.length!==1)throw new Error("維修紀錄已被其他使用者更新，請重新載入後再修改。");return rows[0];
      }
      return insert("maintenance_details",{project_id,reported_at,issue_description,resolution:resolution||null,warranty_status,...meta});
    }
    const site=await ensureProjectSite(project_id,actor);
    const save=(table:string,row:Row)=>id?updateSiteDetail(table,id,rowVersion,site.id,{...row,...meta}):insert(table,{site_id:site.id,...row,...meta});
    if(module==="floors"){
      const floor_code=limited(values.floor_code,20),floor_name=limited(values.floor_name,80),description=nullable(values.description,500),sort_order=text(values.sort_order)?Number(values.sort_order):0;
      if(!floor_code||!floor_name||description===null||!Number.isInteger(sort_order))throw new Error("請完整填寫樓層資料。");return save("site_floors",{floor_code,floor_name,description:description||null,sort_order});
    }
    if(module==="routes"){
      const route_no=limited(values.route_no,80),from_location=limited(values.from_location,160),to_location=limited(values.to_location,160),route_description=nullable(values.route_description,2000),cable_type=nullable(values.cable_type,120);
      if(!route_no||!from_location||!to_location||route_description===null||cable_type===null)throw new Error("請完整填寫走線資料。");return save("site_routes",{route_no,from_location,to_location,route_description:route_description||null,cable_type:cable_type||null});
    }
    if(module==="devices"){
      const device_no=limited(values.device_no,80),device_name=limited(values.device_name,160),inventory_item_id=text(values.inventory_item_id)?uuid(values.inventory_item_id):null,status=text(values.status)||"planned",notes=nullable(values.notes,1000);
      if(!device_no||!device_name||(text(values.inventory_item_id)&&!inventory_item_id)||!["planned","installed","tested"].includes(status)||notes===null)throw new Error("請完整填寫設備點位資料。");return save("site_devices",{project_id,inventory_item_id,device_no,device_name,status,notes:notes||null});
    }
    if(module==="logs"){
      const log_date=date(values.log_date),title=limited(values.title,160),summary=nullable(values.summary,2000),work_type=text(values.work_type),worker_user_ids=Array.isArray(values.worker_user_ids)?values.worker_user_ids.map(uuid):[];
      if(!log_date||!title||summary===null||!["工程施工","維修紀錄","維護保養"].includes(work_type)||worker_user_ids.some(workerId=>!workerId)||new Set(worker_user_ids).size!==worker_user_ids.length||worker_user_ids.length>30)throw new Error("請完整填寫工作日誌、工作類型與有效的施工人員。");
      return rpc("upsert_project_site_work_log_v1",{p_project_id:project_id,p_id:id,p_row_version:id?rowVersion:null,p_log_date:log_date,p_title:title,p_summary:summary||null,p_work_type:work_type,p_worker_user_ids:worker_user_ids,p_reporter_user_id:user!.id,p_actor:actor});
    }
    if(module==="notes"){
      const note_type=limited(values.note_type,80),title=limited(values.title,160),content=limited(values.content,4000),importance=text(values.importance);
      if(!note_type||!title||!content||!["normal","important","warning"].includes(importance))throw new Error("請完整填寫施工備忘。");return save("site_notes",{note_type,title,content,importance});
    }
    throw new Error("不支援的案場明細類型。");
  }
  if (operation === "delete_project_site_entry") {
    requireRole(user,["admin"]);
    const module=text(payload.module),project_id=uuid(payload.project_id),id=uuid(payload.id),rowVersion=Number(payload.row_version);
    if(!project_id||!id||!Number.isInteger(rowVersion)||rowVersion<1)throw new Error("案場明細資料或版本不正確。");
    if(module==="maintenance"){
      if(id!==project_id)throw new Error("維修紀錄與專案不相符。");
      const response=await db(`maintenance_details?project_id=eq.${project_id}&row_version=eq.${rowVersion}`,{method:"DELETE",headers:{Prefer:"return=representation"}}),rows=response.ok?await response.json() as Row[]:[];
      if(rows.length!==1)throw new Error("維修紀錄已被其他使用者更新，請重新載入後再刪除。");return;
    }
    const tables:Record<string,string>={floors:"site_floors",routes:"site_routes",devices:"site_devices",logs:"site_work_logs",notes:"site_notes"},table=tables[module];
    if(!table)throw new Error("不支援的案場明細類型。");
    const sites=await get(`sites?project_id=eq.${project_id}&select=id&limit=2`) as {id:string}[];
    if(sites.length!==1)throw new Error("找不到案場與專案的關聯。");return deleteSiteDetail(table,id,rowVersion,sites[0].id);
  }
  if (operation === "create_site_floor") { requireRole(user,["admin","operator"]); const site_id=uuid(payload.site_id),floor_code=limited(payload.floor_code,20),floor_name=limited(payload.floor_name,80),description=nullable(payload.description,500),sort_order=Number(payload.sort_order); if(!site_id||!floor_code||!floor_name||description===null||!Number.isInteger(sort_order)) throw new Error("請完整填寫樓層資料。"); return insert("site_floors",{site_id,floor_code,floor_name,description:description||null,sort_order,...meta}); }
  if (operation === "create_site_route") { requireRole(user,["admin","operator"]); const site_id=uuid(payload.site_id),floor_id=text(payload.floor_id)?uuid(payload.floor_id):null,route_no=limited(payload.route_no,80),from_location=limited(payload.from_location,160),to_location=limited(payload.to_location,160),route_description=nullable(payload.route_description,2000),cable_type=nullable(payload.cable_type,120),notes=nullable(payload.notes,1000); if(!site_id||!route_no||!from_location||!to_location||route_description===null||cable_type===null||notes===null) throw new Error("請完整填寫走線資料。"); return insert("site_routes",{site_id,floor_id,route_no,from_location,to_location,route_description:route_description||null,cable_type:cable_type||null,notes:notes||null,...meta}); }
  if (operation === "create_site_device") { requireRole(user,["admin","operator"]); const site_id=uuid(payload.site_id),project_id=text(payload.project_id)?uuid(payload.project_id):null,inventory_item_id=text(payload.inventory_item_id)?uuid(payload.inventory_item_id):null,floor_id=text(payload.floor_id)?uuid(payload.floor_id):null,device_no=limited(payload.device_no,80),device_name=limited(payload.device_name,160),notes=nullable(payload.notes,1000); if(!site_id||!device_no||!device_name||notes===null) throw new Error("請完整填寫設備點位資料。"); return insert("site_devices",{site_id,project_id,inventory_item_id,floor_id,device_no,device_name,notes:notes||null,...meta}); }
  if (operation === "create_site_work_log") { requireRole(user,["admin","operator"]); const site_id=uuid(payload.site_id),log_date=date(payload.log_date),title=limited(payload.title,160),summary=nullable(payload.summary,2000),work_type=text(payload.work_type); if(!site_id||!log_date||!title||summary===null||!["工程施工","維修紀錄","維護保養"].includes(work_type)) throw new Error("請完整填寫工作日誌與有效的工作類型。"); return insert("site_work_logs",{site_id,log_date,title,summary:summary||null,work_type,reporter_user_id:user!.id,...meta}); }
  if (operation === "create_site_note") { requireRole(user,["admin","operator"]); const site_id=uuid(payload.site_id),floor_id=text(payload.floor_id)?uuid(payload.floor_id):null,note_type=limited(payload.note_type,80),title=limited(payload.title,160),content=limited(payload.content,4000),importance=text(payload.importance); if(!site_id||!note_type||!title||!content||!["normal","important","warning"].includes(importance)) throw new Error("請完整填寫施工備忘。"); return insert("site_notes",{site_id,floor_id,note_type,title,content,importance,...meta}); }
  if (operation === "create_site_asset") { requireRole(user,["admin","operator"]); const site_id=uuid(payload.site_id),floor_id=text(payload.floor_id)?uuid(payload.floor_id):null,asset_type=text(payload.asset_type),title=limited(payload.title,160),description=nullable(payload.description,1000); if(!site_id||!["drawing","architecture","photo","work_log","acceptance","maintenance","other"].includes(asset_type)||!title||description===null) throw new Error("請完整填寫附件索引資料。"); return insert("site_assets",{site_id,floor_id,asset_type,title,description:description||null,...meta}); }
  if (operation === "create_contract_site_attachment_batch") {
    requireRole(user,["admin","operator"]);
    const customer_id=uuid(payload.customer_id),service_type_id=uuid(payload.contract_service_type_id),project_id=uuid(payload.project_id),values=Array.isArray(payload.rows)?payload.rows:[];
    if(!customer_id||!service_type_id||!project_id||values.length<1||values.length>10) throw new Error("承攬附件缺少客戶、承攬內容或專案資料。");
    const customers=await get(`customers?id=eq.${customer_id}&select=id,name`) as {id:string;name:string}[];
    const services=await get(`contract_service_types?id=eq.${service_type_id}&is_active=eq.true&select=id,name`) as {id:string;name:string}[];
    const links=await get(`customer_contract_services?customer_id=eq.${customer_id}&service_type_id=eq.${service_type_id}&select=customer_id`) as {customer_id:string}[];
    const projects=await get(`projects?id=eq.${project_id}&customer_id=eq.${customer_id}&select=id,name`) as {id:string;name:string}[];
    if(customers.length!==1||services.length!==1||links.length!==1||projects.length!==1) throw new Error("找不到客戶、承攬內容與專案的有效關聯。");
    let uploadFolder="";
    const rows=values.map((value,index)=>{
      if(!value||typeof value!=="object"||Array.isArray(value)) throw new Error(`第 ${index+1} 筆附件索引格式不正確。`);
      const row=value as Row,id=uuid(row.id),log_date=date(row.log_date),asset_type=text(row.asset_type),original_name=limited(row.original_name,160),description=nullable(row.description,1000),mime_type=limited(row.mime_type,160),file_size=nonNegative(row.file_size),nas_path=limited(row.nas_path,1000),uploaded_at=text(row.uploaded_at),sha256=text(row.sha256).toLowerCase(),conflict_resolution=text(row.conflict_resolution)||"new";
      if(!id||!log_date||!["photo","document"].includes(asset_type)||!original_name||description===null||!mime_type||file_size===null||!Number.isInteger(file_size)||!nas_path||Number.isNaN(Date.parse(uploaded_at))||!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`第 ${index+1} 筆附件索引資料不完整。`);
      const slash=nas_path.lastIndexOf("/"),folder=slash>0?nas_path.slice(0,slash):"",storedName=slash>0?nas_path.slice(slash+1):"",expectedFolder=`/GUC-ERP/${safePathPart(customers[0].name)}/${safePathPart(services[0].name)}/${safePathPart(projects[0].name)}/${log_date}`;
      if(folder!==expectedFolder||!storedName||storedName!==safePathPart(storedName)||!["new","overwrite","rename"].includes(conflict_resolution)||(conflict_resolution!=="rename"&&storedName!==safePathPart(original_name))) throw new Error(`第 ${index+1} 筆 NAS 路徑與客戶、承攬內容、專案或日期不相符。`);
      if(uploadFolder&&folder!==uploadFolder) throw new Error("同一批附件必須保存在相同日期資料夾。");
      uploadFolder=folder;
      return {id,project_id,work_log_id:null,asset_type,title:original_name,description:description||null,original_name,mime_type,file_size,nas_path,upload_status:"uploaded",uploaded_by:user!.username,uploaded_at,sha256};
    });
    if(new Set(rows.map(row=>row.id)).size!==rows.length||new Set(rows.map(row=>row.nas_path)).size!==rows.length) throw new Error("附件索引中有重複檔案。");
    return rpc("register_contract_site_attachments_v2",{p_customer_id:customer_id,p_service_type_id:service_type_id,p_project_id:project_id,p_rows:rows,p_actor:actor});
  }
  if (operation === "create_site_attachment_batch") {
    requireRole(user,["admin","operator"]);
    const project_id=uuid(payload.project_id),values=Array.isArray(payload.rows)?payload.rows:[];
    if(!project_id||values.length<1||values.length>10) throw new Error("附件索引資料不完整。");
    const projects=await get(`projects?id=eq.${project_id}&select=id,name,customer_id`) as {id:string;name:string;customer_id:string}[];
    if(projects.length!==1) throw new Error("找不到附件所屬專案。");
    const customers=await get(`customers?id=eq.${projects[0].customer_id}&select=id,name`) as {id:string;name:string}[];
    if(customers.length!==1) throw new Error("找不到附件所屬客戶。");
    let uploadFolder="";
    const rows=values.map((value,index)=>{
      if(!value||typeof value!=="object"||Array.isArray(value)) throw new Error(`第 ${index+1} 筆附件索引格式不正確。`);
      const row=value as Row,id=uuid(row.id),work_log_id=text(row.work_log_id)?uuid(row.work_log_id):null,log_date=date(row.log_date),asset_type=text(row.asset_type),original_name=limited(row.original_name,160),description=nullable(row.description,1000),mime_type=limited(row.mime_type,160),file_size=nonNegative(row.file_size),nas_path=limited(row.nas_path,1000),uploaded_at=text(row.uploaded_at),sha256=text(row.sha256).toLowerCase(),conflict_resolution=text(row.conflict_resolution)||"new";
      if(!id||(text(row.work_log_id)&&!work_log_id)||!log_date||!["photo","document"].includes(asset_type)||!original_name||description===null||!mime_type||file_size===null||!Number.isInteger(file_size)||!nas_path||Number.isNaN(Date.parse(uploaded_at))||!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`第 ${index+1} 筆附件索引資料不完整。`);
      const slash=nas_path.lastIndexOf("/"),folder=slash>0?nas_path.slice(0,slash):"",storedName=slash>0?nas_path.slice(slash+1):"",expectedFolder=`/GUC-ERP/${safePathPart(customers[0].name)}/${safePathPart(projects[0].name)}/${log_date}`;
      if(folder!==expectedFolder||!storedName||storedName!==safePathPart(storedName)||!["new","overwrite","rename"].includes(conflict_resolution)||(conflict_resolution!=="rename"&&storedName!==safePathPart(original_name))) throw new Error(`第 ${index+1} 筆 NAS 路徑與客戶、專案或日期不相符。`);
      if(uploadFolder&&folder!==uploadFolder) throw new Error("同一批附件必須保存在相同日期資料夾。");
      uploadFolder=folder;
      return {id,work_log_id,asset_type,title:original_name,description:description||null,original_name,mime_type,file_size,nas_path,upload_status:"uploaded",uploaded_by:user!.username,uploaded_at,sha256};
    });
    if(new Set(rows.map(row=>row.id)).size!==rows.length||new Set(rows.map(row=>row.nas_path)).size!==rows.length) throw new Error("附件索引中有重複檔案。");
    const workLogIds=[...new Set(rows.map(row=>row.work_log_id).filter(Boolean))] as string[];
    if(workLogIds.length){
      const logs=await get(`site_work_logs?id=in.(${workLogIds.join(",")})&select=id,site_id`) as {id:string;site_id:string}[];
      if(logs.length!==workLogIds.length) throw new Error("關聯工作日誌不存在或已刪除。");
      const siteIds=[...new Set(logs.map(log=>log.site_id))];
      const sites=await get(`sites?id=in.(${siteIds.join(",")})&project_id=eq.${project_id}&select=id`) as {id:string}[];
      if(sites.length!==siteIds.length) throw new Error("關聯工作日誌不屬於此專案。");
    }
    return rpc("register_site_attachments_v2",{p_project_id:project_id,p_rows:rows,p_actor:actor});
  }
  if (operation === "delete_site_entry") { requireRole(user,["admin"]); const id=uuid(payload.id),rowVersion=Number(payload.row_version),entity=text(payload.entity); const tables:Record<string,string>={floor:"site_floors",route:"site_routes",device:"site_devices",work_log:"site_work_logs",note:"site_notes",asset:"site_assets"}; if(!id||!Number.isInteger(rowVersion)||rowVersion<1||!tables[entity]) throw new Error("案場明細資料不正確。"); return deleteVersioned(tables[entity],id,rowVersion); }
  if (operation === "restore_database_backup") { requireRole(user,["admin"]); if(!payload.backup||typeof payload.backup!=="object"||Array.isArray(payload.backup)) throw new Error("請提供已驗證的資料庫備份。"); return rpc("restore_inventory_backup",{p_backup:payload.backup,p_actor:actor}); }
  if (operation === "request_excel_sync") { requireRole(user,["admin"]); return insert("sync_runs",{direction:"database_to_excel",status:"queued",source_name:"網站手動要求"}); }
  if (operation === "create_account") return createAccount(payload, user!);
  if (operation === "update_account") return updateAccount(payload, user!);
  if (operation === "delete_account") return deleteAccount(payload, user!);
  throw new Error("不支援的操作。");
}
Deno.serve(async request => {
  try {
    if(request.method === "GET") {
      const user = await currentUser(request);
      if (!user) return json({error:"請先以有效帳號登入。"},401);
      const params = new URL(request.url).searchParams;
      if (params.has("entity")) return json(await queryRecords(params));
      const scopeName = text(params.get("scope")) || "dashboard";
      if (scopeName === "session") return json({ scope: scopeName, current_user: publicUser(user), errors: [], refreshed_at: new Date().toISOString() });
      return json(await scopedSnapshot(user, scopeName));
    }
    if(request.method !== "POST") return json({error:"僅支援 GET 與 POST。"},405);
    const body=await request.json() as {operation?:unknown;payload?:unknown};
    const operation = text(body.operation), payload = body.payload&&typeof body.payload==="object"&&!Array.isArray(body.payload)?body.payload as Row:{};
    if (operation === "login") { const logged = await login(payload); return json({ session: logged.session, current_user: publicUser(logged.user), errors: [], refreshed_at: new Date().toISOString() }, 200); }
    if (operation === "bootstrap_admin") {
      const existing = await get("app_users?select=id&limit=1") as Row[];
      if (existing.length) throw new Error("首位管理者已建立。");
      await createAccount({ ...payload, role: "admin" }, { id: "", auth_user_id: "", username: "", display_name: "", role: "admin", is_active: true, row_version: 1 }, true);
      return json({ ok: true, refreshed_at: new Date().toISOString() }, 201);
    }
    const user = await currentUser(request);
    if (!user) return json({error:"請先以有效帳號登入。"},401);
    await change(operation,payload,user);
    return json({ ok: true, current_user: publicUser(user), refreshed_at: new Date().toISOString() },201);
  } catch(error) { return json({error:error instanceof Error?error.message:"系統暫時無法完成操作。"},400); }
});
