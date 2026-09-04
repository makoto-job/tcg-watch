# TCGウォッチ（PWA）

`public/feed.json` を読んで、トレカの最新情報とランキングを表示するモバイルアプリです。

- **ビルド不要 / npm依存ゼロ / 外部CDNゼロ**。素の HTML + CSS + Vanilla JS (ESM) だけで動きます。
- iPhone (Safari) / Android (Chrome) の両方で、**ホーム画面に追加**するとアプリのように全画面で使えます。
- Service Worker でオフラインキャッシュ（アプリシェルは cache-first、feed.json は stale-while-revalidate）。

## ファイル構成

```
app/
├── index.html              画面の骨格
├── style.css               ライト/ダーク・セーフエリア・2カラム対応
├── app.js                  取得・描画・フィルタ・共有・Pull-to-refresh
├── config.js               ★公開時に FEED_URL を書き換える場所
├── sw.js                   Service Worker
├── manifest.webmanifest    PWAマニフェスト
├── icons/
│   ├── icon.svg            マスターアイコン（自作SVG）
│   ├── icon-192.png        SVGから生成（macOS の qlmanage + sips）
│   ├── icon-512.png
│   └── apple-touch-icon.png (180x180)
└── README.md
```

---

## 1. ローカルで見る

`file://` で直接開くと、**Service Worker が登録できず、ESM の import と fetch も CORS で失敗します**。
必ずローカルサーバー経由で開いてください。

リポジトリのルート（`tcg_twitter_bot/`）で:

```bash
python3 -m http.server 8000
```

ブラウザで **http://localhost:8000/app/** を開きます。

- `app/feed.json` はまだ存在しないので 404 になり、自動的に開発用サンプル
  `../public/feed.sample.json`（15件）にフォールバックします。
  DevTools のコンソールに 404 が1件出ますが**これは想定どおり**です。
- サンプル表示中はヘッダーの最終更新に「（サンプル）」が付きます。

停止は `Ctrl-C`。

### 実データで試したいとき

区画D（`src/index.js`）が生成した `public/feed.json` を `app/` にコピーすると、
本番と同じ経路（`./feed.json`）で読み込めます。

```bash
cp public/feed.json app/feed.json
```

`app/feed.json` はあくまでローカル確認用です（コミット不要）。

---

## 2. 公開する（GitHub Pages / Cloudflare Pages）

### 手順

1. **`app/config.js` の1行目を書き換える。**

   ```js
   // 変更前（ローカル開発用）
   export const FEED_URL = './feed.json';

   // 変更後（例: GitHub Pages に public/ を置いた場合）
   export const FEED_URL = 'https://<ユーザー名>.github.io/<リポジトリ名>/feed.json';
   ```

   - `app/` と `feed.json` を**同じドメイン**に置くなら相対パスのままでOKです。
     例えば `app/` と `feed.json` を同じディレクトリに並べるなら `'./feed.json'` のままで動きます。
   - **別ドメイン**に置く場合は、feed.json 側に `Access-Control-Allow-Origin: *` が必要です。
     （GitHub Pages / Cloudflare Pages はデフォルトで付きます）

2. `app/` 以下をまるごと静的ホスティングにアップロードする。
   `public/feed.json` は区画Dのワークフローが定期的に更新します。

3. **HTTPS で配信する。** Service Worker は `https://` か `localhost` でしか動きません。

4. アプリを更新したら `app/sw.js` の `VERSION` を上げる（`v1` → `v2`）。
   古いキャッシュが `activate` 時に自動削除され、利用者に新しい版が届きます。

### GitHub Pages の最小構成例

リポジトリの Settings → Pages で `main` ブランチの `/ (root)` を公開すると:

- アプリ: `https://<ユーザー名>.github.io/<リポジトリ名>/app/`
- フィード: `https://<ユーザー名>.github.io/<リポジトリ名>/public/feed.json`

この場合 `FEED_URL` は `'../public/feed.json'` でも動きます。

---

## 3. ホーム画面に追加する

### iPhone / iPad（Safari）

1. Safari で公開URLを開く（**Chrome や他ブラウザではホーム画面追加できません**）
2. 画面下の**共有ボタン（□に↑）**をタップ
3. メニューを下にスクロールして「**ホーム画面に追加**」
4. 名前（TCGウォッチ）を確認して「追加」

