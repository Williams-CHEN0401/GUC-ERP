# GUC ERP 績效考核模組開發與驗收計畫

日期：2026-10-25（Asia/Taipei）
狀態：需求與正式基準已查核；本文件為實作前計畫。尚未建立績效資料表、修改應用程式或啟動功能驗收。

本次在既有 GUC ERP 擴充績效考核。先完成 P0 月度流程，再處理 CSV 中兩項 P1 驗收；依使用者原始要求，24 項案例全部通過後才提出正式發布計畫。所有開發寫入與功能測試先在獨立測試環境完成。

## 1 文件依據與衝突處理

| 來源 | 用途 | 本次採用方式 |
|---|---|---|
| 使用者本篇交辦與後續指示 | 工作範圍、優先級與授權 | 優先於附件；保留既有系統，先計畫、隔離測試、24 項驗收後再提出正式發布計畫 |
| Markdown 功能需求規格 v1.0 | 功能、計分語意、權限、流程、資料與安全要求 | 需求主文件；表名與 operation 為設計提案，須配合現版落地 |
| JSON 權重設定 v1.0 | 初始模板、四職務權重、評級與等級門檻 | 作為版本化模板輸入；目前 `proposal_not_deployed`，`effective_date=null`，不得直接視為已啟用設定 |
| CSV 驗收案例 | AT-01 至 AT-24 的驗收條件 | 保留編號、階段、預期行為；另外增加必要邊界案例，不取代原案例 |
| Word 規格 v1.0 | 參考副本 | 已比對正文與 Markdown 相同，後續以 Markdown 為主 |

JSON 未完整表達的 NO_DATA、發布限制、歷史快照、員工回覆及修訂規則，依 Markdown 補齊。JSON 的 `require_evidence_for_rating_1_2_3_5` 依主文件解讀為「佐證或具體主管說明」，不把連結附件變成唯一可用證明。

三份主要來源均在 `C:/Users/Williams/Downloads/`，SHA-256 如下：

| 檔名 | SHA-256 |
|---|---|
| GUC_ERP_弱電工程績效考核模組_功能需求規格書_v1.0.md | 667d3a78b44eaf42b4fc64a5f72dc86150b9eb1b1270fe968f7a5f5127ce49cf |
| GUC_ERP_績效考核權重設定_v1.0.json | 5a4802008aa5e63e1a4b94e659df17cc6b562ca10a58c3cdb370a13a8d2bdd15 |
| GUC_ERP_績效模組_驗收案例.csv | 317eecc8e81ac965aeaadcdb25bb969fecdb2164a8573b36e6ca7d529f29039b |

## 2 正式環境與來源基準

查核時間：2026-10-25 約 16:45–16:52（UTC+08:00）。正式資料庫查詢強制 `default_transaction_read_only=on`，僅讀系統目錄、版本與權限中繼資料；未查閱員工評語或其他業務內容。

| 項目 | 已查證結果 |
|---|---|
| GitHub 儲存庫 | Williams-CHEN0401/GUC-ERP |
| 最新查核 main | `2234c5a677a92fc2ea2acf5fa62d108080bb2d6a`；本次已成功 fetch |
| 正式部署來源 | `ae701853e5af0d63bd2b0fe7607d3c40b56e7b5b`，分支 `codex/construction-monitor-1025`；遠端與本機相同 |
| 來源差異 | 正式來源比 main 多 1 個施工監控提交；檢查的工作樹乾淨 |
| 可追溯 Git 工作樹 | `F:/GUC-Docker/workspaces/construction-monitor-erp` |
| 正式原始碼副本 | `F:/GUC-ERP-main/GUC-ERP-main`；此目錄沒有 Git 中繼資料 |
| 正式 ERP 映像 | `sha256:48ec9368c6355d744a86053ef8c6c963df999de7519b673e79da18aabd38a0f5` |
| 正式資料庫 | 本機 Docker `supabase-db`，資料庫 `postgres`，PostgreSQL 17.6 |
| PostgreSQL 映像 | `supabase/postgres:17.6.1.136` |
| Gateway 執行環境 | `supabase/edge-runtime:v1.76.2`；正式 `inventory-gateway` 掛載於本機 Supabase functions 目錄 |
| 既有資料防護 | 查核的 10 個主資料／工作／稽核表均開啟 RLS，anon/authenticated 無直接 SELECT 權限 |
| 績效新模型 | 本次未查到 public schema 的 `performance*` 資料表與函式 |

