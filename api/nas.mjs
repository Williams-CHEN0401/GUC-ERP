import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const SUPABASE_BASE = "https://bfgjdxhhnfotkjrbdckr.supabase.co/functions/v1";
const GATEWAY_NAME = process.env.VERCEL_ENV === "production" ? "inventory-gateway" : "inventory-gateway-preview";
const GATEWAY_ENDPOINT = `${SUPABASE_BASE}/${GATEWAY_NAME}`;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_FOLDER_ATTEMPTS = 100;
const PREFLIGHT_TICKET_TTL_MS = 2 * 60 * 1000;
const NAS_CONCURRENCY = 3;
const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif", "pdf", "docx", "xlsx"]);

export class HttpError extends Error {
  constructor(status, message, code = "NAS_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function firstText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function elapsedMs(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

export async function mapWithConcurrency(items, limit, mapper) {
  const source = Array.from(items || []), results = new Array(source.length);
  let cursor = 0;
  const workerCount = Math.min(source.length, Math.max(1, Number(limit) || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < source.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(source[index], index);
    }
  }));
  return results;
}

function ticketSecret(config) {
  return createHash("sha256").update(`guc-erp:nas-preflight:v1\0${config.password}`, "utf8").digest();
}

function authorizationHash(authorization) {
  return createHash("sha256").update(String(authorization || ""), "utf8").digest("base64url");
}

function signTicketPayload(config, encodedPayload) {
  return createHmac("sha256", ticketSecret(config)).update(encodedPayload, "utf8").digest("base64url");
}

export function createPreflightTicket(config, payload, authorization, now = Date.now()) {
  const body = {
    ...payload,
    version: 1,
    issued_at: now,
    expires_at: now + PREFLIGHT_TICKET_TTL_MS,
    nonce: randomUUID(),
    authorization_hash: authorizationHash(authorization)
  };
  const encodedPayload = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return `${encodedPayload}.${signTicketPayload(config, encodedPayload)}`;
}

function ticketError(message = "NAS 預檢結果已失效，請重新檢查後上傳。") {
  return new HttpError(409, message, "PREFLIGHT_TICKET_INVALID");
}

export function verifyPreflightTicket(config, ticket, expected, authorization, now = Date.now()) {
  const value = firstText(ticket);
  if (!value || value.length > 12_000) throw ticketError();
  const [encodedPayload, providedSignature, ...extra] = value.split(".");
  if (!encodedPayload || !providedSignature || extra.length) throw ticketError();
  const expectedSignature = signTicketPayload(config, encodedPayload);
  const providedBuffer = Buffer.from(providedSignature, "utf8"), expectedBuffer = Buffer.from(expectedSignature, "utf8");
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) throw ticketError();
  let payload;
  try { payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")); } catch { throw ticketError(); }
  if (payload?.version !== 1 || !Number.isFinite(payload.issued_at) || !Number.isFinite(payload.expires_at)) throw ticketError();
  if (payload.expires_at <= now || payload.issued_at > now + 30_000 || payload.expires_at - payload.issued_at !== PREFLIGHT_TICKET_TTL_MS) throw ticketError();
  if (payload.authorization_hash !== authorizationHash(authorization) || payload.actor !== expected.actor) throw ticketError();
  for (const key of ["customer_id", "contract_service_type_id", "project_id"]) {
    if (payload[key] !== expected[key]) throw ticketError();
  }
  const expectedNames = validateFileNames(expected.file_names);
  if (!Array.isArray(payload.file_names) || payload.file_names.length !== expectedNames.length || payload.file_names.some((name, index) => name !== expectedNames[index])) throw ticketError();
  if (!Array.isArray(payload.folder_parts) || payload.folder_parts.length !== 4 || payload.folder_parts.some((part) => part !== safePart(part))) throw ticketError();
  const expectedFolder = `${config.root}/${payload.folder_parts.join("/")}`;
  if (payload.target_folder !== expectedFolder || !Number.isInteger(payload.existing_folder_depth) || payload.existing_folder_depth < 0 || payload.existing_folder_depth > 4) throw ticketError();
  return payload;
}

export function safePart(value, fallback = "未分類") {
  return String(value || fallback)
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || fallback;
}

function encodedPath(pathname) {
  return `/${String(pathname).split("/").filter(Boolean).map((part) => encodeURIComponent(part)).join("/")}`;
}

