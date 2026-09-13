# 工程施工分類與日誌選單

來源查核：2026-09-12，GitHub Williams-CHEN0401/GUC-ERP main
33ceb17526193161df0cbf4c24868796b0f2cc43。隔離分支 codex/construction-owners-20260912。

- 工作內容管理保留原列表，增加工程施工分類子頁籤與小額採購／標案篩選、編輯。
- projects.construction_category 可空白；舊資料維持未分類，不推測採購性質。
- 類型仍為 construction，繼續與日誌同步；細分類不改變報價可用工作類型。
- 非工程施工隱藏分類欄位；以新版工作內容表單改成其他類型時清空分類。舊 API／日誌修改類型不主動抹除細分類，分類分頁僅顯示 construction。
- 新增日誌的初始及客戶變更選單皆只列 in_progress，仍套用 project_scoped 授權、保留自由輸入與既有唯讀日誌標題。

## 驗證

npm run check：188 項通過。Chrome 1440／390 px 分頁、篩選、編輯與日誌選單通過。
scripts/verify-construction-db.mjs 使用本機 companion quotation tests/database-fixture.mjs，
透過 QUOTATION_FIXTURE_MODULE 指定 file URL；PGlite 測試 v4、v3 相容、版本衝突、權限及拒絕匿名。
scripts/verify-construction-browser.mjs 使用 PLAYWRIGHT_MODULE 指定可用 Playwright。
scripts/construction-preview-server.mjs 提供 4193 loopback 模擬資料，API 不連線正式系統。

## 尚未發布與部署依賴

需另行取得推送、Preview、正式 migration／Edge Functions／發布授權。
先套用 20260912152945_project_construction_category.sql，再部署 inventory-gateway，最後前端。
v4 原子呼叫正式既有 v3，沿用其權限、編號、施工人員、型態／狀態同步与版本檢查；回傳最終 row_version。
v3 來源為報價 repo 的 20260911083331_work_content_quotation_sync.sql，ERP 正式資料庫已具備。
新欄位尚未套用前不得把新版 Gateway 部署到共享正式資料庫，否則 select 新欄位失敗。
回復時回復前端／Gateway 版本即可，保留分類欄位和資料，不刪欄或反向清除資料。
