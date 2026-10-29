# 管理員查看其他人的工作指派

2026-10-29（Asia/Taipei）。依使用者要求，調整 ERP 首頁「工作指派」查看範圍，保留既有 Auth、角色、私人資料與完成通知規則。

## 來源與成果

- 本次已 fetch `Williams-CHEN0401/GUC-ERP` 的 `main`，基準為 `dec5310d29aa5e7f3703dcd3fa26733d635a35b1`。
- 工作目錄：`F:\GUC-Docker\previews\20261029-admin-assignments\erp`；分支 `codex/admin-assignment-visibility-1029`。
- 本紀錄為發布前驗收；正式部署狀態由 Docker 發布紀錄另行記錄。本次程式變更無需 migration，不修改 DB schema 或帳號角色。

## 行為

- admin 預設查看「所有人的待辦」，可切換「我的待辦」。包含一般指派、取貨、客戶預約與施工規劃。
- 每張卡顯示負責人及指派人；已停用但仍被施工規劃引用的人員保留姓名。
- 自己的工作維持原本完成／日誌入口；新增顯示的他人工作不出現代為完成或填寫日誌的按鈕。後端既有 mutation 權限不變。
- 一般角色沒有全員選項，也不會從 API 收到 `all_pending`；偽造全員 Excel 匯出請求回傳 403。不以使用者名稱提供特權。
- 全員查看仍受原有私人資料授權限制。完成通知仍只交給原指派人。
- Excel 隨「所有人／本人」清單選擇匯出待辦，匯出視窗的兩種範圍都保留此選擇。舊客戶端未傳新範圍欄位時沿用原匯出契約。

## 驗證

- ERP `scripts/check.mjs` 與 455 項既有／新增單元回歸通過。
- 真正 Gateway → 隔離 PGlite → 原有 RPC 的 11 項整合驗證通過：兩位 admin、一般人、非 admin 同名帳號、停用帳號、私人資料、完成及通知限制、超過 100 筆、匯出、RLS／ACL。
- 查詢回歸驗證跨 1000 筆分頁，沒有把全員待辦截斷為 100 筆。
- 瀏覽器 5 組驗證通過，包含四種 Excel 範圍組合、個人／全員清單、通知保留、一般角色限制、390px 手機排版。沒有 JavaScript 錯誤或頁面水平溢出。
- 初始畫面曾因輔助程式載入順序出錯，已調整 `assignment-ui.js` 在 `app.js` 初始化前載入，並由最後瀏覽器回歸確認修復。

[完整單元輸出](F:/GUC-Docker/previews/20261029-admin-assignments/unit-results.log) · [瀏覽器結果](F:/GUC-Docker/previews/20261029-admin-assignments/evidence/browser-verification.json)

## 測試網站

- [管理員](http://localhost:4370/?page=dashboard&test_user=admin)
- [另一位管理員](http://localhost:4370/?page=dashboard&test_user=admin2)
- [一般人員 A](http://localhost:4370/?page=dashboard&test_user=A)

僅本機使用，顯示合成資料；透過真 Gateway 讀取純記憶體隔離資料庫，網站寫入封鎖。不可將預覽中的登入替身或測試資料接入正式環境。

## 同回合已完成的電話資料追加

毒品防制局 Excel 已實際追加正式資料 100 筆，總計 200 筆；原有 100 筆完整保留。其匯入解析與端子槽位顯示修正位於另一個 Site 工作目錄，驗收完成，部署狀態由同次發布紀錄記錄。詳見[電話資料追加紀錄](F:/GUC-Docker/previews/20261029-phone-append/20261029_電話端子追加匯入.md)。
