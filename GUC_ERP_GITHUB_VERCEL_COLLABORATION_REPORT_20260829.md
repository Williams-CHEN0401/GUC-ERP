# GUC ERP GitHub／Vercel 版本控制執行報告

日期：2026-08-29（Asia/Taipei）

## 一、稽核結果

| 項目 | 結果 |
|---|---|
| 正式網站 | `https://guc-erp-vercel-rebuild.vercel.app/` |
| Vercel Project | `guc-erp-vercel-rebuild`（`prj_iKqgI59W9UUL0AcpSCn0ASRzKZi1`） |
| 最新 Production | `dpl_2JGcVK3kSvg86pVFR2EoVqEBR1pB`，`READY` |
| 本地 Git | 專案目錄沒有 `.git`，無法確認 remote、branch 或歷史 |
| 最近部署來源 | 最近 20 筆部署均未提供 Git commit／branch metadata，現況不能證明 Git 自動部署已生效 |
| GitHub 工具／登入 | 工作環境沒有 GitHub CLI，也沒有可用的 GitHub 寫入憑證 |
| Vercel CLI | 工作環境未安裝；Vercel 專案狀態已透過已連線的專案介面核對 |

基於「不得覆蓋或破壞既有 Repository 歷史」原則，目前未執行 `git init`、未建立新 Repository、未 force push，也未修改正式 Vercel Git Integration。

## 二、已完成項目

- 建立完整 `.gitignore`，排除 `.env*` 真實檔、`.vercel/`、`node_modules/`、build/cache、Log、私密憑證與 IDE 暫存檔；保留 `.env.example`。
- 建立 GitHub Actions：`.github/workflows/ci.yml`，對 Pull Request 與 `main` push 執行 `npm run check`。
- 建立 Pull Request 範本，要求測試、Preview、migration、環境變數與回滾檢查。
- 建立 `CONTRIBUTING.md`，規範 main、feature／fix／hotfix 分支、Conventional Commits、Review 與 Release。
- 建立 `VERSION_CONTROL_AND_COLLABORATION.md`，提供標準改版流程、Branch Protection 建議與回滾方式。
- 更新 README 的正式 NAS 路徑、附件關聯規則與已套用 migration 狀態。
- 完成檔案盤點：前端、Vercel API、Supabase Edge Function、migration、scripts、package 與設定檔均已包含在封存版本。
- 敏感資訊掃描未發現硬編碼的 Token、密碼或 Supabase service-role key。
- `npm run check`：22／22 通過。

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

## 七、尚待完成與所需資料

要完成首次安全 commit、push、Pull Request、merge、Vercel Git 自動部署與 Branch Protection，仍需：

1. Vercel 實際綁定的 GitHub Repository URL（`https://github.com/<owner>/<repo>`）。
2. 對該 Repository 的 GitHub 寫入與建立 Pull Request 權限。
3. 若 Repository 為私有，需在目前工作階段連接可存取該 Repository 的 GitHub 帳號。

取得後的安全作法是先 clone 現有 Repository、確認預設分支與完整歷史，再建立 `chore/version-control-baseline` 分支並疊加本封存內容；不得以 unrelated-history push 或 force push 取代遠端。
