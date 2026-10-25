# 維修日期選填與線材米數庫存：測試版交付

日期：2026-10-22。這次為隔離測試版，尚未發布正式網站、推送 GitHub 或套用正式 migration。

## 來源與成果位置

- ERP：從已 fetch 核對的 GitHub main `8b489448340656a03ee9a1a7c6a119f0fa21f392` 建立分支 `codex/cable-meter-1022`，工作樹 `F:\GUC-Docker\workspaces\cable-meter`。
- 報價／會計：從已 fetch 核對的 GitHub main `94d0eb787b5bcd758a456bcd613cb896cdffe292` 建立同名分支，工作樹 `F:\GUC-Docker\workspaces\cable-meter-quotation`。
- 測試環境與證據：`F:\GUC-Docker\previews\20261022-cable-meter`。
- 正式網站、正式資料與原始工作目錄未因這次修改而更新。

## 測試入口

- ERP 案場餘料入庫：<http://localhost:4250/?page=transactions&tab=returns>
- ERP 商品與庫存：<http://localhost:4250/?page=inventory>
- ERP 維修品：<http://localhost:4250/?page=repairs>
- ERP 範例報表：<http://localhost:4250/?page=materials&work_content_id=fac09545-f3cd-4122-a64a-5d01940c014a>
- 會計報表：<http://localhost:4252/reports>

測試站使用合成資料庫 `guc_cable_meter_20261022`，有隔離測試提示。會計報表可選客戶「範例科技大樓（測試資料）」及工作內容「環境管理處辦公室搬遷案（合成案例）9021a7」。預覽使用合成登入身分；資料庫 RPC、庫存帳本與 Gateway 為實際程式路徑，未將預覽登入當作正式登入驗收。

## 操作與計算

1. 商品與庫存的即時庫存雙擊品項，在原有編輯表單設定「每箱／捲米數」，例如 305。新建品項後亦由此設定；未設定的普通商品維持原有單位。
2. 案場餘料入庫選「散料（米）」，可輸入總米數，或在「餘料每段米數」填 `85、93、32`，系統加總為 210 米。米數支援小數二位。
3. 即時庫存分開顯示整箱／整捲數量與散料米數。取貨單可選原包裝單位或散料米數。
4. ERP 與會計的工作內容報表將已設定換算率的線材統一換成米，扣除退回米數。會計修改價格仍輸入每箱／捲單價，系統換算每米價格；金額計算保留精度，最後四捨五入至小數二位。
5. 三個維修流程日期均可獨立留白，包括已返還客戶狀態；有填的日期仍檢查時間先後。其他既有必填條件維持原規則。

範例：10 箱 × 305 米＝3,050 米；退回 85＋93＋32＝210 米；淨用料 2,840 米。每箱 4,500 元 ÷ 305＝每米約 14.754098 元；退料價值約 3,098.36 元，淨材料參考成本為 **41,901.64 元**。

本次沿用既有人工參考單價／最近進貨參考單價口徑，未導入 FIFO 或批次成本會計；不重寫原進貨支出或歷史單據。正式資料唯讀核查時，指定工作內容尚未找到 CAT-6 取貨明細，因此上述數字以合成案例驗證，沒有代填正式取貨／退料帳。

## 庫存與權限保護

- 包裝與米數為既有帳本中的兩種單位維度，不把 210 米當作 210 箱，也不改寫既有包裝數量。
- 退料不得超過該工作內容累計領用量；散料不足時不能領用；已領用的散料不能因取消原退料而變成負庫存。
- 儲存沿用既有權限、稽核、版本檢查、鎖定與重試識別；不建立第二套正式 Auth 或權限模型。
- 已有散料歷史的品項不能直接改變包裝單位／換算率，避免重算歷史帳。原紀錄要改單位時由既有刪除／重建流程處理。
- 舊版開啟中的會計頁面若未傳遞「包裝單價」識別，不能把每米價格誤存成每箱價格，會要求重新整理。

## 已執行驗證

- ERP 語法／檢查通過，既有測試 **438 項通過**。
- 報價／會計 TypeScript 與 Next.js webpack 正式建置通過；完整測試 **143 項通過、7 項既有選用測試略過**，無失敗。
- 真實隔離 PostgreSQL/RPC：15 組庫存、退料、取貨、精度、版本、權限、日期情境通過；額外包裝退料／取消與 RPC ACL 檢查通過。
- 瀏覽器：桌面及手機排版、分段米數加總、修理日期清空儲存、退料修改、散料領用與刪除沖回、商品換算率儲存通過。
- ERP 與會計報表用量一致；Excel 匯出來源資料核對包裝／米數、單位與 41,901.64 元；舊頁面價格阻擋與新頁面包裝價格儲存通過。
- 正式 Docker 容器維持原版本及既有運行時間。本次只新增隔離測試 REST 容器及本機預覽服務。

證據位於預覽目錄 `evidence`：`db-tests.json`、`package-control.json`、`browser-tests.json`、`browser-writes.json`、`export-tests.json`、`erp-tests-final.txt`、`quotation-tests-final.txt`、`quotation-build-final.txt` 及畫面截圖。

## 後續正式發布相依

正式發布需一起帶入以下內容，並依既有發布流程先備份／驗證：

- ERP migration：`supabase/migrations/20261022102602_cable_meter_stock_optional_repair_dates.sql`。
- ERP `inventory-gateway`、匯出處理與 ERP 前端。
- 報價／會計 `quotation-gateway`、會計頁面及同步的共用報表元件。

正式資料庫未套用此 migration。新增欄位與 RPC 需先可用，再切換使用新欄位的 Gateway／前端；正式發布後須重新核對兩站、舊單據、權限與匯出。

`scripts/verify-cable-meter-db.mjs` 是本機驗收腳本副本，需設定 `CABLE_TEST_DIR` 指向上述隔離預覽目錄及其 `preview-db.mjs`。腳本拒絕非 `guc_cable_` 資料庫，會建立新的合成案例並更新預覽 fixture；不要用於正式資料庫。完整驗收實際執行的是預覽目錄中的同源 `verify-db.mjs`。
