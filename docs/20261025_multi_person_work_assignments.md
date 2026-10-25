# 工作指派：多人與施工規劃關聯

## 來源及範圍

- 來源：Williams-CHEN0401/GUC-ERP，查核 origin/main `2e2ab1855ec63a2f9cc35701081d612e2556781b`。
- 查核日期：2026-10-25；隔離工作樹 `F:\GUC-Docker\workspaces\work-assignments`，分支 `codex/work-assignments-1025`。
- 本輪只有功能修改與測試；未發布、未推送 GitHub、未套用正式資料庫 migration。
- 不更動會計、案場、客戶調查網站或 Vercel 部署設定。

## 使用方式

首頁 → 建立工作指派 → 選擇既有工作內容 → 可選施工規劃及子項目 → 勾選指派人員 → 填寫工作說明 → 建立。

可選 1 至 30 位啟用中的人員。每人各自收到一筆指派、各自完成，沿用原有完成通知。可選整筆施工規劃或其中一個未完成子項目，也可不關聯。切換案件或改為手動新增工作時，失效的規劃與子項目選擇會清除。

指派完成不會自動完成施工規劃或子項目。取貨類型明列每人數量及合計，各人完成時沿用原扣庫存流程；手動新增工作只建立一個共用工作內容，所選人員都成為該工作負責人。

## 實作

- `app.js`：既有表單改用共用人員勾選元件；單次送出多人與關聯資訊；保留本機安全預覽模式。
- `assignment-ui.js`：案件／規劃／子項目連動、取貨數量提示、待辦及完成通知顯示規劃名稱。
- `form-reference-sync.js`：人員主資料更新時保留勾選，伺服器仍驗證人員是否啟用。
- `supabase/functions/inventory-gateway/index.ts`：新增多人輸入路徑，沿用原 Auth、RBAC 及私人資料規則；原單人 API 契約保留。
- `supabase/migrations/20261025051340_multi_person_work_assignments.sql`：在既有 work_assignments 增加可空白關聯、名稱快照與請求識別欄位，增加 service_role 專用批次 RPC。重用原單人指派及專案寫入函式；同一交易內建立全批，失敗回滾。同一請求的重試及並行請求不會重複建立。

未新增 Auth、客戶、使用者或平行施工規劃模型。既有指派的新增欄位保持 NULL，可繼續讀取和完成。

## 驗證證據

- 語法／靜態檢查通過；完整 `node --test scripts/*.test.mjs`：441 項通過、0 失敗。
- 實際 Gateway → PostgREST → PostgreSQL：14 組檢查通過，涵蓋多人建立、同時送出、重試、錯誤案件／子項目、無效人員、管理員權限、私人資料拒絕、完成通知、獨立完成、手動工作失敗回滾、原單人契約、每人取貨及不重複扣庫存。
- Edge 桌面與 390px 手機：6 組檢查通過，實際勾選／切換／送出、首頁關聯呈現及第二位人員的待辦；無頁面 JavaScript 錯誤，無水平溢出。
- 測試資料庫：`guc_assignments_20261025`，由既有合成測試資料複製。所有寫入測試均在該資料庫執行；未使用正式資料庫寫入。
- 測試角色使用既有權限模型配置首頁與工作日誌檢視權限；私人資料測試暫時移除合成管理員的檢視授權，測試後已還原。正式帳號權限未變更。
- 證據：`F:\GUC-Docker\previews\20261025-work-assignments\evidence\check.log`、`api-verification.json`、`browser-verification.json`、`assignment-desktop.png`、`assignment-mobile-workers.png`、`assignment-dashboard.png`。
- 2026-10-25 檢查既有正式 Docker 容器仍為 healthy；本輪僅新增綁定 loopback 的測試 PostgREST 容器。

## 測試網址與後續發布

- 管理員：<http://localhost:4290/?page=dashboard>
- 合成施工人員：<http://localhost:4290/?page=dashboard&test_role=worker>
- 預覽由 `F:\GUC-Docker\previews\20261025-work-assignments\preview-server.mjs` 提供，僅綁定本機；頁面有隔離測試標示。測試登入及私鑰檔案只在預覽目錄，不能加入版本庫或映像。
- 正式發布時須先備份並套用上述 additive migration，再更新 ERP Gateway／ERP 容器並驗證首頁與多人指派。不能只更新前端；目前正式環境尚無新欄位及 RPC。
- 回復舊程式時保留新增欄位與已建立指派，不需刪除指派資料；舊單人 API 仍可運作。
