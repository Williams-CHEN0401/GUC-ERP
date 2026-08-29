# 修正版本 V1 執行與驗證報告

日期：2026-08-28（Asia/Taipei）

## 執行結果

`修正版本V1.md` 的四項內容已重新盤點、完成程式補強並正式發布。正式網站已切換到新版；Supabase migration、正式 Gateway 與 Vercel Production 均已完成驗證。

Preview：`https://guc-erp-vercel-rebuild-ivv10cnat-sam5321051-5955s-projects.vercel.app/`

Deployment ID：`dpl_96a9SDjqdpnZt3Mgo5JJs7L2modX`（READY）

Production：`https://guc-erp-vercel-rebuild.vercel.app/`

Production Deployment ID：`dpl_8HCRo8wCtdGrxYPM9QkLb8pPxEqb`（READY）

Supabase Gateway：`inventory-gateway` v26（ACTIVE）

## 四項修正

1. 工作日誌客戶選擇
   - 清單先選「客戶分類」，再顯示該分類下的既有客戶，最後依客戶篩選專案。
   - 新增工作日誌 Modal 使用同一套分類、客戶與專案連動。
   - 修改既有日誌時保留原專案關聯，分類與客戶分欄顯示，避免誤改歷史附件、取貨與日誌關聯。

2. NAS 設定錯誤追查
   - 根因：前一版 Preview 仍呼叫 `/api/nas` 健康檢查，但 Preview 刻意沒有載入正式 NAS 帳密，因此後端正確回傳 `NAS_CONFIG_MISSING`，前端卻把它顯示成一般連線失敗。
   - 修正：Preview 不再呼叫正式 NAS 健康檢查，畫面明確標示「Preview 安全模擬」；Preview 的附件操作只存在目前瀏覽器。
   - Production 行為未放寬：`api/nas.mjs` 仍要求 `NAS_WEBDAV_URL`、`NAS_WEBDAV_USERNAME`、`NAS_WEBDAV_PASSWORD`，並強制 HTTPS 及 `NAS_WEBDAV_ROOT=/GUC-ERP`。
   - 設定位置：Vercel 專案 `guc-erp-vercel-rebuild` → Settings → Environment Variables → Production。變數更新後需重新部署 Production。
   - 驗證方式：以已登入的 Admin／Operator 對 Production `GET /api/nas` 執行健康檢查，成功時應回傳 NAS 可用狀態及 `/GUC-ERP`；錯誤訊息只會列缺少的變數名稱，不會輸出帳密。

3. 工作日誌內容操作
   - 「內容」已整合到「選擇操作」選單內。
   - 「修改」放在「內容」子選單中，取貨、附件及刪除仍維持原權限邏輯。
   - 未刪除或重建任何既有工作日誌，舊資料及關聯保持不變。

4. 案場改以承攬內容關聯
   - 案場選擇順序改為「客戶分類 → 客戶 → 承攬內容」，不再要求用專案作為新案場關聯主鍵。
   - 新資料透過 `sites.customer_id + sites.contract_service_type_id` 關聯客戶承攬內容；附件由承攬內容案場保存。
   - 既有 `sites.project_id`、工作日誌與附件不刪除、不重綁，歷史未歸類案場以唯讀方式保留。
   - migration 先建立承攬主檔及客戶關聯表，再新增可空的承攬欄位與複合外鍵；只有新資料使用新關聯。

## Migration 與相容性

- `contract_service_types`：七筆預設承攬內容。
- `customer_contract_services`：客戶與承攬內容多對多關聯，啟用 RLS，只授權 `service_role`，並補齊外鍵索引。
- 發布前阻擋：只要存在未關聯客戶的專案、同客戶重複專案名稱，或無法回填專案的工作日誌，migration 立即失敗並回滾。
- `sites.contract_service_type_id` 先以可空欄位加入，複合外鍵確保承攬內容確實屬於該客戶。
- 既有五筆案場、五筆工作日誌及七筆附件不做刪除、搬移或重新綁定。
- 回復方式：正式發布前會先保存數量基準；若 Gateway 發布前失敗，migration 可停在相容狀態；若發布後發現問題，先回退 Vercel／Gateway，舊專案式案場仍可讀取。不可直接刪除已產生的新承攬資料，需先清冊後再執行回復 migration。

## 修改與檢查檔案

