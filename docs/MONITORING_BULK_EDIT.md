# 監控設備批次修改

單筆儲存改用 customer_id 與 save_monitoring_device_v4，網路線號、機櫃、IP、詳細資料可留空。解析度／FPS 不再由表單寫入，既有值由資料庫保留，新設備為空值。

批次更新接受 1–200 筆 id／row_version，以及明確選取的共用欄位 patch。可修改類型、品牌、型號、網路線號、機櫃、連接埠、音訊、狀態、說明書網址、詳細資料。未指定欄位保持原值；空值清除選填資料。設備名稱、IP 與帳密使用單筆編輯。

兩個新 RPC 皆 security invoker、限定 service_role 呼叫，從有效 app_users 驗證 admin／operator 身分。批次按 ID 固定順序鎖定設備，沿用既有 upsert 的版本／稽核規則；任一筆失敗即整批回滾。Gateway 身分来自已驗證工作階段；Preview 禁止寫入。

驗證：npm run check；Gateway TypeScript；scripts/monitoring-bulk-postgres.cjs 用 PGlite 載入實際 migration 與既有 v2/v3 函式，驗證清空欄位、未選欄位保留、過期版本整批回滾、跨客戶、權限與無效 patch。測試資料表及稽核 trigger 為隔離 fixture，不寫入正式資料。

執行 PostgreSQL 測試前，安裝 @electric-sql/pglite 或以 PGLITE_MODULE 指定其模組路徑，再執行 node scripts/monitoring-bulk-postgres.cjs。
