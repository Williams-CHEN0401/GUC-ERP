import test from "node:test";
import assert from "node:assert/strict";
import {
  HttpError,
  allocateRenamedFile,
  allocateUploadFolder,
  davRequest,
  ensureNestedFolder,
  inspectNestedFolders,
  nasConfig,
  folderCandidateName,
  formatTaipeiDate,
  formatFolderTimestamp,
  safePart,
  renamedFileName,
  validateFileNames,
  validateUploadFiles,
  verifyUploadedFile
} from "../api/nas.mjs";

const config = { root: "/GUC-ERP" };
const now = new Date("2026-08-28T00:06:00.000Z");

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
