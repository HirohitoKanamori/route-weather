# 中継 Worker（Ride with GPS 連携、ADD_03）

Ride with GPS 公式 API v1 への転送だけを行う Cloudflare Worker。役割は API 鍵を端末に置かないことだけで、ルートの内容は保存・記録しない。

- `GET /rwgps/routes/:id[?privacy_code=…]` → `https://ridewithgps.com/api/v1/routes/:id.json`（`x-rwgps-api-key` と `x-rwgps-auth-token` を付与。公式 API は公開ルートの取得でも両方が必須）
- `GET /health` → `ok`
- 呼び出し元は `ALLOWED_ORIGINS`（`wrangler.toml`）に限定。Origin の無い呼び出し（curl 等）は 403

## 初回の準備（利用者が行う。鍵は Claude に渡さない）

1. Ride with GPS で API クライアントを作る：https://ridewithgps.com/api/api_clients → 名称を登録し、`api_key` を控える。同じページでそのクライアントの「認証トークン（auth token）」を作り、これも控える（運用者アカウントのトークン。Stage 1 では OAuth の redirect URI と client_secret は使わない）
2. Cloudflare のアカウントを作り、Node.js が入った手元で wrangler にログインする
   ```bash
   cd worker && npx wrangler login
   ```
3. 鍵とトークンを秘密として登録する（対話で貼り付ける。ファイルには書かない）
   ```bash
   cd worker && npx wrangler secret put RWGPS_API_KEY
   cd worker && npx wrangler secret put RWGPS_AUTH_TOKEN
   ```
4. 配置する
   ```bash
   cd worker && npx wrangler deploy
   ```
   表示される `https://route-weather-relay.<アカウント名>.workers.dev` が中継の URL。`js/app.js` の `RWGPS_RELAY` に入れて push する
5. 動作確認
   ```bash
   curl -s https://route-weather-relay.<アカウント名>.workers.dev/health
   ```
   `ok` が返れば配置できている。ルート取得はブラウザ（route-weather.jp）からのみ受け付ける

## ローカル確認

Worker のコードは `test/relay.test.mjs` で node のテストを通している（RwGPS には接続しない）。画面込みの確認は、上流を模したローカルサーバーに `UPSTREAM` を向けた node ラッパーで行い、アプリ側は `?relay=http://localhost:8787` で中継先を差し替える。

## 変更したとき

`worker/` を変えたら手元から `npx wrangler deploy` し直す。GitHub Actions は Worker を配置しない（秘密を GitHub に置かないため）。
