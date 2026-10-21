# GUC 客戶意見調查表

獨立 Node.js 24 服務，部署於 `https://guc-erp.theworkpc.com:8888/`。客戶自行輸入客戶名稱及承攬內容，不公開 ERP 客戶名單，也不自動建立或修改主資料。

四項必填評分：服務態度、施工品質、案件處理速度、工程師專業度。每項由 5 分「滿意」至 1 分「非常不滿意」，不預選分數。填寫人姓名、改善建議及聯繫需求為選填；要求聯繫時須提供聯絡方式。送出後顯示收件編號，同一頁重試採 request UUID 防止重複寫入。

## 內部管理

`/admin` 沿用既有 ERP Gateway 登入與 Supabase Auth，不另建帳號或角色。具有既有 `settings VIEW` 權限者可搜尋及查看回覆；CSV 匯出另需 `data_export VIEW`。回覆不開放公開讀取；客戶資料只供內部改善及必要聯繫使用。登入 session 存於 Secure、HttpOnly、SameSite cookie，前端不取得服務金鑰。

## 執行

`npm test` 執行欄位及 HTTP 邊界測試。`npm start` 啟動網站。無外部 npm 相依套件。Docker 只複製程式與 public 資源。

必需環境變數：

| 名稱 | 用途 |
| --- | --- |
| `SUPABASE_REST_URL` | 本機 Supabase REST `/rest/v1` |
| `SUPABASE_AUTH_URL` | 本機 Supabase Auth `/auth/v1` |
| `SUPABASE_SERVICE_ROLE_KEY` | 僅由受保護 runtime env 注入 |
| `GUC_GATEWAY_URL` | 既有 `inventory-gateway` |
| `FEEDBACK_ALLOWED_ORIGINS` | 逗號分隔的 HTTPS 入口，含 8888 埠 |
| `FEEDBACK_COOKIE_SECURE` | 正式環境必須為 `true` |
| `FEEDBACK_VERSION` | 來源 commit |
| `HOST`, `PORT` | Docker 使用 `0.0.0.0`、`3000` |

資料庫僅套用 `20261021145208_customer_feedback_survey.sql`。新增回覆表啟用 RLS，匿名與一般 authenticated 角色沒有資料表及 RPC 權限；服務角色透過後端驗證欄位及既有 RBAC。請勿直接公開服務角色憑證。反向代理必須以實際連線來源覆寫 `X-Forwarded-For`，避免偽造限流識別。

正式 Compose 範例在 `deploy/compose.feedback.yaml`；請加入既有 Compose 檔案清單，保留當前網站映像版本 overlay。新增 8888 轉送需重建 HTTPS 代理一次，不需重建既有三個網站。路由器 NAT 為外部 TCP 8888 → 192.168.17.213:8888，Windows 防火牆亦需允許此入口。沿用既有憑證與自動續期。

回覆備份沿用本機 PostgreSQL 備份流程。runtime env、資料庫備份與憑證不可放進 Git 或映像。正式資料讀寫測試應在隔離資料庫進行，不產生假客戶回覆。
