# 客戶分類管理

## 來源與範圍

- 2026-09-14 查核 GitHub `Williams-CHEN0401/GUC-ERP` 的 `main`：
  `8c40324bb57d43a1e20aa244a7902a57368866e7`。
- 工作分支：`codex/customer-categories-20260914`。
- 本次限 ERP 客戶分類管理與 ERP 內各分類選单，保留場勘、工程施工分類、工作日誌及其他既有功能。
- 使用者於 2026-09-14 確認發布此 ERP 版本，透過 PR、資料庫 migration、Gateway 與 Vercel 正式部署流程上線。

## 操作

「客戶與工作內容」→「客戶」底下分為「客戶資料」與「客戶分類」兩個子頁籤。
「客戶分類」可新增、修改、刪除及搜尋名稱，表格列出使用該分類的客戶數量。
原客戶表格與操作保留於「客戶資料」，預設顯示此子頁籤。
分類名稱限制 1–80 字，不接受空白或不分大小寫的重複名稱。
修改名称保留代碼、客戶 UUID、客戶編號與承攬關聯；刪除使用中的分類時，須先將客戶改為其他分類。
沿用 customers 模組的 VIEW / CREATE / UPDATE / DELETE 權限，後端再次驗證，並沿用既有稽核日誌。

## 資料與相容性

- migration：`20260914004826_customer_category_management.sql`，檔名由 Supabase CLI 產生。
- 新增的是既有 `customers.customer_category` 的分類名稱對照表 `customer_categories`，不是另一套客戶主資料。
- 保留四個原代碼及名稱；不改寫任何客戶列。
- 以外鍵取代固定四選項的 CHECK；分類 code 不可修改，外鍵禁止連帶刪除。
- 使用中分類、並發刪除／客戶新增以外鍵及交易保護；修改／刪除須帶 row_version。
- 所有表與 RPC 只供既有 service-role Gateway 使用，開啟 RLS，不對 anon/authenticated 開放。
- 原 `create_customer_auto_number_v2` 僅改為查詢分類表，保留編號與承攬 wrapper。
- 正式發布應先套用 migration，再更新 inventory-gateway 及 ERP 前端；Preview 的寫入禁制維持原樣。
- 資料庫更新尚未完成或讀取分類失敗時，正式頁面禁用分類管理，不以預設假資料提交修改。
- 回復舊前端不應刪除分類表或重設客戶分類。建立新分類後，舊前端無法完整呈現其名稱，應向前修正。

### 跨網站界線

獨立案場及報價網站不在本次程式變更範圍。既有程式／報價 options RPC 對分類名稱仍有固定對照：
新代碼可能顯示代碼、原代碼改名可能仍顯示舊名稱。資料與客戶 UUID 關聯不變。
若正式發布時需要三站顯示一致，必須同時讓這些既有消費端讀取相同分類表，不可新增平行分類來源。

## 驗證

- `npm run check`：196 項通過。
- `scripts/verify-customer-categories-db.cjs`：隔離 PGlite PostgreSQL 驗證 CRUD、重複名称、舊版本、不可變代碼、
  使用中刪除與外鍵、客戶／承攬保留、既有客戶 RPC、自動編號、稽核、RLS、匿名／登入客戶端拒絕及 service-role 允許。
- `scripts/customer-category-management.test.mjs`：真實 Edge handler 的各操作允許／拒絕、其他模組權限拒絕、匿名拒絕與輸入驗證。
- 瀏覽器：1440px、390px 完整新增／搜尋／修改／刪除、客戶套用新分類、同步篩選選單、唯讀角色、
  重複名稱提示、資料庫回應映射、載入失敗禁用、手機三欄同時可見，無 pageerror。
- 測試只使用本機合成資料；未將測試列寫入正式資料庫。

本機測試：`node scripts/customer-categories-preview-server.mjs`，
[測試網址](http://127.0.0.1:4194/?page=crm)。資料只在瀏覽器暫存，重新整理會還原。
