# TCGニュース自動投稿bot

ポケカ・ワンピカードなど人気TCGの**最新ニュースと抽選/予約情報**を毎日自動で集め、独自スコアでランキング化して**X（旧Twitter）に自動投稿**するbotです。同じデータを `feed.json` として書き出すので、付属のスマホアプリ（PWA）からいつでも最新情報を読めます。**npmパッケージを1つも使いません**（Node.js標準機能のみ）。`npm install` は不要です。

## 対象IP

| キー | 対象 |
| --- | --- |
| `pokemon` | ポケモンカードゲーム |
| `onepiece` | ONE PIECEカードゲーム |
| `dragonball` | ドラゴンボールSCG / フュージョンワールド |
| `gundam` | ガンダムカードゲーム(GCG) |
| `hololive` | ホロライブ関連TCG/グッズ |
| `yugioh` | 遊戯王OCG / ラッシュデュエル |
| `duelmasters` | デュエル・マスターズ |
| `mtg` | マジック：ザ・ギャザリング |
| `newtcg` | 新作・今後発売予定のカードゲーム全般 |
| `lottery` | 抽選予約 / 受注 / 再販情報（IP横断） |

---

## クイックスタート

### 0. 前提

- Node.js **20以上**（`node -v` で確認。18以下では動きません）
- X（Twitter）の開発者アカウント → [docs/X_API_SETUP.md](docs/X_API_SETUP.md)

### 1. 取得する

```bash
git clone https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
cd <リポジトリ名>
node -v   # v20.x 以上であることを確認
```

### 2. `.env` を作る

```bash
cp .env.example .env
```

作成した `.env` をエディタで開き、X開発者ポータルで取得した4つの値を貼り付けます。

```bash
X_API_KEY=ここにAPI Key
X_API_SECRET=ここにAPI Key Secret
X_ACCESS_TOKEN=ここにAccess Token
X_ACCESS_TOKEN_SECRET=ここにAccess Token Secret

TZ=Asia/Tokyo
TOP_N=3
POST_STYLE=thread
```

> `.env` は `.gitignore` に入っているので、GitHubには push されません。

### 3. まずはドライラン（投稿されません）

```bash
node src/index.js --dry-run
```

投稿予定のツイート本文が枠線付きで表示されます。各ツイートの右上に `(178/280)` のように**Xの重み付き文字数**が出るので、280を超えていないか確認できます。

詳しいログを見たいときは。

```bash
node src/index.js --dry-run --verbose
```

### 4. X APIの疎通確認

```bash
node src/index.js --auth-check
```

