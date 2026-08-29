# Vercel／GitHub 版本控制與多人協作

## 目標架構

| 元件 | 正式來源 | 發布規則 |
|---|---|---|
| 程式碼、API、migration、測試 | GitHub Repository | 所有修改經 Pull Request |
| 正式分支 | `main` | 合併後由 Vercel Git Integration 自動發布 Production |
| 功能／修正分支 | `feature/*`、`fix/*`、`hotfix/*` | Push 或 Pull Request 建立 Vercel Preview |
| 密鑰與環境變數 | Vercel／Supabase | 不進 GitHub，只提交 `.env.example` 的變數名稱 |
| 正式版本 | Git Tag／GitHub Release | 使用 `vMAJOR.MINOR.PATCH` |

## Repository 必須包含

- `index.html`、`styles.css`、`app.js`
- `api/`
- `supabase/functions/`
- `supabase/migrations/`
- `scripts/`
- `package.json`、`vercel.json`
- `.env.example`、`.gitignore`、`.vercelignore`
- `.github/workflows/ci.yml` 與 Pull Request 範本
- README、發布紀錄與協作文件

不得包含 `.env*` 真實檔、`.vercel/`、`node_modules/`、建置快取、Log、私密憑證、Token 或密碼。

## 每次改版標準流程

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/<issue>-<description>

# 修改與驗證
npm run check

git add --all
git diff --cached
git commit -m "feat(scope): concise summary"
git push -u origin feature/<issue>-<description>
```

接著建立 Pull Request，檢查 GitHub Actions 與 Vercel Preview，完成 Review 後 Squash merge。合併後確認 Production 為 `READY`，再建立版本：

```bash
git switch main
git pull --ff-only origin main
git tag -a v1.1.0 -m "GUC ERP v1.1.0"
git push origin v1.1.0
```

## 建議 Branch Protection／Ruleset

對 `main` 啟用：

- Require a pull request before merging。
- Require at least 1 approval。
- Dismiss stale approvals when new commits are pushed。
- Require status check：`程式與自動化測試`。
- Require conversation resolution。
- Block force pushes and branch deletion。
- Restrict bypass permissions to Repository 管理者。
- 若團隊人數允許，Require code owner review。

## 回滾

### 程式部署

優先使用 Vercel 將上一個已驗證的 Production deployment 重新指向正式 Alias；同時在 GitHub 建立 revert Pull Request，使 `main` 與正式站重新一致。不得只在 Vercel 回滾而長期不修正 Git 歷史。

```bash
git switch -c revert/<release>
git revert <merge-commit>
git push -u origin revert/<release>
```

### 資料庫

已執行的 migration 不刪除、不改名。使用新的 forward-fix migration 修正 Schema；涉及正式資料時先備份並採可逆、分階段操作。Vercel 程式回滾前必須確認舊程式仍與目前資料庫 Schema 相容。

## 目前驗證門檻

- `npm run check` 必須通過。
- Vercel Preview 必須為 `READY`。
- Build error 與 Production runtime error 必須為 0。
- migration 發布前後核對關鍵資料表筆數。
- NAS 測試不得真正寫入 Preview 環境。

