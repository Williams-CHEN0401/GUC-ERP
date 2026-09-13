# 場勘工作內容類型

工作內容的「工作內容類型」新增「場勘」，儲存為 projects.project_type = site_survey。工作日誌的選單、篩選器及舊案場日誌表單也提供「場勘」，儲存為 site_work_logs.work_type = 場勘。沿用既有選單及按鈕樣式。

選擇場勘工作內容新增日誌時自動帶入類型。修改工作內容會同步所屬日誌；修改日誌也同步工作內容與同專案的其他日誌。既有工程施工細分類仍僅適用工程施工。

20260913140234_site_survey_work_type.sql 由 Supabase CLI 2.117.0 migration new 建立。Migration 擴充兩個 CHECK 約束，並以完整 CREATE OR REPLACE 定義擴充既有八個 RPC／觸發器函式的驗證及雙向映射；簽名、權限、安全屬性及 search_path 保留。未改寫舊 migration，未重分類既有資料。報價的 quotable_work_types_v1 規則沿用現況。

## 驗證

- npm run check：Node.js 24，190 項全數通過。實際 Edge handler 驗證場勘建立／修改 RPC payload、工程細分類限制，以及 viewer、未登入、Preview 和未知類型拒絕。
- verify-site-survey-browser.mjs：1440px、390px Chrome 通過，驗證選單、儲存、重開、日誌同步、篩選、日誌修改與新增日誌預設值；合成資料僅在 Preview 暫存，零 API 寫入。
- verify-site-survey-database.mjs：PGlite 0.3.14 執行 PostgreSQL。先證明舊 RPC 拒絕場勘，再套用 migration，驗證工作內容 v4 與日誌 v2/v3 新增／修改／自建工作內容、六種類型、同專案日誌及狀態雙向同步、版本衝突、非法類型、viewer、匿名與未授權專案人員拒絕；比對資料、函式 EXECUTE ACL、RLS、policy 與報價類型規則不變。
- 資料庫 fixture 使用 GUC-Quotation e61739144b8065d838f2c6bf1b3f9f91cf80cca2 的 tests/database-fixture.mjs 及 migrations，並載入 ERP 現有 SQL。僅案場建立 helper 使用最小測試 adapter。這是隔離 PostgreSQL 測試，未宣稱正式 Supabase 環境驗收。

重跑：在隔離的上述 Quotation checkout 安裝其 PGlite 相依套件，設定 QUOTATION_FIXTURE_DIR 為其路徑後，以 Node.js 24 執行 node scripts/verify-site-survey-database.mjs。瀏覽器測試執行 node scripts/verify-site-survey-browser.mjs，PLAYWRIGHT_MODULE 可指定既有 Playwright index.mjs 的 file URL，使用本機 Chrome。

## 發布順序

依 CONTRIBUTING 的 PR／Preview 流程，使用者確認發布後：先套用新 migration，再部署 inventory-gateway 與 inventory-gateway-preview，最後發布 ERP 前端。先擴充資料庫可保留舊前端相容性；先發布前端會讓新選項被舊 API／資料庫拒絕。無新增環境變數。

目前未套用正式資料庫或部署正式 Edge Function。若發布後需回復，保留已擴充的資料庫約束、映射及 Gateway，使用向前修正移除新增選項並繼續識別既有場勘紀錄；不可縮回約束或把場勘資料改成其他類型。
