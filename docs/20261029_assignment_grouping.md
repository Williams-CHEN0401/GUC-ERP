# 工作指派合併卡片驗證

## 來源與範圍

- 2026-10-29 已 fetch `Williams-CHEN0401/GUC-ERP` 的 `main`，基準為 `61cf6afaf6d44460e751817c3c36c78042e22496`。
- 工作分支：`codex/assignment-grouping-1029`。
- 本次修改 ERP 首頁工作指派的顯示；正式網站、Docker 容器及正式資料未寫入。未推送 GitHub、未合併 main。
- 以唯讀交易確認使用者截圖的兩位負責人屬同一個 `assignment_request_id`、同一指派人、相同內容，均為待辦。沒有複製正式資料至測試站。

## 行為

- 依既有 `created_by_user_id + assignment_request_id` 合併同次多人指派，以一張卡片顯示，負責人以「、」分隔。
- 保持原排序。不同次派工、不同指派人及無批次識別碼的舊資料分開顯示，不以工作名稱或內容文字推測相同指派。
- 畫面中的完成按鈕仍指向登入者自己的原始指派 ID 與版本；多人卡片顯示「完成我的指派」。其他負責人待辦不受影響。
- 個人完成狀態、完成通知、取貨扣庫存及權限規則不變；多人取貨卡片標示每位人員的數量。
- Excel 保留逐人指派明細；原有施工規劃卡片維持其多人顯示。

## 修改位置

- `assignment-ui.js`：將已授權的待辦清單分組後呈現，保留成員原始資料供個人操作。
- `app.js`：首頁待辦呈現前呼叫分組函式。
- `supabase/functions/inventory-gateway/index.ts`：既有三個指派查詢帶回已存在的 `assignment_request_id`；不擴大查詢權限或修改寫入 API。
- `scripts/assignment-visibility-ui.test.mjs`、`scripts/assignment-grouping-fixture.mjs`、`scripts/verify-assignment-grouping-db.mjs`：行為回歸；歷史測試資料結構補齊現有欄位。

## 已執行驗證

1. `node scripts/check.mjs` 通過；`node --test scripts/*.test.mjs` 全部 **465 項通過**。
2. 實際 Gateway → 隔離 PGlite PostgreSQL → 既有 RPC：`verify-admin-assignment-db.mjs` 與 `verify-assignment-grouping-db.mjs` 共 **12 項通過**。涵蓋批次識別碼、一般人員拒絕操作他人指派、個人完成後重新讀取、完成通知、Excel 逐人資料及既有私有客戶界線。
3. Playwright / Microsoft Edge Chromium，1440×1100 桌面與 390×844 手機尺寸：同次多人一張卡片、不同次相同文字保留兩張、完成請求使用正確個人 ID/版本、全部／我的切換、Excel 實際下載、一般人員範圍、無水平溢出；未出現 JavaScript pageerror。
4. 已檢視桌面及手機截圖，`git diff --check` 通過。

隔離資料為合成使用者與指派，批次識別碼在測試資料中設定；本次沒有重測多人建立 RPC 的所有流程。既有最小化資料庫 fixture 未包含完整新稽核結構，其稽核寫入警告不作為正式稽核驗證。未執行正式資料寫入或手機 Safari 實機驗證。

本機證據存放於工作樹上一層：`unit-results.log`、`db-results.log`、`check-results.log`、`evidence/browser-results.json`、`evidence/grouped-desktop.png`、`evidence/grouped-mobile.png` 及 Excel 下載檔。

## 測試網站與後續發布

- 同機測試網址：<http://localhost:4381/?page=dashboard>。
- 隔離、合成資料、唯讀；可切換管理員／一般人員查看，提交完成操作會明確拒絕。
- 需要正式發布時更新 ERP 前端及 `inventory-gateway`；此電腦現有資料庫已具有所需欄位，**不需 migration 或資料回填**。
- 若在尚未套用既有 `20261025051340_multi_person_work_assignments.sql` 的環境部署，應先核對該環境 schema；本次不自動套用歷史 migration。

技術查核參考：[Supabase changelog](https://supabase.com/changelog)；本次只增加既有 REST 查詢的欄位投影，不升級平台、SDK 或 PostgreSQL。
