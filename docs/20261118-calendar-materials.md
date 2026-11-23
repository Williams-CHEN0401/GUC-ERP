# Prompt111：月曆、分列單據與散料核對

完成日期：2026-11-18（Asia/Taipei）。

## 來源及工作區

- Repository：https://github.com/Williams-CHEN0401/GUC-ERP
- GitHub main 已於 2026-11-18 重新 fetch 核對，基底為 `1403bd1ab763d4dda8a45dab264587d3312bad11`。
- 開發分支：`codex/calendar-loose-materials-1117`。
- 程式碼位於 `F:\GUC-Docker\previews\20261110-item-aliases\erp`，本次改動保留於開發工作區，未推送、未合併、未正式發布。

## 完成行為

1. 首頁提供月曆與行事曆切換、前後月、今天、人員篩選及當日行程。工作指派、客戶預約和授權可見的施工規劃都會列出。一般工作沿用建立日期；預約沿用預約日期；施工規劃沿用施工日期。沒有另造排程資料。
2. 多人同次指派仍合併顯示，完成按鈕只完成登入者自己的指派；部分人完成時顯示「部分完成」。原本不限日期的個人待辦與完成通知保留。負責的施工進度固定放在工作內容之前。
3. 新增／修改取貨、進貨、供應商退貨可保留相同品項的獨立明細。搜尋帶入同品項會填空白列或新增下一列。案場餘料原本的分箱紀錄繼續保留。
4. 取貨可保留負庫存供人工校正。數量格式、來源箱與品項關聯、角色權限、版本衝突及請求重送防護仍有效；沒有清除歷史單據或改寫舊規格。
5. 用料彙總增加原始數量與單據長度快照的明細，數值排序仍正確。土庫國小顯示「255 米散料＋10 箱 × 305 米＝3,305 米」。

## 散料問題的實際查核

本次查核時，正式資料庫 RPC 與隔離站載入的原版圖表、材料彙總皆已顯示 3,305 米，未重現漏算 255 米的問題，因此沒有修改正確的統計公式或既有資料。改為顯示可以核對的整箱與散料來源。

以正式資料庫的唯讀交易核對目前帳號可查看的 195 個工程施工／維修查修工作內容、316 筆取貨、282 個品項與單位群組；領用量與紀錄筆數皆相符，差異為 0。此檢查保留私有資料權限，不繞過可見範圍。

## 驗證

- 既有及新增 Node 測試：560 通過、0 失敗。
- JavaScript 語法、Gateway TypeScript、`scripts/check.mjs`、`git diff --check` 通過。
- 原生 PostgreSQL 回滾測試：相同品項進貨新增／修改／重送、供應商退貨重送、實體餘料分箱；月曆管理者、本人與無權限拒絕路徑、日期範圍及 RPC 執行權限均通過。
- Playwright 真實表單：搜尋同一 CAT-6 網路線兩次，分列以米取貨、負庫存、整單修改、重送及過期版本拒絕；進貨同品項兩列、公司入庫均通過。
- 月曆多人指派合併、只完成本人、部分完成、月份／人員／日期切換、施工規劃順序均通過。
- 全新 390px 手機 context 實測：頁面 scrollWidth 390、側欄收合，月曆及行程可讀。
- Supabase 安全顧問唯讀檢查：0 findings（warn 以上）；臨時檢查通道已移除。
- 額外搜尋另外兩站目前 checkout 的 JS/TS，沒有發現相同「合併數量／同一批取貨」攔截字串；本次未修改或宣稱完整測試另外兩站。

## 測試站

http://localhost:4645/?page=dashboard

土庫國小用料報表：
http://localhost:4645/?page=materials&work_content_id=16e2fa0f-55bc-405f-9b24-7b4e33379a3a

僅綁定本機 127.0.0.1。測試身分透過既有隔離測試入口，不連正式 Auth；資料庫為 `guc_construction_relink_20261113`，NAS／外部請求有隔離邊界。內含明確標示的驗收資料，不能作為正式庫存依據。

## 正式發布時的相依項目

本次尚未取得正式發布授權。後續正式發布需一併部署：

- ERP HTML、JS、CSS（包含新增 `assignment-calendar.js`、`assignment-calendar.css`）。
- `supabase/functions/inventory-gateway/index.ts`。
- `supabase/migrations/20261117150501_dashboard_calendar_duplicate_transaction_rows.sql`。

Migration 延續既有函式與權限、新增 service_role 專用的 invoker 月曆 RPC；沒有新增主資料表。正式部署應先備份，核對既有函式版本及測試後再套用。不可只更新前端或只更新資料庫。

詳細執行證據：`F:\GUC-Docker\diagnostics\20261117-prompt111`（all-projects-report-audit.json、browser-verified.json、final-browser-verified.json、native-verified.json、advisors.json、mobile-verified.json、check-final.log）。
