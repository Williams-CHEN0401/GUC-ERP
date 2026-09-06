# ERP 與案場系統優化驗收

## 基線與範圍

從 GitHub 最新 main 建立 `codex/erp-site-optimization-preview`。ERP 基線 `4b2fd45`、案場基線 `77162d5`，包含已發布的綠色圖示、門禁系統名稱及指定的門禁／緊急求救圖片。此版本只提供 Preview，不合併 main，不更新正式 Gateway，不執行正式資料庫 migration。

## Repository Analysis / Implementation

| Repository | 路徑 | 用途與修改 |
|---|---|---|
| GUC-ERP | `app.js`, `index.html`, `styles.css` | 首頁三區、日期排序、業務列雙擊、日誌篩選與詳細視窗、刪除試算表匯出 |
| GUC-ERP | `audit-ui.js` | 由案場 `lib/audit-presentation.ts` 產生的同一套繁中顯示與遮蔽邏輯 |
| GUC-ERP | `project-report.js` | 保留用料／施工人員統計，移除 CSV 專用 helper |
| GUC-ERP | `api/inventory.js`, `api/public-config.js` | 獨立 Preview Gateway；轉送請求來源；Preview 系統切換網址 |
| GUC-ERP | `supabase/functions/inventory-gateway/index.ts` | 共用稽核查詢、請求操作者脈絡、首頁 LIMIT、IP 批次查重 |
| GUC-ERP | `supabase/migrations/20260906152432_audit_context_and_query_indexes.sql` | 稽核欄位、遮蔽觸發器、關聯表稽核與索引，待正式發布時套用 |
| GUC-Site-Data | `components/system-audit-log.tsx`, `lib/audit-presentation.ts`, `app/page.tsx` | 共用伺服器日誌，日期／操作者／模組／事件／關鍵字、25 筆分頁、詳細視窗 |
| GUC-Site-Data | `app/globals.css` | 原生繁中字型 fallback、標題／表格／表單字型 token |
| GUC-Site-Data | `lib/device-ip-conflicts.ts`, `app/api/devices/import-preview/route.ts`, `app/api/devices/import-commit/route.ts` | 僅查上傳檔中的 IP，每批 250 個，併發上限 1 |
| GUC-Site-Data | `lib/server-config.ts`, `lib/server-device-gateway.ts`, `app/api/gateway/route.ts`, `next.config.ts` | Preview 隔離、轉送來源資訊、只讀查重操作與系統切換 |

## System Log Design

保留 insert/update/delete/LOGIN/LOGOUT/IMPORT_DEVICES/BATCH_UPDATE/UPDATE_CREDENTIAL 等英文事件碼，UI 轉為繁體中文。兩站共用 `public.audit_logs`；管理員可查閱，操作者來自 Gateway 驗證後的使用者。AsyncLocalStorage 讓同時發生的請求各有自己的操作者、Request ID、來源 IP、User-Agent、系統來源，透過服務角色資料庫請求傳入觸發器。瀏覽器不能指定受信任操作者，也不另寫日誌。

伺服器固定 `created_at DESC, id DESC`、LIMIT/OFFSET、count=exact，限制每頁最多 100 筆。日期採台灣時區含起訖日。關鍵字查操作者、資料類型、事件、來源，支援常用繁中事件／模組別名；不掃描敏感 JSON 全文。查詢該頁涉及的人員、客戶、專案、承攬分類和品項名稱作為顯示名稱；原始關聯 ID 留在遮蔽後的 before/after。舊紀錄沒有 IP 等欄位時明確顯示未提供，無法事後補造。

密碼、token、Authorization、Cookie、service role、密文／加密金鑰等欄位遞迴遮蔽，附加 Bearer/JWT/常見明文設定字串遮蔽。新 DB 觸發器在 INSERT 前遮蔽；migration 同時清理歷史 payload。API 與 UI 再遮蔽一次。電話匯入稽核保留檔案與計數，不複製整份 source_rows。新增承攬關聯及施工人員等複合主鍵表的稽核觸發器，沿用既有 RPC 交易。

Preview 僅讀既有正式資料，登入可用；業務寫入仍封鎖。新稽核寫入欄位和觸發器已在隔離 PostgreSQL 驗證，未套用正式資料庫，所以 Preview 不會製造「已寫入正式系統」的假日誌。

## Dashboard Design

首頁只有專案檢視、維修品管理、工作日誌。三組主要查詢並行；接著批次補齊該 15 筆涉及的客戶、品項與施工人員。沒有載入全部交易後再於瀏覽器截取。

| 區塊 | 真實欄位 / ORDER BY | 筆數 |
|---|---|---|
| 未完成專案 | `updated_at DESC, id DESC`，`status <> completed` | 最多 15 |
| 維修品 | `received_on DESC, created_at DESC, id DESC` | 最新 15 |
| 工作日誌 | `log_date DESC, created_at DESC, id DESC`，排除軟刪除 | 最新 15 |

工作日誌沒有 customer_id；客戶由 project_id 對應專案取得。Desktop 足夠寬時維修／日誌並排，小螢幕單欄。首頁唯讀，保留查看全部入口。

## ERP 清單逐頁矩陣