初回アクセス時、アプリ内にもこの案内バナーが自動で出ます（×で閉じると二度と出ません）。

### Android（Chrome）

1. Chrome で公開URLを開く
2. 条件を満たすと、アプリ内に「**インストール**」ボタンが出るのでタップ
3. 出ない場合は右上の「⋮」→「**アプリをインストール**」または「ホーム画面に追加」

---

## 4. 主な機能

| 機能 | 説明 |
| --- | --- |
| ランキング | `ranking.top` の TOP3。1位は大きく表示。`ranking.tweetUrl` があればXの投稿へのリンクボタン |
| 最新情報 | `items` を publishedAt 降順で10件ずつ表示（「もっと見る」で +10件） |
| IPフィルタ | チップを複数選択（OR条件）。選択状態は `localStorage` に保存され、次回も復元 |
| 抽選・予約のみ | `intentTags` に 抽選 / 予約 / 受付 / 再販 を含むものだけ表示 |
| 相対時刻 | 「たった今」「3分前」「2時間前」「昨日」「一昨日」「8/21」 |
| 共有 | `navigator.share` があれば共有シート、無ければクリップボードにコピー＋トースト |
| Pull-to-refresh | 最上部で80px以上下に引くと更新。ヘッダーの更新ボタンでも同じ |
| 自動更新 | 10分ごと＋アプリに戻ったとき（前回取得から10分以上経過している場合） |
| オフライン | 取得失敗時は `localStorage` のキャッシュを表示。それも無ければ再試行ボタン付きのエラー画面 |

### フォールバックの順番

```
FEED_URL → FALLBACK_FEED_URL（開発用サンプル）→ localStorage キャッシュ → エラー画面
```

### セキュリティ

feed.json の値は **一切 `innerHTML` に入れていません**（すべて `textContent` / `createElement`）。
リンクURLも `https?://` 以外は `href` に設定しません（`javascript:` 対策）。

---

## 5. アイコンについて

マスターは自作の `icons/icon.svg`（トレカ3枚を扇状に広げたモチーフ）です。

PNG は macOS 標準の `qlmanage`（SVG→PNG のサムネイル生成）と `sips`（リサイズ）で書き出しています。
アイコンを作り直したいときは:

```bash
cd app/icons
qlmanage -t -s 512 -o . icon.svg      # icon.svg.png ができる
mv icon.svg.png icon-512.png
sips -Z 192 icon-512.png --out icon-192.png
sips -Z 180 icon-512.png --out apple-touch-icon.png
```

`qlmanage` の出力は角が丸く透過するため、`maskable` 用途では背景を不透明で塗り潰しておくと安全です
（現在のPNGは塗り潰し済み）。macOS以外の環境では `rsvg-convert` や `inkscape` を使ってください。

manifest には SVG と PNG の両方を登録してあります。iOS の `apple-touch-icon` は SVG が無視される
ことがあるため、PNG（180x180）を指定しています。

---

## 6. トラブルシューティング

| 症状 | 原因と対処 |
| --- | --- |
| 何も表示されない / import エラー | `file://` で開いている。`python3 -m http.server` 経由で開く |
| Service Worker が登録できない | `http://` の非localhost、または自動テスト用ブラウザ。HTTPS か localhost で確認する |
| 更新しても内容が古い | `sw.js` の `VERSION` を上げてデプロイ。または DevTools → Application → Service Workers → Unregister |
| コンソールに `feed.json 404` | ローカル開発では想定どおり（サンプルにフォールバックする） |
| ダークモードにならない | 端末のシステム設定に追従します（アプリ内切り替えは未実装） |

---

## 7. 将来ストアに出したくなったら

PWA のままでも iPhone / Android 両方にホーム画面から入れられますが、
App Store / Google Play に並べたい場合の選択肢:

- **PWABuilder**（https://www.pwabuilder.com/） — 公開URLを入れるだけで Android の TWA (Trusted Web Activity) パッケージと iOS 用ラッパーを生成してくれる。このアプリはそのまま投入できる構成です。
- **Capacitor**（https://capacitorjs.com/） — `app/` を `webDir` に指定して Xcode / Android Studio プロジェクトを生成。プッシュ通知やネイティブ機能を足したくなったらこちら。

どちらも Apple Developer Program（年 $99）への登録と審査が必要になります。
「まず使ってもらう」段階では PWA のままで十分です。
