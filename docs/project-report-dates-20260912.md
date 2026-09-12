# 工作內容統計報表預設日期

## 來源與狀態

- Repository：Williams-CHEN0401/GUC-ERP。
- 2026-09-12 查核 GitHub `main`：`874568582d2a8d2b8287b46cd640b3718846df7e`。
- 分支：`codex/project-report-dates-20260912`。
- 僅本機修改與驗證，未推送 GitHub、發布 Vercel 或套用正式資料庫。

## 日期規則

- 開始：`projects.created_at` 的台灣日期，不使用可手動修改的 `project_date`，也不使用工作日誌日期。
- 結束：沿用 `projects.completed_on`，由既有專案資料表的 BEFORE ROW trigger 記錄標記完成當天。
- 工作內容管理與工作日誌同步狀態時皆觸發；一般修改不得移動完成日期。
- 改回進行中會清空完成日期；再次完成記錄新的完成日期。建立時即完成則記錄建立當天。
- 選擇工作內容及其狀態／日期更新時重設預設範圍；切換報表分頁、一般重新渲染保留手動日期篩選。
- 進行中或舊資料無法確認完成日期時，結束留白（不限制）；不猜測或以最後修改日期代替。

## 相容性與正式發布待辦

- Migration：`20260912053403_track_project_completion_date.sql`，使用 Supabase CLI 建立檔名。
- 沿用既有欄位、API snapshot、Auth、RBAC、RLS，沒有新主資料表或授權捷徑。
- 先依 `audit_logs` 專案 insert／狀態轉入 completed 的最新紀錄補齊空值，再安裝 trigger。保留已有完成日期。
- 2026-09-12 唯讀查核：78 個專案（52 已完成、26 進行中）；52 個已完成皆有可回溯狀態紀錄，目前 completed_on 皆空白。這是查核結果，尚未補寫正式資料。
- 正式補寫會沿用既有版本與稽核 trigger，因此發布前仍需使用者同意，備份／查核當時的資料與 migration 歷史。沒有新增環境變數；Gateway 已回傳 completed_on，不須為本次修改 Gateway。Migration 短暫鎖定專案寫入，避免補齊與安裝 trigger 之間漏記；等待鎖超過 5 秒會安全失敗回滾。
- 回退前端不需刪除日期；若停用新 trigger，保留已填日期和歷史紀錄，不刪資料。

## 驗證

- `node scripts/check.mjs`、JavaScript 語法檢查、185 項 Node 測試通過。
- `scripts/verify-project-report-dates-db.mjs`：使用本機 PGlite 和 repository 既有專案／日誌雙向同步函式驗證歷史補齊、未知日期、普通更新、建立即完成、重開、再次完成、日誌同步、RLS 與函式 EXECUTE 限制；不連線正式資料庫。
- `scripts/verify-project-report-dates-browser.mjs`：Playwright／Chrome 在 1440px、390px 與美西瀏覽器時區驗證台灣日期、報表連結、自動篩選含起訖日、手動篩選、切換專案及分頁、表單完成／重開，無 pageerror。
- `agent-browser` 未安裝，使用現有 Playwright；尚未執行 Safari 或正式登入環境的本次測試。
- 本機測試網站：執行 `node scripts/report-dates-preview-server.mjs`，開啟 `http://127.0.0.1:4192/?page=materials&work_content_id=p1`。全為人造資料，不連線外部 API，不寫入正式資料庫。