正式 `index.html`、`app.js`、`inventory-gateway/index.ts` 與上述 Git 工作樹的 SHA-256 相同。API 代理 `api/inventory.js` 的原始位元組雜湊不同，正規化 CRLF/LF 後內容相同；正式原始碼副本與容器內檔案雜湊相同。

目前沒有 `supabase_migrations.schema_migrations` 標準應用 migration 登錄表。自架環境以發布清單中的精確 SQL 路徑與 SHA 追溯，並以現場 schema/RPC 查證，不能只用 PostgreSQL 引擎版本代表應用 schema 版本。

已核對的近期變更：

| Migration | 查核證據 |
|---|---|
| `20261025051340_multi_person_work_assignments.sql` | 2026-10-25 正式發布清單存在；現場具有 assignment_request_id、assignee_user_id、construction_plan_id、construction_item_id；`create_work_assignments_v1` 定義 MD5 與發布證據相同：`89792cb4d733e7364659bafbf0364435` |
| `20261025062408_construction_contract_monitoring.sql` | 最新正式發布清單記載；現場 10 個相關 RPC 定義 MD5 全數與 `database-after.json` 相同；SQL SHA-256：`9f5e3d843c94e71ea5c355c6dd3d046ce1ac6182b39b529e667a296eebc05bf9` |

因此，規格書「多人指派尚未發布」的現況描述已過時。此能力可以列為候選佐證來源；本次僅證明版本及結構存在，未重新執行其正式寫入驗收。

`work_assignments.project_id` 在實際資料表可為 NULL，但已查閱的多人指派 RPC 對 existing 模式仍要求有效工程，manual 模式會建立工程。公共責任任務仍依主文件獨立建模，不靠欄位可空繞過既有工程流程。

正式環境另有施工主管統計 `construction_manager_performance_v1` 及會計系統 `/performance`。新增 ERP 員工績效入口需清楚區別，保留這些既有統計用途。

## 3 開發基準與隔離環境

開工前重新 fetch 並記錄 main 與正式部署來源。依現行 CONTRIBUTING 從最新 main 建立獨立功能分支，將仍未包含於 main 的已部署施工監控提交列為明確相依，在隔離工作樹整合；不讓功能開發倒退正式站既有功能。若開工時 main 已納入該提交，改用更新後 main，避免重複整合。

測試使用專屬 Docker Compose 專案，配置獨立 PostgreSQL、Supabase Auth、API／Gateway、資料卷、網路與測試金鑰。只匯入 schema 與必要參照設定，再建立合成員工、工程與佐證；不複製正式帳號、客戶資料、NAS 檔案或正式 session。

啟動寫入測試前須以檢查程式證明：前端代理、Gateway、Auth、PostgREST、資料庫與附件目的地均指向測試環境；沒有正式 volume 掛載、正式金鑰或正式主機目的地。專屬測試堆疊使用相同服務別名與既有程式路徑；如需要設定擴充，採明確測試環境白名單並保留原代理防護。禁止藉放寬一般 Preview 寫入限制直接測正式庫。

## 4 資料庫變更計畫

沿用既有 migration 命名與產生流程，採向前相容增量。先在隔離資料庫驗證，按「模型與設定、計分與流程、授權與讀取」拆成可審閱單元；最終只交付本次需要的精確 SQL，不重放歷史 pending migration。

| 資料群組 | 規劃內容 | 主要約束 |
|---|---|---|
| 月份與模板 | performance_periods、performance_templates、performance_role_weights | 月份唯一；模板啟用後不可原地改內容；四職務各七指標，權重合計 100；保存設定與計分規則版本 |
| 職務配比與指定人員 | performance_role_allocations 與 review 的指定評核／核定人欄位 | 人員 FK 指向 app_users；配比合計 100；評分前核定；變更須留版本、原因並重新確認 |
| 評核及分項 | performance_reviews、performance_review_items | 每人每月一個目前有效發布版本；revision 留歷史；唯一 review/role/criterion；區分未評分、N/A、已評分 |
| 來源佐證 | performance_evidence_links，必要時增加員工佐證提交明細 | 來源白名單；保存最小摘要、來源 ID、權限範圍資訊與擷取時間；發布後凍結 |
| 員工回覆 | 專用回覆明細或等效可追溯關聯 | 對應精確 review revision、本人、回覆類型與時間；知悉與同意分開 |
| 公共任務 | performance_shared_tasks | 不要求 project_id；明確指派人、負責人、期限、完成證明與狀態；取消／退回留原因 |
| 改善與異議 | performance_goals、必要的異議／答覆紀錄 | P0 提供簡化改善項目、本人意見與管理員修訂；完整申覆流程於 P1 擴充 |
| 重送防護 | 優先沿用既有冪等模式；必要時新增績效專用 request receipt | 唯一 actor/operation/request_id；保存 payload fingerprint 與結果；同 ID 不同內容拒絕 |
| 技能資料 | performance_skill_catalog、performance_user_skills | P1；L1–L4、實作證明、評核人、核定版本；無第二套員工主檔 |

