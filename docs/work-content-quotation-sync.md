# 工作內容與報價同步相依性

此分支基於 GUC-ERP/main `71df7be692fbf63210cecac6d827ec236a144a06`。工作內容沿用 projects，沒有新增第二套主資料。

- app.js：工作內容表單及快照加入 project_date、精確報表 work_content_id 連結、附件分類→客戶選擇。
- receipt-customers.js：進貨切換客戶分類時移除不相容已選客戶。
- supabase/functions/inventory-gateway/index.ts：projects 讀取增加業務日期，建立／修改沿用原權限入口並呼叫 upsert_erp_project_with_workers_v3。
- scripts/work-content-sync.test.mjs：真實 Gateway 呼叫及表單／連結回歸；相關舊 RPC 斷言更新為 v3。

共享資料庫 migration 由 **GUC-Quotation** 管理：`supabase/migrations/20260911083331_work_content_quotation_sync.sql`。部署本分支前必須先套用一次該 migration；v3 包裝既有 v2、保留編號器與 RBAC。不可把同一 migration 在兩個 Repository 重複套用。

完整同步規則、資料盤點、部署與回復順序見配套 GUC-Quotation 分支的 `docs/work-content-sync.md`；本機位置 `D:/codex/報價追蹤系統/GUC-Quotation/docs/work-content-sync.md`。

`pnpm run check` 共 176 項測試通過。雙系統瀏覽器驗收使用隔離資料庫，正式資料庫／Auth 寫入及正式發布尚未執行。
