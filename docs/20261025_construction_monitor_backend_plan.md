# 施工履約監控：後端最小修改範圍

來源：GitHub `GUC-ERP/main`，已由主代理查核 `2234c5a`；工作樹與正式來源隔離。

| 檔案／入口 | 目前方式 | 本次修改 | 需求 |
|---|---|---|---|
| 新 migration：projects／construction_plans | 無契約期限；80% 工期固定警示 | projects 唯一履約日期；規劃可選門檻；配對與日期驗證 | 2、6 |
| 原規劃／工作內容寫入 RPC | 既有 RBAC、私人資料、版本鎖、稽核 | 原交易中擴充欄位，不改 Auth 或主資料 | 2、6、10 |
| construction_completion_totals_v1／construction_scope_v1 | 預計天數加權完成率 | 有效勾選項目數比率；有效實作日期去重；未設門檻不告警 | 3、5、6 |
| work_content_report_v1 | ERP、會計共用；會計單價獨立權限 | 保留成本計算，整合相同監控與負責人客觀統計 | 8、9 |
| inventory-gateway/index.ts | project 欄位固定投影 | 增加履約欄位與原交易入口路由 | 2、10 |

驗證在專用 synthetic 資料庫進行：邊界、零項目、取消勾選、增刪項目、未完成與重複日期、未來／未關聯日期、門檻解除、逾期分離、觀察者／施工人員拒絕修改、私人／範圍權限及會計成本欄位回歸。正式資料庫不修改。

## 實作結果

- 唯一履約欄位：`projects.contract_start_date`、`contract_end_date`；日期可單獨留空，兩者同時設定時不得倒置。
- 規劃門檻：`construction_plans.warning_work_days`（1–3650 正整數）、`warning_min_progress`（0–100）；同時設定或同時留空。未設定不沿用原本固定 80% 告警。
- 勾選完成數／有效項目數決定完成度；項目為零時為未知，不從日誌或規劃狀態推算百分比。
- `worked_days` 依正式 plan ID 關聯的有效、非未來、`in_progress`／`completed` 日誌日期去重。監控為累計工程狀況，不隨材料／人工報表的日期篩選縮減；既有材料、人工日期篩選維持。
- 履約逾期與進度落後各自計算；有施工項目時以項目是否全部完成判斷工程完工，避免歷史日誌同步的工作內容狀態掩蓋未完成工程。
- 負責人依現有 `project_workers.is_assignee` 彙總；僅有既有 `projects UPDATE` 及報表查看權限可查看，且再次檢查專案可見範圍。沒有正式負責人關聯的歷史文字保留為獨立標籤，不建立使用者。
- 準時率只納入工程完成、有履約截止日且有既有正式 `completed_on` 的資料；缺少日期保持空值。未新增個人評分。
- 新日期／門檻寫入與既有交易、版本鎖、稽核整合；施工項目完成勾選須有施工規劃管理權限，一般施工人員原工作日誌操作維持。

## 實際驗證

- [PASS] 18 組 isolated SQL 整合測試：`evidence/backend-verification.json`。
- [PASS] 11 組修改前後會計材料／人工／進貨／餘料成本及單價可見性相容驗證：`evidence/cost-compatibility.json`。
- [PASS] 4 組最終工程完成狀態、真實完工日期及績效範圍邊界：`evidence/completion-status-boundary.json`。
- [PASS] 3 組私人資料隔離驗證：未列入私人名單的管理員，不能從報表選項或績效彙總取得私人專案；原私人擁有者維持可見：`evidence/private-monitoring.json`。
- [PASS] 最終 migration 於乾淨 synthetic 基準一次套用成功；121 張 public/Auth/Storage 資料表資料雜湊不變，新增函式與 RLS 權限檢查正常：`evidence/clean-migration.json`。

證據根目錄：`F:/GUC-Docker/previews/20261025-construction-monitor/`。正式資料庫及正式容器未更動；正式發布時需套用本次 migration 與 Inventory Gateway。