新增可修改資料保存 row_version、created_at、updated_at、created_by、updated_by；事件時間以 timestamptz 儲存，月界以 Asia/Taipei 判定。重要外鍵採保留歷史的刪除限制，必要的停用／軟刪除不連帶清除評核。

資料約束分兩層：CHECK/UNIQUE/FK 保護單列與唯一性；跨列權重、配比、狀態與發布完整性由同一交易中的 RPC、鎖與必要 constraint trigger 保證。正式發布唯一性由資料庫限制與交易處理，不只依賴 UI。

索引以實際查詢為準，包含月份／員工／revision、評核人／狀態／月份、review/role/criterion、任務負責人／狀態／期限，以及佐證與回覆的 review 外鍵。小規模資料避免多餘索引；在隔離資料用代表性資料量檢查查詢計畫。

所有績效表開啟 RLS，撤銷 public、anon、authenticated 的直接表存取，RPC 僅授予既有受控 service_role 路徑。RPC 每次驗證啟用帳號、能力、本人／指定評核關係與狀態；actor 由 Gateway 的已驗證登入身分決定，不能信任客戶端自報。

沿用既有 audit_logs 與 Gateway audit context。寫入事件須涵蓋前後內容、操作人、時間、request_id 與事件識別；查看敏感評語與匯出另記存取稽核，不將密碼、Token 或無關私密內容寫入稽核。

## 5 權限與既有程式整合

現有 role_permissions 為 module 加上 can_view/can_create/can_update/can_delete。擴充原本 module CHECK、Gateway PERMISSION_MODULES 與 permissions-ui.js，加入 performance；不建立第二套角色模型。細部操作在既有授權入口後，結合評核關係與資源範圍判斷。

| 能力 | 後端必要條件 |
|---|---|
| VIEW_SELF、本人回覆、本人佐證 | performance 對應能力＋受評人等於登入人＋該狀態允許的欄位集合 |
| VIEW_ASSIGNED、SCORE_ASSIGNED | performance 對應能力＋當期明確指定評核人＋有效人員／月份；不能藉傳入任意 user_id 擴大範圍 |
| CONFIG、APPROVE | 沿用現有管理員能力判定；核定人必須與受評人不同，包含管理員本人也不得繞過 |
| 來源佐證／匯出 | 評核權限與既有來源資料權限同時成立；仍套用 erp_private_* 及工程可見性 |

指定評核人只獲得該評核的領域關係，不因此得到薪資或全部工程閱覽權。已凍結的佐證摘要每次讀取仍檢查權限；來源失效或權限撤銷時，保留評核歷史但遮蔽無權內容。

重用路徑：app.js 的 apiRequest、api/inventory.js 代理、inventory-gateway 的 hydratePermissions/requirePermission/authorizeRead、私人資料過濾、rpc 與 audit context。規格書的 performance.* operation 採原路由慣例登錄，不另建公開直連資料庫 API。

介面新增「績效管理」及五個 P0 頁籤：我的績效、我的共同任務、主管評核、考核設定、核定與紀錄。沿用現有導航、表單、錯誤與空狀態；390px 使用卡片／折疊區塊。P1 再加入技術矩陣與季度報表。

## 6 計分與流程契約

