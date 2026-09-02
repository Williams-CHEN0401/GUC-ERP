type Row = Record<string, unknown>;
type Role = "admin" | "operator" | "viewer";
type AppUser = {
  id: string;
  auth_user_id: string;
  username: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  row_version: number;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const upstreamTimeoutMs = 12_000;
const quoteStatuses = new Set(["draft", "completed", "sent", "confirmed", "lost", "won", "voided"]);
const billingStatuses = new Set(["unbilled", "preparing", "in_progress", "partial", "completed"]);
const previewAuthorizedUserIds = new Set([
  "bb880df3-a731-4735-8e1a-c95575aec875",
  "79ce8566-898e-4dd3-a67b-d4eba7c088f5",
  "5926554a-b8cc-4756-8d66-0a9a0877f94e",
]);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
  },
});
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const uuid = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text(value)) ? text(value) : null;
const date = (value: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? text(value) : null;
const username = (value: unknown) => {
  const normalized = text(value).toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{2,31}$/.test(normalized) ? normalized : null;
};
const password = (value: unknown) => {
  const candidate = typeof value === "string" ? value : "";
  return candidate.length >= 1 && candidate.length <= 128 ? candidate : null;
};
const internalEmail = (name: string) => `${name}@inventory.local`;
const publicUser = (user: AppUser) => ({
  id: user.id,
  username: user.username,
  display_name: user.display_name,
  role: user.role,
  can_access_quotations: true,
});

async function timedFetch(resource: string, init: RequestInit = {}, label = "資料服務") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
  try {
    return await fetch(resource, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error(`${label}回應逾時，請稍後重試。`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function database(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("apikey", serviceRoleKey);
  headers.set("Authorization", `Bearer ${serviceRoleKey}`);
  headers.set("Content-Type", "application/json");
  return timedFetch(`${supabaseUrl}/rest/v1/${path}`, { ...init, headers }, "資料庫");
}

async function get(path: string) {
  const response = await database(path);
  if (!response.ok) throw new Error("讀取資料失敗。");
  return response.json();
}

async function getAll(path: string, pageSize = 1000) {
  const rows: Row[] = [];
  let offset = 0;
  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const page = await get(`${path}${separator}limit=${pageSize}&offset=${offset}`) as Row[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
    offset += page.length;
  }
}

async function rpc(name: string, args: Row) {
  const response = await database(`rpc/${name}`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(args),
  });
  const raw = await response.text();
  let body: unknown = null;
  if (raw) {
    try { body = JSON.parse(raw); }
    catch { if (response.ok) throw new Error("資料服務回應格式不正確。"); }
  }
  if (!response.ok) {
    const failure = body && typeof body === "object" && !Array.isArray(body) ? body as { code?: string; message?: string } : {};
    if (failure.code === "P0001" && failure.message && /[\u3400-\u9fff]/.test(failure.message)) throw new Error(failure.message.slice(0, 300));
    if (failure.code === "23505") throw new Error("報價編號或版本已存在，請重新整理後再試。");
    if (failure.code === "23503") throw new Error("報價所選的客戶、專案或使用者已不存在。");
    throw new Error("報價資料處理失敗，請確認輸入內容後重試。");
  }
  return body;
}

async function currentUser(request: Request): Promise<AppUser | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const auth = await timedFetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceRoleKey, Authorization: authorization },
  }, "登入工作階段驗證");
  if (!auth.ok) return null;
  const authUser = await auth.json().catch(() => ({})) as { id?: string };
  if (!authUser.id) return null;
  const profiles = await get(`app_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&is_active=eq.true&select=id,auth_user_id,username,display_name,role,is_active,row_version&limit=2`) as AppUser[];
  return profiles.length === 1 ? profiles[0] : null;
}

