# GUC ERP｜弱電工程績效考核模組

**功能需求暨系統開發規格書**

| 文件版本 | 文件日期 | 定位與適用範圍 |
|---|---|---|
| v1.0（需求草案） | 2026-10-25 | 既有 GUC-ERP 擴充；適用 1–4 人、多人兼職之弱電工程公司 |

開發狀態：本文件是交付開發評估的需求規格，尚未修改原始碼、資料庫、ERP 正式站或部署。評分權重均為提案預設值，上線前須由管理者核定。

# 1. 專案目標與驗收範圍

目的：將施工、維修、帶班與專案管理的工作成果、工單與日誌佐證、公共責任、主管評核、員工回覆及改善追蹤整合到 ERP；少填表、不評印象、不以做完本職工作後的空閒直接扣分。

| 階段 | 開發範圍 | 不納入 |
|---|---|---|
| P0（第一期必做） | 月度考核；七大指標與四職務權重；多職務加權；來源證據連結；公共責任任務；員工自查與回覆；主管評分／管理員核定；稽核與匯出。 | 不計算薪資、不扣薪、不自動判定「態度」。 |
| P1（第二期） | 技術能力 L1–L4；季度趨勢；完整改善計畫／申覆與進階報表；案件難度校正。 | 不直接以案件數排行決定獎懲。 |

- 系統啟用前 90 天採試評；不得以新制度直接減少既有約定工資或既有應得獎金。
- 同一位員工可同月兼任多個工作職務；ERP 登入角色不等於技術職務，不得共用一個 role 欄位。
- 「未被分派」或「無觀察機會」可標記不適用（N/A）；「已分派但未履行」須照事實評分，不能用 N/A 規避。
- 每項非滿分／低分必須可說明；評級 1、2、3、5 必須附佐證或具體主管說明；4 分可由達標紀錄支持。

# 2. 現有 ERP 技術基準與不變原則

已檢視現有 GUC-ERP 主分支之 README、2026-10-25 工作指派文件及相關 SQL migration。原系統採 HTML/CSS/JavaScript、Vercel Functions、Supabase Auth/PostgreSQL 與 inventory-gateway。新增考核功能須保留現有登入、角色權限、私人資料控管、版本鎖與 audit_logs，不可再造一套員工主檔。

| 已存在之資料／能力 | 建議串接方式與限制 |
|---|---|
| app_users、app_roles、role_permissions | 沿用帳號與角色；新增 performance 模組權限；工作職務另存於績效資料，避免與 ERP 權限角色混淆。 |
| projects、site_work_logs、site_work_log_workers | 以專案／工作內容、工作日誌及現場施工人員關聯作為候選證據；日誌填寫人不必然是到場施工者。 |
| work_assignments | 既有一般／取貨／預約工作指派可作工程相關佐證；多人指派部分須確認已發布到正式環境。 |
| construction_plans、construction_plan_items | 連結施工規劃、進度與子項目；時間／複雜度為主管判斷依據，不直接換算為績效分。 |
| audit_logs、Gateway／RPC | 所有新增／編輯／審核／發布／撤回／申覆均留稽核；寫入走既有受控 Gateway 與資料庫 RPC。 |

注意：現有一般 work_assignments 需 project_id；工具清點、車輛巡檢等沒有案場的公共責任，不得虛構 projects。第一期另建「非工程共同任務」資料表，並與工程類 work_assignments 並存。

注意：2026-10-25 多人工作指派文件記載當時為測試成果，尚未正式發布；開發前必須先核對 Production 的 schema、Gateway 與前端版本，不能因主分支已有 SQL 就視為正式可用。

# 3. 使用者、權限與操作畫面

| 角色／情境 | 查閱 | 新增／評分 | 核定／設定 |
|---|---|---|---|
| 員工（本人） | 本人當期草稿進度（限制資訊）與已發布成績；本人公共任務 | 提交佐證及本人回覆／申覆；不可改主管評級 | 不可批准自己或他人的考核 |
| 帶班主管（指定評核人） | 僅被授權之團隊成員與相關工作佐證 | 建立評核草稿、逐項評級、改善建議 | 不得單獨發布自己的考核；無全公司薪資閱覽權 |
| 管理員／企業負責人 | 公司範圍考核與設定（仍受私人資料界線） | 設定權重／工作職務／考核週期；必要時協助評分 | 審核發布、訂定試行期限、檢視異議與匯出 |

