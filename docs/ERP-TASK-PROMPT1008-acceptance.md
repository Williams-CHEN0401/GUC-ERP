# ERP-TASK-PROMPT1008 實作與驗收紀錄

驗收日期：2026-10-08。文件「場刊」依使用者確認，解讀為「場勘」；報表排除場勘與文書作業。
後續確認（2026-10-08）：請款「狀態退回更正原因」改為選填，空白／空字串／只有空白均可退回；提供內容時仍保留。原本文中「原因必填」是第一次驗收時的行為，已由此決策取代。回歸已驗證客戶確認退回、部分請款及請款完成的既有更正路徑；發票保護、備註 1000 字上限、狀態歷程與版本鎖維持。使用者另已授權發布，實際發布狀態另記於發布紀錄。
依 guc-website-maintainer 採最小範圍增量修改，沿用 Auth、私人客戶限制、RBAC、既有施工規劃及工作日誌。
本次只修改本機程式並以合成資料測試，沒有發布、推送 GitHub、修改正式資料庫、清理正式歷史資料。

- ERP 根目錄：C:/Users/KHUser/Documents/ChatGPT/ERP系統開發/GUC-ERP-transaction-documents-1002
- 會計／原報價根目錄：C:/Users/KHUser/Documents/ChatGPT/ERP系統開發/GUC-Quotation-search-sort-0926
- 兩者分支：codex/accounting-construction-20261008
- ERP 基準：a27521eab375dfaafe2a6eb9587ac12ffe9cb20d
- 會計基準：7d725bce76ee61ab06b8f662be30cdcd988d6d68
- 新變更尚未提交；正式發布前應重新查核遠端 main、PR、相依 migration 與環境。

## 1. 修改檔案

以下檔名相對上述所屬根目錄。測試及文件也是本次新增／修改範圍。

### ERP

| 檔案 | 修改函式／元件 | 修改目的 | 需求 |
|---|---|---|---|
| app.js | hydrateSnapshot、apiRequest、selectedProjectReport、報表／工作日誌與進貨列渲染 | 進貨單價保存、共用報表、系統名稱、儲存後更新施工進度及失效報表快取 | 1–4、7–8 |
| receipt-documents.js | receiptPriceField、receiptPricePayload、進貨單列收集與預覽 | 查看及各價格操作分開；省略單價不清除舊價 | 1 |
| permissions-ui.js | 權限模組清單及預設 | purchase_prices、accounting_reports、accounting_prices 沿用既有四項動態權限 | 1、4 |
| shared-report-ui.js（新增） | sharedProjectReport、reportProjectIncluded、reportVerticalBars | 共用 RPC 統計、類型排除、使用者／權限／條件快取、直式圖 | 3–4 |
| form-reference-sync.js | 工作內容報表選項更新 | 參照資料重讀後仍排除場勘／文書作業 | 3–4 |
| index.html | 工作內容／施工規劃子頁籤、報表搜尋欄位、系統入口、script | 類型篩選放進既有搜尋面板；加入施工規劃分頁 | 2–3、8 |
| construction-plan-ui.js | constructionProgress、refreshConstructionPane、renderConstructionDashboard、refreshConstructionProgressViews、saveConstructionPlan、施工日誌入口 | 預計工期／去重進度、首頁負責人進度、先重取授權施工資料再開既有日誌表單 | 7–8 |
| styles.css | 施工進度與報表直式圖樣式 | 沿用現有 UI；正常／達標／超期分色，進度條不溢出 | 3、8 |
| supabase/functions/inventory-gateway/index.ts | 進貨單保存、私有請求序列化、work_report／materials scope、dashboard construction_progress | 後端移除無權限單價、呼叫新 RPC、只向真正負責人回傳進度 | 1、3–4、7–8 |
| supabase/migrations/20261008000659_receipt_prices_accounting_reports.sql（新增） | save_stock_receipt_document_v3、work_content_report_v1、save_accounting_material_price_v1 | 每列價格、權限及人工參考價、單一統計來源 | 1、3–4 |
| supabase/migrations/20261008000701_construction_progress.sql（新增） | save_construction_plan_v1、construction_scope_v1 | nullable planned_days、動態計算已完成有效日期 | 8 |
| scripts/receipt-prices.test.mjs（新增） | 價格 UI／payload 測試 | 不可見、唯讀、新增／修改／清除、非法及未變更值 | 1 |
| scripts/construction-plan-ui.test.mjs | 進度顯示測試 | 7／1／6／14.3%、150% 超期、進度條上限 | 8 |
| scripts/pickup-notes.test.mjs | 既有測試環境 stub | 補齊價格渲染依賴，取貨備註行為不變 | 回歸 |
| scripts/construction-plan-fixture.mjs | 隔離施工資料庫及本機伺服器 | 載入新 migration、7 天範例及新 RPC | 1、7–8 測試 |
| scripts/accounting-quotation-fixture.mjs（新增） | 會計生命週期隔離資料庫 | 可重複執行真實 RPC，禁止連正式資料 | 5–6 測試 |
| scripts/accounting-preview-fixture.mjs（新增） | 會計合成報表資料 | 本機 UI→Gateway→SQL 測試 | 3–6 測試 |
| scripts/verify-accounting-construction-db.mjs（新增） | 三組真實 Gateway／SQL 回歸 | 單價安全、統計一致、進度、唯讀負責人與越權 | 1、3–4、7–8 |
| scripts/verify-accounting-quotation-db.mjs（新增） | 四組生命週期驗證 | 同 ID 回退修改、財務保護、永久刪除及新有效報價保留 | 5–6 |
| docs/ERP-TASK-PROMPT1008-acceptance.md（本文件）與 docs/evidence/20261008/ | 驗收紀錄及畫面 | 記錄已驗證與未驗證邊界 | 全部 |