async function hasQuotationAccess(user: AppUser, preview: boolean) {
  const response = await database(`quotation_access_users?app_user_id=eq.${encodeURIComponent(user.id)}&select=app_user_id&limit=2`);
  if (response.ok) {
    const rows = await response.json() as Row[];
    return rows.length === 1;
  }

  const failure = await response.json().catch(() => ({})) as { code?: string };
  const accessTableNotInstalled = response.status === 404 && failure.code === "PGRST205";
  if (preview && accessTableNotInstalled) return previewAuthorizedUserIds.has(user.id);
  throw new Error("報價權限服務暫時無法使用。");
}

async function requireQuotationUser(request: Request, preview: boolean) {
  const user = await currentUser(request);
  if (!user) throw new Error("請先以有效帳號登入。");
  if (!await hasQuotationAccess(user, preview)) throw new Error("您沒有執行報價管理系統的權限。");
  return user;
}

async function login(payload: Row, preview: boolean) {
  const name = username(payload.username);
  const pass = password(payload.password);
  if (!name || !pass) throw new Error("帳號或密碼格式不正確。");
  const profiles = await get(`app_users?username=eq.${encodeURIComponent(name)}&is_active=eq.true&select=id,auth_user_id,username,display_name,role,is_active,row_version&limit=2`) as AppUser[];
  if (profiles.length !== 1) throw new Error("帳號或密碼錯誤。");
  const response = await timedFetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: serviceRoleKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: internalEmail(name), password: pass }),
  }, "帳號登入");
  const session = await response.json().catch(() => ({})) as { access_token?: string; expires_at?: number; user?: { id?: string } };
  if (!response.ok || !session.access_token || !session.user?.id || session.user.id !== profiles[0].auth_user_id) throw new Error("帳號或密碼錯誤。");
  if (!await hasQuotationAccess(profiles[0], preview)) throw new Error("您沒有執行報價管理系統的權限。");
  return {
    session: { access_token: session.access_token, expires_at: session.expires_at ?? null },
    current_user: publicUser(profiles[0]),
  };
}

async function previewOptions() {
  const [customers, projects, contacts, users] = await Promise.all([
    getAll("customers?select=id,customer_code,name,phone,email,address&order=name.asc"),
    getAll("projects?select=id,project_code,name,customer_id,status,updated_at&order=project_code.asc.nullslast,name.asc"),
    getAll("customer_contacts?select=id,customer_id,name,title,phone,email,is_primary&order=customer_id.asc,is_primary.desc,name.asc"),
    getAll("app_users?is_active=eq.true&select=id,display_name&order=display_name.asc"),
  ]);
  return {
    customers: customers.map(row => ({ id: row.id, code: row.customer_code, name: row.name, phone: row.phone, email: row.email, address: row.address })),
    projects: projects.map(row => ({ id: row.id, code: row.project_code, name: row.name, customer_id: row.customer_id, status: row.status, updated_at: row.updated_at })),
    contacts,
    users,
    settings: { currency: "TWD", default_tax_rate_basis_points: 500, quantity_scale: 3, rounding: "round_half_away_from_zero" },
  };
}

