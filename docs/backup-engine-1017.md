# 1017 備份引擎與復原驗證

實作：`docker/backup-engine.mjs`，由 `backup-service.mjs` 的管理者授權服務呼叫。備份密碼與解密金鑰不寫入工作紀錄；密碼遺失無法復原。正式資料僅備份讀取，網站入口的復原僅建立全新隔離驗證環境。

## 封存範圍

- 網站：所選程式碼完整檔案、Git revision、逐檔 SHA-256 與來源樹 SHA-256；排除 `.git`、`node_modules`、`.next`、本機環境檔、測試證據與私鑰。未提交程式也包含在來源樹雜湊。
- 映像：另選 Docker images 才執行 `docker image save`，記錄固定 image ID、repo digests；預覽必須設定明確候選 image，不能借用舊正式映像冒充修改後版本。
- 共用資料庫：單一 PostgreSQL `REPEATABLE READ READ ONLY` 匯出快照供 `pg_dump -Fc --snapshot` 使用，包含三套系統及 Auth；另保存 roles 與必要 DB/Vault 設定。角色、序列在備份前後變動會停止，避免不一致。Storage/NAS 必須與資料庫同選。
- 部署：`compose*.yaml/yml`、部署/網域設定、`.env.production`、Supabase `.env/.env.functions` 與 functions。機密設定僅存在有 ACL 保護的暫存及 AES-GCM 加密套件內。
- Storage：既有容器 volume 以唯讀掛載 tar；測試環境可使用合成檔案目錄。
- NAS：WebDAV `PROPFIND/GET` 唯讀取得設定根目錄。限制同 origin、根路徑、無 redirect、無 XML 實體、回應大小與檔案總量；ETag 變動停止。

附件與資料庫不支援跨服務原子快照。備份期間應避免修改附件及程式碼；套件會記錄此限制，不能將逐檔檢查誤稱為全服務同時快照。HTTPS 憑證 volume 與外部服務狀態不在本引擎的已驗證復原範圍；正式切換須依原部署設定重新設定或續發憑證。

## 檔案與設定

工作輸出固定 `directory/<UUID>.gucbackup`。容器格式由 `backup-archive.mjs` 處理：串流 gzip、AES-256-GCM、scrypt、逐檔 SHA-256。寫完後立即完整解密驗證。`prepareDirectory` 在 Windows 限登入帳號與 SYSTEM，在 Linux 使用 mode 0700。

`capture-*`、`verify-*`、`inspect-*` 僅可位於設定工作根目錄下；安全清理會檢查最終絕對路徑及 symlink。密碼錯誤、竄改、過期或還原完成後不保留解密檔案。主機突然斷電時可能留下暫存；服務重新啟動取得獨占工作目錄鎖後，僅停止帶有同工作目錄hash/有效job標記且名稱符合的隔離還原容器，然後清除失效暫存。未標記、其他工作目錄及正式容器均不觸碰。

`config.mode=isolated` 僅允許 `guc_*preview*` 資料庫，roles 強制 `--no-role-passwords`；Vault 必須為空，套件使用新隨機測試 key，避免預覽下載攜出正式 key。`production` 僅允許 `postgres`，完整 role/Vault 機密只存在加密套件。

## 復原流程

1. 套件先驗證密碼、GCM、檔名、容量、逐檔 hash、網站白名單與版本；不採信套件提供的任意路徑或 Docker image。
2. 使用主機設定的可信任現有 DB image，建立隨機命名、network-none、唯讀 rootfs、cap-drop ALL、no-new-privileges、memory/pids/tmpfs 限制的容器。只掛本次解密資料庫資料夾為唯讀，不掛正式 volume。
3. 新 initdb、載入 roles、以單一交易 `pg_restore --exit-on-error` 還原；對全部表列數/內容、函式/ACL、RLS/policy、序列與 Vault 解密摘要逐項核對。
4. 呼叫還原 DB 的 `quotation_options_v1` 與 `construction_scope_v1`。若設定 `rest.container` 或可信任 `rest.image`，另開 PostgREST 僅共用無外部網路的 loopback，實際測試 customers 與上述兩個 HTTP RPC。沒有發布任何 host port。
5. 所有測試容器及解密暫存清理。此步驟不切換正式網站，不將附件寫回 NAS；正式復原切換仍需維運部署流程。

## 實測證據

- [PASS] `docker/backup-engine.test.mjs`：WebDAV 中文巢狀附件、跨網域/冒號/尾點/XML實體/redirect/ETag/容量拒絕、錯誤 profile、附件相依資料庫、偽造 manifest 網站路徑。
- [PASS] `../backup-engine-check.mjs`：實際隔離 DB、修改後 Site 原始碼、合成 NAS/Storage、部署設定加密封存；密碼錯誤與竄改均拒絕。
- [PASS] `../backup-engine-evidence/engine-results.json`：133 張表、4567 筆、6 個合成 Auth 帳號與全部指紋一致；真正 PostgREST HTTP RPC 正常；來源 hash、暫存/容器清理通過。筆數為該次測試快照，後續合成測試可能改變。
- [PASS] `../backup-engine-orphan-check.mjs` 與 `../backup-engine-evidence/orphan-results.json`：真實標記孤兒容器停止、無標記容器及正式資料庫完全不變，解密暫存清除而完成備份保留。
- [PASS] `../system-1017/backup-image-results.json`：實際候選ERP映像與來源加密封存、image reload 保持相同image ID；無網路容器啟動並回應UI200，機密路徑404，未設定備份服務503。
- [NOT VERIFIED] 真正外部 NAS 主機、實際正式資料復原、外部 OAuth provider、把網站容器切換至還原 DB 的瀏覽器登入。`applicationHttpApiVerified=true` 不等於 `applicationRuntimeVerified=true`。

執行 unit：`node --test docker/backup-engine.test.mjs`；完整還原驗證必須在明確隔離 profile 執行 `node ../backup-engine-check.mjs`，過程只讀來源 DB、所有寫入限定新隔離容器。
