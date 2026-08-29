# GUC ERP Vercel Rebuild

依 2026-08-23 ChatGPT／Codex 交接文件重建的 Vercel 正式版。

- 透過 Vercel Function 轉送既有受保護 ERP API，不在原始碼保存 Gateway token 或 service role。
- 登入前不讀取客戶或庫存資料；登入工作階段只保存在瀏覽器 sessionStorage。
- 正式發布依序執行資料庫備份與 preflight、migration、Edge Function、Vercel Production、上線驗證；不執行 seed 或 restore。
- 「案場資料」以客戶承攬內容為核心；新平面、走線、設備、施工備忘及附件綁定客戶＋承攬內容。既有專案案場保留為未歸類歷史資料，不自動重新綁定。
- 「現場照片／施工照片」頁籤已移除；附件功能仍保留於獨立的「附件」頁籤。
- 工作日誌的工作類型限定為「工程施工」、「維修紀錄」、「維護保養」，前端、Gateway 與資料庫約束一致。
- 工作日誌可複選既有系統使用者作為施工人員，並可從日誌直接登錄取貨；取貨仍共用既有 `pickup_records`、庫存扣減、稽核與同步流程。
- 新附件上傳固定使用 NAS `/GUC-ERP/客戶名稱/承攬內容/專案名稱/日期/檔名`；同名檔案必須選擇覆蓋、另存新檔或取消，寫入後再驗證檔案存在與大小。新附件不建立工作日誌關聯，歷史附件的關聯與路徑不改寫。
- 所有正式寫入仍由既有 Gateway 執行 Auth、RBAC、驗證、版本控制與 Audit Log。

執行 `npm run check` 可檢查必要檔案與主要頁面標記，並執行 NAS 命名、碰撞、檔案限制、驗證與逾時測試。

NAS Vercel Function 需要在對應環境設定 `NAS_WEBDAV_URL`、`NAS_WEBDAV_USERNAME`、`NAS_WEBDAV_PASSWORD`，根目錄固定為 `NAS_WEBDAV_ROOT=/GUC-ERP`。變數名稱範本見 `.env.example`；真實帳密不可寫入原始碼。Preview 刻意不載入或檢查正式 NAS 帳密，附件流程只做瀏覽器安全模擬；Production 仍會在伺服器端嚴格檢查上述三個必填變數。

資料庫 migration：

- `20260827000100_add_nas_attachment_index.sql`：交接快照已顯示正式庫套用相同 NAS 變更，發布時只做唯讀核對。
- `20260827000200_formal_site_crud_and_work_type.sql`：本次正式發布的新 migration。
- `20260828000100_work_log_workers_pickups_and_nas_folders.sql`：新增工作日誌施工人員、既有取貨共用關聯與重送防護；正式 migration 記錄版本為 `20260828003547`。
- `20260828000200_standalone_work_logs_contracts_accounts_nas.sql`：已套用；工作日誌獨立專案關聯與客戶承攬內容主檔。
- `20260828000300_contract_centric_sites.sql`：已套用；新增案場客戶＋承攬內容關聯，保留全部歷史專案關聯。
- `20260828000400_lock_down_work_log_project_trigger.sql`：已套用；限制工作日誌專案同步函式的執行權限。
- `20260829000100_contract_attachment_project_path.sql`：已套用；附件路徑加入專案層級，並禁止新附件建立工作日誌關聯。

版本控制與多人協作方式請見 `CONTRIBUTING.md` 與 `VERSION_CONTROL_AND_COLLABORATION.md`。
