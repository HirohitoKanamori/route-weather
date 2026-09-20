#!/usr/bin/env bash
# Ride with GPS の api_key とアカウントから認証トークンを発行し、認証を確かめてから中継の秘密として登録する。
# 値は画面に出さず、コピー＆ペーストもしない（文字数と HTTP の結果だけ表示する）。パスワードは RwGPS にしか送らない。
# 使い方：cd worker && bash setup-secrets.sh   （事前に npx wrangler login 済みであること）
set -u
cd "$(dirname "$0")"
read -r -p "api_key（API クライアント管理ページの値）: " KEY
read -r -p "Ride with GPS のメールアドレス: " MAIL
read -r -s -p "Ride with GPS のパスワード（表示されません）: " PW; echo
KEY=$(printf '%s' "$KEY" | tr -d '[:space:]')
BODY=$(MAIL="$MAIL" PW="$PW" python3 -c 'import json,os; print(json.dumps({"user":{"email":os.environ["MAIL"].strip(),"password":os.environ["PW"]}}))')
unset PW
RES=$(curl -s -X POST "https://ridewithgps.com/api/v1/auth_tokens.json" -H "x-rwgps-api-key: $KEY" -H "content-type: application/json" -d "$BODY")
unset BODY
TOKEN=$(printf '%s' "$RES" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
t = d.get("auth_token") or {}
print(t.get("auth_token", "") if isinstance(t, dict) else "")
if d.get("errors"):
    sys.stderr.write("RwGPS からのエラー: %s\n" % d["errors"])
')
echo "api_key の文字数: ${#KEY} ／ 発行されたトークンの文字数: ${#TOKEN}"
if [ -z "$TOKEN" ]; then echo "トークンを発行できませんでした。api_key・メールアドレス・パスワードを確認してください"; exit 1; fi
ST=$(curl -s -o /dev/null -w '%{http_code}' -H "x-rwgps-api-key: $KEY" -H "x-rwgps-auth-token: $TOKEN" "https://ridewithgps.com/api/v1/users/current.json")
echo "認証テスト（users/current）: HTTP $ST"
if [ "$ST" != "200" ]; then echo "認証に失敗しました。中継には登録しません"; exit 1; fi
printf '%s' "$KEY" | npx wrangler secret put RWGPS_API_KEY || exit 1
printf '%s' "$TOKEN" | npx wrangler secret put RWGPS_AUTH_TOKEN || exit 1
echo "中継に登録しました（deploy は不要）。"
