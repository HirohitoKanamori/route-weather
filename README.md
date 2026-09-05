# ルート天気（route-weather）

ブルベ（長距離自転車）向け。コース（GPX / FIT）と出走時刻・グロス速度・仮眠から、コース上の通過時刻ごとの風（相対風）・降水・気温を表示するブラウザアプリ。

- 予報は気象庁の数値予報（MSM：4 日先まで、GSM：11 日先まで）を Open-Meteo 経由で取得
- ビルド不要の `index.html` 1 本。GitHub Pages で公開
- コースファイルは端末内で処理し、外部に送信しない
- 第一対象は iPhone Safari（「ファイル」アプリ経由で GPX を読み込む）

要件は [docs/RDD_06.md](docs/RDD_06.md)、実装方針は [CLAUDE.md](CLAUDE.md)。

## 使い方

1. Ride with GPS アプリでルートを開き「⋯」→ Export GPX →「"ファイル"に保存」
2. 本アプリを開き「コースを読み込む」で保存した GPX を選ぶ
3. 出走日時・グロス速度・仮眠（距離 km と分）を入力する
4. 通過時刻ごとの風・雨・気温がリボン・区間表・略地図に表示される

出走が 4 日より先の場合は「傾向モード」（GSM、50 km 区間 × 通過日で集約）、11 日より先は予報範囲外。

## 開発

- 純粋関数（course / plan / wind / sun / forecast）は `index.html` 内の `/*==CORE-BEGIN==*/` 〜 `/*==CORE-END==*/` にまとめ、`test/_load.mjs` が切り出して Node で評価する
- テスト：`node --test "test/*.test.mjs"`
- ローカル確認：リポジトリ直下で `python3 -m http.server 8000` → `http://localhost:8000/`（`file://` ではサンプル読み込みと FIT SDK の import が動かない）
- 公開：`main` へ push すると `.github/workflows/pages.yml` がテストを実行してから GitHub Pages に配置する（リポジトリ設定の Pages → Source を「GitHub Actions」にしておく）

## 構成

```
index.html                  本体（HTML / CSS / JS）
vendor/fitsdk/              Garmin FIT SDK（@garmin/fitsdk の src をそのまま同梱、遅延 import）
samples/*.gpx               動作確認用コース
mock/                       表示イメージのモック
docs/RDD_06.md              要件定義書
test/                       Node テスト
.github/workflows/pages.yml GitHub Pages デプロイ
```

## 出典

気象庁 数値予報（MSM／GSM）— [Open-Meteo](https://open-meteo.com/)（CC BY 4.0）経由。予報は参考情報です。
