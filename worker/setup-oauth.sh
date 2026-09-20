#!/usr/bin/env bash
# パスワードを使わずに、運用者アカウントの OAuth アクセストークンを発行して中継の秘密（RWGPS_ACCESS_TOKEN）に登録する。
# 事前に API クライアント管理ページで OAuth を有効にし、redirect URI に https://route-weather.jp/ を登録しておく。
# 値は画面に出さない（文字数と HTTP の結果だけ表示）。使い方：cd worker && bash setup-oauth.sh
set -u
cd "$(dirname "$0")"
REDIRECT="https://route-weather.jp/"
read -r -p "OAuth の client_id（管理ページの値。api_key とは別）: " CID
read -r -s -p "OAuth の client_secret（表示されません）: " CSEC; echo
CID=$(printf '%s' "$CID" | tr -d '[:space:]'); CSEC=$(printf '%s' "$CSEC" | tr -d '[:space:]')
echo
echo "次の URL をブラウザで開き、Ride with GPS にログインして許可してください："
echo "  https://ridewithgps.com/oauth/authorize?client_id=$CID&redirect_uri=$(printf %s "$REDIRECT" | python3 -c "import sys,urllib.parse as u; print(u.quote(sys.stdin.read(), safe=''))")&response_type=code"
echo "許可後に route-weather.jp へ戻ります。そのときのアドレスバーの URL（?code=… を含む）を丸ごと貼り付けてください。"
read -r -p "戻り先の URL: " BACK
CODE=$(printf '%s' "$BACK" | python3 -c 'import sys,urllib.parse as u; s=sys.stdin.read().strip(); q=u.urlparse(s).query if "://" in s else s; print(u.parse_qs(q).get("code",[s if "=" not in s else ""])[0])')
if [ -z "$CODE" ]; then echo "code が見つかりませんでした"; exit 1; fi
BODY=$(CID="$CID" CSEC="$CSEC" CODE="$CODE" REDIRECT="$REDIRECT" python3 -c 'import json,os; print(json.dumps({"grant_type":"authorization_code","code":os.environ["CODE"],"client_id":os.environ["CID"],"client_secret":os.environ["CSEC"],"redirect_uri":os.environ["REDIRECT"]}))')
unset CSEC
RES=$(curl -s -X POST "https://ridewithgps.com/oauth/token.json" -H "content-type: application/json" -H "accept: application/json" -d "$BODY")
unset BODY
TOKEN=$(printf '%s' "$RES" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
print(d.get("access_token", "") or "")
err = d.get("errors") or d.get("error_description") or d.get("error")
if err:
    sys.stderr.write("RwGPS からのエラー: %s\n" % err)
')
echo "アクセストークンの文字数: ${#TOKEN}"
if [ -z "$TOKEN" ]; then echo "トークンを発行できませんでした（code は 1 回しか使えないので、やり直すときは URL を開き直してください）"; exit 1; fi
ST=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" -H "accept: application/json" "https://ridewithgps.com/api/v1/users/current.json")
echo "認証テスト（users/current、Bearer）: HTTP $ST"
if [ "$ST" != "200" ]; then echo "認証に失敗しました。中継には登録しません"; exit 1; fi
printf '%s' "$TOKEN" | npx wrangler secret put RWGPS_ACCESS_TOKEN || exit 1
echo "中継に登録しました（deploy は不要）。"
