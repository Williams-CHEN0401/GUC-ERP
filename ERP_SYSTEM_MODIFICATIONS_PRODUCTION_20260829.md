# GUC ERP 正式發布紀錄（2026-08-29）

## 發布結果

- 正式網站：https://guc-erp-vercel-rebuild.vercel.app/
- Vercel Production deployment：`dpl_2JGcVK3kSvg86pVFR2EoVqEBR1pB`
- Vercel 狀態：`READY`
- Supabase Edge Function：`inventory-gateway` v27，狀態 `ACTIVE`
- Supabase migration：`contract_attachment_project_path_no_work_log`

## 本次最後調整

- 刪除「上傳案場附件」中的「關聯工作日誌」欄位。
- 新上傳附件不再傳送或建立 `work_log_id` 關聯。
- Gateway 忽略舊版前端傳入的工作日誌值，固定以 `work_log_id = null` 註冊附件。
- NAS 路徑日期一律採用 Asia/Taipei 上傳日期。
- 歷史附件及既有工作日誌關聯不刪除、不搬移、不改寫。

## 驗證結果

- JavaScript 語法檢查：通過。
- 自動化測試：22 / 22 通過。
- Vercel build error：0。
- Vercel Production runtime error／fatal：0。
- 正式登入頁、主導覽、標題與正式系統標記：正常。
- 附件註冊 RPC 權限：`anon` 與 `authenticated` 不可直接執行，僅 `service_role` 可執行。

## 正式資料核對

| 資料表 | 發布前 | 發布後 |
|---|---:|---:|
| customers | 120 | 120 |
| projects | 19 | 19 |
| sites | 5 | 5 |
| site_work_logs | 5 | 5 |
| site_assets | 7 | 7 |
| contract_service_types | 7 | 7 |
| customer_contract_services | 5 | 5 |

所有核對表筆數一致；本次發布未刪除或搬移既有資料與 NAS 檔案。

## 備註

`SITE_SYSTEM_TARGET_URL` 仍維持空值；使用者選擇「案場系統」時會顯示尚未設定，而不會跳轉到未確認的網址。