export function nasConfig() {
  const url = String(process.env.NAS_WEBDAV_URL || "").replace(/\/+$/, "");
  const username = String(process.env.NAS_WEBDAV_USERNAME || "");
  const password = String(process.env.NAS_WEBDAV_PASSWORD || "");
  const root = String(process.env.NAS_WEBDAV_ROOT || "/GUC-ERP").replace(/\/+$/, "") || "/GUC-ERP";
  const missing = [["NAS_WEBDAV_URL", url], ["NAS_WEBDAV_USERNAME", username], ["NAS_WEBDAV_PASSWORD", password]].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new HttpError(503, `NAS 環境變數尚未完整設定（缺少：${missing.join("、")}）。`, "NAS_CONFIG_MISSING");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new HttpError(500, "NAS_WEBDAV_URL 必須使用 HTTPS。", "NAS_URL_INSECURE");
  if (root !== "/GUC-ERP") throw new HttpError(500, "NAS_WEBDAV_ROOT 必須設定為 /GUC-ERP。", "NAS_ROOT_INVALID");
  return { url, username, password, root };
}

function logEvent(level, event, fields = {}) {
  const payload = { service: "erp-nas", event, ...fields };
  const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  writer(JSON.stringify(payload));
}

async function gatewayRequest(path, authorization, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(`${GATEWAY_ENDPOINT}${path}`, {
      headers: { Authorization: authorization },
      cache: "no-store",
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new HttpError(504, `${label}回應逾時，請稍後再試。`, "GATEWAY_TIMEOUT");
    throw new HttpError(502, `目前無法連接${label}。`, "GATEWAY_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
}

async function currentUser(request) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw new HttpError(401, "請先登入 ERP。", "AUTH_REQUIRED");
  const response = await gatewayRequest("?scope=session", authorization, "ERP 登入服務");
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.current_user) throw new HttpError(401, "ERP 登入狀態已失效，請重新登入。", "AUTH_EXPIRED");
  if (!["admin", "operator"].includes(data.current_user.role)) throw new HttpError(403, "目前帳號沒有附件上傳權限。", "ROLE_FORBIDDEN");
  return { user: data.current_user, authorization };
}

async function resolveUploadContext(customerId, contractServiceTypeId, projectId, authorization) {
  const response = await gatewayRequest("?scope=sites", authorization, "ERP 承攬資料服務");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(response.status === 401 ? 401 : 502, data.error || "無法讀取 ERP 承攬資料。", "CONTRACT_LOOKUP_FAILED");
  const customer = Array.isArray(data.customers) ? data.customers.find((row) => row.id === customerId) : null;
  const contractService = Array.isArray(data.contract_service_types) ? data.contract_service_types.find((row) => row.id === contractServiceTypeId && row.is_active !== false) : null;
  const linked = Array.isArray(data.customer_contract_services) && data.customer_contract_services.some((row) => row.customer_id === customerId && row.service_type_id === contractServiceTypeId);
  if (!customer || !contractService || !linked) throw new HttpError(400, "找不到客戶承攬內容或關聯已失效，請重新選擇。", "CONTRACT_NOT_FOUND");
  const project = Array.isArray(data.projects) ? data.projects.find((row) => row.id === projectId && row.customer_id === customerId) : null;
  if (!project) throw new HttpError(400, "找不到此客戶的專案；缺少專案時禁止上傳。", "PROJECT_REQUIRED");

  return {
    contractServiceName: safePart(contractService.name, "未命名承攬內容"),
    customerName: safePart(customer.name, "未命名客戶"),
    projectName: safePart(project.name, "未命名專案"),
    logDate: formatTaipeiDate()
  };
}

export function formatTaipeiDate(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function davRequest(config, method, pathname, body, extraHeaders = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(config.requestTimeoutMs) > 0 ? Number(config.requestTimeoutMs) : REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${config.url}${encodedPath(pathname)}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64")}`,
        ...extraHeaders
      },
      body,
      redirect: "error",
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new HttpError(504, "NAS 回應逾時，請稍後再試。", "NAS_TIMEOUT");
    throw new HttpError(502, "Vercel 目前無法連接 NAS WebDAV。", "NAS_UNREACHABLE");
  } finally {
    clearTimeout(timer);
  }
}