1. JSON 匯入時驗證結構、唯一代碼、四職務、七指標、合法整數評級、權重合計與等級門檻；保存完整模板快照及版本。正式生效日由管理員設定。
2. 每項評級為 1–5；未評分與 N/A 分開記錄。N/A 必填合理原因，只允許未指派或客觀無觀察機會。
3. 職務分數按有效權重正規化；有效權重為零時回傳 NO_DATA。任一正配比職務為 NO_DATA 時，整月禁止發布，不將配比自動轉移。
4. 後端使用 decimal/NUMERIC 保留中間計算精度，最終分數 HALF_UP 至兩位後判斷 A/B/C/D；前端只呈現後端結果。中間值不提前四捨五入的設計須明列於計分版本與邊界測試。
5. 評級 1、2、3、5 必須有具體說明或合格佐證；4 亦須有達標依據。工單筆數、出勤天數與完工百分比只供判讀，不自動轉成評級。
6. 主管送出前檢查完整七項／各正配比職務、說明、配比與權重。流程為 DRAFT → SUBMITTED → EMPLOYEE_RESPONDED 或 ACK_TIMEOUT → APPROVED → PUBLISHED。
7. 員工只能回覆該版本，不能改分；未回覆不等於同意。5 個工作日先作可設定提案，工作日曆定義確認前不以任意日曆天啟動逾期核定。
8. 發布以交易與版本檢查封存分數、配比、權重、說明與佐證；修改已發布評核須建立新 revision，再走通知與核定。原版本永遠可追溯。
9. 主文件列於 P0「我的績效」的年度趨勢先提供有效已發布月份的簡單展示及樣本月數；P1 的季度統計與進階報表另行完成。

文件案例的獨立核算：全部 4 分為 80.00/B；AT-06 的 QUALITY=4、SCHEDULE=5、權重 25/20，其餘 N/A，為 88.89；AT-07 為 81.20/B。上述只是需求數值核對，不是產品測試完成證據。

## 7 工作拆分與完成條件

| 順序 | 工作 | 可交付成果與完成條件 |
|---|---|---|
| 1 | 基準與隔離環境 | 記錄來源 commit、正式相依、schema；測試環境目的地檢查通過；合成員工角色與私人來源資料就緒 |
| 2 | DEV-01 資料庫與權限 | 增量 SQL、模板匯入、FK/索引/RLS/ACL、稽核及反向存取案例通過 |
| 3 | DEV-02 計分與交易 | 精確小數計分、N/A/NO_DATA、配比鎖定、唯一發布、重送及競爭控制通過 |
| 4 | DEV-03 佐證整合 | 日誌施工人員、多人指派、施工規劃、維修資料與公共任務依來源權限提供候選摘要 |
| 5 | DEV-04 P0 介面與完整流程 | 桌面及 390px 可操作；草稿、送出、員工回覆、核定、修訂與匯出保存後重讀正確 |
| 6 | DEV-05 P0 驗收 | AT-01～AT-22 與必要補充測試、既有 ERP 回歸；逐項附證據 |
| 7 | DEV-06 P1 必要驗收範圍 | 完成 AT-23 技術矩陣、AT-24 季度報表；其他 P1 深度需求依主文件另列工作，不默認已完成 |
| 8 | 交付驗收報告 | 24 項通過、限制與風險清楚後，才另外提出正式發布計畫 |

初期功能旗標預設關閉；只在隔離環境啟用。資料庫設計支持舊版程式共存；復原以關閉功能及回復相容程式為原則，保留已產生的考核與稽核資料，禁止刪表重建作為一般回復方式。

## 8 驗收對應

CSV 的 24 個案例編號連續、唯一，均有 5 個欄位。下表為規劃執行方式；本次狀態全部為「未執行」。

