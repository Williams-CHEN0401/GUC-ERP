# GUC ERP 績效模組實作與操作說明

日期：2026-10-25（Asia/Taipei）

已完成隔離環境開發：P0 月度流程及 CSV 所列 AT-23、AT-24 的 P1 必要功能。24 項自動驗收、450 項既有測試與相關 Gateway／資料庫回歸通過。正式環境尚未套用 migration、部署或開啟功能；尚未推送 GitHub。

詳見 [驗收報告](20261025_驗收報告.md)、[正式發布計畫](20261025_正式發布計畫.md)。[原始開發計畫](plan.md) 保留實作前狀態，實際完成狀態以本文件與驗收報告為準。

## 開發基準

- 儲存庫：Williams-CHEN0401/GUC-ERP。
- 分支：`feature/performance-module-1025`；工作樹：`F:/GUC-Docker/workspaces/performance-module`。
- 開工時 main：`2234c5a677a92fc2ea2acf5fa62d108080bb2d6a`。已納入正式部署的施工監控相依提交 `ae701853e5af0d63bd2b0fe7607d3c40b56e7b5b`。
- 正式基準已唯讀查證為 PostgreSQL 17.6。測試使用相同 PostgreSQL、GoTrue、PostgREST、Edge Runtime 版本，匯入 schema-only 並建立合成資料。
- 需求以 [Markdown](sources/requirements-v1.md) 為主；[JSON](sources/weights-v1.json) 是初始評分設定；[CSV](sources/acceptance-v1.csv) 是驗收依據。

## 完成功能

| 頁籤 | 功能 |
|---|---|
| 我的績效 | 本人已發布月份、年度分數趨勢、評核內容、改善項目、待回覆評核及佐證提交 |
| 我的共同任務 | 工具、車輛、材料、交接及其他公共任務；指派、完成說明、驗證、退回及取消 |
| 主管評核 | 僅指定員工；分項評級、N/A 原因、候選佐證、逐人確認、改善事項及送出 |
| 考核設定 | 版本化四職務／七指標權重、月份、試評／生效日期、工作日曆、指定評核人／核定人、職務配比 |
| 核定與紀錄 | 員工回覆、管理員答覆、核定、發布、歷史修訂；禁止自我核定 |
| 技術矩陣 | L1–L4、實作證明、評核人及版本；僅依已發布評核登錄，員工不能擅改 |
| 季度報表 | 有效已發布月份平均、樣本月份及有效權重、缺資料月份；不以零替代缺值 |

CSV 與 Excel 匯出沿用既有 Excel 工具，伺服器逐份驗證評核查閱權限，輸出欄位為月份、員工、版本、狀態、分數與等級。

## 整合與資料保護

沿用 `app.js` 的登入、導航與 `apiRequest`，經既有 `/api/inventory` 代理進入 `inventory-gateway`。不重建使用者、工程、工單或維修主檔。既有 `role_permissions` 增加 `performance` 模組，既有非管理員角色不會自動獲得新權限。

新增 14 張績效資料表，全部開啟 RLS，撤銷匿名與 authenticated 直接存取。RPC 僅允許既有 service_role 路徑，並以 Gateway 驗證的目前帳號作為 actor；每次操作再查權限、指定關係及狀態。新表人員外鍵引用 `app_users`。

後端 PostgreSQL NUMERIC 計分；前端只顯示結果。每職務依有效項目權重正規化，再依事先核定配比加權，中間值不提前四捨五入，最後 HALF_UP 到兩位並判定 A/B/C/D。`UNRATED`、`NA`、`NO_DATA` 各自處理，無有效分數不能送出或發布。計分版本為 `decimal-v1`。

流程：`DRAFT → SUBMITTED → EMPLOYEE_RESPONDED 或 ACK_TIMEOUT → APPROVED → PUBLISHED`。員工回覆「知悉」與「有疑義」不改變主管分數；逾期不代表同意。必須先設定工作日曆與期限，管理員才能執行逾期轉態；本期沒有背景排程自動轉態。