function statusError(status, action) {
  if (status === 401) return new HttpError(502, "NAS 專用帳號或密碼不正確。", "NAS_AUTH_FAILED");
  if (status === 403) return new HttpError(502, "NAS 專用帳號沒有 /GUC-ERP 寫入權限。", "NAS_PERMISSION_DENIED");
  if (status === 404) return new HttpError(502, "NAS 上找不到 /GUC-ERP 共用資料夾。", "NAS_ROOT_MISSING");
  if (status === 423) return new HttpError(503, "NAS 目標目前被鎖定，請稍後再試。", "NAS_LOCKED");
  if (status >= 500) return new HttpError(502, `NAS ${action}暫時失敗（${status}）。`, "NAS_UPSTREAM_ERROR");
  return new HttpError(502, `NAS ${action}失敗（${status}）。`, "NAS_UNEXPECTED_STATUS");
}

async function requireRoot(config, request = davRequest) {
  const response = await request(config, "PROPFIND", config.root, undefined, { Depth: "0" });
  if (![200, 207].includes(response.status)) throw statusError(response.status, "根目錄檢查");
}

async function pathExists(config, pathname, request = davRequest) {
  const response = await request(config, "PROPFIND", pathname, undefined, { Depth: "0" });
  if ([200, 207].includes(response.status)) return true;
  if (response.status === 404) return false;
  throw statusError(response.status, "路徑檢查");
}

export async function ensureNestedFolder(config, parts, request = davRequest, knownExistingDepth = 0) {
  let pathname = config.root;
  for (let index = 0; index < parts.length; index += 1) {
    const rawPart = parts[index];
    pathname += `/${safePart(rawPart)}`;
    if (index < knownExistingDepth) continue;
    if (await pathExists(config, pathname, request)) continue;
    const created = await request(config, "MKCOL", pathname);
    if (![201, 204, 405].includes(created.status)) throw statusError(created.status, "資料夾建立");
    if (created.status === 405 && !(await pathExists(config, pathname, request))) throw new HttpError(409, "NAS 資料夾建立發生競態衝突，請重試。", "NAS_FOLDER_RACE");
  }
  return pathname;
}

export async function inspectNestedFolders(config, parts, request = davRequest) {
  let pathname = config.root, parentExists = true;
  const folders = [];
  for (const rawPart of parts) {
    pathname += `/${safePart(rawPart)}`;
    const exists = parentExists ? await pathExists(config, pathname, request) : false;
    folders.push({ pathname, exists });
    parentExists = exists;
  }
  return folders;
}

function splitFileName(fileName) {
  const index = fileName.lastIndexOf(".");
  return index > 0 ? { stem: fileName.slice(0, index), extension: fileName.slice(index) } : { stem: fileName, extension: "" };
}

export function renamedFileName(fileName, attempt) {
  const { stem, extension } = splitFileName(safePart(fileName, "附件"));
  return safePart(`${stem} (${attempt})${extension}`, "附件");
}

export async function allocateRenamedFile(config, targetFolder, fileName, request = davRequest) {
  for (let attempt = 2; attempt <= 101; attempt += 1) {
    const storedName = renamedFileName(fileName, attempt);
    const nasPath = `${targetFolder}/${storedName}`;
    if (!(await pathExists(config, nasPath, request))) return { storedName, nasPath };
  }
  throw new HttpError(409, "同名檔案過多，無法取得可用的新檔名。", "NAS_RENAME_LIMIT");
}

async function preflightFiles(config, targetFolder, fileNames, request = davRequest) {
  return mapWithConcurrency(validateFileNames(fileNames), NAS_CONCURRENCY, async (storedName) => {
    const nasPath = `${targetFolder}/${storedName}`;
    const exists = await pathExists(config, nasPath, request);
    const suggestion = exists ? await allocateRenamedFile(config, targetFolder, storedName, request) : null;
    return { name: storedName, nas_path: nasPath, exists, suggested_name: suggestion?.storedName || "" };
  });
}

export function formatFolderTimestamp(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
}

export function folderCandidateName(baseName, timestamp, attempt) {
  if (attempt === 0) return baseName;
  if (attempt === 1) return `${baseName}_${timestamp}`;
  return `${baseName}_${timestamp}_${String(attempt).padStart(2, "0")}`;
}