function previewRecords(options: { customers: Row[]; projects: Row[]; users: Row[] }) {
  const customers = options.customers;
  const projects = options.projects;
  const users = options.users;
  const customerById = new Map(customers.map(customer => [customer.id, customer]));
  const project = (index: number) => projects[index % Math.max(projects.length, 1)] ?? {};
  const owner = (index: number) => users[index % Math.max(users.length, 1)] ?? {};
  const definitions = [
    { id: "10000000-0000-4000-8000-000000000001", number: "Q26090001", status: "draft", billing: "unbilled", projectIndex: 0, total: 31500, version: 1, updated: "2026-09-02T09:20:00+08:00" },
    { id: "10000000-0000-4000-8000-000000000002", number: "Q26090002", status: "sent", billing: "unbilled", projectIndex: 1, total: 127050, version: 2, updated: "2026-09-01T16:45:00+08:00" },
    { id: "10000000-0000-4000-8000-000000000003", number: "Q26090003", status: "won", billing: "in_progress", projectIndex: 2, total: 84000, version: 1, updated: "2026-08-31T14:10:00+08:00" },
    { id: "10000000-0000-4000-8000-000000000004", number: "Q26080018", status: "won", billing: "partial", projectIndex: 3, total: 206850, version: 3, updated: "2026-08-29T11:30:00+08:00" },
  ];
  return definitions.map((definition, index) => {
    const selectedProject = project(definition.projectIndex);
    const selectedCustomer = customerById.get(selectedProject.customer_id) ?? {};
    const selectedOwner = owner(index);
    return {
      id: definition.id,
      quotation_number: definition.number,
      customer_id: selectedCustomer.id ?? "",
      project_id: selectedProject.id ?? null,
      owner_user_id: selectedOwner.id ?? "",
      owner_name: selectedOwner.display_name ?? "Williams",
      quote_status: definition.status,
      billing_status: definition.billing,
      created_at: definition.updated,
      updated_at: definition.updated,
      row_version: 1,
      version_id: definition.id.replace(/1$/, "a"),
      version_number: definition.version,
      quote_date: index < 2 ? "2026-09-01" : "2026-08-25",
      valid_until: index < 2 ? "2026-09-30" : "2026-09-24",
      customer_code_snapshot: selectedCustomer.code ?? "C---",
      customer_name_snapshot: selectedCustomer.name ?? `示範客戶 ${index + 1}`,
      project_code_snapshot: selectedProject.code ?? null,
      project_name_snapshot: selectedProject.name ?? null,
      subtotal_twd: Math.round(definition.total / 1.05),
      discount_twd: 0,
      tax_twd: definition.total - Math.round(definition.total / 1.05),
      total_twd: definition.total,
    };
  });
}

function previewDetail(record: Row) {
  const subtotal = Number(record.subtotal_twd ?? 0);
  const first = Math.round(subtotal * 0.7);
  const quoteStatus = String(record.quote_status ?? "draft");
  const billingStatus = String(record.billing_status ?? "unbilled");
  return {
    quotation: {
      id: record.id,
      quotation_number: record.quotation_number,
      customer_id: record.customer_id,
      project_id: record.project_id,
      owner_user_id: record.owner_user_id,
      owner_name: record.owner_name,
      quote_status: quoteStatus,
      billing_status: billingStatus,
      created_at: record.created_at,
      updated_at: record.updated_at,
      row_version: record.row_version,
    },
    current_version: {
      id: record.version_id,
      version_number: record.version_number,
      quote_date: record.quote_date,
      valid_until: record.valid_until,
      contact_id: null,
      customer_code_snapshot: record.customer_code_snapshot,
      customer_name_snapshot: record.customer_name_snapshot,
      customer_phone_snapshot: null,
      customer_email_snapshot: null,
      customer_address_snapshot: null,
      contact_name_snapshot: null,
      contact_title_snapshot: null,
      contact_phone_snapshot: null,
      contact_email_snapshot: null,
      project_code_snapshot: record.project_code_snapshot,
      project_name_snapshot: record.project_name_snapshot,
      subtotal_twd: subtotal,
      discount_twd: record.discount_twd,
      tax_rate_basis_points: 500,
      tax_twd: record.tax_twd,
      total_twd: record.total_twd,
      note: "Preview 示範報價；所有異動只保存在目前瀏覽器工作階段。",
      created_at: record.created_at,
      updated_at: record.updated_at,
      row_version: 1,
    },
    items: [
      { id: `${record.id}-1`, line_number: 1, description: "設備與材料", specification: "依專案規格", quantity_milli: 1000, unit: "式", unit_price_twd: first, line_subtotal_twd: first, note: null },
      { id: `${record.id}-2`, line_number: 2, description: "安裝、測試與教育訓練", specification: null, quantity_milli: 1000, unit: "式", unit_price_twd: subtotal - first, line_subtotal_twd: subtotal - first, note: null },
    ],
    versions: [{ id: record.version_id, version_number: record.version_number, is_current: true, quote_date: record.quote_date, valid_until: record.valid_until, total_twd: record.total_twd, created_at: record.created_at, created_by_name: record.owner_name }],
    quote_status_history: [{ id: 1, from_status: null, to_status: quoteStatus, note: "Preview 狀態", changed_at: record.updated_at, changed_by_name: record.owner_name }],
    billing_history: [{ id: 1, from_status: null, to_status: billingStatus, note: "Preview 請款狀態", changed_at: record.updated_at, changed_by_name: record.owner_name }],
  };
}

