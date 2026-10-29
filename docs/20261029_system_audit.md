# 系統日誌改版與歷史追溯

狀態：已完成程式與隔離驗證，尚未發布、推送 GitHub 或套用正式 migration。

## 來源與範圍

- 儲存庫：Williams-CHEN0401/GUC-ERP；已 fetch 並核對 main `bb599592d819f13c782590a7af7ba49f90612f0f`（2026-10-29）。
- 修改分支：`codex/system-audit-1029`。
- 範圍：ERP 系統日誌、共用 inventory-gateway 稽核及既有 ERP 表單的資料異動。
- 保留既有 Auth、app_users、角色權限、私有資料隔離、所有業務表單 API；未建立第二套帳號或主資料。

## 使用方式

管理設定 → 系統日誌。預設顯示所有使用者在目前帳號可查看資料範圍內的紀錄。

- 依日期、操作者、功能模組、新增／修改／刪除等操作、紀錄分類、執行結果搜尋。
- 列表顯示時間、操作者、表單、結果、變更摘要；沿用既有搜尋彈出框、排序、分頁及 Excel 匯出。
- 明細提供原始紀錄 ID、帳號辨識依據、修改前後、IP／瀏覽器（舊紀錄可能沒有）、Request ID。
- 「查看同次操作」用 Request ID 串起送出結果與主表、明細、關聯資料的異動；「查看此資料歷程」以資料 ID 查詢。
- 分辨「歷史紀錄」「資料異動」「表單送出」，不把一次送出的多筆資料異動當作多次點擊。
- 沒有操作者、原始值或已刪除關聯名稱時，清楚顯示缺漏／原 ID，不以目前建立者或最後修改者猜測。

## 歷史查核（2026-10-29 09:01 UTC）

目前 audit_logs：15,064 筆，最早 2026-08-16 10:26:54（台灣時間）。5,801 筆保有帳號 ID，149 筆沒有操作者；其餘保留原始操作者文字。28 種操作者文字包含使用者別名、匯入與維護程式，不能當作 28 位使用者。

| 備份 | 稽核筆數 | 與目前 ID、表單、資料 ID、動作、時間相符 | 缺少／衝突 |
|---|---:|---:|---:|
| 2026-10-10 初次雲端搬移 | 12,227 | 12,227 | 0 |
| 2026-10-28 22:33 本機備份 | 14,758 | 14,758 | 0 |

此次不需回填、重新匯入或還原資料庫。只能顯示當時確實保存的事件，未記錄的點擊、未儲存輸入、沒有快照的舊版本及不存在的刪除事件無法憑空補回。未對全部歷代備份逐一比對，結論限於上述兩個備份及目前資料庫。

本機預覽以既有 `private_select_audit_logs_v1` 按 Williams 現有權限擷取的歷史快照；僅綁定 localhost，須使用本次測試連結，禁止寫入。快照／測試連結存於工作樹之外，不進 Git，也不打包網站映像。

## 新紀錄機制

Migration `20261029084350_system_audit_coverage.sql`：

- 擴充既有 audit_logs：event_kind、outcome、operation、entity_key、record_label；舊事件 ID、時間、操作者及前後內容不改寫。
- 解除 audit_logs.entity_id 的 NOT NULL 限制，讓尚無 UUID 的新增／失敗請求、匯出及代碼主鍵表單保存真實 request_id／entity_key，不虛構資料 ID；既有資料 ID 不變。
- 對 44 張既有表，使用同一個內部 trigger 記錄新增／修改／刪除；涵蓋客戶科室／承攬、商品庫存、進取退貨主表與明細、工作規劃／人員／日誌／維修／附件、帳號／角色權限、會計相關表。
- 替換的只有既有稽核 trigger；業務／驗證 trigger、FK、RPC 與編號機制保留。複合主鍵以 entity_key 保存；不依賴每張表必有 id。
- 變更與稽核同一資料庫交易，交易 rollback 時不保留假的成功事件；只有時間／版本欄位變化的無實質異動略過。
- 已登入使用者的正式 Gateway 表單送出另記完成或失敗，同 Request ID 可檢查部分已完成步驟。驗證失敗不等於所有先前交易已回復。
- 不保存原始請求本文、密碼或金鑰；沿用 SQL／API 遮蔽。薪資、每日工資、材料單價的新增觸發器只記識別與狀態，金額明細仍在原會計權限範圍。
- 一般瀏覽器不可插入、修改、刪除或清空日誌。沿用 `audit` 檢視權限及 private read path，不新增角色或放寬 RLS。
- 結果紀錄若寫入失敗，保留實際業務回應並回傳 audit_warning，避免把已保存的操作變成可重送的假失敗；伺服器以 Request ID 記錄異常。這不宣稱能記錄程序中斷前未送達的請求。

## 驗證

- 既有檢查腳本通過，462 項單元／回歸測試通過；最後搜尋摘要與空值顯示修正後，相關 11 項測試再驗證通過。
- 隔離 PGlite：44 張表共 132 次新增／修改／刪除；舊紀錄保留、rollback、偽造標頭、日誌寫入拒絕、實際 Gateway 供應商新增／修改、版本衝突、權限拒絕、結果篩選與分頁通過。
- 測試表欄位依正式 schema 擷取；與稽核無關的 FK／業務約束沒有完整複製，因此不宣稱已重測全站所有表單業務流程。
- Edge / Playwright：8 組歷史資料讀取、使用者及日期搜尋、詳細內容、單筆歷程、分頁、390px 手機及唯讀保護測試通過，無 page error。手機為模擬視窗，非 Safari 真機。
- 正式 DB 僅唯讀查核，沒有用正式資料執行新增、修改或刪除測試。

## 發布相依與復原

正式發布需依序執行此次單一 migration → inventory-gateway → ERP 網站，再核對日誌讀取及正式版本。未套 migration 前不可單獨啟用新的事件分類篩選與結果寫入。Gateway 為共用元件，發布時須一併核對案場原有讀取／寫入契約。

回復程式時保留已產生的稽核與業務資料，不還原舊 DB、不刪除 audit_logs。舊版程式可忽略新增欄位；保留新 trigger 繼續擷取資料。正式復原需依發布程序查核，不自動執行。

主要檔案：app.js、audit-ui.js、index.html、styles.css、search-panels.js、supabase/functions/inventory-gateway/index.ts、上述 migration、scripts/system-audit-fixture.mjs、scripts/verify-system-audit-db.mjs、scripts/system-audit.test.mjs。

技術參考：[PostgreSQL triggers](https://supabase.com/docs/guides/database/postgres/triggers)、[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)。