export async function allocateUploadFolder(config, baseName, now = new Date(), request = davRequest) {
  const timestamp = formatFolderTimestamp(now);
  for (let attempt = 0; attempt < MAX_FOLDER_ATTEMPTS; attempt += 1) {
    const name = folderCandidateName(baseName, timestamp, attempt);
    const pathname = `${config.root}/${name}`;
    if (await pathExists(config, pathname, request)) continue;

    const created = await request(config, "MKCOL", pathname);
    if ([201, 204].includes(created.status)) return { pathname, collisionResolved: attempt > 0, attempt };
    if ([405, 409, 412].includes(created.status)) continue;
    throw statusError(created.status, "資料夾建立");
  }
  throw new HttpError(409, "NAS 無法取得唯一資料夾名稱，請稍後再試。", "NAS_FOLDER_COLLISION_LIMIT");
}

function supportedFile(file) {
  const extension = String(file.name || "").split(".").pop()?.toLowerCase() || "";
  return ALLOWED_EXTENSIONS.has(extension);
}

export function validateUploadFiles(files) {
  if (!files.length || files.length > MAX_FILES) throw new HttpError(400, `請選擇 1～${MAX_FILES} 個附件。`, "FILE_COUNT_INVALID");
  if (files.reduce((sum, file) => sum + Number(file.size || 0), 0) > MAX_TOTAL_BYTES) throw new HttpError(413, "單次附件合計不可超過 80 MB。", "TOTAL_SIZE_EXCEEDED");
  for (const file of files) {
    if (!Number(file.size)) throw new HttpError(400, `${safePart(file.name, "附件")} 是空白檔案，請重新選擇。`, "EMPTY_FILE");
    if (file.size > MAX_FILE_BYTES) throw new HttpError(413, `${safePart(file.name, "附件")} 超過 20 MB。`, "FILE_SIZE_EXCEEDED");
    if (!String(file.name || "").trim() || String(file.name).length > 160) throw new HttpError(400, "附件檔名不可空白或超過 160 個字元。", "FILE_NAME_INVALID");
    if (!supportedFile(file)) throw new HttpError(415, `${safePart(file.name, "附件")} 的檔案格式不支援。`, "FILE_TYPE_UNSUPPORTED");
  }
  const names = files.map((file) => safePart(file.name, "附件").toLocaleLowerCase("zh-Hant"));
  if (new Set(names).size !== names.length) throw new HttpError(400, "同一批附件不可包含重複檔名。", "DUPLICATE_FILE_NAME");
}

export function validateFileNames(names) {
  if (!Array.isArray(names) || names.length < 1 || names.length > MAX_FILES) throw new HttpError(400, `請提供 1～${MAX_FILES} 個附件檔名。`, "FILE_COUNT_INVALID");
  const sanitized = names.map((name) => {
    const original = firstText(name);
    if (!original || original.length > 160) throw new HttpError(400, "附件檔名不可空白或超過 160 個字元。", "FILE_NAME_INVALID");
    const extension = original.split(".").pop()?.toLowerCase() || "";
    if (!ALLOWED_EXTENSIONS.has(extension)) throw new HttpError(415, `${safePart(original, "附件")} 的檔案格式不支援。`, "FILE_TYPE_UNSUPPORTED");
    return safePart(original, "附件");
  });
  if (new Set(sanitized.map((name) => name.toLocaleLowerCase("zh-Hant"))).size !== sanitized.length) throw new HttpError(400, "同一批附件不可包含重複檔名。", "DUPLICATE_FILE_NAME");
  return sanitized;
}

function contentLengthFromPropfind(xml) {
  const match = String(xml || "").match(/<(?:[^:>]+:)?getcontentlength[^>]*>\s*(\d+)\s*<\/(?:[^:>]+:)?getcontentlength>/i);
  return match ? Number(match[1]) : null;
}

