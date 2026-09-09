# 手機附件、送貨與商品種類修正

## 來源與範圍

2026-09-09 09:29（Asia/Taipei）交付前再次 fetch 確認：

- ERP `origin/main`：`3ab7f1f5656f5a0439d795bfc3eb518a70a47e74`（2026-09-08 17:48:54 +08:00）。
- 案場 `origin/main`：`6f104afe5635350dadf810f8810e7bdc357a99a4`（2026-09-08 17:49:00 +08:00）。
- 修正分支：`codex/mobile-attachments-delivery-categories`。

保留既有介面、公司 LOGO、Auth、客戶及設備主檔、RBAC 與稽核機制。案場服務入口依資料庫服務主檔產生，本次不需修改案場程式。

## 修正行為

1. 工作日誌附件：正式紀錄顯示多張照片預檢成功後遭主機回覆 413；原程式把最多 80 MB 的附件合併在一次 multipart 請求。現在逐檔處理，大於 3 MiB 的檔案以 3 MiB 分段上傳，保留 JPEG、HEIC、HEIF 等原檔。每段重新驗證既有登入權限；短效簽章綁定工作階段、客戶、承攬內容及專案。完成時核對分段大小、SHA-256、NAS 最終檔案大小，成功一檔即保存該檔 ERP 索引。只有分段傳輸可自動重試，最終寫入不自動重送。原單檔 20 MiB、單批 80 MiB／10 檔上限保持。
2. 專案／工作日誌新增 `delivery`／「送貨」，同步修改建立、更新、舊版 RPC 與雙向同步 trigger；保留工程施工、維修／查修及維護保養。
3. 既有 `contract_service_types` 新增 `maintenance`／「維護保養」，客戶選取後沿用 `customer_contract_services` 關聯；不替既有客戶自動勾選。
4. 貨品種類：修正新增 RPC 重複插入不合法 `CREATE_PRODUCT_CATEGORY` 稽核動作造成整筆回滾。沿用既有 category audit trigger；補上「貨品種類」分頁、名稱／字首搜尋、啟用狀態篩選、雙擊／觸控／Enter 修改、停用與刪除。新增／修改／刪除均使用既有 inventory 權限；修改與刪除檢查 row_version。已關聯品項或維修紀錄的種類禁止刪除，可停用。修改名稱同步品項分類顯示，既有品項編號、數量及關聯不變。

## 驗證

- `npm run check`：164 項通過，包括真實 Gateway handler 的種類 CRUD 權限允許／拒絕路徑。
- 隔離 PostgreSQL 相容測試：先重現種類新增稽核回滾及送貨遭拒，再套用 migration；連續兩輪通過四種專案新增／修改、工作日誌正式使用的 maintenance v2 wrapper、雙向及同專案多日誌同步、客戶維護保養關聯、種類 CRUD／重複名稱／停用／使用中刪除限制／版本衝突／audit／RPC grant 檢查。所有資料測試交易 rollback。
- 手機附件整合：原有大批 multipart 明確超限；新版每次傳輸低於主機 4.5 MB 限制。5 MiB JPEG／HEIC、空 MIME、20 MiB 邊界、暫時網路錯誤、缺段、內容竄改、跨 session／專案、票證過期、無權帳號、已授權自訂角色、部分索引失敗皆有實際測試。
- 桌面 Chrome、Pixel 7／Android Chrome 模擬、iPhone 13／WebKit 26.5 模擬各兩輪，共 24 項 UI 流程。照片透過實際 `api/nas.mjs` handler 寫入記憶體 WebDAV fixture，逐檔比較原始 bytes／SHA-256，確認三筆附件索引及暫存清除。
- 案場桌面及 iPhone 模擬各兩輪，共 4 項：維護保養客戶關聯、正確設備 URL 與共用維修紀錄入口。
- 手機貨品種類清單四欄完整顯示，其他頁面樣式保留。

## 發布狀態及順序

目前是本機已驗證修改，尚未推送、發布或套用正式 migration。測試沒有上傳正式 NAS 或建立正式業務資料。

獲得本次發布授權後：

1. 再確認遠端 main、正式資料庫物件及備份。
2. 依既有發布流程套用 `supabase/migrations/20260909010509_delivery_maintenance_category_crud.sql`。新增服務及擴充約束，不重建或清空資料表。
3. 更新既有 `inventory-gateway`，透過 PR 合併並發布 ERP Vercel Production。
4. 確認正式 Git SHA、部署 READY、既有客戶／專案／日誌／品項數量及 RPC 權限。執行正式唯讀驗證。

實體 Android／iPhone、正式 NAS 的分段 GET／DELETE 操作尚待上線驗收；模擬測試不代表實機驗收。分段暫存位於既有 NAS 根目錄內獨立 `.erp-upload-<隨機 UUID>` 資料夾，成功或可處理失敗時清除；若瀏覽器或網路突然中斷，可能留下不會登錄成正式附件的暫存資料夾。清理只能針對已過期的這類暫存資料夾，不可刪除正式附件目錄。

參考：[Vercel Functions 傳輸限制](https://vercel.com/docs/functions/limitations#request-body-size)。