### 會計管理系統

| 檔案 | 修改函式／元件 | 修改目的 | 需求 |
|---|---|---|---|
| app/layout.tsx | metadata | 系統顯示名稱 | 2 |
| components/quotation-app.tsx | Provider、側欄、請款狀態操作、編輯條件 | 名稱、報表入口、刪除後選項失效／過期請求防護、回退原因表單、後端 can_edit | 2、4–6 |
| app/reports/page.tsx（新增） | 報表路由 | 沿用現有登入及頁面架構 | 4 |
| components/accounting-reports.tsx（新增） | AccountingReports | 共用統計、類型／日期篩選、直式圖、來源單價、人工價保存；儲存中鎖定條件防止競態 | 3–4 |
| app/globals.css | accounting report 樣式 | 不引入新圖表框架，合併用料圖及表 | 4 |
| components/work-content-list.tsx | 刪除後訊息 | 與永久刪除事實一致、不誤稱仍保留報價歷史 | 5 |
| lib/quotation-delete.ts | guarded delete、preview delete、選項失效事件 | 真正刪除自身資料、保留 ERP、即時更新選項 | 5 |
| lib/quotation-excel-server.ts | 使用者可見名稱 | 名稱變更，未更動 Excel 格式／計價規則 | 2 |
| types/quotation.ts | quotation.can_edit | 前端採用後端允許編輯判斷 | 6 |
| supabase/functions/quotation-gateway/index.ts | work_report、save_accounting_price | 沿用驗證／allowlist／私人客戶限制，呼叫共用統計與單價 RPC | 4 |
| supabase/migrations/20261008000705_accounting_quotation_lifecycle.sql（新增） | quotation_can_edit_v1、quotation_has_financial_document_v1、quotation_work_selectable_v1、delete_quotation_v1、既有 detail/options/status/write 函式 | 保留私人資料外層檢查；永久刪除、工作選項排除、可控回退 | 5–6 |
| tests/quotation-delete-entry.test.mjs | preview 刪除斷言 | 改驗證永久刪除自身明細，其他報價及 ERP 不變 | 5 |
| tests/accounting-preview-server.mjs（新增） | 本機隔離 API proxy | 真實 Gateway／RPC，所有業務請求攔至合成資料 | UI 測試 |

## 2. 資料庫及 API 修改

必要新增：

