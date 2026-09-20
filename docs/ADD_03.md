# 追加機能仕様書 ADD_03 — Ride with GPS 連携

| 項目 | 内容 |
|---|---|
| 文書番号 | ADD_03（RDD_06 フェーズ3。C-5 公開ルート URL 取得、C-6 OAuth） |
| 作成日 | 2026-09-21 |
| 状態 | Stage 1（C-5）実装済み v1.4.0。Stage 2（C-6）未着手 |
| 対象画面 | 「コースと走行計画」の読み込み欄 |

## 1. 調査結果（2026-09-20）

- 公式 API v1（`/api/v1/routes/{id}.json`、`x-rwgps-api-key`＋`x-rwgps-auth-token` ヘッダー）は CORS を許可しており、route-weather.jp のブラウザから直接呼べる（プリフライトが通り 401 が返ることで確認）
- API 利用に審査・承認は不要。商用可、表記義務なし。固定のレート制限は無く監視のみ（API 利用規約 `/api/v1/doc/terms`）
- 鍵なしで取れる旧 `/routes/{id}.json` は非公式のため使わない
- OAuth は authorization code 方式で `client_secret` が必要（`POST /oauth/token.json`）。トークンの有効期限・更新は文書化されていない
- 非公開ルートは共有リンクの `privacy_code` で取得できる。「友達のみ」等は OAuth でログインした本人のみ

## 2. 利用者の判断（2026-09-21）

1. C-5 は公式 API＋中継（Cloudflare Workers）で行う。api_key を端末に置かない
2. Stage 1 で「試験運用中」と注記して公開する
3. 中継は workers.dev の URL、手元から `npx wrangler deploy`
4. 送信に関する文言は「ファイル読み込み時は送信しない／RwGPS 連携時はルート番号と共有コードを中継経由で送り、中継は内容を保存しない」と分けて書く

## 3. Stage 1 の仕様（C-5）

| ID | 要件 |
|---|---|
| R-1 | 読み込み手順の下に「Ride with GPS のルート URL から読み込む（試験運用中）」の入力欄と「読み込む」ボタンを置く。Enter でも実行 |
| R-2 | 貼り付け文から `ridewithgps.com/routes/(\d+)` と、その後ろの `privacy_code` を取り出す（`RW.rwgps.parseUrl`）。見つからなければ例を添えて案内 |
| R-3 | 中継の `GET /rwgps/routes/:id?privacy_code=` を呼ぶ。中継は Origin を許可リストで限定し、`x-rwgps-api-key` と `x-rwgps-auth-token`（運用者アカウントのトークン。公式 API は公開ルートでも両方が必須。2026-09-21 に実配置で確認）を付けて公式 API へ転送、本文と状態をそのまま返す。内容は保存・記録しない |
| R-4 | 応答の `route.track_points`（x=経度、y=緯度、e=標高）を既存の `fromPoints` でコースにする（`RW.rwgps.toCourse`）。コース名は `route.name`。`course.source` に番号と URL を残し、コース欄に「Ride with GPS #番号」を出す |
| R-5 | 文言：403＝非公開（公開にするか共有リンクを貼る）、404＝番号を確認、401＝中継の設定不備、503＝中継未設定、通信失敗＝圏外の案内。読み込めたら従来どおり最近のコースに保存して予報取得へ |
| R-6 | 中継 URL は `js/app.js` の `RWGPS_RELAY`。空なら「準備中」と案内。`?relay=http://localhost:…` で確認用に差し替え可（localhost のみ） |
| R-7 | フッター・README・CLAUDE.md の送信に関する文言を判断 4 のとおり分ける |

## 4. Stage 2 の見通し（C-6、未着手）

- 中継に `POST /oauth/exchange`（code ＋ client_secret → token）を足し、トークンは端末内にのみ保持
- 「Ride with GPS と連携」→ `/oauth/authorize` → `?code=` で戻る → 交換 → `/api/v1/routes.json` で一覧 → 選択して R-4 へ
- 最大の不確定要素は iPhone のホーム画面 PWA から OAuth の往復が戻れるか。Stage 2 の最初に実機で確かめる

## 5. 変更履歴

- v1.4.0（2026-09-21）：Stage 1 を実装。`js/core.js` に `rwgps.parseUrl`／`rwgps.toCourse`、`worker/`（`src/index.mjs`、`wrangler.toml`、README）、`test/rwgps.test.mjs`・`test/relay.test.mjs` を追加
