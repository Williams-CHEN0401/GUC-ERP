# ERP 搜尋、匯出、客戶封存前端與報表驗證

範圍：prompt1017 需求 1 的前端整合、2、3（ERP）、4（ERP 與共用 XLSX）、6。僅修改 `previews/project-dashboard/erp`，資料測試使用隔離資料庫 `guc_dashboard_preview_20261012` 的合成資料。此報告不宣稱已正式部署。

## 修改檔案與目的

|檔案|元件／函式|目的與需求|
|---|---|---|
|app.js|hydrateSnapshot、matches、searchValue、renderMasterData、customerOptions、delete_customer mutation、各搜尋 renderer|同步 customer.deleted_at；封存後清單與新增選單即時更新，歷史名稱保留；雙側 NFKC 比對；已提交的中文組字值；品項分類沿用 category_id 的現行分類名稱（1、3）|
|customer-departments.js|filterModalCustomerSearch、syncModalDepartmentOptions、renderCustomerDepartments|未先選分類也可搜尋所有授權客戶；已選分類保留；不清除其他表單內容；排除封存客戶但保留既有歷史選值（1、3）|
|receipt-customers.js|receiptCustomerPickerFields、refreshReceiptCustomerPicker|跨分類客戶搜尋、正確空狀態、保留歷史選值與既有勾選；不新增已封存客戶（1、3）|
|form-reference-sync.js|applyFormReferenceSnapshot、refreshReferenceFilters|背景更新選項時保留草稿、搜尋字與合法選值；中文組字中使用提交前值（1、3）|
|customer-services.js|render、load、ensureDialog|搜尋不關閉編輯器、不丟失備註；明確重新載入／儲存後才收合；Modal 加入匯出（3、4）|
|contract-service-catalog.js|renderContractServiceCatalog、contractServiceCatalogFields、save handler|移除排序欄與輸入，修改保持原 sort_order、新增接續末尾（2）|
|search-input.js|normalize、matches、value、install|共用全半形／大小寫／前後空白比對；composition capture；背景回覆仍使用已提交搜尋值（3）|
|permissions-ui.js|PERMISSION_LABELS、canModule、projectAccessSearch|沿用 role_permissions 增列 data_export／quotation_invoices／system_backups；新權限對非管理者預設拒絕；搜尋採共同比對（3、4）|
|excel-export-ui.js|definitions、open、install、update|各清單傳入 resource 與當前條件；先向伺服器取得可選欄位，再開共用對話框；每次確認重新檢查權限（4）|
|shared-excel-export.js|buildWorkbook、chooseSaveHandle、saveBytes、openDialog|三站共用 OOXML .xlsx、選欄及選取順序、兩種資料範圍、儲存對話框／相容下載（4）|
|shared-excel-export.css|guc-export-dialog、guc-export-toolbar|沿用主題；窄螢幕可換行、對話框可捲動（4）|
|api/inventory.js|Preview POST allowlist|只讀 export_data 可轉送既有授權 Gateway；其他新增／修改／刪除依舊封鎖（4）|
|supabase/functions/inventory-gateway/export-lists.ts|ERP_EXPORT_SPECS、erpExportColumns、buildErpExport|29 個伺服器欄位白名單；重新讀取授權完整資料；拒絕偽造欄位、未授權價格及部分載入結果（4）|
|supabase/functions/inventory-gateway/index.ts|exportErpData、dashboardSnapshot、getAll 呼叫、auditRecords、phoneSecurityAudit|中央 export_data 授權／完整分頁；報表沿用現有 RPC；私有資料先過濾再轉文字；Site 電話敏感操作紀錄受 admin＋site/phone/audit/data_export 保護且按客戶／承攬分頁（3、4）|
|shared-report-ui.js|reportProjectIncluded|報表搜尋沿用相同正規化與已提交文字；原有非同步快取及統計來源不變（3）|
|interface-theme.css|既有語義文字 CSS variables|以工作管理／工作內容現有文字樣式為基準（6）|
|work-content-report.css|報表標題／表格／輸入／按鈕／圖表／明細 tokens|兩站共用字型、字級、字重、行高；手機輸入 16px，標題與表格各依語義變數；不修改統計算法（6）|
|index.html|script/style 引入、承攬表頭|加入共用搜尋及匯出載入；承攬表頭移除排序（2、3、4）|
|scripts/search-export-1017.test.mjs|11 個新測試|欄位／分頁／格式／公式安全／儲存 API／中文組字資料契約|
|scripts/export-proxy-1017.test.mjs|Preview 代理回歸|驗證 read-only 匯出轉送、驗證憑證延續且 delete_customer 仍被拒絕|
|scripts/optimization-gateway.test.mjs|dashboard projection fixture、1001 筆完整分頁測試|假資料分頁不無限回傳；確認首頁仍限15筆、匯出移除15/100筆上限，前日日誌完整|
|scripts/inventory-item-tools.test.mjs、pickup-item-search.test.mjs、receipt-customer-selection.test.mjs|既有測試 harness|載入真實共用搜尋 helper，保留既有行為斷言|
|scripts/verify-*-1017.mjs、seed-search-export-1017.mjs|隔離 API／瀏覽器驗證|逐一測試下列入口；seed 嚴格拒絕非隔離資料庫|