- stock_receipts.unit_price：nullable numeric(14,2)，非負；各進貨列獨立，不寫入其他列或商品主檔。
- construction_plans.planned_days：nullable 整數 1–3650；舊資料無值顯示未設定，不強行補估算。
- accounting_material_prices：以 project_id + inventory_item_id 為主鍵，保存人工參考價、版本、操作者、時間；FK、RLS 及 service-only RPC。
- 三個權限模組：進貨價格、會計報表、會計參考價格；一般角色預設不授權，管理員可透過既有動態角色設定修改，無硬編碼使用者名單。
- 查詢價格及外鍵需要的索引。沒有重建客戶、品項、施工規劃或使用者模型。
- quotation_work_list_deletions 沿用既有最小工作 ID 排除紀錄，避免被刪報價對應工作再以「未報價」重現；不是保留被刪報價內容。

API 沿用目前 Gateway：

- ERP work_report 及 materials scope：work_content_report_v1(accounting=false)。
- 會計 entity=work_report：同 RPC(accounting=true)。
- 會計 operation=save_accounting_price：依使用者、新增／修改／清除及版本檢查。
- 進貨單只在 payload 有明確 unit_price 時使用 v3，舊客戶端省略仍相容；v3 沿用 v2 的單據、庫存、單號、版本與原權限規則。
- 施工規劃原保存／查詢 API 保留，擴充工期欄位及派生進度。
- 報價路徑、ID、稅額規則及 Auth 不變；新的 detail.can_edit 避免前端自行猜測財務狀態。

正式套用仍需發布授權及各層查核。建議相依順序：

1. 精確套用 ERP 20261008000659、20261008000701 與會計 20261008000705 三份 migration；先核對正式版本／既有相依函式及資料備份，不批次推所有 pending migration。
2. 發布兩套對應 Gateway，再發布兩套前端。
3. 依真實角色需要授予新價格／會計報表權限；未獲 VIEW 不從後端回傳價格。
4. 驗證正式 migration 記錄、函式 ACTIVE、Vercel Production commit／alias；本次均未執行。

舊進貨單無價格正常開啟；不填／不變更價格不會被誤清空。既有計畫無預計工期可照常操作。沒有本次以外的資料清理。正式若需回退以程式版本回復為優先，不刪除已新增業務資料或表格。

## 3. 價格同步

現有 inventory_items.cost_price／sale_price 是商品主檔價格，本次保留不變；每張進貨單的實際行單價用 stock_receipts.unit_price 明確保存，沒有用主檔價格覆蓋歷史單據。

- 同品項 ID 選最近有效且非空的進貨價格，依 receipt_date、created_at、id 穩定排序，不把不同採購價格平均或混合。
- 會計報表顯示來源（進貨／人工）、日期及進貨列 ID；金額以彙總數量 × 參考單價、四捨五入小數二位。
- 人工參考價按「工作內容 ID + 品項 ID」保存，重新讀取優先採人工價，ERP 原始進貨價不變。
- 「恢復進貨參考價」只刪除人工參考覆寫；刪除進貨單價只清除該列 unit_price，不刪整單或品項。
- 權限後端驗證；沒有價格 VIEW 的回應移除價格，包括嵌套資料。無修改權限送偽造價格 payload 會失敗。
- 版本衝突不覆寫別人已保存的價格；儲存中禁用篩選切換，避免舊條件讀取蓋掉新畫面。

## 4. 統計報表

- 報表工時口徑：實際有效工作日誌，保留既有未完成／已完成工作日誌的出勤語意，以「人員 ID + 工作內容 ID + 日期」去重為人天；同一工作內容的施工日數以日期去重。這和下述施工進度「只計已完成日誌」不同，不混為一談。
- 每人直式長條圖的單位為天；同人同日多筆不重複。不同人同一天各計自己的出勤，總人天與工作內容日數分開。
- 材料以 pickup_records 的實際取貨紀錄按 inventory_item_id 彙總，不再重複加上工作日誌所關聯的同一取貨紀錄；各單位分別統計，圖表和明細使用同一資料。
- 前後端報表選項／查詢均排除 project_type=clerical/site_survey 及相應文書作業／場勘日誌；不刪除原資料、不改一般工作頁的類型選項。
- ERP 與會計都使用 work_content_report_v1，套用相同條件、ID、日期及私人客戶／可見範圍。會計多出授權價格欄，沒有獨立另一套統計。
- 選擇工作內容後預設起始日取工作建立日，結案工作可帶結束日；可以自行調整。日期篩選會同步更新圖與表。