function filterPreviewRecords(records: Row[], params: URLSearchParams) {
  const search = text(params.get("search")).toLocaleLowerCase("zh-Hant");
  const quoteStatus = text(params.get("quote_status"));
  const billingStatus = text(params.get("billing_status"));
  const customerId = uuid(params.get("customer_id"));
  const projectId = uuid(params.get("project_id"));
  if ((text(params.get("customer_id")) && !customerId) || (text(params.get("project_id")) && !projectId)) {
    throw new Error("客戶或專案篩選格式不正確。");
  }
  if ((quoteStatus && !quoteStatuses.has(quoteStatus)) || (billingStatus && !billingStatuses.has(billingStatus))) {
    throw new Error("報價或請款狀態篩選值不正確。");
  }
  return records.filter(record => {
    const haystack = [record.quotation_number, record.customer_name_snapshot, record.project_name_snapshot].join(" ").toLocaleLowerCase("zh-Hant");
    return (!search || haystack.includes(search))
      && (!quoteStatus || record.quote_status === quoteStatus)
      && (!billingStatus || record.billing_status === billingStatus)
      && (!customerId || record.customer_id === customerId)
      && (!projectId || record.project_id === projectId);
  });
}

function previewTracking(options: { customers: Row[]; projects: Row[] }, records: Row[]) {
  const customerById = new Map(options.customers.map(customer => [customer.id, customer]));
  return options.projects.map(project => {
    const customer = customerById.get(project.customer_id) ?? {};
    const latest = records.filter(record => record.project_id === project.id).sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))[0];
    return {
      customer_id: customer.id ?? project.customer_id,
      customer_code: customer.code ?? null,
      customer_name: customer.name ?? "未命名客戶",
      project_id: project.id,
      project_code: project.code ?? null,
      project_name: project.name,
      project_status: project.status,
      quotation_id: latest?.id ?? null,
      quotation_number: latest?.quotation_number ?? null,
      quote_status: latest?.quote_status ?? (project.status === "in_progress" ? "unquoted" : "unconfirmed"),
      billing_status: latest?.billing_status ?? null,
      owner_user_id: latest?.owner_user_id ?? null,
      owner_name: latest?.owner_name ?? null,
      total_twd: latest?.total_twd ?? null,
      updated_at: latest?.updated_at ?? project.updated_at ?? null,
    };
  });
}

