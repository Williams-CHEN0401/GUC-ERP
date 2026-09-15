# 工作日誌新增修正（v1.9.1）

來源：Williams-CHEN0401/GUC-ERP，2026-09-15 03:58 +08:00 fetch 後的 origin/main `face9b961e2bf30ea40eed87cc356dcc00569935`。本機隔離分支 `codex/fix-worklog-create-20260915`。

## 原因與修正

- `upsert_customer_project_work_log_department_v1` 是 SECURITY INVOKER，但直接讀寫 `work_log_save_requests`；正式 service_role 並沒有該表權限。帶 request_id 的新增必定失敗。若省略 request_id 且選擇維修品，則會在直接 UPDATE `repair_items` 時因相同的權限邊界問題失敗。兩者皆已使用相同限制於本機重現。
- 保留 invoker、RLS、ACL 與既有 RBAC。由現有 `upsert_customer_project_work_log_with_maintenance_v2` 負責 request replay；科室包裝函式不再碰受保護的 replay 表。客戶／科室鎖與檢查仍先執行。
- 新增維修品的科室繼承移入現有 maintenance v1 INSERT，一併留下 audit；不再於 invoker 包裝函式直接修改維修品。未重寫既有資料。
- 自動建立工作內容時，沿用現有六種工作類型對應，不再將維修、送貨、文書、場勘初始建立為保養。
- 欄位名稱改為「工作內容」。選擇「維修/查修」時隱藏並停用該欄位，不參與表單必填檢查。新日誌以故障內容、處理流程產生摘要；皆空白時使用使用者填寫的日誌標題，不要求重複描述。完整故障與處理流程仍各自儲存，摘要遵循既有 2000 字上限。
- 修改舊日誌時保留既有自由文字、事件描述與處理結果；切換非維修類型會恢復工作內容欄位及先前輸入。

## 驗證

1. `npm run check`：217 項通過。
2. `node scripts/verify-worklog-save-db.mjs`：先重現兩種 permission denied，再驗證修正、重複套用 migration、資料與 ACL 不變、六種工作類型、重複送出、失敗回滾、過期版本及未授權／跨科室拒絕。
3. `node scripts/verify-worklog-save-http.mjs`：實際 inventory-gateway 程式驗證輸入，呼叫實際 SQL RPC，以受限 service_role 寫入本機 PGlite，再讀回核對日期、科室、摘要及維修品。只有測試登入與無關案場建立使用隔離適配，不使用正式登入或金鑰。
4. 瀏覽器手動走完「國立高雄大學 → 應用數學系」選擇，建立「應用數學系設備查修（流程測試）」；未填隱藏工作內容，填入故障與處理流程，選擇測試設備品項。儲存並讀回成功，自動建立 1 篇日誌、1 筆維修事件、1 筆維修品；取貨詢問與跳轉正常。
5. 重新整理、開啟同一筆日誌、修改備註後再次儲存並核對成功；維修品仍只有 1 筆，日誌與事件版本皆為 2。

客戶與科室關係依正式唯讀查詢核實；版本庫內測試 UUID、測試人員、承攬項目、設備與工作描述均為隔離範例，不包含正式資料備份。PGlite 測試相依套件可透過 `PGLITE_MODULE` 指向既有安裝的 `@electric-sql/pglite/dist/index.js`（file URL）。

## 測試網站與發布限制

`node scripts/worklog-save-preview-server.mjs` 啟動 `http://127.0.0.1:4198/?page=worklogs`，僅綁定本機，允許測試工作日誌新增／修改；其他寫入及 NAS 均拒絕。伺服器重啟會重置隔離資料。

使用者於 2026-09-15 確認正式發布。發布順序：備份及 preflight → GitHub PR／CI／Vercel Preview → 套用 `20260914200535_fix_worklog_department_save_boundary.sql` → 合併 main 與確認 Production READY → 建立 v1.9.1。無新增環境變數，不需更換 Auth、放寬政策或更新 Gateway 程式。

上一正式部署（回復目標）：`dpl_4pJ5yEaB9f3etcXoh9vXdeRZ79Bd`，main `face9b961e2bf30ea40eed87cc356dcc00569935`。完成後的正式部署 ID 與 migration 實際版本登錄於 v1.9.1 標籤說明及本機發布紀錄。

資料庫回復方式：取前一版 migration 中的 department v1 及 maintenance v1 函式定義重新套用；不刪表、不刪日誌。但回復 department v1 會再次出現已知新增失敗，應優先修正前進。
