# 正式發布紀錄（2026-08-28）

正式網站：`https://guc-erp-vercel-rebuild.vercel.app/`

## 變更範圍

- 工作日誌新增施工人員複選，資料來源為既有 `app_users`，關聯表為 `site_work_log_workers`。
- 工作日誌新增取貨入口，與交易管理共用 `pickup_records`、庫存扣減、Audit Log 與同步佇列；不建立第二套取貨資料。
- 既有 `create_pickup_records_batch` 與交易管理介面保留，內部轉接新版共用 RPC。
- 附件 NAS 根目錄固定為 `/GUC-ERP`；每次上傳建立新資料夾，重名時依序使用台灣時間與序號，不覆寫舊檔。

## 資料庫與 API

- migration 原始檔：`supabase/migrations/20260828000100_work_log_workers_pickups_and_nas_folders.sql`
- 正式 migration 記錄：`20260828003547 work_log_workers_pickups_and_nas_folders`
- 新增 `site_work_log_workers`，`pickup_records` 僅增加可空的 `work_log_id`、`request_id`、`request_row`，舊資料不需轉換。
- 新增原子 RPC `upsert_project_site_work_log_v1` 與 `create_pickup_records_batch_v2`；舊 RPC 簽章保留。
- Gateway sites scope 只提供施工人員顯示名稱、啟用狀態與關聯，不暴露帳號角色或認證資料。

## NAS 流程

1. Gateway 驗證登入、角色、專案及工作日誌歸屬。
2. WebDAV `PROPFIND /GUC-ERP` 確認根目錄存在且可存取。
3. 以 `客戶_專案_日期` 建立資料夾；先精確檢查同層名稱。
4. 重名使用 `_YYYYMMDD_HHMMSS`，再碰撞則加 `_02`、`_03`。
5. 檔名清理非法字元並加 UUID，PUT 使用 `If-None-Match: *`。
6. 寫入後以 HEAD；不支援時改用 PROPFIND，驗證存在與檔案大小。
7. 多檔部分失敗回傳已成功與失敗清單；後端只記錄結構化事件與錯誤碼，不記錄密碼。

## 驗證與回復

- `npm run check`：8/8 NAS 測試通過，靜態標記檢查通過。
- 正式資料庫以 transaction 建立、修改、重送取貨、舊 RPC 相容性測試後 ROLLBACK；沒有留下 Codex 測試資料。
- migration 後核對 RLS、FK、唯一索引與 RPC；新增表僅允許 service role，寫入仍經 Gateway。
- Edge Function Preview：`inventory-gateway-preview` v3。
- 正式 Edge Function：`inventory-gateway` v25（ACTIVE）。
- 最終 Vercel Preview：`dpl_HF7SLWRRSAkcaehXdEWoBWfYApKg`（READY，errors-only build log 無錯誤）。
- Vercel Production：`dpl_B4xsRV1xHqqvtcZ9ikvV7HBdDWSm`（READY，正式 alias 已切換）。
- 前一個 Vercel Production 回復點：`dpl_8r7H4C83dsRhFSd3sPEVC8SaCWan`。
- 前一個正式 Edge Function 回復點：`inventory-gateway` v24。

## 上線後核對

- 正式首頁、`app.js` 與 `styles.css` 回傳 200；新施工人員與工作日誌取貨標記存在。
- 未登入 inventory 與 NAS API 均回傳 401；4xx 記 warning，只有 5xx 記 error。
- 正式部署後 Runtime Errors：0。
- 正式資料核對：取貨 40、案場 2、工作日誌 2；Codex 測試工作日誌 0、格式異常的工作日誌取貨 0。
- 發布期間正式使用者仍有操作，資料筆數增加屬正式活動；部署未執行 seed、restore、truncate 或正式 DML 清理。
