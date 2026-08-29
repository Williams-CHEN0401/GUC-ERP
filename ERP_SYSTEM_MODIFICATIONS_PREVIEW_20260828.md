# ERP 系統修改 Preview 驗收報告

日期：2026-08-28  
狀態：Preview 已完成，正式網站與正式 Supabase 尚未更新

## Preview

- 網址：https://guc-erp-vercel-rebuild-4zj19uqrn-sam5321051-5955s-projects.vercel.app/（原臨時分享 Token 已移除）
- Deployment ID：`dpl_DvoJzEiJZpUEwkA9Dn7XC33iemCq`
- Vercel 狀態：`READY`

## 已完成修改

1. 工作日誌列表不再直接展開完整內容；「內容」改為單一可點入口，開啟既有工作日誌 Modal。Viewer 僅能查看，Admin／Operator 才能儲存。
2. 附件表單新增客戶、承攬內容、專案連動選單；承攬內容只取自所選客戶的既有關聯，工作日誌只顯示所選專案資料。
3. 新附件 NAS 路徑改為 `/GUC-ERP/客戶名稱/承攬內容/專案名稱/日期/檔名`。前端、NAS API、Gateway 與資料庫 RPC 均驗證客戶、承攬內容、專案及工作日誌關聯。
4. 登入成功後先顯示系統選擇視窗；ERP 系統進入目前 Dashboard。案場資料按鈕與未設定提示已完成，但不建立假網址、不執行錯誤跳轉。

## 主要修改檔案

- `index.html`
- `styles.css`
- `app.js`
- `api/nas.mjs`
- `supabase/functions/inventory-gateway/index.ts`
- `supabase/migrations/20260829000100_contract_attachment_project_path.sql`
- `scripts/check.mjs`
- `scripts/correction-v1.test.mjs`
- `scripts/nas-upload.test.mjs`
- `scripts/erp-system-modifications.test.mjs`

## 驗證結果

- JavaScript 語法檢查：通過。
- 自動化測試：21／21 通過。
- Preview API 寫入阻擋：通過。
- Vercel Preview 建置：READY。
- Preview 登入頁：正常載入。
- Vercel Runtime error／fatal：0 筆。
- 瀏覽器主控台：無網站程式錯誤；僅有瀏覽器擴充功能自身訊息。

## 正式發布前待處理

1. 由使用者登入 Preview，驗收工作日誌內容 Modal、附件連動選單與登入後系統選擇視窗。
2. 未來案場系統完成後，在 `app.js` 的 `SITE_SYSTEM_TARGET_URL` 設定正式網址。
3. 正式發布時依序套用 `20260829000100_contract_attachment_project_path.sql`、部署新版 `inventory-gateway`，最後發布 Vercel Production。
4. 正式發布前後再次核對既有客戶、專案、工作日誌及附件筆數；本次 Preview 沒有寫入正式資料庫或 NAS。