其他工程師的客戶封存 migration、備份功能、會計功能與 Site 功能，另見總報告；此處不重複計入個別實作。

## ERP 所有實際搜尋入口盤點

證據縮寫：A＝`results.json`；B＝`extended-results.json`；C＝`filters-results.json`；D＝`final-flows-results.json`；E＝`final-readonly-results.json`。都位於 `F:/GUC-Docker/previews/project-dashboard/system-improvements-1017/erp/`。

|頁面／實際入口|搜尋欄位|修正或確認|實測|
|---|---|---|---|
|客戶管理|customerSearch|排除已封存、雙側正規化、全部資料先篩選再分頁|PASS A/C/D|
|客戶分類|customerCategorySearch|已提交組字值；背景重繪不中途套用|PASS A/E|
|客戶科室|customerDepartmentSearch|分類／客戶／啟用條件；保留組字中值|PASS A/C/E|
|承攬內容|contractServiceSearch|名稱搜尋；排序欄移除但順序保留|PASS A/E|
|供應商|supplierSearch|名稱／聯絡方式；完整清單後分頁|PASS A|
|即時庫存|inventorySearch|名稱／品牌／型號／編號；修正 category_id 與舊 item_type 不一致|PASS A/C|
|貨品種類|productCategorySearch|名稱／字首＋啟用；保留組字中值|PASS A/C/E|
|工作內容|projectSearch|編號／名稱／客戶／類型／狀態／負責人；中文狀態、跨頁重設頁碼|PASS A/C|
|工程施工分類|constructionSearch|分類＋名稱／編號／客戶|PASS A/C/E|
|施工規劃|planningSearch|完整授權工作內容＋分類／客戶／科室／類型|PASS A|
|工作日誌|worklogSearch|完整授權日誌；分類／客戶／科室／工作內容／工作類型；取貨摘要、未指派人員與日期顯示字亦與匯出一致|PASS A/C|
|進貨管理|receiptSearch|整單名稱／供應商／日期＋日期區間／供應商|PASS A/C|
|取貨管理|pickupSearch|單號／客戶／品項＋工作內容／日期|PASS A/C|
|維修品|repairSearch|正確非空維修 fixture；狀態＋故障關鍵字|PASS A/B/C|
|客戶預約|appointmentSearch|非空預約 fixture；人員／分類／科室／日期／類型／狀態|PASS A/B/C|
|使用者|userSearch|帳號／名稱／角色／狀態|PASS A|
|工作內容報表|materialKeyword|工作編號／名稱／客戶；分類／科室／日期；回覆亂序保護|PASS C/D|
|系統日誌|audit q|繁中操作別名、新舊回覆競態、伺服器全部分頁|PASS C/D|
|系統日誌|audit actor|操作者＋模組＋關鍵字／日期|PASS C|
|新增／修改工作內容|customerSelectorSearch|不用先選分類；保留草稿；新增排除已封存、歷史仍可讀|PASS B/D|
|新增取貨|customerSelectorSearch|未選分類搜尋；保留其他輸入|PASS B|
|新增維修品|customerSelectorSearch|未選分類搜尋；保留其他輸入|PASS B|
|新增工作日誌|customerSelectorSearch|未選分類搜尋；實際選取；保留已完成內容|PASS A/B|
|新增預約|customerSelectorSearch|未選分類搜尋；保留其他輸入|PASS B|
|新增工作指派|customerSelectorSearch|未選分類搜尋；保留其他輸入|PASS B|
|上傳附件 Modal|customerSelectorSearch|未選分類搜尋；組字／空狀態／保留說明，不上傳 NAS|PASS D|
|新增進貨的訂貨客戶|receiptCustomerSearch|跨分類搜尋；分類條件；勾選與草稿保持|PASS A/B|
|新增進貨品項|receiptItemSearch|全形英文／繁中／編號、選取會帶入實際品項，不清空備註|PASS A/B|
|新增取貨品項|pickupItemSearch|同上，實際點擊品項與清空結果|PASS B|
|工作日誌→取貨|pickupItemSearch|獨立 Modal 情境實際點擊品項|PASS C|
|新增品項|名稱的相似品項建議|部分字／組字／無結果／不清空品牌|PASS B|
|權限設定|projectAccessSearch|工作編號／名稱、全部授權候選、選框不因搜尋重建|PASS B|
|客戶承攬 Modal|data-service-search|部分名稱／組字／空狀態；不收合或清空已輸入備註|PASS B|
|工作日誌既有工作|projectName / workLogProjectNames|原生 datalist 候選／精確選取／部分名稱不清除日誌草稿|PASS B|
|工作日誌設備選取|data-equipment-search|限定客戶＋承攬的正式設備；清空／無結果仍保留已選設備|PASS C|