權限採後端驗證：員工只可 VIEW_SELF；主管僅可 VIEW_ASSIGNED / SCORE_ASSIGNED；管理員才可 APPROVE / CONFIG。不可單靠前端隱藏選單；避免員工輸入其他 user_id 讀取個人評語。工作日誌私人資料／案場可見性須沿用現有 erp_private_* 檢查。

| ERP 選單／頁籤 | 功能 | 優先級 |
|---|---|---|
| 績效管理 > 我的績效 | 月度進度、七項評級與說明、來源紀錄、年度趨勢、員工回覆 | P0 |
| 績效管理 > 我的共同任務 | 工具、車輛、材料等非案場公共工作；完成回報 | P0 |
| 績效管理 > 主管評核 | 月份與員工清單、分項評分、證據挑選、草稿、送審 | P0 |
| 績效管理 > 考核設定 | 職務與權重、評級說明、月份建立、各員工職務配比 | P0 |
| 績效管理 > 核定與紀錄 | 核定、發布、回覆、修訂歷史、CSV/Excel 匯出 | P0 |
| 績效管理 > 技術能力矩陣 | 監視、網路、電話、門禁、音響五類 L1–L4 | P1 |

手機版 390px 應採卡片／折疊區塊，將評分、來源佐證及送出按鈕保持可讀可觸控，不允許橫向溢出。

# 4. 考核指標、職務配分與評級

| 指標代碼／名稱 | 工程施工 | 維修保養 | 現場帶班／主管 | 專案管理 |
|---|---|---|---|---|
| QUALITY 工作成果與品質 | 25 | 30 | 20 | 20 |
| SCHEDULE 工作效率與時程 | 20 | 15 | 15 | 20 |
| RECORD 文件紀錄與交接 | 15 | 15 | 15 | 20 |
| TEAM 團隊協作與共同責任 | 15 | 15 | 20 | 15 |
| REPORT 主動回報與問題改善 | 10 | 10 | 10 | 10 |
| LEARNING 技術學習與經驗傳承 | 5 | 5 | 10 | 5 |
| SAFETY 安全與工作規範 | 10 | 10 | 10 | 10 |
| 總計 | 100 | 100 | 100 | 100 |

| 評級 | 標準 | 建議資料依據 |
|---|---|---|
| 5｜明顯超越要求 | 有具體可驗證的額外貢獻或改善成果 | 具名改善事項、前後差異、主管確認 |
| 4｜符合要求 | 依指派標準完成品質、效率、紀錄與交接 | 正常合格工單、主管例行確認 |
| 3｜部分未達要求 | 部分明確要求未達成，且有具體紀錄 | 逾期回報、缺漏紀錄、應改善項 |
| 2｜明顯未達要求 | 多次違反合理且明確的工作要求 | 重複未交接、無理由漏完成任務 |
| 1｜嚴重未達要求 | 重大且可歸責的工作缺失 | 重大品質／安全事件之個案紀錄 |

符合所有要求者各項評級為 4，最終月分為 80；5 分必須高於一般合格門檻。定義是「行為及結果」，不可把性格、忠誠度、是否下班關心公司作為分數來源。

# 5. 分數計算規則（後端唯一可信）