| 頁面 / 清單 | 預設排序 | 雙擊 | 本次修改 |
|---|---|---|---|
| 取貨 | pickup_date 最新 | 編輯，保留修改鈕 | 補雙擊 |
| 進貨 | receipt_date 最新 | 編輯，保留修改鈕 | 補雙擊 |
| 維修品 | received_on 最新 | 編輯，保留修改鈕 | 補雙擊 |
| 即時庫存 | 品項 created_at 最新 | 管理員編輯 | 日期預設、補雙擊 |
| 客戶 | updated_at 最新 | 依原權限編輯 | 日期預設、補雙擊 |
| 專案 | updated_at 最新 | 依原權限編輯 | 日期預設、補雙擊 |
| 供應商 | created_at 最新 | 依原權限編輯 | 日期預設、補雙擊 |
| 使用者 | updated_at 最新 | 管理員編輯 | 日期預設、補雙擊 |
| 工作日誌 | log_date、created_at、id 最新 | 沿用既有編輯入口 | 保留既有雙擊 |
| 系統日誌 | 伺服器 created_at、id 最新 | 詳細唯讀 | 新增詳細視窗 |
| 專案統計報表 | 沿用報表彙總／日期範圍語義 | 不整列雙擊編輯 | 保留原工作日誌明細入口 |
| 盤點校正／新增品項／備份 | 表單操作，非業務資料列 | 不適用 | 保留必要入口 |

Mobile 保留按鈕；雙擊只觸發當前使用者已可見的編輯按鈕。日誌不提供編輯／刪除。

## Excel Export / Import

ERP 現有試算表匯出實際為 CSV（庫存與專案報表）；移除按鈕、handler、CSV helper 與 request_excel_sync 操作。JSON 災難復原快照不屬於試算表匯出，仍保留。案場 XLSX 匯入及其依賴保留。

監控匯入原本最多掃描 20 頁、每頁 100 筆既有設備，超過 2,000 筆可能漏查。新流程在伺服器解析檔案，去除重複 IP，再每批 250 個只查對應客戶監控承攬的現有 IP。檢查失敗或回應不完整立即停止。確認匯入仍走既有單一交易 RPC，資料庫唯一索引處理預覽到確認之間的競爭；未引入逐列 API 或無限制併發。

## Performance Analysis

瓶頸是首頁載入不需要的完整交易資料與匯入全設備掃描，採用 LIMIT、挑欄位、相依資料批次查詢、查重分批；不新增 Worker 或大型字型依賴。

| 量測 | 修改前 | 修改後 | 條件與限制 |
|---|---:|---:|---|
| 1,000 列 XLSX 解析＋驗證中位數 | 50.3405 ms | 48.8844 ms | 231,265 bytes，Windows Node 24.20.0，2 次暖機＋10 次量測；解析器未改，差異視為波動 |
| 首頁主要資料列 | 367 | 27 | 當時正式 DB read-only count；新版另有必要的關聯 lookup，兩版區塊內容不同，不作等量速度比較 |
| 新版工作日誌 LIMIT 15 SQL | — | 2.589 ms | 正式 DB EXPLAIN ANALYZE，15 rows，未套新索引；單次 execution time，不含 10.642 ms planning／網路 |
| 新版維修品 LIMIT 15 SQL | — | 1.585 ms | 正式 DB EXPLAIN ANALYZE，當時 1 row；單次 execution time，不含 11.671 ms planning／網路 |
| 2,101 個 IP 查重 | 最多讀前 2,000 台設備 | 9 批完整 IP、併發 1 | 自動化 fixture，驗證第 2,101 個 IP 的重複仍可檢出；不宣稱真實網路加速比例 |

原始數據見 `docs/optimization-verification/`。Preview 不進行正式資料寫入，因此完整匯入 Commit Time / rows/sec、真實登入後 API 延遲尚未量測，不宣稱匯入提升百分比。既有單一交易 RPC 與實際匯入解析測試保留。

## Verification

第一輪：ERP 140 tests、案場 70 tests 通過；案場 TypeScript、Next production build 通過；Gateway TypeScript 通過。初輪找到舊測試與已刪功能不一致、以及工作日誌欄位對應問題，修正後重跑。

隔離 PostgreSQL（PGlite）驗證 migration 重複執行、歷史／巢狀敏感欄位遮蔽、承攬增修刪、操作者與 IP/UA/Request ID、拒絕偽造 client 脈絡、RLS／權限，共 6 組通過。`scripts/verify-audit-migration.cjs` 可重跑，透過 `PGLITE_MODULE` 指定開發環境的 @electric-sql/pglite，不增加產品 dependency。

Windows Chrome 實際載入前端程式、使用隔離 HTTP fixture：1440px／390px、首頁 3 區與各 15 筆、9 清單雙擊、日誌查詢／第二頁／詳細／Escape、字型 computed style、無整頁橫向溢出與 JS pageerror 均通過。Fixture 不存放真實客戶資料或帳密。

第二輪部署驗證結果於交付前補入本節。macOS Safari／iPhone Safari 實機未執行；Windows 窄視窗不冒稱 iPhone 實機。正式寫入 E2E 未執行，待核准正式發布與 migration 後另驗。

## 發布與回復

本次新建獨立 `inventory-gateway-preview-optimization`；它沿用已驗證的自訂登入／角色權限，所有預覽業務寫入封鎖。正式 Gateway 未替換。正式發布時先套前向相容 migration，再部署 Gateway 與兩站；如需回復前端／Gateway，保留新增欄位及已遮蔽稽核資料，不還原敏感明文或刪除歷史資料。
