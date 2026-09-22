# 追加機能仕様書 ADD_03 — Ride with GPS 連携

| 項目 | 内容 |
|---|---|
| 文書番号 | ADD_03（RDD_06 フェーズ3。C-5 公開ルート URL 取得、C-6 OAuth） |
| 作成日 | 2026-09-21 |
| 状態 | Stage 1（C-5）実装済み v1.4.0。Stage 2（C-6）実装済み v1.5.0（2026-09-22） |
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
| R-3 | 中継の `GET /rwgps/routes/:id?privacy_code=` を呼ぶ。中継は Origin を許可リストで限定し、運用者アカウントの OAuth アクセストークン（`RWGPS_ACCESS_TOKEN`、`Authorization: Bearer`）を付けて公式 API へ転送、本文と状態をそのまま返す。内容は保存・記録しない。公式 API は公開ルートでも利用者認証が必須（api_key 単体では 401。2026-09-21 に実配置で確認） |
| R-4 | 応答の `route.track_points`（x=経度、y=緯度、e=標高）を既存の `fromPoints` でコースにする（`RW.rwgps.toCourse`）。コース名は `route.name`。`course.source` に番号と URL を残し、コース欄に「Ride with GPS #番号」を出す |
| R-5 | 文言：403＝非公開（公開にするか共有リンクを貼る）、404＝番号を確認、401＝中継の設定不備、503＝中継未設定、通信失敗＝圏外の案内。読み込めたら従来どおり最近のコースに保存して予報取得へ |
| R-6 | 中継 URL は `js/app.js` の `RWGPS_RELAY`。空なら「準備中」と案内。`?relay=http://localhost:…` で確認用に差し替え可（localhost のみ） |
| R-7 | フッター・README・CLAUDE.md の送信に関する文言を判断 4 のとおり分ける |

## 4. Stage 2（C-6：OAuth で自分のルート一覧）

### 4.1 往復の検証結果（2026-09-22、利用者の実機）

「Ride with GPS と連携（検証中）」ボタン（`rwgpsAuthStart`／`rwgpsAuthReturn`、トークン交換なし）で確認。

| 環境 | 結果 |
|---|---|
| iPhone Safari | 戻れる。認可コード 43 文字、state 一致、開始・戻り先ともブラウザ |
| iPhone ホーム画面（PWA） | 戻れる。state 一致、開始・戻り先とも PWA |
| Android Chrome | 戻れる。state 一致 |

結論：当初の設計（redirect_uri＝`https://route-weather.jp/`、`state` を端末内に保持して照合）のままで進める。

### 4.2 仕様（2026-09-22 に利用者が承認、v1.5.0 で実装）

| ID | 要件 |
|---|---|
| R-8 | 中継に `POST /oauth/exchange`（body：`{ code }`）を足す。中継は `client_id`・`client_secret`（秘密）・`redirect_uri` を添えて `POST /oauth/token.json` へ送り、返った `access_token`・`user_id` を端末へ返すだけで保存しない。Origin 制限は R-3 と同じ |
| R-9 | 端末は受け取ったトークンを `rw:rwgps`（localStorage）に保持する。保持するのは `access_token`・`user_id`・取得日時のみ。外部に出すのは Ride with GPS への API 呼び出しだけ |
| R-10 | 連携後は「連携」ボタンを「自分のルートを選ぶ」と「連携を解除」に置き換える。解除はトークンを消すだけ（RwGPS 側の取り消しは利用者が RwGPS の設定で行う旨を添える）。「コース削除」でもトークンを消す |
| R-11 | 一覧は端末から直接 `GET /api/v1/routes.json?page=1&page_size=50`（`Authorization: Bearer`）を呼ぶ。名前・距離・獲得標高・更新日を新しい順に表示し、名前での絞り込みと「さらに読み込む」を付ける。中継は通さない（トークンは端末にあるため） |
| R-12 | 選んだルートは端末から直接 `GET /api/v1/routes/{id}.json`（Bearer）を取り、R-4 の変換へ。非公開ルートも本人のものは読める |
| R-13 | 401 が返ったらトークンを捨てて「連携が切れました。もう一度連携してください」と案内（有効期限が文書化されていないため） |
| R-14 | 中継経由の URL 貼り付け（Stage 1）は連携の有無に関わらず残す |
| R-15 | フッターと README に「連携時のトークンは端末内にのみ保持し、Ride with GPS 以外には送らない」を追記。v1.5.0 として公開し、「（試験運用中）」は Stage 1 と同じ扱い |

## 5. 変更履歴

- v1.4.0（2026-09-21）：配置時の知見。公式 API は公開ルートの取得にも api_key に加えて利用者の認証が要る。個人アカウントの認証トークン発行（`POST /api/v1/auth_tokens.json`、メール＋パスワード）は運用者アカウントで「Failed to authenticate the user」となり通らなかったため、OAuth（authorize → `POST /oauth/token.json`）で運用者のアクセストークンを 1 回発行し、中継の秘密 `RWGPS_ACCESS_TOKEN` に登録する方式にした（`worker/setup-oauth.sh`）。トークンの有効期限は文書化されておらず、失効したら同じ手順で発行し直す
- v1.4.0（2026-09-21）：Stage 1 を実装。`js/core.js` に `rwgps.parseUrl`／`rwgps.toCourse`、`worker/`（`src/index.mjs`、`wrangler.toml`、README）、`test/rwgps.test.mjs`・`test/relay.test.mjs` を追加
- v1.5.0（2026-09-22）：Stage 2 を実装。中継に `POST /oauth/exchange`、画面に「Ride with GPS と連携」「自分のルートを選ぶ」「連携を解除」とルート一覧（50 件ずつ、名前で絞り込み、更新日の新しい順、非公開は表示）。トークンは `rw:rwgps` に保持し 401 で破棄。確認用の `?rwgpsapi=http://localhost:…` を追加。テスト 2 件追加