1. 每項得分＝(rating ÷ 5) × weight；rating 為 1–5 整數，N/A 不進行分數累計。
2. 同一職務得分＝100 × Σ(適用項目 weight × rating ÷ 5) ÷ Σ(適用項目 weight)。若全部 N/A，回傳 NO_DATA，禁止發布成 0 分。
3. 當月總分＝Σ(各職務得分 × 已核定職務配比%)；各職務配比必須合計 100%；配比於評分前核定並鎖定。
4. 等級 A：90.00–100.00；B：80.00–89.99；C：70.00–79.99；D：0–69.99。顯示與封存採 decimal 兩位、HALF_UP，等級以已四捨五入至兩位的封存分數判定，避免畫面顯示與等級不一致。
5. 年度／季度統計只彙總有效已發布月份，顯示樣本月數；不得將資料不足、法定休假或未分派任務當成零分。若已核定有正配比的職務整月 NO_DATA，當月也不得發布，須補充有效評分或重新核定職務配比；不得私自分攤到其他職務。

| 計算案例 | 正確輸出 |
|---|---|
| 某員工單一職務七項皆4分 | 80.00分，B級 |
| 施工60%得78分、維修40%得86分 | 78×0.6+86×0.4＝81.20分，B級 |
| 施工配比60%，維修配比30% | 總和90%，拒絕儲存，提示調整至100% |
| 某指標當月無核定訓練或觀察機會 | 標N/A並按其他有效權重重算，不等同評級1 |
| 全部指標無有效評核證據 | NO_DATA，不計算等級、不發布 |

# 6. 佐證與公平性規則

| 來源 | 可作為何種證據 | 不可直接推論 |
|---|---|---|
| site_work_logs / site_work_log_workers | 個別人員參與日期、工單紀錄完整性、異常回報 | 工單數多＝績效高；日誌建立者＝現場執行者 |
| work_assignments | 主管有明確指派、個人完成時間與狀態 | 未被指派者不主動接任務＝扣分；取消任務＝員工過失 |
| construction_plans | 排程／工程子項目、核定的工作難度 | 超期全部歸咎施工者；完工百分比直接等於人員績效 |
| 維修歷史、設備測試與驗收 | 故障診斷、測試、可歸責返工經主管確認 | 同設備再故障必為前次工程師失誤 |
| performance_shared_tasks（新增） | 明確分派的工具、材料、車輛及交接責任 | 未排班的公共任務或工作時間外參與義務 |

- 先顯示候選佐證，由主管勾選及補充說明；第一期不從原始工單數或出勤天數自動扣分。
- 同一工程日誌可關聯多人，但不代表每人都獨立完成所有工作；個人責任仍由主管與可查核事實確認。
- 區分「不可控因素」（缺料、客戶臨時改期、未提供資源）與「可控行為」（未通報、未記錄、無理由拖延）。
- 已發布考核採證據快照：原工單後續改動不直接變更歷史分數；重新審定必須留修訂紀錄。
- 考核介面不得揭露設備密碼、客戶私人資料、API Token 或其他無關敏感內容。佐證引用為最小必要摘要與可授權跳轉。
- 重大職安事件須另行啟動安全處理／個案調查；不得因整體總分高就抵銷法定安全義務，也不得未經調查直接認定員工過失。

# 7. 業務流程與狀態機

| 步驟 | 動作與角色 | 必要後端約束 |
|---|---|---|
| ① 建立月份 | 管理員設定月份、職務權重版本、預定主管；OPEN | 同一月份不可重複開啟；記錄 template_version |
| ② 核定職務配比 | 主管／管理員核定每位員工各職務百分比 | 總和100%、有效人員、配比定稿後不可無紀錄改寫 |
| ③ 彙整證據 | ERP從有權讀取之工程／維修／任務載入候選證據 | 只參考、不自動下評價；過濾私人案場 |
| ④ 主管評分 | 主管逐職務七項給1–5或N/A，並記錄原因 | 評級1/2/3/5必填理由或連結；只有被授權員工 |
| ⑤ 送員工知悉 | 評核 SUBMITTED，員工可回覆，不可變更評級 | 保留回覆時間；知悉不代表同意 |
| ⑥ 管理員核定 | 管理員檢查權重、證據、說明並 PUBLISHED | 不可自我核定；發布快照與audit log |
| ⑦ 申覆／修訂 | 員工提出疑義；管理員答覆並視需要建立新 revision | 歷史版本不可覆蓋；重算需保存原因與核定人 |