- `app.js`：Preview NAS 隔離、工作日誌與承攬案場流程確認。
- `index.html`：工作日誌分類／客戶篩選及案場承攬內容選擇器。
- `styles.css`：Preview NAS 狀態樣式。
- `api/nas.mjs`：Production NAS 變數、HTTPS 與根目錄驗證（未繞過）。
- `supabase/migrations/20260828000200_standalone_work_logs_contracts_accounts_nas.sql`：承攬主檔、客戶關聯、工作日誌專案回填及發布前防護。
- `supabase/migrations/20260828000300_contract_centric_sites.sql`：承攬內容案場關聯與附件註冊。
- `supabase/migrations/20260828000400_lock_down_work_log_project_trigger.sql`：撤銷 Trigger Function 的公開 RPC 執行權限。
- `scripts/check.mjs`、`scripts/correction-v1.test.mjs`、`scripts/nas-upload.test.mjs`：自動化回歸測試。
- `README.md`：NAS Preview／Production 設定差異。

## 自動化與資料庫驗證

- `node --check app.js`：通過。
- `node --check api/nas.mjs`：通過。
- `npm run check`：17 項通過、0 失敗。
- 測試範圍：客戶分類篩選、內容／修改選單階層、Preview NAS 隔離、外鍵索引、路徑清理、台灣日期、逐層目錄、同名另存、競態碰撞、大小驗證、空檔／容量限制、逾時與敏感資訊保護。
- 正式 Supabase Transaction Dry-run：兩支主要 migration 套用、結構與關聯建立驗證均通過，最後 `ROLLBACK`。
- 回滾後核對：新表不存在、新欄位不存在；客戶 120、專案 19、案場 5、工作日誌 5、附件 7 筆，與執行前一致。
- Vercel Preview：建置完成、7 個部署檔案、0 個建置錯誤，根頁面回應 200。
- 線上結構核對：根頁面包含工作日誌客戶分類選擇器及案場承攬內容選擇器。
- 正式 migration：`correction_v1_standalone_work_logs_contracts_nas`、`correction_v1_contract_centric_sites`、`lock_down_work_log_project_trigger` 均已成功。
- Security Advisor：新 Trigger Function 的 `anon`／`authenticated` 執行權限已撤銷；只剩專案原有的外洩密碼保護未啟用提醒。
- 正式 Gateway：v26 ACTIVE；未登入請求經 Vercel 到 Supabase 正確回傳 401。
- Vercel Production：7 個部署檔案、0 個建置錯誤、正式網域 Alias 正常，近 30 分鐘無 Runtime Error。
- 正式瀏覽器：顯示「正式系統」，帳號及密碼欄位各一組，沒有錯誤 Overlay；工作日誌分類及案場承攬內容選擇器均存在。
- 正式資料核對：客戶 120、專案 19、案場 5、工作日誌 5、附件 7；新增七筆承攬主檔，既有資料筆數及關聯未改變。

## 手動驗收步驟

1. 以 Admin 登入 Production，進入「工作日誌」。
2. 切換客戶分類，確認客戶清單只顯示該分類；新增一筆日誌後再開啟修改。
3. 在日誌「選擇操作 → 內容」確認摘要與「修改」按鈕。
4. 在客戶資料替一位客戶勾選承攬內容，再到案場依「分類 → 客戶 → 承攬內容」選取。
5. 進入附件，確認顯示「NAS WebDAV 已連線」及 `/GUC-ERP`；先只做健康檢查，不上傳測試檔案。
6. 確認既有未歸類案場仍可唯讀查看，既有工作日誌與附件數量未改變。

## 已知風險與發布後檢查

- 正式發布已依序完成：資料數量基準 → migration → Security Advisor → Production Gateway → Vercel Production → 未登入 API、瀏覽器及 Runtime 回歸。
- Production NAS 三項秘密變數必須存在且 URL 使用 HTTPS；不得複製到 Preview、前端或版本庫。
- 由於驗證環境沒有 ERP 帳密，正式 NAS 健康檢查及登入後新增／修改流程需由使用者登入後完成；未登入 NAS API 已確認正確回 401，沒有洩漏設定或帳密。
- Vercel 回復點為 `dpl_B4xsRV1xHqqvtcZ9ikvV7HBdDWSm`。若登入後發現阻斷問題，應先回退網站與 Gateway，再依清冊處理新承攬資料；不可直接刪除既有案場、工作日誌或附件。