## 5. 報價管理

- 永久刪除仍要求目前允許的報價狀態、使用者權限及最新 row_version；交易內先檢查，再刪該報價專屬明細、版本、狀態／請款歷程、audit、工作連結及表頭。
- 不刪 ERP 工作內容、日誌、客戶、進貨或共用檔案。合併報價的各工作 ID 使用既有排除紀錄防止重現；無依名稱猜測刪除。
- 清單／搜尋／建立／合併選項共用 selectable 判斷；刪除後立即清除選項快取重抓。
- 若同 ERP 工作另有有效的新報價，刪除舊作廢報價不會讓有效報價消失。
- 既有已刪除歷史資料只在查詢排除，未做未核准的歷史全面清除。
- 客戶確認 → 請款中 → 退回客戶確認（billing 回 unbilled），必填原因並保留狀態歷程；原報價 ID 不變，回退後可修改內容、品項、數量、價格並沿用原稅額規則。
- 現有發票、曾有發票／不可回退財務資訊、部分請款／請款完成歷程會阻擋回退；不自動刪正式憑證。

## 6. 施工進度

- 修正點：首頁進入日誌前，一般參照資料重新載入可能缺少施工規劃的授權上下文；現在先更新 worklogs，再讀最新 construction_plans／關聯主資料，驗證 can_create_log，才帶入原工作日誌表單。
- 帶入既有 project_id、construction_plan_id、目前指派使用者、施工日期、客戶／科室。後端仍驗證計畫與工作、指派、作者、私有客戶及操作權限，不移除檢查。
- 獨立「施工規劃」子頁籤仍屬於工作內容，只允許工程施工的小額採購及標案。
- 完成日數以「construction_plan_id + log_date」distinct 計算；只計未刪除、工程施工、status=completed 的日誌。同日 A 兩筆 + B 一筆仍為 1 天。
- 剩餘=max(預計−完成,0)，超出=max(完成−預計,0)，比例=完成÷預計×100，顯示一位小數。沒有預計值時不偽造百分比。
- 7 天完成 1 天=剩 6 天、14.3%；2 天完成 3 天=超出 1 天、150%。進度條限制 100%，超期文字與警示色保留真實超出量。
- 單筆日誌已完成／工期用盡不等於整個計畫完成，原計畫狀態保存原值，須依原機制手動完成。
- 日誌新增／修改／封存後使報表及 Dashboard scope 失效，顯示中的規劃／首頁 refetch，不以整頁重整作主要方法。
- 負責人由既有 project_workers.is_assignee 關聯判定。只有查看權的真正負責人仍能看到自己的進度，其他觀察者不會因此多拿資料。

## 7. 實際測試結果

### 執行環境與命令

Windows、本機 Node 24.20.0、Next 16.2.6、PGlite 0.5.8。瀏覽器為 Codex 內建 Chromium；不是 iPhone Safari 實機。
全部資料為本機合成資料。Gateway 與 SQL 測試會載入實際函式／migration，Auth 對外供應者及部分歷史表格以隔離 fixture 代替。

| 實際執行 | 結果 |
|---|---|
| ERP npm run check | [PASS] 373 通過、0 失敗、0 略過 |
| 會計 npm run check | [PASS] TypeScript、119 測試、Next production build；0 失敗 |
| 會計既有 Excel 私人檔案測試 | [NOT VERIFIED] 7 項 skip，缺 templates/private/quotation-template.xlsx 或桌面 Excel roundtrip 檔案 |
| verify-accounting-construction-db.mjs | [PASS] 3 組；單價／RBAC／實際 Gateway、跨系統共用報表、施工去重與超期 |
| verify-accounting-quotation-db.mjs | [PASS] 4 組；回退修改、財務阻擋、永久刪除、新有效報價保留 |
| verify-construction-plans-db.mjs | [PASS] 14 組；小額／標案、多人指派、日誌 CRUD、重送／版本、私有及越權、六種一般工作類型 |
| git diff --check（兩 repository） | [PASS] 無 whitespace errors；既有 Windows CRLF 提示不影響結果 |

