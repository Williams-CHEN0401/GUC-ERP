# 報價管理系統實作報告

更新日期：2026-09-02（Asia/Taipei）

## 1. Repository Analysis

既有 ERP 位於 `GUC-ERP`，前端為靜態單頁介面，Vercel Functions 作為 BFF，Supabase Edge Function 作為 Gateway，Supabase Postgres 與 Auth 為資料與身分來源。登入後已有工作系統選擇頁，可加入第三個「報價管理系統」入口。

實際檢查到的既有主檔為 `customers`、`projects`、`customer_contacts`、`app_users`，且 `app_users.auth_user_id` 可連結 Supabase Auth。現有資料量在分析時為 120 位客戶與 36 個專案。

未在既有 schema 中發現可直接重用的 quote、estimate、sales order、invoice、receivable 或 payment ledger。是否另有外部會計／請款系統：**未確認**。因此本階段的 billing status 僅是管理流程標記，不產生會計分錄。

新的獨立 UI 位於 `GUC-Quotation`，採 Next.js App Router；ERP 與報價站以受控 `postMessage` 交接既有登入工作階段，token 不放入 URL。

## 2. 既有資料可重用項目

- 客戶：直接引用 `customers.id`，顯示已確認的 `customer_code`、`name`、`phone`、`email`、`address`。
- 專案：直接引用 `projects.id` 與 `projects.customer_id`，依客戶篩選專案。
- 聯絡人：直接引用 `customer_contacts.id`。
- 使用者：直接引用 `app_users.id`，並以 `auth_user_id` 核對 Supabase Auth。
- 報價快照：保存當時的客戶、聯絡人及專案顯示資料，但外鍵仍指向 Master Data，兩者用途明確分離。
- 客戶統一編號欄位：**未確認**，目前不宣稱可依統編搜尋。
- 既有 Invoice／Billing ledger：**未確認（本次 schema 未發現）**，目前不建立第二套應收帳款或收款帳。

## 3. 權限設計

初始白名單固定為既有三個 app user ID：Williams、Joyce、老闆；顯示名稱不是安全判斷依據。

權限防線如下：

1. ERP UI 只有 session API 回傳 `can_access_quotations=true` 時才顯示入口。
2. ERP BFF 與報價 BFF 不信任前端權限，並限制 method、body size、timeout 與 upstream。
3. Gateway 以 Supabase Auth token 查回唯一、有效且 Auth UUID 相符的 `app_users`，再查 `quotation_access_users`。
4. Database RPC 再呼叫 `quotation_require_access_v1`；報價表啟用並強制 RLS，對一般 anon／authenticated 不開放直接表格存取。
5. SSO 同時核對 exact origin、window source、message type、nonce 與非空 token；握手後清除 URL query。

Preview 僅在 access table 尚未安裝且 PostgREST 明確回 `PGRST205` 時，才以三個 immutable ID 作 read-only fallback；其他錯誤一律 fail closed。

## 4. 報價資料模型

- `quotation_access_users`：可進入報價模組的既有使用者。
- `quotations`：報價 header、客戶／專案／負責人、報價狀態、請款狀態、row version、作廢與封存欄位。
- `quotation_versions`：每版的日期、聯絡人、Master Data snapshot、折扣、稅率、稅額、總額與備註。
- `quotation_items`：說明、規格、數量（千分之一單位）、單位、整數 TWD 單價、資料庫生成小計、備註。
- `quotation_status_history`、`quotation_billing_history`：分開保存兩條狀態歷程。
- `quotation_audit_log`：操作者、時間、動作、報價／版本 ID、before／after JSON。

每張報價必須綁定既有專案。同一專案只允許一張未封存且未作廢的 active header；後續修改商務提案應建立新版本，避免兩張報價互相覆蓋專案追蹤狀態。草稿可封存，任何未進入請款的報價可依規則作廢並記錄原因。

## 5. UI Sitemap

```text
報價管理系統
├─ Dashboard
│  ├─ KPI
│  ├─ 近期報價
│  └─ 需要處理的專案
├─ 報價單管理
│  ├─ 搜尋／篩選
│  ├─ 新增／編輯草稿
│  └─ 詳情／歷史版本／狀態／作廢／封存
├─ 客戶／專案追蹤
└─ 請款追蹤
```

桌面採 Sidebar 與高資訊密度表格；Tablet KPI 轉兩欄；Mobile 轉單欄並保留可水平捲動的完整表格。Badge 均同時顯示文字，不只依靠顏色。

## 6. Dashboard Wireframe