發布後保留分數、配比、權重及佐證快照，透過新修訂更正，原版本仍可查證。佐證每次讀取重新檢查既有私人案場與來源權限；來源刪除或權限撤銷後遮蔽摘要與識別資訊。查看目前來源另經授權查詢，不覆寫封存摘要。

寫入沿用 `audit_logs`；保存操作人、時間、前後內容與 request_id，避免寫入登入憑證。request_id 重送採交易鎖與內容指紋，舊 row_version 回報 409。切換登入人會清除績效前端快取。

## 測試站操作

測試站為 `http://localhost:4268/?page=performance`，僅本機可連線。合成測試帳號列於工作樹的 `tmp/performance/preview-access.md`；該檔不納入 Git，也不會由網站公開。

1. 管理員登入「考核設定」，從 JSON v1.0 建立權重版本；每職務七項合計必須為 100。
2. 建立月份，選模板，填試評／生效日期。若未確定公司工作日曆，保持回覆期限未設定。
3. 選員工、指定主管及其他管理員核定人，核定總和 100% 的職務配比並建立草稿。
4. 指定主管評級、填說明、確認佐證及改善事項；保存後由後端重算，再送出。
5. 員工登入查看待回覆評核並回覆；核定人閱讀回覆後分別執行核定與發布。
6. 員工重新整理後可查看與匯出自己的發布結果。後續更正由管理員建立修訂，重走流程。

測試資料月份刻意使用未來年份以避免多次測試碰撞，不代表實際公司考核政策。

## 重現測試

需 Node.js、Docker Desktop、測試用 `pg`、Playwright（Chrome／Edge／WebKit）。本機 Playwright 路徑可由 `PLAYWRIGHT_MODULE` 覆寫。既有部分回歸測試另需 `@electric-sql/pglite` 與 TypeScript。依賴僅供開發測試，未改變正式應用套件。

現有隔離堆疊已啟動；先在本工作樹執行：

```powershell
node scripts/verify-performance-isolation.mjs
npm run check
docker exec -e PERFORMANCE_TEST_INTERNAL=true guc-performance-test-erp-1 node scripts/verify-performance-db.mjs
docker exec -e PERFORMANCE_TEST_INTERNAL=true guc-performance-test-erp-1 node scripts/verify-performance-extra.mjs
node scripts/verify-performance-ui.mjs
node scripts/verify-performance-ui-boundaries.mjs
node scripts/verify-performance-static.mjs
node scripts/performance-setup.mjs --fresh
```

資料庫案例會建立新合成帳號與月份，並更新 `tmp/performance/runtime.json`；後續瀏覽器測試依賴該次資料，應接續執行。測試 session 有效期有限，過期時先重跑資料庫案例，不擴大正式驗證權限。

功能關閉回歸需先以 `tmp/performance/feature-off.yaml` 同時覆寫 ERP／Gateway 的 `GUC_PERFORMANCE_ENABLED=false`，只重建這兩個測試服務，再執行 `verify-performance-off.mjs`；完成後使用原 compose 還原兩個服務，重新驗證隔離。不能在正式堆疊執行此測試。

重新建立隔離環境時，`performance-isolation.mjs` 會產生獨立金鑰及專屬 compose，遇到既存設定會停止；須另備唯讀取得的 schema-only 基準，依 `--baseline`、`--auth-passwords`、`--migrate` 初始化。`--functions` 只供隔離開發更新函式；正式發布必須依發布計畫套用精確 SQL，不能用此開發捷徑。

## 本期界線

- 完整 P1 申覆追蹤、改善事項後續結案工作流、進階難度校正及更多管理報表，未納入本期。
- 試評起算、生效日期、真人角色授權、評核／核定名單、工作日曆與保存期限，仍由公司在正式啟用前設定；90 天為試評政策，沒有自動轉正式生效的排程。
- 已完成 390px 瀏覽器驗證；尚未做手機實機、人員業務試用或大資料量壓力測試。
- 正式發布與遠端 Git 操作尚未執行。