function quotationPayload(payload: Row) {
  const items = Array.isArray(payload.items) ? payload.items : null;
  const customerId = uuid(payload.customer_id);
  const projectId = uuid(payload.project_id);
  const ownerId = uuid(payload.owner_user_id);
  const contactId = text(payload.contact_id) ? uuid(payload.contact_id) : null;
  const quoteDate = date(payload.quote_date);
  const validUntil = date(payload.valid_until);
  const discount = Number(payload.discount_twd);
  const taxRate = Number(payload.tax_rate_basis_points);
  const note = typeof payload.note === "string" ? payload.note.trim() : "";
  if (!customerId || !projectId || !ownerId || (text(payload.contact_id) && !contactId)
      || !quoteDate || !validUntil || !Number.isSafeInteger(discount) || discount < 0
      || !Number.isInteger(taxRate) || taxRate < 0 || taxRate > 10000 || note.length > 4000
      || !items || items.length < 1 || items.length > 100) {
    throw new Error("報價基本資料或明細格式不正確。");
  }
  const normalizedItems = items.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`第 ${index + 1} 筆報價明細格式不正確。`);
    const row = value as Row;
    const description = text(row.description);
    const specification = text(row.specification);
    const unit = text(row.unit);
    const quantityMilli = Number(row.quantity_milli);
    const unitPrice = Number(row.unit_price_twd);
    const itemNote = typeof row.note === "string" ? row.note.trim() : "";
    if (!description || description.length > 500 || specification.length > 500 || !unit || unit.length > 32
        || !Number.isSafeInteger(quantityMilli) || quantityMilli < 1 || quantityMilli > 1_000_000_000
        || !Number.isSafeInteger(unitPrice) || unitPrice < 0 || unitPrice > 1_000_000_000
        || itemNote.length > 500) throw new Error(`第 ${index + 1} 筆報價明細不完整。`);
    const lineSubtotal = (BigInt(quantityMilli) * BigInt(unitPrice) + 500n) / 1000n;
    if (lineSubtotal > 90_000_000_000_000n) throw new Error(`第 ${index + 1} 筆報價金額超過允許範圍。`);
    return { description, specification: specification || null, unit, quantity_milli: quantityMilli, unit_price_twd: unitPrice, note: itemNote || null };
  });
  return {
    customer_id: customerId,
    project_id: projectId,
    owner_user_id: ownerId,
    contact_id: contactId,
    quote_date: quoteDate,
    valid_until: validUntil,
    discount_twd: discount,
    tax_rate_basis_points: taxRate,
    note: note || null,
    items: normalizedItems,
  };
}

async function productionMutation(operation: string, payload: Row, user: AppUser) {
  if (operation === "create_quotation") {
    const input = quotationPayload(payload);
    return rpc("create_quotation_v1", { p_actor_user_id: user.id, ...Object.fromEntries(Object.entries(input).map(([key, value]) => [`p_${key}`, value])) });
  }
  if (operation === "update_quotation") {
    const input = quotationPayload(payload);
    const quotationId = uuid(payload.id);
    const quotationVersion = Number(payload.row_version);
    const versionRowVersion = Number(payload.version_row_version);
    if (!quotationId || !Number.isInteger(quotationVersion) || quotationVersion < 1 || !Number.isInteger(versionRowVersion) || versionRowVersion < 1) throw new Error("報價版本資料不正確。");
    return rpc("update_quotation_v1", {
      p_actor_user_id: user.id,
      p_quotation_id: quotationId,
      p_expected_quotation_row_version: quotationVersion,
      p_expected_version_row_version: versionRowVersion,
      ...Object.fromEntries(Object.entries(input).map(([key, value]) => [`p_${key}`, value])),
    });
  }
  const quotationId = uuid(payload.id);
  const rowVersion = Number(payload.row_version);
  if (!quotationId || !Number.isInteger(rowVersion) || rowVersion < 1) throw new Error("報價資料或版本不正確。");
  if (operation === "create_quotation_version") return rpc("create_quotation_version_v1", { p_actor_user_id: user.id, p_quotation_id: quotationId, p_expected_quotation_row_version: rowVersion, p_note: text(payload.note) || null });
  if (operation === "update_quotation_status") return rpc("update_quotation_status_v1", { p_actor_user_id: user.id, p_quotation_id: quotationId, p_expected_row_version: rowVersion, p_status: text(payload.status), p_note: text(payload.note) || null });
  if (operation === "update_quotation_billing_status") return rpc("update_quotation_billing_status_v1", { p_actor_user_id: user.id, p_quotation_id: quotationId, p_expected_row_version: rowVersion, p_status: text(payload.status), p_note: text(payload.note) || null });
  if (operation === "void_quotation") return rpc("void_quotation_v1", { p_actor_user_id: user.id, p_quotation_id: quotationId, p_expected_row_version: rowVersion, p_reason: text(payload.reason) });
  if (operation === "archive_quotation") return rpc("archive_quotation_draft_v1", { p_actor_user_id: user.id, p_quotation_id: quotationId, p_expected_row_version: rowVersion, p_reason: text(payload.reason) });
  throw new Error("不支援此報價操作。");
}

