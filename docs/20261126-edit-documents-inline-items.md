# 修改進貨單／取貨單時新增品項

來源：Williams-CHEN0401/GUC-ERP main `d955b5b5f781`，2026-11-26 20:02（台北）查核。

## 修改

- 修改既有進貨單或取貨單時，明細列可以和新增單據一樣輸入名稱搜尋；系統內沒有該品項時，按「＋ 新增此品項」填寫種類、名稱、品牌、單位（型號選填）。新品項期初庫存為 0，跟單據同一交易寫入 `inventory_items`，之後在庫存頁以既有盤點調整校正。
- 新增的明細列與既有明細列改為新品項都適用；既有明細 ID、單號、日期、供應商、訂貨客戶、計價設定、單價不變。
- 退貨單、案場餘料入庫仍只能選既有品項。
- 權限沿用既有 RBAC：需要 `inventory` VIEW／CREATE，以及 `purchases` 或 `pickups` 的 VIEW／UPDATE。前端只決定是否顯示按鈕，Gateway 與資料庫各自再驗證。

## 程式

- 前端：`transaction-inline-items.js` 開放修改單據顯示新增品項；`receipt-documents.js` 的取貨單修改 payload 帶上 `new_item`（進貨單修改原本已帶）。
- Gateway：`update_stock_receipt_document`、`update_pickup_document` 接受 `new_item`，有新品項時改呼叫 `update_transaction_inline_items_v1`；沒有新品項時仍走原本的 `save_stock_receipt_document_v5`／`save_pickup_document_v1`。退貨單帶 `new_item` 一律拒絕。
- 資料庫：`20261126120959_edit_documents_inline_items.sql` 新增 `update_transaction_inline_items_v1`，以既有 `create_inventory_items_batch_v1` 建立品項，再交給既有單據寫入函式。只授權 service_role。不新增資料表、欄位或政策，不改寫既有資料。

## 重試與失敗

修改時以開啟單據時固定的明細版本判斷：同一請求重送，第二次會因版本已更新被拒絕，整個交易（含新品項）回滾，不會產生重複品項。品項名稱與既有品項重複、版本過期、權限不足等任何錯誤，都不會留下新品項或單據變更。

## 驗證

- `npm run check`：565 項通過。
- `node scripts/verify-edit-inline-items-postgres.mjs`：原生 PostgreSQL 16 隔離叢集、合成資料，使用真實 `create_inventory_items_batch_v1` 與本次 migration，13 項斷言通過（取貨修改、進貨修改、過期版本回滾、重複品項、米數單位、權限、帳號不符、非 service_role 不可執行）。單據寫入函式以記錄器替代，其行為由既有回歸腳本涵蓋。
- Gateway `tsc -p supabase/functions/inventory-gateway/tsconfig.verify.json` 無錯誤。

## 發布順序

1. 備份正式資料庫，於隔離還原副本套用 migration 並重跑既有交易單據回歸。
2. 套用 `20261126120959_edit_documents_inline_items.sql`。
3. 更新 `inventory-gateway`。
4. 更新 ERP 前端。

先套用 migration 再更新 Gateway；舊 Gateway 不會呼叫新函式，不影響現行操作。回滾時先還原前端與 Gateway，函式可保留；以此功能建立的品項與單據是正式資料，不以刪除回滾。
