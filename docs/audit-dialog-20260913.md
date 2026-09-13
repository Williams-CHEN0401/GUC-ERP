# ERP 系統日誌明細修正

基準：main 651a704dbcabb64a3a814e75f0a7ddf8913bbc8e。

原本明細的關閉按鈕使用 inline onclick，遭正式 vercel.json 的 script-src 'self' 阻擋。以正式 CSP 搭配原版頁面已在本機瀏覽器重現。此次改用原生 dialog form，右上角關閉、底部關閉與 Esc 共用原生關閉流程，不放寬 CSP。

系統日誌列保留雙擊查看，新增清楚的操作提示、鍵盤焦點與 Enter，並沿用 ERP 手機點列開啟的互動。查看詳細按鈕仍保留。關閉後焦點回到原本的資料列或按鈕；再次開啟會替換內容並重設捲動。

明細使用既有 modal-head、secondary 按鈕、details 欄位樣式及主題色彩／字體。前後修改內容分欄，手機單欄；長內容在視窗內捲動，標頭與關閉操作保持可見。系統日誌清單的詳細與分頁按鈕同步使用既有按鈕格式。

## 驗證

- Node.js 24 執行 npm run check：190 項通過（含本次場勘分類測試）。
- scripts/verify-audit-dialog-browser.mjs：原版 CSP 問題重現，以及 1440px Chrome、390px 觸控模擬驗證通過；涵蓋雙擊／觸控、Enter、查看詳細、兩個關閉按鈕、Esc、焦點還原、長內容捲動、舊紀錄缺值、HTML 跳脫及敏感欄位遮蔽。
- 新版瀏覽器流程無 JavaScript 錯誤或 CSP 違規；沒有 API 寫入。視覺截圖位於忽略提交的 tmp/audit-dialog/。
- 使用合成資料與 loopback HTTP fixture，未操作正式業務資料；手機為瀏覽器觸控模擬，未宣稱實機驗收。

重跑瀏覽器驗證：Node.js 24 執行 node scripts/verify-audit-dialog-browser.mjs；PLAYWRIGHT_MODULE 可指定既有 Playwright index.mjs 的 file URL，BROWSER_CHANNEL 預設 chrome。原版重現從本機 Git 的基準提交讀取，不下載遠端程式。需保留基準提交歷史。

系統日誌修正本身僅變更 ERP 前端，不需要資料庫或環境變數調整；本 PR 同時加入的場勘分類需要 migration 與 Edge Function 更新，發布順序請見 site-survey-20260913.md。