建議評核狀態：DRAFT → SUBMITTED → EMPLOYEE_RESPONDED（或 ACK_TIMEOUT）→ APPROVED → PUBLISHED；APPEALED 由獨立申覆表追蹤，不覆寫已發布版本。員工收到考核後，建議保留5個工作日回覆；逾期可進入 ACK_TIMEOUT 並由管理員核定，但不得視作員工同意。已發布內容只有建立新修訂版可修改。

如管理員也是受評員工，系統禁止本人審核自己；須由另一位具權限的核定人處理，或將該員工當期標記「不適用正式評核」，不能偷偷移除限制。

# 8. 資料模型（建議新增表）

採 additive migration，不重建既有 app_users/projects/work_logs/assignments。所有人員 ID FK 一律指向 public.app_users(id)，採 UUID 主鍵與 timestamptz；有修改的表含 row_version、created_at、updated_at、created_by/updated_by。

| 表名 | 主要欄位及約束 | 用途／重點 |
|---|---|---|
| performance_periods | id、month_start(date,unique)、status、template_version、opened_by、row_version | 月份設定，Asia/Taipei，禁止同月重複 |
| performance_templates | id、version、effective_from、status、criterion_json／名稱 | 七指標與1–5規準的不可變版本 |
| performance_role_weights | template_id、job_role_code、criterion_code、weight(int) | 四職務配分；同職務加總100；唯一(template,role,criterion) |
| performance_role_allocations | period_id、user_id、job_role_code、allocation_pct(numeric) | 每月職務配比，所有非零配比合計100 |
| performance_reviews | id、period_id、user_id、reviewer_id、status、total_score、grade、revision、row_version、published_at | 每人每月一個有效已發布版本，修訂保留歷史 |
| performance_review_items | review_id、job_role_code、criterion_code、rating(null 代表 N/A)、weight_snapshot、reason | 逐項評級與當期權重快照 |
| performance_evidence_links | id、review_item_id、source_type、source_id、snapshot_summary、captured_at | 引用既有資料，私密內容按權限呈現 |
| performance_shared_tasks | id、assignee_id、title、instructions、due_at、status、completed_at、created_by | 獨立非工程公共任務；不建立假案場 |
| performance_goals | id、review_id、target、due_at、owner_id、status、followup_note | 待改善行動及追蹤（P0最簡化） |
| performance_appeals | id、review_id、submitted_by、reason、status、decision_note、resolved_by | 員工異議，原評分封存不刪除 |
| performance_skill_catalog / performance_user_skills | skill_code、level(1–4)、evidence、assessed_by、assessed_at | P1能力矩陣，可擴充技術類別 |

- 模板發生修改時新增 version，既有月份沿用原版 snapshot；不得回頭重算歷史而無審核。
- 證據來源型別採白名單，如 site_work_log、work_assignment、construction_plan、maintenance_event、shared_task，不允許使用任意資料表名稱。
- 對應資料遭軟刪除時保留必要 evidence snapshot 與來源 ID；顯示來源不可用，但不可藉快照暴露原本無權存取的私密資料。
- 考核資料屬員工人事個資，應明確規定閱覽範圍、保存期限及更正程序；存取行為需稽核。

# 9. API / Gateway 規格（建議 operation）

以下 operation 名稱為新功能提案，不代表現有 API 已實作。實際請以 inventory-gateway 既有路由、Supabase Auth、RBAC 與 service_role 專用 RPC 的設計方式落地；前端不得直接操作保護資料表。