Deno.serve(async request => {
  try {
    if (!supabaseUrl || !serviceRoleKey) return json({ error: "報價資料服務尚未完成設定。" }, 503);
    const requestUrl = new URL(request.url);
    const normalizedPath = requestUrl.pathname.replace(/\/+$/, "");
    const pathMatch = normalizedPath.match(/^\/(?:functions\/v1\/)?(quotation-gateway|quotation-gateway-preview)$/);
    if (!pathMatch) {
      return json({ error: "找不到報價 API。" }, 404);
    }
    const preview = pathMatch[1] === "quotation-gateway-preview";
    if (request.method === "GET") {
      const user = await requireQuotationUser(request, preview);
      const entity = text(requestUrl.searchParams.get("entity")) || "session";
      if (entity === "session") return json({ current_user: publicUser(user), preview_readonly: preview });
      if (entity === "options") {
        const result = preview ? await previewOptions() : await rpc("quotation_options_v1", { p_actor_user_id: user.id });
        return json({ ...(result as Row), current_user: publicUser(user), preview_readonly: preview });
      }
      if (preview) {
        const options = await previewOptions();
        const records = previewRecords(options);
        const tracking = previewTracking(options, records);
        if (entity === "dashboard") {
          const summary = {
            total: records.length,
            draft: records.filter(row => row.quote_status === "draft").length,
            sent: records.filter(row => row.quote_status === "sent").length,
            won: records.filter(row => row.quote_status === "won").length,
            pending_billing: records.filter(row => row.quote_status === "won" && row.billing_status !== "completed").length,
            won_total_twd: records.filter(row => row.quote_status === "won").reduce((sum, row) => sum + Number(row.total_twd || 0), 0),
          };
          const projectSummary = {
            total_projects: tracking.length,
            unquoted_projects: tracking.filter(row => row.quote_status === "unquoted").length,
            waiting_customer: tracking.filter(row => row.quote_status === "sent").length,
            won_projects: tracking.filter(row => row.quote_status === "won").length,
            pending_billing_projects: tracking.filter(row => row.quote_status === "won" && row.billing_status !== "completed").length,
          };
          return json({ summary, project_summary: projectSummary, recent: records, current_user: publicUser(user), preview_readonly: true, is_sample_data: true });
        }
        if (entity === "list") return json({ records: filterPreviewRecords(records, requestUrl.searchParams), next_cursor: null, current_user: publicUser(user), preview_readonly: true, is_sample_data: true });
        if (entity === "tracking") return json({ records: tracking, current_user: publicUser(user), preview_readonly: true, is_sample_data: true });
        if (entity === "detail") {
          const id = uuid(requestUrl.searchParams.get("id"));
          const record = records.find(row => row.id === id);
          if (!record) return json({ error: "找不到報價資料。" }, 404);
          return json({ ...previewDetail(record), current_user: publicUser(user), preview_readonly: true, is_sample_data: true });
        }
      } else {
        if (entity === "dashboard") return json({ ...(await rpc("quotation_dashboard_v1", { p_actor_user_id: user.id }) as Row), current_user: publicUser(user), preview_readonly: false });
        if (entity === "tracking") {
          const ownerId = text(requestUrl.searchParams.get("owner_user_id")) ? uuid(requestUrl.searchParams.get("owner_user_id")) : null;
          if (text(requestUrl.searchParams.get("owner_user_id")) && !ownerId) return json({ error: "負責人篩選格式不正確。" }, 400);
          const result = await rpc("quotation_project_tracking_v1", {
            p_actor_user_id: user.id,
            p_search: text(requestUrl.searchParams.get("search")) || null,
            p_quote_status: text(requestUrl.searchParams.get("quote_status")) || null,
            p_billing_status: text(requestUrl.searchParams.get("billing_status")) || null,
            p_owner_user_id: ownerId,
          });
          return json({ records: result, current_user: publicUser(user), preview_readonly: false });
        }
        if (entity === "list") {
          const params = requestUrl.searchParams;
          const customerId = text(params.get("customer_id")) ? uuid(params.get("customer_id")) : null;
          const projectId = text(params.get("project_id")) ? uuid(params.get("project_id")) : null;
          if ((text(params.get("customer_id")) && !customerId) || (text(params.get("project_id")) && !projectId)) {
            return json({ error: "客戶或專案篩選格式不正確。" }, 400);
          }
          const result = await rpc("quotation_list_v1", {
            p_actor_user_id: user.id,
            p_search: text(params.get("search")) || null,
            p_quote_status: text(params.get("quote_status")) || null,
            p_billing_status: text(params.get("billing_status")) || null,
            p_customer_id: customerId,
            p_project_id: projectId,
            p_cursor_updated_at: text(params.get("cursor_updated_at")) || null,
            p_cursor_id: text(params.get("cursor_id")) ? uuid(params.get("cursor_id")) : null,
            p_limit: Math.min(Math.max(Number(params.get("limit")) || 50, 1), 100),
          });
          return json({ ...(result as Row), current_user: publicUser(user), preview_readonly: false });
        }
        if (entity === "detail") {
          const id = uuid(requestUrl.searchParams.get("id"));
          if (!id) return json({ error: "報價編號格式不正確。" }, 400);
          return json({ ...(await rpc("quotation_detail_v1", { p_actor_user_id: user.id, p_quotation_id: id }) as Row), current_user: publicUser(user), preview_readonly: false });
        }
        if (entity === "version_detail") {
          const id = uuid(requestUrl.searchParams.get("id"));
          const versionId = uuid(requestUrl.searchParams.get("version_id"));
          if (!id || !versionId) return json({ error: "報價或版本編號格式不正確。" }, 400);
          return json({ ...(await rpc("quotation_version_detail_v1", { p_actor_user_id: user.id, p_quotation_id: id, p_version_id: versionId }) as Row), current_user: publicUser(user), preview_readonly: false });
        }
      }
      return json({ error: "找不到報價 API。" }, 404);
    }

    if (request.method !== "POST") return json({ error: "僅支援 GET 與 POST。" }, 405);
    const body = await request.json().catch(() => ({})) as { operation?: unknown; payload?: unknown };
    const operation = text(body.operation);
    const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload as Row : {};
    if (operation === "login") return json(await login(payload, preview));
    const user = await requireQuotationUser(request, preview);
    if (preview) return json({ error: "Preview 環境只會在瀏覽器工作階段模擬報價異動，不會寫入正式資料庫。", code: "PREVIEW_READ_ONLY" }, 403);
    const result = await productionMutation(operation, payload, user);
    return json({ ok: true, result, current_user: publicUser(user), preview_readonly: false }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "系統暫時無法完成操作。";
    const status = message.includes("沒有執行") ? 403
      : message.startsWith("請先") ? 401
      : message.startsWith("找不到") ? 404
      : message.includes("其他使用者") ? 409
      : message.includes("回應逾時") ? 504
      : message.includes("尚未完成設定") || message.includes("暫時無法使用") || message.includes("讀取資料失敗") ? 503
      : 400;
    return json({ error: message, code: status === 403 ? "FORBIDDEN" : status === 401 ? "UNAUTHORIZED" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : status === 503 ? "SERVICE_UNAVAILABLE" : status === 504 ? "GATEWAY_TIMEOUT" : "VALIDATION_ERROR" }, status);
  }
});
