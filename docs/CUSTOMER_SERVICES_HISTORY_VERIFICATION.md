# 客戶承攬與共用履歷驗證

基準：GitHub main 005135d；分支 codex/customer-service-history。新增 UI 只管理既有共用承攬類型的客戶關聯，不複製類型 master。

## 實作

- `customer-services.js`：客戶列表與客戶視窗可開啟承攬管理。支援搜尋、詳細資料、新增關聯、啟停、備註及刪除；管理員可修改，其他角色可查詢。
- `supabase/functions/inventory-gateway/index.ts`：驗證角色與登入身分；共用履歷搜尋／寫入、承攬管理、分客戶載入資料及 Server-Timing。
- `supabase/migrations/20260907155544_customer_services_and_shared_history.sql`：承攬關聯新增狀態、備註、更新時間及版本；沿用複合主鍵、稽核 trigger、設備／維修事件／工作日誌關聯。相容舊客戶表單，相關資料存在時只停用。

## 已執行

- `npm run check`：146 個測試通過。
- `node --check customer-services.js`：通過。
- `scripts/verify-customer-services-history-db.cjs`：隔離 PGlite PostgreSQL 執行實際 migration，14 組檢查通過：角色、防重複、版本衝突、保留歷史、舊表單相容、工作人員、事件修改／稽核、搜尋與跨客戶限制、瀏覽器無 RPC 執行權限。新事件呼叫既有工作日誌 RPC 的測試使用 adapter，不視為真實業務寫入證據。
- Chrome 與 Edge 實際 UI，以完整網路攔截的隔離資料操作：管理員新增、修改、停用，390px 手機點選及 Enter；operator、viewer、Preview 寫入限制。無 JavaScript 錯誤及整頁橫向溢出。
- 共用資料庫 migration 已套用。原有承攬關聯、設備、維修事件筆數不變；三個新 RPC 只開放 service_role，RLS 保持啟用；既有關聯稽核 trigger 與事件禁止刪除 trigger 保留。線上唯讀搜尋 smoke 通過。

## 發布邊界

本次建立前端 Preview；正式前端及正式 inventory-gateway 未更新。Preview Gateway 已更新並維持禁止業務寫入。正式資料沒有加入測試紀錄。正式發布前須同步部署本分支 Gateway，才能讓正式前端使用新功能及停用關聯篩選。

正式帳號登入後的完整 HTTP 寫入及網路延遲未執行；不以隔離測試宣稱正式寫入成功。macOS Safari CI 證據另見案場 repository 工作流程。
