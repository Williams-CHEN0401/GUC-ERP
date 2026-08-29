# 正式發布檢查表（2026-08-27）

目標專案：

- Vercel project：`prj_iKqgI59W9UUL0AcpSCn0ASRzKZi1`
- Supabase project：`bfgjdxhhnfotkjrbdckr`
- 正式 Edge Function：`inventory-gateway`
- 正式網站：`https://guc-erp-vercel-rebuild.vercel.app/`

## 發布前唯讀檢查

1. 匯出正式資料庫備份，記錄 customers、projects、inventory_items、pickups、receipts、stock_adjustments、sites、site_work_logs、site_assets、app_users 筆數。
2. 確認 `sites.project_id` 沒有重複值：

   ```sql
   select project_id, count(*)
   from public.sites
   where project_id is not null
   group by project_id
   having count(*) > 1;
   ```

3. 確認工作類型現況：

   ```sql
   select coalesce(work_type, '<NULL>') as work_type, count(*)
   from public.site_work_logs
   group by work_type
   order by work_type;
   ```

4. 確認 Vercel Production 的 NAS 環境變數仍存在；不得在輸出中顯示值。

## 固定發布順序

1. 核對 NAS 相關 migration 已存在。交接快照記錄 `20260827070151`、`20260827070343`、`20260827070452`、`20260827070635` 已套用，不重複套用 `20260827000100_add_nas_attachment_index.sql`。
2. 套用本次唯一的新 migration：`supabase/migrations/20260827000200_formal_site_crud_and_work_type.sql`。
3. 部署 `supabase/functions/inventory-gateway/index.ts` 至正式 `inventory-gateway`。
4. 先驗證未登入請求回傳 401、登入及 sites scope 正常，再部署 Vercel Production。
5. 發布 `source/` 至既有 Vercel project，不建立新 project、不改 domain。

## 上線驗證

- 導覽列沒有「現場照片」或「施工照片」。
- 「附件」頁籤與 NAS 狀態仍可使用。
- 「工作日誌」新增／修改表單只有「工程施工」、「維修紀錄」、「維護保養」。
- admin／operator 可新增與修改案場明細；只有 admin 可刪除。
- 新增案場明細時，每個 project 最多只建立一筆 `sites` 主檔。
- 修改與刪除使用 `row_version`；衝突時提示重新載入。
- 上線前後各表筆數相符；只有驗證操作明確建立的測試資料可以增加。

## 回復原則

- 若 migration 失敗，停止後續 Edge Function 與 Vercel 發布，依正式備份回復。
- 若 Edge Function 驗證失敗，重新部署上一版 `inventory-gateway`，Vercel 不變。
- 若僅前端驗證失敗，將 Vercel Production 回復至上一個成功 deployment；不要回滾已通過驗證的資料庫 migration。
