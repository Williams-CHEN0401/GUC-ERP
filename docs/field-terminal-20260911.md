# 現場端 FIELD 槽位修正

查核日期：2026-09-11。基準為當日 fetch 的 GitHub main：GUC-ERP `71df7be`、GUC-Site-Data `6f104af`。修改分支為 `codex/field-terminals-20260911`，使用者已確認本機測試版本並授權正式發布。實際部署資訊以 GitHub Release 為準。

## 行為與資料模型

- 現場端以棟別、樓層、FIELD 數值排序後分頁，每頁 100 筆。保留有槽位編號但其他欄位空白的資料。
- 延伸既有 `phone_terminal_points`：僅現場端允許未連結系統端，保存來源號碼、原始類型、解析類型、核對狀態與原因。不複製客戶、分機或設備主資料。
- 找不到系統端、已有其他現場端使用該號碼、檔內重複號碼均保留為紅底。缺少實體位置或同一位置出現兩筆資料仍拒絕，避免無法分辨要覆蓋哪個槽位。
- Excel 話機型態空白，僅從同客戶、同承攬、同號碼且唯一的系統端補入。不能確認時留空並說明。
- 重複匯入依棟樓群組、板號、FIELD 更新原本端子，不新增重複分機。單筆手動編輯仍使用原有入口；未連結端子可查看來源明細，修正來源 Excel 後重匯同槽位。
- 沿用既有登入、RBAC、API 與 RLS。新 RPC 僅授權 service_role，API 仍驗證使用者及電話模組權限，資料庫重新確認承攬與匹配，不信任前端傳入的關聯 ID。

## 實際檔案驗證

測試檔：`A棟2樓_現場端端子資料.xlsx`，SHA256 `3C8F7E7781D908FC1974B2A58A7887118BD6AD6F67EE2CE620ADA5C69378C07D`。

使用環保局系統端資料的唯讀快照，在隔離 PGlite 資料庫套用既有結構及新 migration 後測試，未修改正式資料庫。

- 100 個槽位，41 筆非空號碼，59 個空白槽位。
- 自動補入 34 筆空白型態；38 筆具有確認後的型態（另 4 筆原 Excel 有型態）。
- 6 筆無系統端號碼對應：FIELD 58、59、60、97、98、100。保留號碼及前導零，顯示紅底。真實號碼僅保留在使用者的本機核對檔，不提交 GitHub。
- 首次 100 新增，重送 0 新增、100 更新、0 失敗；既有系統端及分機主資料未變。
- 瀏覽器實際走新版網頁 → Edge handler → 本機 SQL：排序、空白明細、紅底、Excel 預覽、確認匯入、重新讀取、Excel 下載通過。原 A 棟 1 樓 61 筆仍保留，FIELD 排序修正。
- 額外測試重複號碼、跨位置衝突、不合法槽位、重複位置、偽造關聯、無效承攬，以及未登入、viewer、preview 拒絕路徑。

## 重現

1. 在測試資料目錄提供上述 Excel 與唯讀 `system-snapshot.json`（含 `extensions`、`points`），勿提交真實客戶快照。
2. 設定 `FIELD_TEST_DATA_DIR`、`FIELD_TEST_SITE_DIR`、`PGLITE_MODULE`（PGlite 0.5.8 入口），執行 `node scripts/verify-field-terminal-import.mjs`。加 `--serve` 啟動僅綁定 127.0.0.1:4191 的隔離測試 gateway。
3. Site 專案建置後啟動 `next start --hostname 127.0.0.1 --port 3191`。開啟 `http://127.0.0.1:4191/rehearsal`，僅有現場端匯入可寫測試 DB，其餘寫入拒絕。
4. Site 執行 `tests/verify-field-terminal-browser.cjs`。需設定 `PLAYWRIGHT_MODULE`，使用已安裝 Chrome 與本機資料目錄。

## 已授權發布順序

1. 套用 `20260911092521_preserve_field_terminal_slots.sql`。保留欄位、FK 與現有 RLS，不刪除舊資料。
2. 發布 ERP 的 `inventory-gateway`，再發布 Site 分支。先 migration 再 gateway，避免新欄位查詢失敗。
3. 正式匯入前先重新載入當下系統端資料與預覽，經確認後執行。過去被略過的空白槽位不能由不存在的資料推測，需重新匯入來源檔補齊。
4. 若回退應用版本，不可直接恢復 `phone_extension_id NOT NULL`，已保存的空白／未匹配端子需保留。先回退前後端程式，保留新增 schema 與資料供調查。