### 逐項驗收

「SQL／Gateway」代表實際執行隔離資料庫／Handler，不是只有程式碼審查。UI 有明列者已操作保存並重讀。

| 文件驗收項目 | 狀態及實際證據 |
|---|---|
| 進貨單每品項輸入價格 | [PASS] UI 新增兩列 2×1250.25、10×5.50 |
| 價格正確保存 | [PASS] 保存整單後重新開啟，兩列各自原值；SQL 多列不同價格斷言 |
| 權限分別控制查看／新增／修改／刪除 | [PASS] 動態角色 RPC、UI payload 單元測試及資料庫行為 |
| 無價格權限不能經 API 修改 | [PASS] 真實 Gateway 偽造 payload 被拒絕，資料仍 12.50；無 VIEW 回應不含 unit_price |
| 清除價格不影響單或品項 | [PASS] SQL 清價後兩列仍在，普通無價格修改仍保留舊價 |
| 系統顯示名稱更名 | [PASS] UI 側欄、系統名／標題為會計管理系統；顯示入口測試 |
| 原報價功能 | [PASS] 119 既有及增量測試、build、UI 修改金額；私人 Excel 實檔另外未驗證 |
| ERP 報表 | [PASS] UI 類型→客戶→工作→人員圖；2 筆同日誌顯示 1 天 |
| 會計共用報表 | [PASS] UI 2 天、5 台；兩模式同 DB、同條件結果相等斷言 |
| 排除場勘及文書作業 | [PASS] 真實 RPC 選項排除及非法類型拒絕，UI 選項無兩類；不變更原資料 |
| 人員施工直式圖 | [PASS] UI 圖及欄位觀察；未引入圖表套件 |
| 人員統計單位為天 | [PASS] UI 顯示天、人天；同人多筆去重 SQL 斷言 |
| 用料／品項彙總合併 | [PASS] UI 同一用料區塊圖表與品項表 |
| 材料總量正確 | [PASS] SQL 3+2=5 台，按 ID，不重加日誌 |
| 會計同步進貨價 | [PASS] 真實共用 SQL 12.50×5=62.50；UI fixture 最近價 3200×5=16000 |
| 人工價格可保存 | [PASS] UI 保存 3500.25×5=17501.25；SQL 20 元 |
| 一般重讀不覆蓋人工價 | [PASS] UI 重新讀取仍 3500.25；SQL 原 ERP 12.50 不變，清除覆寫恢復 12.50 |
| 刪除後不在清單 | [PASS] 真實 RPC 清單斷言；未對正式 UI 執行刪除 |
| 已刪除不在合併選項 | [PASS] RPC options/list 排除工作 ID，直接重建被拒絕 |
| 報價自身資料真正刪除 | [PASS] 隔離 SQL 所有 quote-owned rows 查核 |
| ERP／客戶等未誤刪 | [PASS] 原 ERP 工作仍在；保留另一有效報價測試 |
| 客戶確認→請款中 | [PASS] UI 操作及 SQL |
| 請款中→客戶確認 | [PASS] UI 原因空白不能提交，填原因後成功；SQL 原因必填 |
| 回退後重新修改內容 | [PASS] UI 數量 2、單價 1234，保存後未稅 2468、稅 123、合計 2591 |
| ID 不重複及財務保護 | [PASS] 同 ID SQL／UI；發票存在時 RPC 拒絕且發票不變 |
| 指派人員 Dashboard 開日誌 | [PASS] UI test_user=A 的「填寫工作日誌」進既有表單 |
| 工作內容 ID 正確 | [PASS] 保存 RPC 及 UI 自動帶入 PLAN-small；資料庫關聯查核 |
| 施工規劃 ID 正確 | [PASS] 保存後該計畫的相關日誌由 1→2；SQL exact ID |
| 指派及權限驗證 | [PASS] 非指派／他人作者／viewer／私有客戶／直接 client RPC 被拒絕 |
| 日誌保存 | [PASS] UI 完成內容保存成功，重新讀取可見 |
| 規劃查看日誌 | [PASS] UI 相關工作日誌 2 筆；後端回傳授權作者 |
| 一般日誌不受影響 | [PASS] 隔離 SQL 六種一般工作類型新增／修改／封存、373 回歸；NAS 實傳另列未驗證 |
| 規劃獨立子頁籤 | [PASS] UI「工作內容列表／工程施工分類／施工規劃」 |
| 小額採購及標案正常 | [PASS] SQL 兩者可建計畫、維修被拒絕；UI 子頁列出兩者 |
| 設定預計天數 | [PASS] UI 7→8 儲存重讀，顯示 8／1／7／12.5% |
| 指派施工人員 | [PASS] SQL 多人指派與替換／撤銷；UI 原 A/B 保留 |
| 完成日誌計日數 | [PASS] UI 保存完成後首頁立即 1 天；SQL |
| 同日多人多筆去重 | [PASS] SQL A×2+B×1 當天仍 1 天 |
| 未完成不計進度 | [PASS] SQL 未完成日期排除；報表出勤口徑另述 |
| 7 天完成 1 天剩 6 天 | [PASS] UI 保存後即時值及單元測試 |
| 進度百分比 | [PASS] 14.3%、12.5%、150% 測試 |
| 超期警示與顏色 | [PASS] 渲染測試 overrun class、文字、progress=100/實際150%；非實機視覺測試 |
| 修改／刪除日誌重算 | [PASS] SQL 完成改未完 3→2 天、封存另一日 2→1；原日誌保存／封存回歸 |
| 負責人 Dashboard | [PASS] 最新 Gateway 實測唯讀負責人取得進度、非負責人無資料；UI 重啟後預計7／已完0正確 |
| 日誌不自動完成計畫 | [PASS] UI 已有完成日誌仍「未開始」；SQL status 保留 pending |