`認証OK: @あなたのアカウント名 として投稿できます。` と出れば準備完了です。失敗する場合は下の[トラブルシューティング](#トラブルシューティング)へ。

### 5. 本番投稿

```bash
node src/index.js --post
```

投稿したツイートのURLが表示され、投稿済み記事が `data/posted.json` に記録されます（次回以降は同じ記事を再投稿しません）。

`package.json` の npm scripts でも同じことができます。

```bash
npm run preview      # = node src/index.js --dry-run --verbose
npm run auth-check   # = node src/index.js --auth-check
npm run post         # = node src/index.js --post
```

---

## ディレクトリ構成

| パス | 役割 |
| --- | --- |
| `src/index.js` | CLIエントリポイント。収集→ランキング→投稿→フィード出力の司令塔 |
| `src/collect.js` `src/rss.js` `src/resolve.js` | RSS収集・URL解決 |
| `src/score.js` `src/cluster.js` | スコアリングと重複記事のクラスタリング |
| `src/format.js` | ツイート本文の組み立て（文字数計算含む） |
| `src/x.js` | X API v2 への投稿（OAuth 1.0a 署名を自前実装） |
| `src/config.js` | `.env` と `config/*.json` の読み込み |
| `src/store.js` | 投稿済み記事の記録（`data/posted.json`・30日で自動削除） |
| `src/feed.js` | `public/feed.json` の生成 |
| `config/sources.json` | **情報源の定義**（RSSのURL・IPキーワード・ハッシュタグ） |
| `config/scoring.json` | **順位付けの重み** |
| `data/posted.json` | 投稿済み記事の記録（自動生成・Git管理外） |
| `public/feed.json` | アプリが読むフィードAPI（自動生成） |
| `app/` | スマホアプリ本体（PWA） |
| `test/` | `node --test` で動くユニットテスト |
| `docs/` | セットアップ・公開手順のドキュメント |

---

## CLIオプション

| オプション | 既定 | 説明 |
| --- | --- | --- |
| `--dry-run` | ● | 投稿せず、投稿予定の内容をコンソールに表示する |
| `--post` | | 実際にXへ投稿する（`--dry-run` と併用不可） |
| `--no-post` | | 投稿しない。`feed.json` だけ更新したいとき |
| `--verbose` | | 収集件数・除外件数などの詳細ログを出す |
| `--auth-check` | | X APIの疎通確認だけして終了する |
| `--top=N` | `3` | ランキングに載せる件数（`.env` の `TOP_N` を上書き） |
| `--style=thread` | ● | スレッド形式で投稿する |
| `--style=single` | | 1ツイートに収めて投稿する |
| `--no-feed` | | `public/feed.json` を書き出さない |
| `--max-age=H` | `48` | 何時間以内の記事を収集対象にするか |
| `--help`, `-h` | | ヘルプを表示 |

例。

```bash
node src/index.js --dry-run --top=5 --max-age=24
node src/index.js --post --style=single
```

---

## 設定のカスタマイズ

### 情報源を追加する（`config/sources.json`）

RSSフィードのURLを追加すれば収集対象が増えます。`weight` は情報源の信頼度で **0.5〜1.5** の範囲です（大きいほど上位に来やすい）。

```jsonc
{
  "feeds": [
    {
      "id": "4gamer",              // 一意なID。"official-" で始めると公式扱い、"x-" で始めるとX由来扱い
      "name": "4Gamer",            // 表示名。名前に「公式」を含めても公式扱いになる
      "url": "https://www.4gamer.net/rss/index.xml",
      "weight": 1.0
    }
  ],
  "ips": {
    "pokemon": {
      "keywords": ["ポケモンカード", "ポケカ"],   // タイトル/本文がこれにマッチするとこのIPに分類
      "hashtag": "#ポケカ"                       // 投稿に付けるハッシュタグ
    }
  }
}
```

- IPキーの一覧は上の[対象IP](#対象ip)の表のとおりで、**キー名は変更しないでください**（アプリのフィルタUIと対応しています）。
- 新しい情報源を足したら `node src/index.js --dry-run --verbose` で、そのフィードが正しく取得できているか確認してください。取得に失敗したフィードは警告を出してスキップされます。

### 順位の重みを調整する（`config/scoring.json`）

スコアは「新しさ・意図（抽選/予約など）・IP人気度・情報源の信頼度・複数メディアが報じたか」の合計で決まります。それぞれの重みを変えると順位の傾向が変わります。

- 抽選/予約情報を最優先にしたい → 意図（intent）の重みを上げる
- 速報性を重視したい → 新しさ（recency）の重みを上げる
- 大手メディアを優先したい → 情報源（source）の重みを上げる

変更後は必ず `--dry-run` で結果を確認してから `--post` してください。

---

## GitHub Actions で自動運用する

毎日 **JST 12:00** に自動投稿し、**2時間ごと**に `feed.json` だけ更新するワークフローが入っています（`.github/workflows/daily.yml`）。

### 手順1: Secrets を登録する

1. GitHubでリポジトリのページを開く
2. 上部タブの **Settings** をクリック
3. 左サイドバーの **Secrets and variables** → **Actions** をクリック
4. 緑色の **New repository secret** ボタンをクリック
5. **Name** に `X_API_KEY`、**Secret** に値を貼り付けて **Add secret**
6. 同じ手順で残り3つも登録する

登録するSecretsは以下の4つです。

| Name | 中身 |
| --- | --- |
| `X_API_KEY` | X開発者ポータルの API Key |
| `X_API_SECRET` | API Key Secret |
| `X_ACCESS_TOKEN` | Access Token |
| `X_ACCESS_TOKEN_SECRET` | Access Token Secret |

### 手順2: Actions に書き込み権限を与える

1. **Settings** → 左サイドバー **Actions** → **General**
2. ページ下部の **Workflow permissions** で **Read and write permissions** を選択
3. **Save** をクリック

これで bot が `data/posted.json` と `public/feed.json` の更新を同じリポジトリにコミットできるようになります。

### 手順3: 手動で1回試す

1. 上部タブの **Actions** をクリック
2. 左サイドバーの **TCG bot daily** を選択
3. 右上の **Run workflow** をクリック
4. **実行内容を選択** で `feed` を選ぶ（投稿されません）→ **Run workflow**
5. 緑のチェックが付けば成功。問題なければ次は `post` を選んで実際の投稿を試す

> スケジュール実行はGitHub側の混雑状況により**数分〜十数分ずれる**ことがあります。仕様です。

---

## スマホアプリ（PWA）

`app/` にPWA（iPhone / Android 両対応・ストア審査不要）が入っています。GitHub Pages に公開してホーム画面に追加すれば、通常のアプリと同じように使えます。

**公開手順 → [docs/DEPLOY.md](docs/DEPLOY.md)**

公開後のURLの例。

- アプリ: `https://<ユーザー名>.github.io/<リポジトリ名>/`
- フィード: `https://<ユーザー名>.github.io/<リポジトリ名>/feed.json`

公開URLが決まったら、`app/config.js` の `FEED_URL` をそのURLに書き換えてください（詳細は [docs/DEPLOY.md](docs/DEPLOY.md)）。

---

## X API 無料枠の制限（重要）

無料プラン（Free）でできること・できないことを把握しておいてください。

| | 無料プラン (Free) |
| --- | --- |
| 投稿 | **月500件まで**（1日あたり約16件） |
| 読み取り（他人のツイート検索・リスト取得） | **不可**（Basic 月$200〜が必要） |
| 料金 | 無料 |

- このbotの既定運用（1日1回・スレッド最大4本）なら **月120件程度**なので無料枠に十分収まります。
- `--top` を増やすとスレッドが伸びて投稿数が増えます。`--top=10` を毎日実行すると月330件になるのでご注意ください。
- CONTRACT.md の「X読み取り（`src/sources/xlists.js`）」機能は**無料枠では使えません**。既定で無効になっており、`X_READ_ENABLED=true` と `X_BEARER_TOKEN` を `.env` に足したときだけ有効になります。
- APIキーの取得手順は **[docs/X_API_SETUP.md](docs/X_API_SETUP.md)** を参照してください。

### `.env` で使えるオプション設定

| 変数名 | 既定 | 説明 |
| --- | --- | --- |
| `TZ` | `Asia/Tokyo` | 日付表示のタイムゾーン |
| `TOP_N` | `3` | ランキング件数 |
| `POST_STYLE` | `thread` | `thread` または `single` |
| `X_READ_ENABLED` | `false` | X読み取り機能の有効化（有料プランが必要） |
| `X_BEARER_TOKEN` | (空) | X読み取り用のBearer Token |
| `FEED_URL` | (空) | 公開したフィードのURL（メモ用） |

---

## テスト

```bash
node --test test/
```

ネットワーク接続は不要です。特定のファイルだけ実行することもできます。

```bash
node --test test/store.test.js test/feed.test.js
```

---

## トラブルシューティング

### `401 Unauthorized` が出る

APIキーが間違っているか、時刻ずれです。

1. `.env` の4つの値に**余分な空白・改行・引用符**が混ざっていないか確認する
2. X開発者ポータルでキーを**再生成**して貼り直す
3. PCの時計が大きくずれていないか確認する（OAuth 1.0a は署名に時刻を使うため、数分のずれで失敗します）

### `403 Forbidden` が出る

アプリの権限が「読み取り専用」のままです。

1. [X開発者ポータル](https://developer.x.com/en/portal/dashboard) → 対象アプリ → **Settings** → **User authentication settings** → **Edit**
2. **App permissions** を **Read and write** に変更して保存
3. **重要**: そのあと **Keys and tokens** タブで **Access Token and Secret を再生成**する（権限変更前に発行したトークンは読み取り専用のままです）
4. 新しいトークンを `.env`（およびGitHubのSecrets）に貼り直す
5. `node src/index.js --auth-check` で確認

### 「本日は該当ニュースなし」と出る

異常ではありません。以下を順に確認してください。

1. `node src/index.js --dry-run --verbose` を実行し、`[収集] N件` の数を見る
   - **0件** → 情報源のRSSが落ちている、またはネットワークの問題。警告ログに失敗したフィードURLが出ます
   - **収集はできているが除外が多い** → 既に投稿済みです。`--max-age=72` のように収集範囲を広げてみてください
2. それでも0件なら `config/sources.json` の `ips` のキーワードが実際の記事タイトルとマッチしていない可能性があります。キーワードを増やしてください
3. 記事は集まっているのに投稿されない場合、`data/posted.json` に記録が残っています。テスト中にリセットしたいときは削除してください（`rm data/posted.json`）

### `feed.json` が更新されない

- **ローカルで更新されない** → `--no-feed` を付けていませんか。`public/` ディレクトリの書き込み権限も確認してください
- **GitHub Actionsで更新されない** → 上記「手順2: Actions に書き込み権限を与える」を実施済みか確認してください。未設定だと push が `403` で失敗します
- **公開URLが古いまま** → GitHub Pages のデプロイが走っていません。**Actions** タブで **Deploy Pages** ワークフローの実行結果を確認してください。ブラウザ側のキャッシュが原因のこともあるので、アプリの更新ボタンかスーパーリロード（Cmd+Shift+R）を試してください
- `data/posted.json` は `.gitignore` に入っているため、ワークフローでは `git add -f` で強制追加しています。手元で `git add` しても無視されるのは仕様です

### 設定ファイルが無いというエラーが出る

```
設定ファイルが見つかりません: config/sources.json
```

`config/` が空の状態です。`config/sources.json` と `config/scoring.json` の両方が必要です。

---

## ライセンス / 注意

- 収集対象のRSSは各配信元の利用規約に従ってください。
- 記事の全文転載はしません（タイトル・要約・元記事へのリンクのみ）。
- Xの自動投稿は [X の自動化ルール](https://help.x.com/en/rules-and-policies/x-automation) に従って運用してください。

---

## 抽選に「間に合う」ための仕組み

ニュース記事を追うだけでは、メディアが記事にする頃には抽選が始まっていて遅い。
そこで3段構えにしている。

### 1. 公式サイトを直接見る（最速）

メディアより数時間〜数日早い一次情報を取りに行く。設定は `config/official-sites.json`。

| サイト | 備考 |
|---|---|
| ポケモンカード公式 / ワンピカード公式 / 遊戯王公式 / デュエマ公式 | ニュース一覧をスクレイプ |
| ガンダムGCG / ドラゴンボール フュージョンワールド | 言語コードは `ja` ではなく `jp` |
| ホロライブ | RSSあり |
| MTG日本公式 | 連載コラムを `titleExclude` で除外し、製品ニュースだけ拾う |
| プレミアムバンダイ（抽選販売 / 新着 / 締切間近） | Shift_JIS。商品名は一覧上で20字に切られる |
| ポケモンセンターオンライン | bot対策のため `enabled: false`。回避はしない |

### 2. 応募ページの直リンクと締切を抜き出す

抽選・予約系の記事だけ本文を取得し、応募先URLと締切を割り出す（`src/enrich.js`）。

- 対応店舗は `config/shops.json` に約70件（メーカー直販・カードショップ・おもちゃ屋・家電量販・総合EC・書店・中古・スーパー・コンビニ・アニメ系）
- アフィリエイトリンク（もしも / バリューコマース / 楽天 / Amazonタグ）は実URLに戻す
- 転売・フリマ・オークションは除外
- 締切は「受付期間：8月28日(木)12:00〜9月3日23:59」のような日本語表記を解析。**確信が持てなければ表示しない**（誤った締切は、締切を出さないより有害なため）
- 同じ抽選を複数媒体が報じた場合、**どこか1社でも応募リンクを持っていれば代表記事に引き継ぐ**（Yahoo!ニュースは外部購入リンクを削除するため、これが無いと導線が切れる）

### 3. 「読む」ではなく「応募する」導線にする

- ツイートは記事URLではなく**応募URL**を貼る（`⏰ 8/31 23:59まで` `🛒 Amazon` の2行つき）
- レポートとアプリは最上部に「**いま応募できるもの**」を締切が近い順で表示
- タイトル・タグ・カードのどこを押しても応募ページへ。飛び先の店名は押す前に表示
- 「記事を読む」は副リンクとして残す

### チェック頻度

抽選は告知から締切までが短いことがあるため、更新間隔がそのまま「気づくまでの遅れ」になる。

| 時間帯 | 間隔 |
|---|---|
| JST 08:00〜24:00 | 30分ごと |
| JST 00:00〜08:00 | 1時間ごと |
| Xへの投稿 | 1日1回 JST 12:00 |

## 追加のCLIオプション

| オプション | 説明 |
|---|---|
| `--html[=PATH]` | 実行結果をHTMLレポートで出力（既定 `public/report.html`） |
| `--no-enrich` | 応募ページ・締切の抽出をスキップ（高速確認用） |
| `--tweet-max-age=H` | ツイートのTOP選出に使う新しさ（既定48時間。収集自体は168時間） |

```bash
npm run report
```

## ツイートに載らないもの

フィード（アプリ）には出るが、TOP3には選ばれない条件:

- **対象IPに1つも当てはまらないもの** — `lottery` タグしか付かない記事。デジモンカード・バトルスピリッツ等はここで外れる
- **タイトルが途中で切れているもの** — プレミアムバンダイの一覧は商品名を20字で打ち切るため
- **同一サイトの重複** — 同じ配信元の記事で1位と3位が埋まらないようにしている
- **48時間より古いもの** — 収集は7日分だが、ツイートは新しいものだけ