```text
┌ 本月報價金額 ┐ ┌ 待報價 ┐ ┌ 待客戶確認 ┐ ┌ 已成交金額 ┐ ┌ 請款待辦 ┐

┌──────────────────────────┐ ┌──────────────┐
│ 近期報價                  │ │ Pipeline     │
│ 編號／客戶／專案／狀態…  │ │ 草稿／送出… │
└──────────────────────────┘ └──────────────┘

┌──────────────────────────────────────────┐
│ 需要處理的專案                           │
│ 未報價／待確認／成交但未完成請款         │
└──────────────────────────────────────────┘
```

本月金額與件數以 `quote_date` 的台灣當月篩選；未報價僅指「進行中且此模組沒有有效報價」的專案。模組上線前已完成但沒有模組報價者標為「歷史資料未確認」，不臆測其從未報價。

## 7. 報價流程

```text
草稿 → 報價完成 → 已送客戶 → 客戶確認 → 已成交
                         └────────→ 未成交
```

建立報價時必選客戶、該客戶的專案、日期、有效期限與負責人，並填 1–100 筆明細。狀態轉換由 RPC 白名單控制；已定案後若需修改內容，建立新版本並回到草稿。舊版本資料與金額不覆寫，可由詳情頁點選唯讀查看。

刪除採安全替代方案：只有未請款草稿可封存；已確認、成交或其他重要狀態使用作廢並強制填原因，不執行 physical delete。

## 8. 請款流程整合

```text
尚未請款 → 準備請款 → 請款中 → 部分請款 → 請款完成
```

非 `尚未請款` 的狀態必須搭配 `已成交`，Database 有跨欄位 constraint。允許受控倒退修正，但 UI 與 RPC 都要求填寫真實更正原因並保留歷程。

本階段 billing status 是 workflow label，不代表發票、應收、收款或完成會計入帳。既有 Accounting／Invoice 整合：**未確認**；確認正式 ledger 前不得由本模組推算「已請款金額」或帳款餘額。

## 9. API / Database Impact

新增 ERP `/api/quotation` BFF、Supabase `quotation-gateway` 與 `quotation-gateway-preview`，以及報價站 `/api/gateway`。Preview 三層都禁止 login 以外的寫入：ERP BFF、報價 BFF、Preview Edge path。

Database migration 新增報價相關表、FK、唯一／查詢索引、constraint triggers、RLS、audit 與 14 支 service-role-only RPC。所有金額由資料庫重新計算；每列及整張總額均有上限，避免超過 JavaScript safe integer。

截至本報告建立時，正式 migration 尚未套用，正式 `quotation-gateway` 尚未替換，正式寫入旗標仍為 false。這是刻意的發布保護，不是遺漏。

## 10. Implementation

已完成：ERP 權限入口、SSO、獨立 Next.js UI、Dashboard、報價清單、客戶／專案追蹤、請款追蹤、建立／編輯、項目計算、狀態機、版本快照、歷史版本檢視、作廢／封存、Preview session-only 模擬、Gateway、migration、RLS、audit 與 optimistic concurrency。

MVP 後續項目：報價列表的建立人、日期區間與多欄排序 UI；列印／PDF；圖表與成交率分析；與已確認之正式 Invoice／Receivable ledger 整合。這些項目未被當成本階段已完成內容。

## 11. Tests

- `GUC-Quotation`：quantity、BigInt 金額、稅額四捨五入、safe limit、Preview 編號、upstream allowlist、SSO、Preview 禁寫、歷史資料讀取等測試。
- `GUC-ERP`：原有回歸加報價入口、public config exact-host、Preview BFF、Gateway exact path、Auth UUID、migration 安全與權限測試。
- Static release gate 另檢查必要檔案非空、兩個 Edge Function 入口、`verify_jwt=false` 與禁止 destructive table operation。
- Next.js production build 必須成功，且 routes 包含 Dashboard、報價、詳情、新增、追蹤、請款與 Gateway。

## 12. Verification

2026-09-02 本機驗證結果：

- GUC-Quotation TypeScript：通過。
- GUC-Quotation unit／integration：9/9 通過。
- GUC-Quotation Next.js production build：通過，共 7 個應用 routes（另含 not-found）。
- GUC-ERP regression：74/74 通過。
- GUC-ERP static preview check：通過。

部署後仍須完成的 Preview smoke：三帳號登入、其他帳號拒絕、ERP→報價 SSO、options/list/detail、Preview BFF 與 Edge 雙層 403、direct URL 權限、歷史版本與手機流程。Preview URL 將在實際部署後補入；正式 migration 與正式網站必須等使用者確認測試站後才發布。