| 方法／operation（示例） | 操作人 | 請求／回應關鍵 |
|---|---|---|
| GET performance.bootstrap | 本人／主管／管理員 | 登入者權限、當月狀態、可見員工與權重 |
| POST performance.period_upsert | 管理員 | month、template_version、row_version、request_id |
| POST performance.allocation_upsert | 管理員 | period_id、user_id、[{job_role_code,pct}]，合計100 |
| GET performance.evidence_candidates | 授權主管／本人 | period、user、source_type；僅授權的摘要與來源ID |
| POST performance.evidence_submit | 受評員工 | 本人補充工作佐證或說明，主管審核採用 |
| POST performance.shared_task_upsert | 管理員／指定主管 | 非專案公共任務、負責人、期限、完成證明 |
| POST performance.review_save | 指定主管 | review_id、row_version、items、remarks、request_id；伺服器重算 |
| POST performance.review_submit | 指定主管 | review_id、row_version；驗證配比、評分完整及理由 |
| POST performance.employee_respond | 受評員工 | review_id、comment、ack_type、request_id |
| POST performance.review_publish | 管理員（非本人） | review_id、row_version、publish_reason；封存快照 |
| POST performance.appeal_submit / resolve | 員工／管理員 | 理由、回覆、決定、必要時創建 revision |
| GET performance.export | 依權限 | 期間、員工範圍、格式；下載內容與存取權一致 |

API 驗證：驗證登入身份、啟用帳號、身分範圍、私人資料權限、row_version、request_id 冪等及狀態轉移；拒絕由前端傳入的計算總分或 grade 直接入庫。所有寫入一律產生現有 audit_logs 與資料庫事件識別。

```json
{
  "operation": "performance.review_save",
  "request_id": "<uuid>",
  "payload": {
    "review_id": "<uuid>",
    "row_version": 3,
    "items": [
      {"job_role_code": "construction", "criterion_code": "QUALITY",
       "rating": 4, "reason": "完成驗收與交接", "evidence_ids": ["<uuid>"]},
      {"job_role_code": "construction", "criterion_code": "LEARNING",
       "rating": null, "na_reason": "本月未分派訓練或觀察任務"}
    ]
  }
}
```

# 10. 非功能、安全與資料管理

- RBAC：擴充既有 role_permissions 的 module CHECK 與 UI 設定；新增 performance 權限，細粒度的 VIEW_SELF、SCORE_ASSIGNED、APPROVE 仍須由 Gateway 以身分與所屬關係驗證。
- 資料庫採 RLS + revoke direct authenticated/anon；所有受保護資料只由 service_role 受控存取，不在前端公開 service_role key。
- 對發佈／核定採交易鎖與版本校驗；同 request_id 重送不得重複建立評核。
- 時間記錄以 timestamptz 存 UTC，考核月份與日期在 Asia/Taipei 做邊界切分；避免跨時區計入錯誤月份。
- 員工資料匯出時逐人校驗權限；管理員匯出不應預設包含私人客戶設備帳密或薪資資料。
- 手機優先；390px 無左右溢出；Chrome/Edge/Safari 基本功能可用；空資料與錯誤提示清楚。
- 考核分數與技術等級不能因合法請假、請病假天數或未分派工作而自動給負分；如涉及人事處置須人工複核並依勞動法令處理。
- 預覽站須使用隔離測試資料與合成員工，不得直接對 Production 進行變更驗證；發布前跑完整回歸。

# 11. 研發工作拆分與建議交付順序

| 工作包 | 內容 | 優先級 |
|---|---|---|
| DEV-01｜資料庫與權限 | P0 tables、migration、索引、RLS/RPC、performance 模組權限與 audit | P0 |
| DEV-02｜計分服務 | 七指標、N/A正規化、多職配比、等級、decimal與凍結快照 | P0 |
| DEV-03｜證據整合 | 既有工單、工作日誌、作業人員、指派、施工規劃之授權查詢 | P0 |
| DEV-04｜介面 | 個人績效、主管評核、權重設定、公共任務、回覆與核定 | P0 |
| DEV-05｜測試／發布 | 權限、冪等、版本衝突、個資、手機、既有ERP回歸、Production前備份 | P0 |
| DEV-06｜擴充 | 技能矩陣、季度趨勢、異常與案件難度校正 | P1 |

發布順序建議：先確認 Production 版本與資料備份 → 隔離測試 migration/RPC → Gateway 新 operation → 前端功能旗標 Preview → 自動化與實機驗收 → 正式套用 additive migration → Gateway → ERP 前端 → 正式功能開關與監測。不可只上新版前端，也不可刪除既有歷史資料回滾。