export async function verifyUploadedFile(config, nasPath, expectedBytes, request = davRequest) {
  const head = await request(config, "HEAD", nasPath);
  if ([200, 204].includes(head.status)) {
    const length = head.headers?.get?.("content-length");
    if (length !== null && Number(length) !== expectedBytes) throw new HttpError(502, "NAS 檔案大小驗證失敗。", "NAS_SIZE_MISMATCH");
    return true;
  }
  if (head.status === 404) throw new HttpError(502, "NAS 寫入後找不到檔案。", "NAS_VERIFY_MISSING");
  if (![405, 501].includes(head.status)) throw statusError(head.status, "檔案驗證");

  const propfind = await request(config, "PROPFIND", nasPath, undefined, { Depth: "0" });
  if (![200, 207].includes(propfind.status)) throw statusError(propfind.status, "檔案驗證");
  const recordedBytes = contentLengthFromPropfind(await propfind.text());
  if (recordedBytes !== null && recordedBytes !== expectedBytes) throw new HttpError(502, "NAS 檔案大小驗證失敗。", "NAS_SIZE_MISMATCH");
  return true;
}

async function uploadFile(config, targetFolder, file, conflictAction = "new", request = davRequest) {
  const totalStartedAt = Date.now(), readStartedAt = Date.now();
  const buffer = Buffer.from(await file.arrayBuffer());
  const readMs = elapsedMs(readStartedAt), conflictStartedAt = Date.now();
  const id = randomUUID(), originalName = String(file.name || "attachment"), safeName = safePart(originalName, "attachment");
  let storedName = safeName, nasPath = `${targetFolder}/${storedName}`, resolution = "new";
  const exists = await pathExists(config, nasPath, request);
  if (exists) {
    if (conflictAction === "cancel") return { skipped: true, originalName, reason: "使用者取消同名檔案" };
    if (conflictAction === "rename") { const allocated = await allocateRenamedFile(config, targetFolder, safeName, request); storedName = allocated.storedName; nasPath = allocated.nasPath; resolution = "rename"; }
    else if (conflictAction === "overwrite") resolution = "overwrite";
    else throw new HttpError(409, `${safeName} 已存在，請選擇覆蓋、另存新檔或取消。`, "NAS_FILE_CONFLICT");
  }
  const conflictMs = elapsedMs(conflictStartedAt), putStartedAt = Date.now();
  const response = await request(config, "PUT", nasPath, buffer, {
    "Content-Type": file.type || "application/octet-stream",
    "Content-Length": String(buffer.length),
    [resolution === "overwrite" ? "If-Match" : "If-None-Match"]: "*"
  });
  if (response.status === 412) throw new HttpError(409, `${storedName} 的狀態已改變，請重新檢查後再上傳。`, "NAS_FILE_RACE");
  if (![200, 201, 204].includes(response.status)) throw statusError(response.status, "檔案寫入");
  const putMs = elapsedMs(putStartedAt), verifyStartedAt = Date.now();
  await verifyUploadedFile(config, nasPath, buffer.length, request);
  const verifyMs = elapsedMs(verifyStartedAt), hashStartedAt = Date.now();
  const sha256 = createHash("sha256").update(buffer).digest("hex"), hashMs = elapsedMs(hashStartedAt);
  return { id, originalName, storedName, nasPath, conflictResolution: resolution, size: buffer.length, sha256, timing: { read_ms: readMs, conflict_ms: conflictMs, put_ms: putMs, verify_ms: verifyMs, hash_ms: hashMs, total_ms: elapsedMs(totalStartedAt) } };
}

