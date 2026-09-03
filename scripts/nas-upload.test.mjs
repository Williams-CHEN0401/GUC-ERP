import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nasApi, {
  HttpError,
  allocateRenamedFile,
  allocateUploadFolder,
  createPreflightTicket,
  davRequest,
  ensureNestedFolder,
  inspectNestedFolders,
  nasConfig,
  folderCandidateName,
  formatTaipeiDate,
  formatFolderTimestamp,
  mapWithConcurrency,
  safePart,
  renamedFileName,
  validateFileNames,
  validateUploadFiles,
  verifyPreflightTicket,
  verifyUploadedFile
} from "../api/nas.mjs";

const config = { root: "/GUC-ERP" };
const now = new Date("2026-08-28T00:06:00.000Z");

test("前端沿用簽章預檢票證並顯示分階段進度", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(app, /body\.append\("preflight_ticket",preflight\.preflight_ticket\)/);
  assert.match(app, /attachmentUploadProgress/);
  assert.match(app, /scrollIntoView/);
  assert.match(app, /NAS 已完成寫入與檔案大小驗證/);
  assert.match(styles, /\.attachment-upload-progress\[data-stage="uploading"\]/);
});

test("保留中文並清理 WebDAV 非法字元", () => {
  assert.equal(safePart('高雄/中學:*?"<>| 施工照片.jpg'), "高雄_中學_______ 施工照片.jpg");
});

test("資料夾時間採台灣時區且序號規則固定", () => {
  assert.equal(formatTaipeiDate(now), "2026-08-28");
  assert.equal(formatFolderTimestamp(now), "20260828_080600");
  assert.equal(folderCandidateName("案場", "20260828_080600", 0), "案場");
  assert.equal(folderCandidateName("案場", "20260828_080600", 1), "案場_20260828_080600");
  assert.equal(folderCandidateName("案場", "20260828_080600", 2), "案場_20260828_080600_02");
});

test("建立資料夾前檢查同層重名並改用時間名稱", async () => {
  const calls = [];
  const request = async (_config, method, pathname) => {
    calls.push([method, pathname]);
    if (method === "PROPFIND" && pathname === "/GUC-ERP/案場") return new Response("", { status: 207 });
    if (method === "PROPFIND") return new Response("", { status: 404 });
    if (method === "MKCOL") return new Response("", { status: 201 });
    throw new Error("unexpected request");
  };
  const result = await allocateUploadFolder(config, "案場", now, request);
  assert.equal(result.pathname, "/GUC-ERP/案場_20260828_080600");
  assert.equal(result.collisionResolved, true);
  assert.deepEqual(calls.map(([method]) => method), ["PROPFIND", "PROPFIND", "MKCOL"]);
});

test("依客戶、承攬內容、專案、日期逐層檢查並建立固定資料夾", async () => {
  const calls = [];
  const request = async (_config, method, pathname) => {
    calls.push([method, pathname]);
    if (method === "PROPFIND" && pathname === "/GUC-ERP/高雄中學") return new Response("", { status: 207 });
    if (method === "PROPFIND") return new Response("", { status: 404 });
    if (method === "MKCOL") return new Response("", { status: 201 });
    throw new Error("unexpected request");
  };
  const result = await ensureNestedFolder(config, ["高雄中學", "監視系統建置", "校園監控更新", "2026-08-28"], request);
  assert.equal(result, "/GUC-ERP/高雄中學/監視系統建置/校園監控更新/2026-08-28");
  assert.deepEqual(calls.map(([method]) => method), ["PROPFIND", "PROPFIND", "MKCOL", "PROPFIND", "MKCOL", "PROPFIND", "MKCOL"]);
});

test("正式上傳可安全略過預檢已確認存在的資料夾層級", async () => {
  const calls = [];
  const request = async (_config, method, pathname) => {
    calls.push([method, pathname]);
    if (method === "PROPFIND") return new Response("", { status: 404 });
    if (method === "MKCOL") return new Response("", { status: 201 });
    throw new Error("unexpected request");
  };
  await ensureNestedFolder(config, ["高雄中學", "監視系統", "校園更新", "2026-09-03"], request, 2);
  assert.deepEqual(calls.map(([, pathname]) => pathname), [
    "/GUC-ERP/高雄中學/監視系統/校園更新",
    "/GUC-ERP/高雄中學/監視系統/校園更新",
    "/GUC-ERP/高雄中學/監視系統/校園更新/2026-09-03",
    "/GUC-ERP/高雄中學/監視系統/校園更新/2026-09-03"
  ]);
});

