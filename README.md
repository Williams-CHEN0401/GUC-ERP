# GUC ERP Vercel Rebuild

依 2026-08-23 ChatGPT／Codex 交接文件重建的 Vercel 正式版。

- 透過 Vercel Function 轉送既有受保護 ERP API，不在原始碼保存 Gateway token 或 service role。
- 登入前不讀取客戶或庫存資料；登入工作階段只保存在瀏覽器 sessionStorage。
- 「案場資料」會在新分頁開啟；兩站以限定來源、視窗與 nonce 的 `postMessage` 交接短期 access token，不傳送密碼、refresh token，也不把 Token 放進網址。
- 正式發布依序執行資料庫備份與 preflight、migration、Edge Function、Vercel Production、上線驗證；不執行 seed 或 restore。
- 「案場資料」以客戶承攬內容為核心；新平面、走線、設備、施工備忘及附件綁定客戶＋承攬內容。既有專案案場保留為未歸類歷史資料，不自動重新綁定。
- 「現場照片／施工照片」頁籤已移除；附件功能仍保留於獨立的「附件」頁籤。
- 工作日誌的工作類型包含「工程施工」、「維修紀錄」（顯示為維修/查修）、「維護保養」、「送貨」，前端、Gateway 與資料庫約束一致。
- 工作日誌可填寫每筆獨立「時段」，並可設定「進行中／已完成」；狀態視為專案層級資料，從工作日誌或專案管理修改時會同步同一專案的全部工作日誌。
- 客戶分類包含「學校機關、政府機關、社福機關、清潔隊」；正式 migration 只依既有名稱中的「社福／清潔隊」分類，不新增或改寫客戶名稱。
- 工作日誌可複選既有系統使用者作為施工人員，並可從日誌直接登錄取貨；取貨仍共用既有 `pickup_records`、庫存扣減、稽核與同步流程。
- 原「專案用料」入口已升級為「專案統計報表」，保留 `materials` route，提供總覽、用料統計與施工人員三分頁；客戶／專案與日期篩選會同時套用既有取貨、工作日誌及施工人員資料，且不同材料單位分開彙總。
- `inventory-gateway` 的共用 RPC 回應處理可接受成功的 `204` 空本文，避免總機、分機或監控設備實際刪除成功後被誤報失敗；電話總機名稱重複時會保留明確的資料庫錯誤訊息。
- 新附件上傳固定使用 NAS `/GUC-ERP/客戶名稱/承攬內容/專案名稱/日期/檔名`；同名檔案必須選擇覆蓋、另存新檔或取消，寫入後再驗證檔案存在與大小。新附件不建立工作日誌關聯，歷史附件的關聯與路徑不改寫。
- 所有正式寫入仍由既有 Gateway 執行 Auth、RBAC、驗證、版本控制與 Audit Log。

執行 `npm run check` 可檢查必要檔案與主要頁面標記，並執行 NAS 命名、碰撞、檔案限制、驗證與逾時測試。

## 2026-09-16 工作內容與設備驗證更新

### 工作日誌選擇與維修收件日期

- 修改日誌保留手動輸入，並提供明確下拉選單；選項限定同客戶／科室、進行中工作內容。手動輸入新名稱仍同步共用名稱；選擇另一筆既有工作內容只改這筆日誌歸屬，沿用目標類型／狀態。
- 歸屬調整保留原有 Auth、工作日誌與工作內容更新權限；已有取貨或歷史附件的日誌不直接搬移，以免改寫相關帳務。維修與施工人員仍連結原日誌 ID。
- 從工作日誌登錄的維修品收件日期使用日誌日期；後續儲存日誌同步對應維修品日期，不更動手動新增維修品，也不批次回填歷史資料。
- 發布前依序套用 `20260916001938_worklog_title_selection.sql`、`20260916002422_worklog_repair_received_date.sql`，再更新 ERP 前端；兩者保留既有函式簽章／權限，不需新環境變數或 Gateway 修改。
- 隔離資料庫回歸：`node scripts/verify-worklog-title-db.mjs`；瀏覽器：`node scripts/worklog-title-preview-server.mjs` 與 `node scripts/verify-worklog-title-browser.mjs`（可設定 `WORKLOG_TEST_PORT`／`WORKLOG_TEST_URL`）。

