# GUC ERP 協作規範

## 分支

- `main`：正式版本，只透過 Pull Request 合併。
- `feature/<issue>-<description>`：新功能。
- `fix/<issue>-<description>`：錯誤修正。
- `hotfix/<issue>-<description>`：需優先處理的正式站問題。
- `docs/<description>`：文件修改。

分支名稱使用小寫英數與連字號，不使用人名作為長期分支。

## 提交訊息

採 Conventional Commits：

```text
feat(worklogs): add worker selector
fix(attachments): remove work-log association
docs(devops): document rollback workflow
test(nas): cover duplicate filename handling
chore(ci): add pull-request quality gate
```

每個 commit 只處理一個可說明、可回復的目的。禁止把 `.env`、Token、密碼、NAS 帳密或私密憑證提交到 Git。

## Pull Request

1. 從最新 `main` 建立 feature／fix 分支。
2. 執行 `npm run check`。
3. Push 分支並建立 Pull Request。
4. 等待 GitHub Actions 與 Vercel Preview 完成。
5. 不要求非作者 Review；使用者確認發布後，作者或維護者可在自動檢查通過後合併。人工 Review 為選用，不作為發布門檻。
6. 使用 Squash merge，保留清楚的 Conventional Commit 標題。
7. 合併後確認 Vercel Production 為 `READY`，再建立 Release Tag。

不得直接 push、force push 或刪除 `main`。資料庫 migration 必須向前相容；不得把回滾設計成刪除正式資料。

## 版本與發布

- 一般版本：`vMAJOR.MINOR.PATCH`。
- 功能增加但相容：MINOR。
- 修正：PATCH。
- 不相容變更：MAJOR，必須先提出 migration 與回復計畫。

Release 說明至少包含變更摘要、migration、環境變數名稱、驗證結果、正式部署 ID 與回滾目標。