# 12. 功能驗收案例（完整CSV另附）

| 案例 | 必須通過的情境 |
|---|---|
| AT-01 | 員工只可查詢自己的已發布評分與改善計畫 |
| AT-02 | 帶班主管僅能評核核定管轄人員 |
| AT-03 | 四職務各七項權重總和100 |
| AT-04 | 所有適用項目均4分，月分應為80.00 |
| AT-05 | 不適用項目只允許未指派／客觀不可觀察情況 |
| AT-06 | 適用項目重新按有效權重正規化 |
| AT-07 | 施工60%得78、維修40%得86，總分81.20 |
| AT-08 | 工作角色分配合計非100%禁止送出 |
| AT-09 | 無任何有效評分項目不得產生0分或發布 |
| AT-10 | 員工不得修改主管評級或批准自己的評核 |
| AT-11 | 已參與施工之site_work_log_workers成員可成為候選佐證 |
| AT-12 | 多人指派不會把同一任務自動當成每人獨立滿分成果 |
| AT-13 | 工具/車輛整理可建立不依附工程案的共同任務 |
| AT-14 | 已發布評分遭後續工單變動不可靜默改變 |
| AT-15 | 任何評級、回覆與批准變更留下操作人、時間、前後內容 |
| AT-16 | 同一request_id重送不得重複建立考核 |
| AT-17 | row_version落後應回報409衝突 |
| AT-18 | 合法病假及未分派任務不得自動計算負面分數 |

其餘 AT-19 至 AT-24（私人案場、手機介面、匯出、相容性、技術矩陣、季度統計）詳見隨附驗收案例 CSV，可直接交給 QA 或轉成測試工單。

# 13. 需在啟動開發前確認的決策

- 由管理員指定誰可以擔任受評員工的「核定主管」，並提供核定人與受評人不相同的規則；企業負責人是否列入評核須先決定。
- 確認既有 work_assignments 多人指派 schema 與正式 Gateway 目前是否已部署；未部署不得依該功能作為P0阻塞。
- 確認月度角色配比使用「事先核定工作比例」或「工單工時候選＋主管核定」；本版採事先核定，工時僅供參考。
- 確認公共任務種類、指派者、完成證明欄位，以及稽核與留存年限；涉及薪酬的進一步整合應另立需求及合法性審查。
- 確認是否啟用員工對主管評分的申覆流程；本版建議至少保留員工回覆與管理員重新核定功能。

# 14. 實作參考與法規來源

- ERP 主程式與資料模型：https://github.com/Williams-CHEN0401/GUC-ERP/blob/main/README.md
- 多人工作指派（2026-10-25）：https://github.com/Williams-CHEN0401/GUC-ERP/blob/main/docs/20261025_multi_person_work_assignments.md
- 原始工作指派與工作人員 migration：https://github.com/Williams-CHEN0401/GUC-ERP/blob/main/supabase/migrations/20260916232954_work_assignments_dashboard.sql
- 既有角色權限 migration：https://github.com/Williams-CHEN0401/GUC-ERP/blob/main/supabase/migrations/20260908060047_role_permissions_project_scope.sql
- 最新工作日誌人員紀錄 migration：https://github.com/Williams-CHEN0401/GUC-ERP/blob/main/supabase/migrations/20261015153853_worklog_workforce_pending_costs.sql
- 跨站系統規格：https://github.com/Williams-CHEN0401/GUC-Site-Data/blob/main/docs/SYSTEM_SPECIFICATION.md
- 《勞工請假規則》第9-1條：https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=N0030006
- 《勞動基準法》第22條：https://laws.mol.gov.tw/FLAW/FLAWDOC01.aspx?flno=22&id=FL014930
- 《個人資料保護法》第5、19、20條：https://law.moj.gov.tw/LawClass/LawAll.aspx?PCode=I0050021

註：現有 GitHub 文件描述部分功能可能處於預覽或尚待發布狀態。開發工程師須以正式環境版本、已套用 migration 清單與實際 Gateway 路由核對，絕不可直接將需求草案視為已部署功能。
