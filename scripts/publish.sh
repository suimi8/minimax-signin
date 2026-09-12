#!/usr/bin/env bash
# 一键发布到 GitHub（公开仓库）
#
# 前置：先执行 `gh auth login` 完成登录
# 用法：bash scripts/publish.sh [仓库名]     默认 minimax-signin
#
# 它会：
#   1. 检查 gh 登录状态与工作区是否干净
#   2. 创建公开仓库并推送
#   3. 把 .env 里的 KV 凭证写入仓库 Secrets（供 GitHub Actions 使用）

set -euo pipefail

REPO="${1:-minimax-signin}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> 检查 gh 登录状态"
if ! gh auth status >/dev/null 2>&1; then
  echo "❌ 尚未登录 GitHub。请先执行：gh auth login"
  exit 1
fi
GH_USER="$(gh api user --jq .login)"
echo "    已登录为：$GH_USER"

echo "==> 检查工作区"
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ 工作区有未提交的改动，请先提交："
  git status --short
  exit 1
fi

echo "==> 创建公开仓库 $GH_USER/$REPO"
if gh repo view "$GH_USER/$REPO" >/dev/null 2>&1; then
  echo "    仓库已存在，跳过创建"
else
  gh repo create "$REPO" --public --source=. --remote=origin --push
fi

echo "==> 推送代码"
git push -u origin HEAD:main 2>/dev/null || git push -u origin HEAD:master

echo "==> 写入 Actions Secrets"
set-secrets() {
  local env_file="$1"
  [ -f "$env_file" ] || { echo "    跳过（无 $env_file）"; return; }
  while IFS='=' read -r key val; do
    key="$(echo "$key" | tr -d ' ')"
    [ -z "$key" ] || case "$key" in \#*) continue ;; esac
    case "$key" in
      UPSTASH_REDIS_REST_URL|UPSTASH_REDIS_REST_TOKEN|KV_REST_API_URL|KV_REST_API_TOKEN|ADMIN_TOKEN|CRON_SECRET)
        val="${val%\"}"; val="${val#\"}"
        if [ -n "$val" ]; then
          printf '%s' "$val" | gh secret set "$key"
          echo "    ✅ $key"
        fi
        ;;
    esac
  done < <(grep -E '^\s*[A-Z_]+=' "$env_file")
}
set-secrets "$ROOT/.env"

echo
echo "🎉 完成：https://github.com/$GH_USER/$REPO"
echo
echo "接下来："
echo "  1. 打开 https://github.com/$GH_USER/$REPO/actions 启用工作流"
echo "  2. 确认 Secrets 已写入：Settings → Secrets and variables → Actions"
echo "  3. 手动跑一次验证：Actions → MiniMax 每日签到 → Run workflow"
echo
echo "⚠️  凭证在聊天/终端出现过，建议到 Upstash 控制台 Revoke 并重新生成后更新 Secrets。"
