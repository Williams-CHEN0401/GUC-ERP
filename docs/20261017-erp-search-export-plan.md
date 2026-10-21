# 2026-10-17 ERP 最小修改與驗收範圍

來源由本次主工作確認：`codex/system-improvements-1017`，起點 `6dcb66b9462dd742935ef3c801bc3a2a83981ef5`。

|檔案／函式|目前問題及最小修改|需求|
|---|---|---|
|contract-service-catalog.js、index.html／renderContractServiceCatalog、contractServiceCatalogFields|移除顯示及輸入排序欄；修改時保留現有 sort_order，新建採末尾順序；資料庫欄位不變|2|
|search-input.js、app.js／matches、搜尋事件|字串比對只正規化資料側，部分搜尋大小寫／空白不一致；共用正規化兩側、中文組字完成前暫停搜尋處理|3|
|customer-departments.js、form-reference-sync.js|新增工作日誌客戶搜尋在尚未選分類時清單為空；搜尋結果改由所有授權客戶產生，已選分類仍作為篩選；不重建或清空表單|3|
|app.js、audit 查詢|既有 generation 已阻止過期請求覆蓋，保留並驗證；主清單均先篩選再分頁，保持此順序|3|
|shared-excel-export.js、excel-export-ui.js、export-catalog.js|共用 XLSX 編碼及選欄／範圍／儲存位置 UI；各清單只定義欄位與篩選，全部符合資料由授權後端產生，不信任前端資料|4|
|supabase/functions/inventory-gateway/export-lists.ts|既有授權 snapshot＋data_export 模組權限，欄位 allowlist、價格權限與後端篩選；root 整合中央路由與權限 migration|4|
|interface-theme.css、work-content-report.css|工作內容既有字型／標題／表格／按鈕樣式抽成 tokens；報表依相同語義角色套用；不改統計邏輯|6|

驗證需涵蓋每一個實際清單及表單搜尋、跨頁／中文組字／清空／組合篩選、無資料、表單保持；匯出解析 XLSX 驗證欄位、順序、型別、長字串與公式隔離；伺服器允許與拒絕、價格／私人資料；375/430/768/1024/1366/1920 畫面檢查。
