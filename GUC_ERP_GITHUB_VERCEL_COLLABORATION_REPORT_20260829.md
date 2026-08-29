# GUC ERP GitHub／Vercel 版本控制執行報告

日期：2026-08-29（Asia/Taipei）

## 一、稽核結果

| 項目 | 結果 |
|---|---|
| 正式網站 | `https://guc-erp-vercel-rebuild.vercel.app/` |
| Vercel Project | `guc-erp-vercel-rebuild`（`prj_iKqgI59W9UUL0AcpSCn0ASRzKZi1`） |
| GitHub Repository | `Williams-CHEN0401/GUC-ERP`，Private，預設分支 `main` |
| Baseline PR | `#1`，已以 squash merge 合併 |
| 程式 baseline commit | `7d0645731de25fe7c0a6bf42936c732505f02f40` |
| Vercel Preview | `dpl_EQFbzGy4cC6VjFT5mpC2ooZT2gtW`，`READY`，來源 Git |
| 程式 baseline Production | `dpl_DmpVYfx3cYHgZJYVPuv3abYVEEAW`，`READY`，來源 Git `main` |
| GitHub 權限 | 登入帳號 `Williams-CHEN0401`，具有 Admin 與 Push 權限 |
| Vercel CLI | 工作環境未安裝；Vercel 專案狀態已透過已連線的專案介面核對 |

既有 Initial commit `06b3ccf6488323caffa22cd2a1fc195523f03983` 已保留。完整程式由 `chore/version-control-baseline` 分支經 PR 合併，沒有 force push、沒有 unrelated-history，也沒有重建 Repository。

## 二、已完成項目

- 建立完整 `.gitignore`，排除 `.env*` 真實檔、`.vercel/`、`node_modules/`、build/cache、Log、私密憑證與 IDE 暫存檔；保留 `.env.example`。
- 建立 GitHub Actions：`.github/workflows/ci.yml`，對 Pull Request 與 `main` push 執行 `npm run check`。
- 建立 Pull Request 範本，要求測試、Preview、migration、環境變數與回滾檢查。
- 建立 `CONTRIBUTING.md`，規範 main、feature／fix／hotfix 分支、Conventional Commits、Review 與 Release。
- 建立 `VERSION_CONTROL_AND_COLLABORATION.md`，提供標準改版流程、Branch Protection 建議與回滾方式。
- 更新 README 的正式 NAS 路徑、附件關聯規則與已套用 migration 狀態。
- 完成檔案盤點：前端、Vercel API、Supabase Edge Function、migration、scripts、package 與設定檔均已包含在封存版本。
- 敏感資訊掃描未發現硬編碼的 Token、密碼或 Supabase service-role key。
- 歷史 Preview 報告中的 Vercel 臨時分享 Token 已移除。
- `.vercelignore` 已排除 migration、GitHub 設定、測試與 Markdown 報告，避免 Git 自動部署時成為公開靜態檔案。
- `npm run check`：22／22 通過。
- GitHub Actions「品質檢查」：成功。
- Vercel Preview：HTTP 200、Build errors 0、Runtime error／fatal 0。
- PR #1 已 squash merge；Vercel 已由 `main` 自動建立 Production deployment。
- 正式網站：HTTP 200，`app.js` HTTP 200，Build errors 0、Runtime error／fatal 0。

## 三、建議 Git 分支架構

| 分支 | 用途 | Vercel |
|---|---|---|
| `main` | 正式版本，只允許 PR 合併 | Production |
| `feature/*` | 新功能 | Preview |
| `fix/*` | 一般修正 | Preview |
| `hotfix/*` | 正式站緊急修正 | Preview，驗證後 PR 合併 |
| `docs/*` | 文件／流程 | Preview 可略過或保留 |

## 四、每次改版標準流程

1. 從最新 `main` 建立 feature／fix 分支。
2. 修改程式並執行 `npm run check`。
3. 檢查 staged diff 與敏感資訊後 commit。
4. Push 分支並建立 Pull Request。
5. 等待 GitHub Actions 與 Vercel Preview 成功。
6. 至少一位非作者 Review，完成後 Squash merge。
7. 確認 Vercel Production 為 `READY` 且 runtime errors 為 0。
8. 建立 `vMAJOR.MINOR.PATCH` Tag／Release，記錄 migration、部署 ID 與回滾點。

## 五、Branch Protection 建議

- Require pull request before merging。
- Require at least 1 approval。
- Dismiss stale approvals。
- Require status check：`程式與自動化測試`。
- Require conversation resolution。
- 禁止 force push 與刪除 `main`。
- 限制 bypass 權限；團隊人數允許時加入 CODEOWNERS review。

## 六、回滾方法

- Vercel：將上一個已驗證的 Production deployment 重新指向正式 Alias。
- GitHub：建立 `revert/*` 分支，對合併 commit 執行 `git revert`，經 PR 合併，讓 `main` 與正式站重新一致。
- Supabase：已執行的 migration 不刪除、不改名；使用新的 forward-fix migration。程式回滾前先確認舊版仍相容目前 Schema。

## 七、尚待人工設定

完整 Git／GitHub／Vercel 自動部署流程已完成。因目前 GitHub 連線未提供 Repository Ruleset／Branch Protection 與 Release Tag 寫入介面，以下兩項需由 Repository 管理者在 GitHub 設定頁完成：

1. 依第五節對 `main` 啟用 Branch Protection／Ruleset，並將 `程式與自動化測試` 與 Vercel 設為必要檢查。
2. 建立首個正式 Tag／Release，例如 `v1.0.0`，指向 `7d0645731de25fe7c0a6bf42936c732505f02f40`。
