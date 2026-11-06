#!/bin/bash
# v3（ブランチ v3）を beta.route-weather.jp に置く（Cloudflare Workers の静的アセット「route-weather-beta」）。手元から実行する。
# サイトに要るファイルだけを、コミット済みの内容で一時フォルダに書き出して送る（docs・worker・test などは送らない）
set -e
cd "$(dirname "$0")/.."
if [ "$(git rev-parse --abbrev-ref HEAD)" != "v3" ]; then echo "ブランチ v3 で実行してください"; exit 1; fi
out=$(mktemp -d)
mkdir "$out/site"
git archive HEAD index.html about.html js vendor icons logo samples sw.js manifest.webmanifest _headers | tar -x -C "$out/site"
cp beta/wrangler.jsonc "$out/"
source ~/.nvm/nvm.sh >/dev/null 2>&1 || true
(cd "$out" && npx wrangler deploy --message "$(git -C "$OLDPWD" log -1 --format='%h %s')")
rm -rf "$out"