test("短效預檢票證綁定登入權杖、使用者、案場與檔名", () => {
  const ticketConfig = { root: "/GUC-ERP", password: "strong-nas-password" };
  const issuedAt = Date.parse("2026-09-03T02:00:00.000Z");
  const payload = {
    actor: "operator",
    customer_id: "customer-1",
    contract_service_type_id: "service-1",
    project_id: "project-1",
    file_names: ["施工照片.jpg"],
    folder_parts: ["高雄中學", "監視系統", "校園更新", "2026-09-03"],
    target_folder: "/GUC-ERP/高雄中學/監視系統/校園更新/2026-09-03",
    existing_folder_depth: 3
  };
  const expected = { actor: payload.actor, customer_id: payload.customer_id, contract_service_type_id: payload.contract_service_type_id, project_id: payload.project_id, file_names: payload.file_names };
  const ticket = createPreflightTicket(ticketConfig, payload, "Bearer session-a", issuedAt);
  assert.equal(verifyPreflightTicket(ticketConfig, ticket, expected, "Bearer session-a", issuedAt + 30_000).target_folder, payload.target_folder);
  assert.throws(() => verifyPreflightTicket(ticketConfig, ticket, expected, "Bearer session-b", issuedAt + 30_000), (error) => error instanceof HttpError && error.code === "PREFLIGHT_TICKET_INVALID");
  assert.throws(() => verifyPreflightTicket(ticketConfig, `${ticket.slice(0, -1)}x`, expected, "Bearer session-a", issuedAt + 30_000), (error) => error instanceof HttpError && error.code === "PREFLIGHT_TICKET_INVALID");
  assert.throws(() => verifyPreflightTicket(ticketConfig, ticket, { ...expected, project_id: "project-2" }, "Bearer session-a", issuedAt + 30_000), (error) => error instanceof HttpError && error.code === "PREFLIGHT_TICKET_INVALID");
  assert.throws(() => verifyPreflightTicket(ticketConfig, ticket, expected, "Bearer session-a", issuedAt + 120_001), (error) => error instanceof HttpError && error.code === "PREFLIGHT_TICKET_INVALID");
});

test("多檔工作最多三個並行且維持輸入順序", async () => {
  let active = 0, peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
});

test("正式上傳沿用票證時仍重新驗證登入，但不重複查詢案場", async () => {
  const envNames = ["VERCEL_ENV", "NAS_WEBDAV_URL", "NAS_WEBDAV_USERNAME", "NAS_WEBDAV_PASSWORD", "NAS_WEBDAV_ROOT"];
  const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  let sitesCalls = 0, putCalls = 0, uploaded = false;
  process.env.VERCEL_ENV = "production";
  process.env.NAS_WEBDAV_URL = "https://nas.example.test/webdav";
  process.env.NAS_WEBDAV_USERNAME = "erp-uploader";
  process.env.NAS_WEBDAV_PASSWORD = "strong-nas-password";
  process.env.NAS_WEBDAV_ROOT = "/GUC-ERP";
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url), method = init.method || "GET";
    if (value.includes("scope=session")) return Response.json({ current_user: { username: "operator", role: "operator" } });
    if (value.includes("scope=sites")) {
      sitesCalls += 1;
      return Response.json({
        customers: [{ id: "customer-1", name: "高雄中學" }],
        contract_service_types: [{ id: "service-1", name: "監視系統", is_active: true }],
        customer_contract_services: [{ customer_id: "customer-1", service_type_id: "service-1" }],
        projects: [{ id: "project-1", customer_id: "customer-1", name: "校園更新" }]
      });
    }
    if (!value.startsWith(process.env.NAS_WEBDAV_URL)) throw new Error(`unexpected url: ${value}`);
    if (method === "PUT") { uploaded = true; putCalls += 1; return new Response(null, { status: 201 }); }
    if (method === "HEAD") return new Response(null, { status: uploaded ? 200 : 404, headers: uploaded ? { "content-length": "5" } : {} });
    if (method === "PROPFIND" && value.endsWith(encodeURIComponent("施工照片.jpg"))) return new Response("", { status: uploaded ? 207 : 404 });
    if (method === "PROPFIND") return new Response("", { status: 207 });
    throw new Error(`unexpected method: ${method}`);
  };
  try {
    const context = (body) => {
      body.append("customer_id", "customer-1");
      body.append("contract_service_type_id", "service-1");
      body.append("project_id", "project-1");
    };
    const preflightBody = new FormData();
    preflightBody.append("mode", "preflight");
    context(preflightBody);
    preflightBody.append("file_names", JSON.stringify(["施工照片.jpg"]));
    const preflightResponse = await nasApi.fetch(new Request("https://erp.example.test/api/nas", { method: "POST", headers: { Authorization: "Bearer session-a" }, body: preflightBody }));
    const preflight = await preflightResponse.json();
    assert.equal(preflightResponse.status, 200);
    assert.ok(preflight.preflight_ticket);

    const uploadBody = new FormData();
    uploadBody.append("mode", "upload");
    context(uploadBody);
    uploadBody.append("preflight_ticket", preflight.preflight_ticket);
    uploadBody.append("conflict_actions", "{}");
    uploadBody.append("files", new File(["hello"], "施工照片.jpg", { type: "image/jpeg" }));
    const uploadResponse = await nasApi.fetch(new Request("https://erp.example.test/api/nas", { method: "POST", headers: { Authorization: "Bearer session-a" }, body: uploadBody }));
    const result = await uploadResponse.json();
    assert.equal(uploadResponse.status, 201);
    assert.equal(result.uploaded.length, 1);
    assert.equal(result.uploaded[0].file_size, 5);
    assert.equal(sitesCalls, 1);
    assert.equal(putCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  }
});