- 工作日誌名稱可由具備 `projects UPDATE` 的非專案限定使用者修改，同步共用專案及相關日誌名稱；保留版本鎖、科室、其他欄位及歷史報價快照。
- ERP 與報價共用 `erp_work_content_types_v1`；施工子分類仍為 `small_purchase`／`tender`。
- 設備帳密揭露需以既有 Supabase Auth 再次驗證當前使用者，且符合 site／phone／credentials 權限及設備所屬客戶／有效承攬；一般分頁不增加登入次數。
- 發布需先套用 `20260915150407_shared_work_types_and_worklog_rename.sql`，再套用報價庫 `20260915150411_quotation_inline_workflow.sql`，之後更新兩個 Gateway 與三個網站。兩份 migration 不重寫歷史業務資料；資料庫只採 forward-fix，不能刪除資料回滾。

NAS Vercel Function 需要在對應環境設定 `NAS_WEBDAV_URL`、`NAS_WEBDAV_USERNAME`、`NAS_WEBDAV_PASSWORD`，根目錄固定為 `NAS_WEBDAV_ROOT=/GUC-ERP`。變數名稱範本見 `.env.example`；真實帳密不可寫入原始碼。Preview 刻意不載入或檢查正式 NAS 帳密，附件流程只做瀏覽器安全模擬；Production 仍會在伺服器端嚴格檢查上述三個必填變數。

資料庫 migration：

- `20260827000100_add_nas_attachment_index.sql`：交接快照已顯示正式庫套用相同 NAS 變更，發布時只做唯讀核對。
- `20260827000200_formal_site_crud_and_work_type.sql`：本次正式發布的新 migration。
- `20260828000100_work_log_workers_pickups_and_nas_folders.sql`：新增工作日誌施工人員、既有取貨共用關聯與重送防護；正式 migration 記錄版本為 `20260828003547`。
- `20260828000200_standalone_work_logs_contracts_accounts_nas.sql`：已套用；工作日誌獨立專案關聯與客戶承攬內容主檔。
- `20260828000300_contract_centric_sites.sql`：已套用；新增案場客戶＋承攬內容關聯，保留全部歷史專案關聯。
- `20260828000400_lock_down_work_log_project_trigger.sql`：已套用；限制工作日誌專案同步函式的執行權限。
- `20260829000100_contract_attachment_project_path.sql`：已套用；附件路徑加入專案層級，並禁止新附件建立工作日誌關聯。
- `20260831081216_work_log_period_project_status_sync.sql`：新增工作日誌時段，並以新版原子 RPC 雙向同步工作日誌與專案狀態；正式發布前只在回滾交易中驗證。
- `20260831105247_add_social_welfare_and_cleaning_customer_categories.sql`：擴充客戶分類，並將名稱含「社福／清潔隊」的既有客戶歸入對應分類；正式發布前只在回滾交易中驗證。
- `20260902010234_monitoring_device_management.sql`：為獨立案場網站擴充監控設備、AES-GCM 密文儲存、軟刪除與原子 Excel 匯入；目前只在 feature branch，使用者確認 Preview 前不得套用正式資料庫。

版本控制與多人協作方式請見 `CONTRIBUTING.md` 與 `VERSION_CONTROL_AND_COLLABORATION.md`。

跨 ERP 與獨立案場系統的正式架構、SSO、Gateway API、資料模型、環境變數、發布、回滾與驗收規格，以 [`GUC-Site-Data/docs/SYSTEM_SPECIFICATION.md`](https://github.com/Williams-CHEN0401/GUC-Site-Data/blob/main/docs/SYSTEM_SPECIFICATION.md) 為單一正式來源。