| 案例 | 階段 | 測試重點 | 主要測試層 |
|---|---|---|---|
| AT-01 | P0 | 員工 A 不可讀 B 的評分與改善資料 | Gateway/API＋UI |
| AT-02 | P0 | 未指定主管不可建立／讀取該員工評核 | Gateway/API＋SQL |
| AT-03 | P0 | 四職務各七項權重合計 100 | 設定驗證＋SQL |
| AT-04 | P0 | 所有適用項目 4 分得到 80.00 | 計分單元＋RPC |
| AT-05 | P0 | 未指派可 N/A，已安排未履行不得規避 | RPC＋UI |
| AT-06 | P0 | 有效權重重算，本例 88.89 | 計分單元＋RPC |
| AT-07 | P0 | 60%×78＋40%×86＝81.20/B | 計分單元＋RPC＋UI |
| AT-08 | P0 | 配比不等於 100 拒絕，不默補 | SQL＋API |
| AT-09 | P0 | 全無有效評分為 NO_DATA、禁止發布 | RPC＋UI |
| AT-10 | P0 | 偽造參數改主管分數／自我核定被拒絕 | API＋SQL |
| AT-11 | P0 | 依實際施工人員關聯選佐證，非日誌填寫人 | 來源查詢＋UI |
| AT-12 | P0 | 多人任務僅列候選，主管逐人確認 | API＋UI |
| AT-13 | P0 | 公共任務不依附工程、不建假 projects | SQL＋完整 UI 流程 |
| AT-14 | P0 | 來源修改不改已發布評分；新 revision 留痕 | SQL＋API |
| AT-15 | P0 | 評級／回覆／核定前後內容與操作者稽核 | SQL＋API |
| AT-16 | P0 | 並行重送同 request_id 不重複新增 | 多連線併發測試 |
| AT-17 | P0 | 舊 row_version 回 409，不覆寫新內容 | 多連線 API＋UI |
| AT-18 | P0 | 請假與未派工不自動降低分數 | 計分＋流程案例 |
| AT-19 | P0 | 私人案場、摘要、來源連結均守既有權限 | API 正反向＋UI |
| AT-20 | P0 | 390px 個人分數、回覆與主管核定可觸控 | Chromium/Edge/WebKit＋手機人工驗收 |
| AT-21 | P0 | 匯出與查閱範圍一致，逐人授權 | API＋CSV/Excel 檔案檢查 |
| AT-22 | P0 | 功能關閉時日誌、指派、取貨既有流程正常 | npm run check＋隔離完整回歸 |
| AT-23 | P1 | L1–L4 有證明與評核人，員工不能擅改核定值 | SQL＋API＋UI |
| AT-24 | P1 | 季度排除資料不足月份，呈現樣本與有效權重 | 計分／聚合＋報表 |

必要補充案例：評級越界及假造總分；正配比中單一職務 NO_DATA；69.995/79.995/89.995 的最終四捨五入門檻；月份台北時區邊界；相同 request_id 不同內容；同時核定兩個 revision；模板更新不改舊月份；來源軟刪除／權限撤銷後的快照遮蔽；停用帳號及登入過期；回覆逾期不能記為同意；匯出內容最小化與試算表公式字元處理。

測試證據記錄案例、版本、環境、步驟、預期／實際、結果與必要截圖。瀏覽器流程須走 UI → Gateway → 測試資料庫 → 保存後重讀。WebKit 自動測試不宣稱 iPhone Safari 實機通過；尚未具備的實機證據標示未測。

## 9 尚需設定的產品決策

下列事項可先用合成設定開發測試，正式啟用前須填妥。不得自行指定真實員工的評核權或擴大其既有權限。

| 事項 | 本計畫處理方式 |
|---|---|
| 核定人與負責人是否受評 | 提供指定欄位及自我核定禁止；無其他合格核定人時，採主文件允許的當期不適用正式評核流程 |
| 職務配比 | 依主文件採事先核定；工時僅供參考 |
| 試評與生效日期 | 保留 90 天試評政策；起算日與生效日由管理員設定，不從文件日期推定 |
| 回覆期限及工作日曆 | 5 個工作日作可設定提案；確認公司排班／假日規則後才啟用自動逾期轉態 |
| 公共任務與完成證明 | 先提供工具、車輛、材料、交接等可設定類型；完成說明及可授權佐證，不連正式 NAS 做測試 |
| 人事資料保存期限 | 設定保留政策及更正方式；期限未核定前不啟用自動刪除 |
| 申覆深度 | P0 保留本人意見、管理員答覆與重新核定；完整申覆與進階改善追蹤依 P1 規格擴充 |

CSV 的 P0/P1 分類只決定開發順序；不將使用者要求的 24 項發布前驗收自行降低為 22 項。若日後要先發布 P0，須由使用者明確調整原發布門檻。

## 10 本次完成與限制

已完成：四份附件閱讀、Word/Markdown 正文比對、JSON 結構與權重核算、CSV 24 項完整性檢查、GitHub fetch 與來源差異比對、正式資料庫版本／相關 schema／ACL／RPC 定義及主要執行檔案雜湊查核。

未執行：績效實作、測試堆疊建立、migration 套用、功能測試、24 項驗收、GitHub 推送／合併及正式發布。歷史發布報告中的通過數不列為本次測試成果。

查證來源包含 `F:/GUC-Docker/work-assignments-deployment.json`、`F:/GUC-Docker/construction-monitor-deployment.json`、`F:/GUC-Docker/releases/20261025-construction-monitor/database-after.json`，以及本次實際唯讀命令結果。沒有以雲端舊 Supabase 專案版本替代目前 Docker 正式基準。
