# GitHub Actions

- `deploy.yml`: push 到 `main` 时只做构建与测试校验，不再执行旧的 VPS 自动部署。
- `deploy-worker.yml`: 手动触发的 Cloudflare Worker 部署。

# GitHub Secrets

- `CLOUDFLARE_API_TOKEN`: 允许 `wrangler deploy` 的 Cloudflare API Token。
- `CLOUDFLARE_ACCOUNT_ID`: Worker 所在 Cloudflare 账号 ID。