test("預檢會明確回報承攬內容目標資料夾是否存在", async () => {
  const request = async (_config, method, pathname) => {
    assert.equal(method, "PROPFIND");
    return new Response("", { status: pathname.endsWith("/高雄中學") ? 207 : 404 });
  };
  const result = await inspectNestedFolders(config, ["高雄中學", "監視系統建置", "校園監控更新", "2026-08-28"], request);
  assert.deepEqual(result.map((folder) => folder.exists), [true, false, false, false]);
});

test("同名檔案另存新檔採用可預期序號且不覆蓋", async () => {
  assert.equal(renamedFileName("施工照片.jpg", 2), "施工照片 (2).jpg");
  const request = async (_config, method, pathname) => {
    if (method !== "PROPFIND") throw new Error("unexpected request");
    return new Response("", { status: pathname.endsWith("(2).jpg") ? 207 : 404 });
  };
  const result = await allocateRenamedFile(config, "/GUC-ERP/客戶/監控系統/專案/2026-08-28", "施工照片.jpg", request);
  assert.equal(result.storedName, "施工照片 (3).jpg");
});

test("預檢拒絕同批重複檔名", () => {
  assert.throws(() => validateFileNames(["施工照片.jpg", "施工照片.jpg"]), (error) => error instanceof HttpError && error.code === "DUPLICATE_FILE_NAME");
});

test("MKCOL 競態碰撞時不覆寫並繼續換名", async () => {
  let mkcolCount = 0;
  const request = async (_config, method) => {
    if (method === "PROPFIND") return new Response("", { status: 404 });
    if (method === "MKCOL") {
      mkcolCount += 1;
      return new Response("", { status: mkcolCount === 1 ? 405 : 201 });
    }
    throw new Error("unexpected request");
  };
  const result = await allocateUploadFolder(config, "案場", now, request);
  assert.equal(result.pathname, "/GUC-ERP/案場_20260828_080600");
  assert.equal(mkcolCount, 2);
});

test("HEAD 不支援時以 PROPFIND 驗證檔案存在與大小", async () => {
  const request = async (_config, method) => {
    if (method === "HEAD") return new Response("", { status: 405 });
    if (method === "PROPFIND") return new Response('<d:multistatus xmlns:d="DAV:"><d:getcontentlength>12</d:getcontentlength></d:multistatus>', { status: 207 });
    throw new Error("unexpected request");
  };
  assert.equal(await verifyUploadedFile(config, "/GUC-ERP/案場/a.pdf", 12, request), true);
});

test("拒絕空白檔案", () => {
  assert.throws(
    () => validateUploadFiles([{ name: "空白.pdf", size: 0 }]),
    (error) => error instanceof HttpError && error.code === "EMPTY_FILE"
  );
});

test("拒絕超大檔案與超量多檔", () => {
  assert.throws(
    () => validateUploadFiles([{ name: "大型檔.pdf", size: 20 * 1024 * 1024 + 1 }]),
    (error) => error instanceof HttpError && error.code === "FILE_SIZE_EXCEEDED"
  );
  assert.throws(
    () => validateUploadFiles(Array.from({ length: 11 }, (_, index) => ({ name: `${index}.pdf`, size: 1 }))),
    (error) => error instanceof HttpError && error.code === "FILE_COUNT_INVALID"
  );
});

test("WebDAV 逾時回傳可辨識錯誤且不洩漏連線資訊", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  try {
    await assert.rejects(
      davRequest({ url: "https://nas.invalid", username: "user", password: "secret", requestTimeoutMs: 5 }, "PROPFIND", "/GUC-ERP"),
      (error) => error instanceof HttpError && error.code === "NAS_TIMEOUT" && !error.message.includes("secret")
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NAS 設定缺少時只列出變數名稱且不洩漏密碼", () => {
  const names = ["NAS_WEBDAV_URL", "NAS_WEBDAV_USERNAME", "NAS_WEBDAV_PASSWORD", "NAS_WEBDAV_ROOT"];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    delete process.env.NAS_WEBDAV_URL;
    process.env.NAS_WEBDAV_USERNAME = "nas-user";
    delete process.env.NAS_WEBDAV_PASSWORD;
    assert.throws(
      () => nasConfig(),
      (error) => error instanceof HttpError
        && error.code === "NAS_CONFIG_MISSING"
        && error.message.includes("NAS_WEBDAV_URL")
        && error.message.includes("NAS_WEBDAV_PASSWORD")
        && !error.message.includes("nas-user")
    );
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});