### 未驗證、限制與非本次操作

- [NOT VERIFIED] 正式 Supabase Auth/RLS 線上設定、正式資料遷移、正式 Gateway、Vercel Production。不得將隔離通過等同正式發布完成。
- [NOT VERIFIED] 正式 NAS 照片／附件實際上傳、實際 Excel 私人範本／桌面 Excel、iPhone Safari 實機。本次保留相關原路徑，並執行現有附件／表單／Excel 合成資料回歸。
- [NOT VERIFIED] 瀏覽器點選永久刪除最後確認。已以隔離真實 RPC 執行永久刪除及關聯驗證；未刪使用者任何正式資料。
- [NOT VERIFIED] 正式歷史誤留關聯的全面盤點／清理，沒有依名稱猜測處理。
- 本機 ERP 與會計預覽使用**各自獨立的合成資料庫**；在 ERP 預覽新增的單據不會直接出現在另一預覽。跨系統一致性另由同一隔離 DB 的共享 RPC 測試驗證。
- 本機進程重啟會重建測試資料；畫面證據為操作當時結果，不是正式資料。

### 測試網站

只限本電腦，無須正式帳密，畫面底部有隔離標示：

- ERP 負責人：http://127.0.0.1:4247/?page=dashboard&test_user=owner
- ERP 指派施工員：http://127.0.0.1:4247/?page=dashboard&test_user=A
- ERP 管理員／進貨：http://127.0.0.1:4247/?page=transactions&test_user=admin
- 會計報表：http://127.0.0.1:4248/reports
- 會計報價：http://127.0.0.1:4248/quotations

4249 為內部前端 server，不作測試入口；請用 4248 的隔離 API proxy。不要在測試站填真實個資或正式帳密。

### 畫面證據

- evidence/20261008/construction-progress.png：預計天數 7 改 8，重讀顯示 8／1／7／12.5%，計畫仍未開始。
- evidence/20261008/accounting-report.png：共用用料報表及保存後重新讀取的人工參考價格。
