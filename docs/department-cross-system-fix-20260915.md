# 科室儲存與表單修正（v1.9.2 發布紀錄）

## 來源與範圍

- ERP GitHub `main`：`16bbee97924b91038738be8ab530638ad0eb6f4d`，2026-09-15 已 fetch 核對。
- 分支：`codex/fix-department-forms-20260915`。
- 報價 GitHub `main`：`5cc5f6d55709b5dc8f4e1f9344a3855c87c9e1b2`；相關科室元件與已讀取工作樹一致。沒有修改報價網站前端。
- 開發測試階段僅唯讀核對正式 Supabase 函式、觸發器與權限；2026-09-15 使用者已確認本機測試並授權正式發布。正式環境不新增測試業務資料。
- 本機測試：[工作日誌](http://127.0.0.1:4199/?page=worklogs)。合成使用者、客戶與 UUID；無正式憑證。重新啟動會重建隔離資料庫。

## 原因

1. 新工作內容寫入科室時觸發 `quotation_project_department_guard_v1`。它以 invoker 身分讀取 `quotations`，但正式 `service_role` 沒有該表 SELECT 權限。隔離資料庫加入相同報價觸發器和 ACL 後，確實得到 `permission denied for table quotations`。之前工作日誌測試未包含此跨系統觸發器。
2. 手動維修品的科室 wrapper 直接鎖定／更新 `repair_items`，但正式服務角色只有該表 SELECT 權限。新增或修改科室會失敗。
3. 表單刷新或切换科室時，可能留下上一科室工作內容及其類型預設；編輯取貨時原本已完成的工作內容會被過濾。客戶空選項也有缺少空 value 的情況。

## 修正方式

- 科室／報價保護移入既有 `audit_work_content_tracking_v1` 授權邊界，原觸發器改呼叫該函式的 BEFORE 驗證分支。原 AFTER 稽核／客戶同步與 DELETE 防護不變；任何已連結報價（含歷史／作廢）的工作內容仍不可更換科室。
- 維修品科室 wrapper 保持 invoker，不直接寫入受保護表。以交易限定的科室輸入交由既有 `upsert_repair_item_v1` 在其原授權邊界驗證客戶、科室、停用狀態、版本及寫入。成功與例外都還原輸入，不污染同一交易的下一次舊版呼叫。
- 不新增函式簽章、服務角色權限或第二套 Auth／客戶／科室模型；既有函式 security mode、ACL 與 search_path 均未變更。
- 客戶／科室切換清除不適用的既有工作內容選擇；新的自由輸入標題保留。受限使用者選單刷新保留有效選擇，類型／狀態只從相同科室工作內容帶入。
- 編輯既有取貨保留原已完成工作內容，新增選單仍不列出已完成項目。科室資料缺漏不再誤顯示成「尚未設定」。篩選列改為可換行，避免新增科室篩選後溢出。

## Verification Report

使用者故事：選擇客戶與科室 → ERP 表單驗證 → 實際 inventory Gateway → 受限 service_role 的實際資料庫 RPC／報價觸發器 → 重新讀取並顯示原科室。

| 邊界／流程 | 結果 | 證據 |
|---|---|---|
| 原始錯誤 | 重現 | 相同報價觸發器、受保護 quotations／repair_items ACL；失敗交易無孤兒資料 |
| 工作日誌 | 通過 | 6 種類型 × 2 科室新增、修改、重讀、重送；自動維修品繼承科室 |
| 工作內容／維修品／進貨 | 通過 | 實際 Gateway → SQL 新增、修改、重新載入；多客戶進貨科室一對一對應 |
| 報價關聯 | 通過 | 未連報價可正常設定科室；已連報價不可更換，原科室可正常編輯與新增日誌 |
| 取貨／附件／報表 | 通過 | 既有瀏覽器表單測試驗證科室篩選、切換、歷史關聯；未寫入正式取貨或 NAS |
| 桌面／手機 | 通過 | Chromium 1440px、390px：真實隔離 DB 流程、選單排列、篩選列不溢出、0 page errors |
| 安全／例外 | 通過 | 跨客戶、停用新關聯、舊版本、未授權／跨專案拒絕；原停用科室可保留；合法專案受限使用者允許 |

執行方式（PGlite 與 Playwright 可由既有工具套件提供；不使用正式連線）：

```powershell
npm run check
node scripts/verify-department-cross-system-db.mjs
node scripts/verify-worklog-save-db.mjs
node scripts/verify-worklog-save-http.mjs
node scripts/verify-department-cross-system-browser.mjs
node scripts/verify-customer-departments-browser.mjs
```

本機環境需要指定 `PGLITE_MODULE` 與 `PLAYWRIGHT_MODULE` 為已安裝模組入口（或自行在測試環境安装模組）。SQL 測試不是以超級使用者執行業務寫入；高權限只用於建立隔離 schema、合成 seed 及檢查結果。`scripts/fixtures` 保存唯讀取得的相關函式定義，不包含正式業務資料。

圖片：`tmp/department-cross-system/worklog-form-390.png`、`worklog-saved-1440.png`、`worklog-saved-390.png`，以及 `tmp/customer-departments/`。

限制：PGlite 為本機 PostgreSQL 相容隔離環境，非正式 Supabase 網路；沒有在正式系統建立測試日誌。NAS 上傳、正式取貨與報價建單並未執行，本次只驗證其科室表單／關聯邊界。

## 正式上線計畫（已獲使用者核准）

需要套用 `supabase/migrations/20260914223754_fix_department_cross_system_boundaries.sql`（3 個既有函式、1 個觸發器），再發布 ERP 前端。沒有資料表結構變更、資料改寫、環境變數／Edge Function／RLS 變更。

上線前重新取得正式版本、備份相關函式和觸發器，核對無並行變更；正式執行使用交易与 5 秒 lock_timeout。回復只還原這些函式及觸發器，前端回上一正式版本；不刪除或還原整庫業務資料。

安全 advisors 為唯讀基線（尚未套用修正）：68 個既有 [RLS enabled/no policy INFO](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) 和 1 個既有 [leaked password protection WARN](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)。本次不擅自調整上述既有安全設定。

- 發布前再次執行 `npm run check`：224 項通過；跨系統 DB 及 HTTP 實際 Gateway 測試通過。
- 正式發布順序：PR CI／Vercel Preview 成功 → 套用已核准 migration 並核對 → Squash merge → Vercel Production READY → 唯讀檢查 → `v1.9.2` tag。
- 回滾目標：`dpl_EmcNQAMCe4jeA1qyHdvLGtXT5HKg`（`16bbee97924b91038738be8ab530638ad0eb6f4d`，v1.9.1）。
- 函式／觸發器回復 SQL、正式資料備份與最後部署 ID 存在工作區外層 `.tmp/department-release-20260915/`，不提交到公開 GitHub。前端回復與函式回復可分別執行，不刪除業務資料。
- 沒有新增或變更環境變數、Edge Function、Auth、RLS 或資料表權限。
