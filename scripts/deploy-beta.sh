#!/bin/bash
# v3（ブランチ v3）を beta.route-weather.jp に置く（Cloudflare Pages のプロジェクト route-weather-beta へ直接アップロード）。
# 手元から実行する。サイトに要るファイルだけを、コミット済みの内容で書き出して送る（docs・worker・test などは送らない）
set -e
cd "$(dirname "$0")/.."
if [ "$(git rev-parse --abbrev-ref HEAD)" != "v3" ]; then echo "ブランチ v3 で実行してください"; exit 1; fi
out=$(mktemp -d)
git archive HEAD index.html about.html js vendor icons logo samples sw.js manifest.webmanifest _headers | tar -x -C "$out"
source ~/.nvm/nvm.sh >/dev/null 2>&1 || true
npx wrangler pages deploy "$out" --project-name route-weather-beta --branch v3 --commit-hash "$(git rev-parse HEAD)" --commit-message "$(git log -1 --format=%s)" --commit-dirty=false
rm -rf "$out"