export default {
  async fetch(request) {
    const requestId = request.headers.get("x-vercel-id") || randomUUID(), requestStartedAt = Date.now();
    try {
      if (!["preview", "production"].includes(process.env.VERCEL_ENV || "")) throw new HttpError(403, "NAS 上傳僅限已部署的 ERP 環境。", "DEPLOYMENT_ONLY");
      if (!["GET", "POST"].includes(request.method)) throw new HttpError(405, "僅支援 GET 與 POST。", "METHOD_NOT_ALLOWED");
      if (process.env.VERCEL_ENV === "preview" && request.method === "POST") throw new HttpError(403, "Preview 環境禁止寫入 NAS；請使用介面安全模擬。", "PREVIEW_NAS_WRITE_BLOCKED");
      const authStartedAt = Date.now();
      const { user, authorization } = await currentUser(request);
      const authMs = elapsedMs(authStartedAt);
      const config = nasConfig();

      if (request.method === "GET") {
        const rootStartedAt = Date.now();
        await requireRoot(config);
        const timing = { auth_ms: authMs, root_ms: elapsedMs(rootStartedAt), total_ms: elapsedMs(requestStartedAt) };
        logEvent("info", "health_ok", { request_id: requestId, actor: user.username, timing });
        return json({ ok: true, available: true, root: config.root, message: "NAS WebDAV 已連線", timing });
      }

      const formStartedAt = Date.now();
      const form = await request.formData();
      const formMs = elapsedMs(formStartedAt);
      const mode = firstText(form.get("mode")) || "upload";
      const customerId = firstText(form.get("customer_id"));
      const contractServiceTypeId = firstText(form.get("contract_service_type_id"));
      const projectId = firstText(form.get("project_id"));
      const description = firstText(form.get("description")).slice(0, 1000);
      const assetType = firstText(form.get("attachment_type")) === "document" ? "document" : "photo";
      if (!customerId || !contractServiceTypeId || !projectId) throw new HttpError(400, "缺少客戶、承攬內容或專案資料；附件未上傳。", "UPLOAD_CONTEXT_REQUIRED");

      if (mode === "preflight") {
        let fileNames;
        try { fileNames = JSON.parse(firstText(form.get("file_names")) || "[]"); } catch { throw new HttpError(400, "附件檔名清單格式不正確。", "FILE_NAMES_INVALID"); }
        validateFileNames(fileNames);
        const rootStartedAt = Date.now();
        await requireRoot(config);
        const rootMs = elapsedMs(rootStartedAt), contextStartedAt = Date.now();
        const { customerName, contractServiceName, projectName, logDate } = await resolveUploadContext(customerId, contractServiceTypeId, projectId, authorization);
        const contextMs = elapsedMs(contextStartedAt), folderParts = [customerName, contractServiceName, projectName, logDate];
        const targetFolder = `${config.root}/${customerName}/${contractServiceName}/${projectName}/${logDate}`, nasPreflightStartedAt = Date.now();
        const [folders, files] = await Promise.all([
          inspectNestedFolders(config, folderParts),
          preflightFiles(config, targetFolder, fileNames)
        ]);
        const existingFolderDepth = folders.findIndex((folder) => !folder.exists);
        const preflightTicket = createPreflightTicket(config, {
          actor: user.username,
          customer_id: customerId,
          contract_service_type_id: contractServiceTypeId,
          project_id: projectId,
          file_names: files.map((file) => file.name),
          folder_parts: folderParts,
          target_folder: targetFolder,
          existing_folder_depth: existingFolderDepth === -1 ? folders.length : existingFolderDepth
        }, authorization);
        const timing = { auth_ms: authMs, form_ms: formMs, root_ms: rootMs, context_ms: contextMs, nas_preflight_ms: elapsedMs(nasPreflightStartedAt), total_ms: elapsedMs(requestStartedAt) };
        logEvent("info", "preflight_completed", { request_id: requestId, actor: user.username, folder: targetFolder, file_count: files.length, conflict_count: files.filter((file) => file.exists).length, timing });
        return json({ ok: true, upload_folder: targetFolder, folders, target_folder_exists: folders.at(-1)?.exists === true, files, conflicts: files.filter((file) => file.exists), preflight_ticket: preflightTicket, timing });
      }
      if (mode !== "upload") throw new HttpError(400, "附件操作模式不正確。", "UPLOAD_MODE_INVALID");

      const files = form.getAll("files").filter((file) => file && typeof file.arrayBuffer === "function");
      validateUploadFiles(files);
      let conflictActions = {};
      try { conflictActions = JSON.parse(firstText(form.get("conflict_actions")) || "{}"); } catch { throw new HttpError(400, "同名檔案處理選項格式不正確。", "CONFLICT_ACTION_INVALID"); }
      if (!conflictActions || typeof conflictActions !== "object" || Array.isArray(conflictActions)) throw new HttpError(400, "同名檔案處理選項格式不正確。", "CONFLICT_ACTION_INVALID");
      const ticketStartedAt = Date.now(), preflightTicket = firstText(form.get("preflight_ticket"));
      let folderParts, targetFolder, existingFolderDepth = 0, fallbackValidationMs = 0, ticketReused = false;
      if (preflightTicket) {
        const ticket = verifyPreflightTicket(config, preflightTicket, {
          actor: user.username,
          customer_id: customerId,
          contract_service_type_id: contractServiceTypeId,
          project_id: projectId,
          file_names: files.map((file) => file.name)
        }, authorization);
        folderParts = ticket.folder_parts;
        targetFolder = ticket.target_folder;
        existingFolderDepth = ticket.existing_folder_depth;
        ticketReused = true;
      } else {
        const fallbackStartedAt = Date.now();
        await requireRoot(config);
        const context = await resolveUploadContext(customerId, contractServiceTypeId, projectId, authorization);
        folderParts = [context.customerName, context.contractServiceName, context.projectName, context.logDate];
        targetFolder = `${config.root}/${folderParts.join("/")}`;
        fallbackValidationMs = elapsedMs(fallbackStartedAt);
      }
      const ticketMs = elapsedMs(ticketStartedAt), folderStartedAt = Date.now();
      await ensureNestedFolder(config, folderParts, davRequest, existingFolderDepth);
      const folderMs = elapsedMs(folderStartedAt);
      logEvent("info", "folder_ready", { request_id: requestId, actor: user.username, folder: targetFolder, file_count: files.length, preflight_ticket_reused: ticketReused, timing: { ticket_ms: ticketMs, fallback_validation_ms: fallbackValidationMs, folder_ms: folderMs } });

      const uploadStartedAt = Date.now();
      const outcomes = await mapWithConcurrency(files, NAS_CONCURRENCY, async (file, index) => {
        try {
          const result = await uploadFile(config, targetFolder, file, firstText(conflictActions[safePart(file.name, "附件")]) || firstText(conflictActions[file.name]) || "new");
          if (result.skipped) return { failed: { name: safePart(file.name, `附件 ${index + 1}`), error: result.reason, skipped: true } };
          const uploaded = {
            id: result.id,
            customer_id: customerId,
            contract_service_type_id: contractServiceTypeId,
            project_id: projectId,
            log_date: folderParts[3],
            title: result.originalName,
            description,
            asset_type: assetType,
            original_name: result.originalName,
            mime_type: file.type || "application/octet-stream",
            file_size: result.size,
            nas_path: result.nasPath,
            stored_name: result.storedName,
            conflict_resolution: result.conflictResolution,
            upload_status: "uploaded",
            uploaded_by: user.username,
            uploaded_at: new Date().toISOString(),
            sha256: result.sha256
          };
          logEvent("info", "file_verified", { request_id: requestId, folder: targetFolder, file_index: index + 1, bytes: result.size, timing: result.timing });
          return { uploaded, timing: result.timing };
        } catch (error) {
          const message = error instanceof HttpError ? error.message : "NAS 寫入失敗，請稍後重試。";
          logEvent("warn", "file_failed", { request_id: requestId, folder: targetFolder, file_index: index + 1, code: error?.code || "NAS_FILE_FAILED" });
          return { failed: { name: safePart(file.name, `附件 ${index + 1}`), error: message } };
        }
      });
      const uploaded = outcomes.flatMap((outcome) => outcome.uploaded ? [outcome.uploaded] : []);
      const failed = outcomes.flatMap((outcome) => outcome.failed ? [outcome.failed] : []);
      const timing = { auth_ms: authMs, form_ms: formMs, ticket_ms: ticketMs, fallback_validation_ms: fallbackValidationMs, folder_ms: folderMs, files_ms: elapsedMs(uploadStartedAt), total_ms: elapsedMs(requestStartedAt), file_timings: outcomes.flatMap((outcome) => outcome.timing ? [outcome.timing] : []) };

      if (!uploaded.length && failed.every((row) => row.skipped)) return json({ ok: false, upload_folder: targetFolder, uploaded, failed, timing }, 200);
      if (!uploaded.length) throw new HttpError(502, `附件未能完成寫入與驗證；NAS 資料夾已保留：${targetFolder}`, "ALL_FILES_FAILED");
      logEvent("info", "upload_completed", { request_id: requestId, folder: targetFolder, uploaded: uploaded.length, failed: failed.length, preflight_ticket_reused: ticketReused, timing });
      return json({
        ok: failed.length === 0,
        upload_folder: targetFolder,
        uploaded,
        failed,
        timing
      }, failed.length ? 207 : 201);
    } catch (error) {
      const status = Number(error?.status) || 500;
      logEvent(status >= 500 ? "error" : "warn", "request_failed", { request_id: requestId, code: error?.code || "NAS_REQUEST_FAILED", status });
      return json({ ok: false, error: error?.message || "NAS 附件服務發生錯誤。", request_id: requestId }, status);
    }
  }
};
