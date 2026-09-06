# ルート天気（route-weather）

ブルベ（長距離自転車）向け、コース上の通過時刻ごとの天候予報を表示するブラウザアプリ。
要件は `docs/RDD_06.md` が正。判断に迷ったら本書より RDD_06 を優先し、RDD_06 に書いていないことは実装側の裁量。

## 今やっていること

フェーズ1 は 2026-09-05 に完了・公開済み（https://route-weather.jp/）。
フェーズ2（`docs/RDD_06.md` §8）を実装中。実装済み：区間別速度（P-4）、走行中の再計算（P-5）、コース反転（C-7）、最近のコース（C-8）、
注意報・警報の区間紐付け（V-7）、体感温度・湿度・日照（V-8）、画像共有（V-9）、ダークモード（V-10）、アメダス実況、PWA、OSM タイルの静的地図。
V-6 本地図は Leaflet で実装済み（2026-09-05 に利用者が許可）。Android 実機確認済み。キューシート変換ツール連携（C-9）はツール未作成のため対象外。

## 守ること

- 静的サイト。ビルド手順・サーバ側処理を作らない。構成は `index.html`（HTML/CSS）＋ `js/core.js`（純粋関数、ES Module）＋ `js/app.js`（画面・取得層）＋ PWA 用の `sw.js`・`manifest.webmanifest`・`icons/`。`vendor/` を更新したら `sw.js` の VERSION を上げる
- コースファイルは端末内で処理する。外部に送らない
- 予報は気象庁モデルのみ。Open-Meteo `/v1/jma` で、4 日先まで `jma_msm`、5〜11 日先は `jma_gsm`。気象庁以外のモデル（`/v1/forecast` 等）は使わない。11 日より先は「予報範囲外」。4 日より先は「傾向モード」として粒度を落として表示する（RDD_06 F-8／F-9／V-11）
- 気象庁ホームページ（`www.jma.go.jp/bosai/`）への直接アクセスは注意報・警報（`warning/data/r8/`、2026 年改正後の形式。旧 `warning/data/warning/` は更新停止）・アメダス・区域表に限る。市区町村の判定は国土地理院の逆ジオコーダを使い、結果は端末内に保持して同じ地点を再送しない
- 地図は OpenStreetMap 標準タイル（モノクロ表示）。利用ポリシーに従い、表示範囲外の一括取得はしない。出典表示を常時見せる
- 第一対象は iPhone Safari。ドラッグ＆ドロップ前提の UI にしない。`<input type="file">` で「ファイル」アプリから読む
- 外部ライブラリは Garmin FIT SDK（`vendor/fitsdk/`）と Leaflet（`vendor/leaflet/`、本地図用）のみ。それ以外を足したいときは理由を書いて確認を取る。Leaflet が読めない場合は静的な略地図にフォールバックする
- 色は意味を持つものだけ（向かい風＝赤系、横風＝黄系、追い風＝緑系、降水＝青系、夜間＝暗帯、仮眠＝紫帯）
- POI（GPX の `<wpt>`）は無視する。エラーにもしない
- 出典表示（気象庁 数値予報 — Open-Meteo 経由）を常時表示する
- UI の文言は日本語。コード内コメントも日本語で可

## 参考

- `mock/brevet_weather_mock.html`：表示イメージ。予報値はダミーだが GPX 解析・距離/方位計算・描画の原型として流用してよい
- `samples/*.gpx`：動作確認用コース

## 検証

- `plan`／`wind`／`sun`／`forecast`／`course` は純粋関数にし、`js/core.js` にまとめる（DOM・fetch を使わない）。`test/_load.mjs` が直接 import する
- テストは `node --test "test/*.test.mjs"`（GitHub Actions でも公開前に実行される）
- 描画は iPhone 実機（幅 375–430 px）で確認してから公開する
- 公開は `main` への push → GitHub Pages
