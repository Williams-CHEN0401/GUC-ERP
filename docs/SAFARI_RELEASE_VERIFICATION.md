# Safari 發布驗證（2026-09-07）

本文件補充 OPTIMIZATION_REVIEW.md 的 Preview 階段紀錄。使用者已要求 Safari 驗證後發布正式網站。

## 實際 Safari

- GitHub macos-15-intel runner：macOS 15.7.9、Safari 26.6，Apple SafariDriver，非模擬瀏覽器。
- [完整執行紀錄](https://github.com/Williams-CHEN0401/GUC-Site-Data/actions/runs/34045457854)：13 組操作檢查全部通過。
- ERP：原生登入、首頁三區與各 15 筆資料、取貨／進貨／維修品／庫存／客戶／專案／供應商／使用者／工作日誌九清單原生雙擊編輯。
- ERP 與案場：日誌篩選、第二頁、明細、敏感內容遮蔽、Escape 關閉；案場字型一致、800px 無整頁橫向溢出；無 JavaScript pageerror。
- 使用真實應用程式與隔離 HTTP fixture，沒有使用正式客戶帳密或寫入業務資料。macOS Safari 不代表 iPhone Safari 實機；iPhone 實機與正式帳號完整寫入 E2E 未執行。
- 首次測試因表格非同步替換導致測試元素過期；修正測試等待後全數通過，沒有修改產品操作邏輯。
- 同一 runner ERP 142 tests、案場 70 tests、TypeScript 與 Next production build 通過。Safari 所測產品版本 ERP 38c2772、案場 068408c；後續 ERP 僅增加資料庫 migration、驗證脚本與此紀錄。

## 正式資料庫與 Gateway

- 已套用 audit_context_and_query_indexes、allow_session_audit_events 兩個前向相容 migration。
- 發布驗證發現既有 audit_logs_action_check 未允許 LOGIN／LOGOUT，已保留既有事件並加入兩值，避免登入稽核寫入被拒絕。
- 正式資料庫交易測試：LOGIN 的 actor、UUID、來源 IP、Request ID、system_module、巢狀 token 與密碼遮蔽皆通過；交易回復後測試紀錄為 0。
- 歷史未遮蔽 payload 為 0；新增 5 個關聯表稽核 trigger、4 個查詢 index；security advisor 比對無新增項目。
- 隔離 PostgreSQL 完整重測 7 組，兩個 migration 均可重複執行，LOGIN／LOGOUT 可用、非法事件仍拒絕。ERP 142 tests 再次通過。
- inventory-gateway version 51 ACTIVE，沿用既有自訂驗證與角色權限；未登入的讀取、修改請求均為 401。

## 發布設定與回復

兩站透過 PR squash merge 至最新 main 觸發 Production 建置，以 VERCEL_ENV=production 選擇正式 Gateway 與配套網址。不得直接將 Preview 建置當正式版本使用。

環境變數名稱：VERCEL_ENV、NEXT_PUBLIC_SITE_DATA_URL、NEXT_PUBLIC_ERP_URL；Gateway 既有私密設定不變。沒有新增必填私密環境變數。

回復目標：ERP 原正式部署 dpl_E1FxWLLFD3jtCMYBkuiYztJjPMHf（4b2fd45）；案場原正式部署 dpl_SnAkXk9bwA2z5MKWu1B8qgdGSMge（77162d5）；Gateway 原 version 50 的來源已在工作區備份。回復前端／Gateway 時保留新增欄位、索引及已遮蔽歷史資料，不刪除正式資料或還原敏感明文。