以上 35 個實際欄位／情境均有瀏覽器驗證。A/B/C/D 已對各對應欄位或結果容器檢查 375、430、768、1024、1366、1920 六種 viewport，並實際點選候選／開關 Modal。其證據不等於實體手機鍵盤測試。

不存在獨立文字搜尋框的供應商、負責人、科室等原生 `<select>`，不憑空增加 UI。首頁工作指派、待辦工作、施工進度為卡片，沒有關鍵字輸入。角色權限矩陣與授權選框是設定表單，不當作業務資料清單匯出。ERP 原始碼仍有舊 `data-site-search`、`inventoryOptions(itemSearch)`、`data-batch-item-search` 相容函式，但目前 index.html／導覽無此 ERP 頁面或輸入；不能把不可達的舊程式列為已測試頁面。實際獨立案場系統由 Site 報告逐頁驗證。

## 29 個可選欄位匯出資源

1. 客戶、客戶科室、客戶分類、客戶承攬內容 Modal、承攬種類、供應商。
2. 即時庫存、貨品種類。
3. 工作內容、工程施工分類、施工規劃、工作日誌。
4. 進貨整單、取貨整單、維修品、預約事項。
5. 使用者、系統日誌。
6. 我的工作指派與完成通知、首頁待辦工作、前日日誌、首頁維修品、負責的施工規劃進度。
7. 報表用料彙總、領用明細、施工規劃、施工子項目、施工人員、日誌明細。

實際欄位 key 清單由最後 API 驗證保存在 `final-readonly-results.json`；中文欄名／型別的唯一來源為 `ERP_EXPORT_SPECS`。客戶沒有獨立聯絡人欄位，因此沒有虛構該欄位。使用者不輸出 ID、密碼／token；進貨的價格欄僅在 purchase_prices VIEW 可用。所有資料均以既有授權 snapshot／RPC 重新讀取，不採信瀏覽器傳入的資料列或權限。

兩個範圍為「目前篩選結果」與「所有目前有權限查看的資料」，皆跨全部頁面。資源本身的業務語義仍維持，例如首頁待辦只含未結案、前日日誌只含前日、指派僅本人待辦／本人建立且尚未確認的完成通知。首頁原本 15 筆摘要仍保留；匯出取得所有符合資料。全範圍不會移除私人資料／RBAC／封存邊界。

OOXML 使用字串儲存格防止公式執行，日期及數量／金額為正確型別，datetime 依台北時間顯示，長字串不截斷；超過 Excel 單格／工作表上限則顯示錯誤。原生 File System Access 儲存對話框可用時先讓使用者選位置；不支援時使用 `.xlsx` 標準下載，介面清楚告知由瀏覽器決定位置。

## 實際結果與限制

- PASS：`node scripts/check.mjs`；最後整套 ERP unit **429/429**，紀錄 `../erp-1017-unit.log`。
- PASS：inventory-gateway `tsconfig.verify.json` strict TypeScript 編譯檢查（含 export-lists.ts 與 Preview import），證據 `gateway-typecheck.log`；字典型別與既有登入驗證 type assertion 未改變行為。
- PASS：29 類實際 API 讀取；完整資料及欄位白名單。29 類逐一測 viewer 403／偽造內部欄位拒絕。
- PASS：非管理者允許匯出時仍不能取得私人客戶、偽造私有 customer_id、進貨價格或無 users 權限清單。
- PASS：實際 UI 建立客戶→建立關聯工作→封存客戶→無整頁 reload 清單更新→新增選單排除→歷史工作編輯仍顯示客戶。
- PASS：實際 HTTP 故意延後舊 audit／report 回應，較新的查詢畫面不被覆蓋。
- PASS：真實瀏覽器下載 `projects-selected.xlsx`，SheetJS 獨立讀取成功，中文欄名／順序／資料筆數符合；JSON 證據 `xlsx-open-validation.json`。
- PASS：11 項匯出專用單元測試包含數字／日期／台北時間／長字串／公式字串／File System API 成功、取消、失敗 abort／組字中已提交值。
- PASS：兩站實際 computed typography 與工作內容頁基準，詳細證據由會計驗證記錄 `system-1017/quotation-report-typography.json` 提供；6 寬度 ERP 報表截圖位於 A 證據目錄。
- NOT VERIFIED：實體手機軟鍵盤與真實中文輸入法候選窗；本次使用 Edge 瀏覽器 composition 事件及 viewport 模擬，不冒充實機。
- NOT VERIFIED：作業系統原生儲存對話框的人手操作；已測 API 契約與真實相容下載。
- NOT VERIFIED：Microsoft Excel 桌面 GUI 開啟。此電腦沒有已註冊 Excel COM；已以 SheetJS 解析實際下載檔案及 OOXML 格式驗證。
- NOT VERIFIED：正式環境資料的任何新增／刪除／部署；本次測試沒有操作正式資料。
