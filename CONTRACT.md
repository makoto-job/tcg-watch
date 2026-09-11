# モジュール間インターフェース契約（全エージェント厳守）

Node.js ESM / **npm依存パッケージ禁止**（Node標準の fetch, crypto, fs/promises のみ）。
Node >= 20。全ファイル `export` は名前付きexport。

## 対象IPキー（固定・変更禁止）
`pokemon` `onepiece` `dragonball` `gundam` `hololive` `yugioh` `duelmasters` `mtg` `newtcg` `digimon` `battlespirits` `aikatsu` `carddass` `vanguard` `weiss` `unionarena` `lottery`

- pokemon = ポケモンカードゲーム
- onepiece = ONE PIECEカードゲーム
- dragonball = ドラゴンボールSCG / フュージョンワールド
- gundam = ガンダムカードゲーム(GCG)
- hololive = ホロライブ関連TCG/グッズ
- yugioh = 遊戯王OCG/ラッシュデュエル
- duelmasters = デュエル・マスターズ
- mtg = マジック：ザ・ギャザリング
- newtcg = 新作・今後発売予定のカードゲーム全般
- digimon = デジモンカードゲーム
- battlespirits = バトルスピリッツ
- aikatsu = アイカツ！シリーズ（データカードダス系）
- carddass = データカードダス／カードダス全般
- vanguard = カードファイト!! ヴァンガード
- weiss = ヴァイスシュヴァルツ
- unionarena = ユニオンアリーナ（UNION ARENA / バンダイのクロスIP TCG。ハンターハンター等が参戦）
- lottery = 抽選予約/受注/再販情報（IP横断）

※ digimon 以降の4つは第2フェーズで追加。プレミアムバンダイ等で実際に抽選・予約が
　 行われているのに、IPが付かず「何のカードか分からない」状態だったため。

## 共通データ型

```js
/**
 * @typedef {Object} RawItem
 * @property {string} id            // 安定ID: sha1(normalizedTitle + '|' + canonicalUrl).slice(0,16)
 * @property {string} title         // 記事タイトル（HTMLエンティティ復号済み・trim済み）
 * @property {string} url           // 最終的な記事URL（Googleリダイレクト解決済み・トラッキングパラメータ除去済み）
 * @property {string} sourceName    // 表示名 例:「4Gamer」「ポケモン公式」
 * @property {string} sourceId      // config/sources.json の id
 * @property {number} sourceWeight  // 0.5〜1.5
 * @property {string} summary       // 本文抜粋（タグ除去・最大200字）空文字可
 * @property {string} publishedAt   // ISO8601文字列
 * @property {string[]} ips         // マッチしたIPキー配列（1つ以上）
 * @property {string} feedUrl
 */

/**
 * @typedef {Object} RankedItem
 * @property {number} score
 * @property {{recency:number,intent:number,ip:number,source:number,cluster:number}} breakdown
 * @property {string[]} intentTags  // 例 ['抽選','予約']
 * @property {number} clusterSize   // 同一ネタを報じた件数（自身含む・最小1）
 * @property {string[]} dupUrls     // クラスタ内の他URL
 * // ↑ RawItem の全プロパティも持つ（RawItem & これ）
 */
```

## 各モジュールの責務とシグネチャ（この通りに実装すること）

### A: 収集 `src/rss.js` / `src/resolve.js` / `src/collect.js` / `config/sources.json`
```js
// src/rss.js
export async function fetchFeed(url, opts) // -> {title:string, items:Array<{title,link,guid,pubDate,description,sourceName}>}
export function parseFeed(xmlText)         // RSS2.0 / RDF(RSS1.0) / Atom 対応の純正規表現パーサ

// src/resolve.js
export async function resolveUrl(url)      // Googleニュースリダイレクト解決。失敗時は入力をそのまま返す
export function canonicalizeUrl(url)       // utm_* / gclid / fbclid / ?ref= 等を除去、末尾スラッシュ正規化

// src/collect.js
export async function collectAll(config, { now = new Date(), maxAgeHours = 48, concurrency = 6, verbose = false } = {})
// -> Promise<RawItem[]>  (取得失敗フィードはスキップし console.warn。全滅時のみ throw)
```

### B: ランキング `src/score.js` / `src/cluster.js` / `config/scoring.json`
```js
// src/cluster.js
export function normalizeTitle(title)               // 記号/空白/全半角ゆれを吸収した比較用文字列
export function clusterItems(items)                 // -> Array<RawItem[]> 類似タイトルでグルーピング

// src/score.js
export function rankItems(items, scoringConfig, now = new Date())
// -> RankedItem[]  score降順ソート済み。同一クラスタは代表1件に集約して返すこと
export function selectTop(rankedItems, n = 3, { maxPerIp = 2 } = {})
// -> RankedItem[]  同一IPばかりにならないよう分散させたTOP N
```

### C: 投稿 `src/x.js` / `src/format.js`
```js
// src/format.js
export function weightedLength(text)   // Xの重み付き文字数（CJK=2, URLは一律23）
export function buildThread(top, { date = new Date(), hashtags = [] } = {})
// -> Array<{text:string}>  1本目=ランキング見出し、2本目以降=各順位+リンク。各本280weight以内を保証
export function buildSingle(top, { date = new Date(), hashtags = [] } = {})
// -> string  1ツイート完結版（280weight以内）

// src/x.js
export async function verifyCredentials(creds)          // -> {ok:boolean, username?:string, error?:string}
export async function postThread(texts, creds, { dryRun = false } = {})
// -> {ids:string[], urls:string[]}  2本目以降は in_reply_to_tweet_id で連結。429/503は指数バックオフで3回リトライ
// creds = {apiKey, apiSecret, accessToken, accessTokenSecret}
```

### D: 運用 `src/index.js` / `src/store.js` / `src/config.js` / workflow / README
```js
// src/config.js
export async function loadConfig()   // config/*.json + .env を読み込みマージ（dotenv非依存の自前パーサ）

// src/store.js
export async function loadPosted()                 // -> {items: Record<string, string /*ISO*/>}
export function isPosted(store, item)              // item.id または canonical URL で判定
export function markPosted(store, items)
export async function savePosted(store)            // 30日より古いエントリは自動prune
```

`src/index.js` はCLI: `--dry-run`(既定) / `--post` / `--verbose` / `--auth-check` / `--top=N` / `--style=thread|single`

## ルール
- 他の区画のファイルを**書き換えない**。必要なら CONTRACT.md の型に従ってスタブ前提で実装する。
- 実装後、自分の担当ファイルだけで動く自己テストを `node --test` 形式で `test/` に置く（Node標準テストランナー）。
- 日本語コメントでOK。

---

# 追加スコープ：フィードAPI と モバイルアプリ

## E: フィード出力 `public/feed.json`（区画Dが生成）

アプリはこのJSONだけを読む。静的ホスティング（GitHub Pages / Cloudflare Pages）に置く前提。

```jsonc
{
  "version": 1,
  "generatedAt": "2026-08-23T09:00:00.000Z",
  "ranking": {
    "date": "2026-08-23",
    "tweetUrl": "https://x.com/USER/status/123",   // 未投稿なら null
    "top": [ { "rank": 1, /* ...FeedItem */ } ]
  },
  "items": [ /* FeedItem[] : publishedAt 降順（最新が先頭）・最大50件 */ ]
}
```

```js
/**
 * @typedef {Object} FeedItem
 * @property {string} id
 * @property {string} title
 * @property {string} url
 * @property {string} sourceName
 * @property {string} publishedAt   // ISO8601
 * @property {boolean} publishedAtKnown // 情報源が掲載日を持っていたか。
 *   false のとき publishedAt は「取得した時刻」であって掲載日ではない。
 *   日付を持たないカタログ型の一覧（プレミアムバンダイのカードダス一覧など）が該当する。
 *   **表示側はこれが false の項目を「◯分前」と呼んではならない。**
 *   無視すると、7月に終わった抽選が「新着9分前」として出る（2026-09-11 に実際に発生）。
 * @property {string} summary       // 最大200字
 * @property {string[]} ips
 * @property {string[]} intentTags  // ['抽選','予約'] など
 * @property {number} score
 * @property {string|null} thumbnail // OGP画像URL（取れなければ null）
 * @property {boolean} isRanked      // 本日のTOP Nに入ったか
 * @property {number|null} rank
 * @property {'news'|'official'|'x'} kind // 情報の出所種別
 */
```

## F: X読み取り（他ユーザーの有益情報）`src/sources/xlists.js` ※区画A担当

- **既定は無効**。環境変数 `X_READ_ENABLED=true` かつ `X_BEARER_TOKEN` がある時のみ動作。
- 無効時は空配列を返すだけ（エラーにしない）。
- 有効時は X API v2 `GET /2/lists/{id}/tweets` もしくは `GET /2/tweets/search/recent` を使用。
- 対象リスト/クエリは `config/x-sources.json` で定義。
- 返り値は他と同じ `RawItem[]`（`kind:'x'` 相当。sourceName は `@ユーザー名`）。
- **無料枠では読み取り不可**である旨をREADMEに明記すること（Basic $200/月〜）。

## G: モバイルアプリ `app/` ※区画E担当

- **PWA**（1コードベースで iPhone / Android 両対応・ストア審査不要・Apple Developer登録不要）
- 素のHTML/CSS/JS（ビルドツール不使用）。`app/index.html` `app/app.js` `app/style.css` `app/sw.js` `app/manifest.webmanifest`
- 機能:
  1. `feed.json` を取得し**最新順**でカード表示（既定10件、「もっと見る」で全50件）
  2. 上部に「本日のランキング TOP3」セクション
  3. IPフィルタ（ポケカ/ワンピ/DB/ガンダム/ホロライブ/遊戯王/デュエマ/MTG/新作/抽選）チップUI
  4. 「抽選・予約」だけ絞り込むトグル
  5. Pull-to-refresh 相当の更新ボタン + 最終更新時刻表示
  6. Service Worker でオフラインキャッシュ（stale-while-revalidate）
  7. ダークモード対応（`prefers-color-scheme`）、セーフエリア対応（`env(safe-area-inset-*)`）
  8. タップで元記事を外部ブラウザで開く
- `FEED_URL` は `app/config.js` の1行で差し替え可能にすること。
- iOSのホーム画面追加手順をアプリ内に案内表示（初回のみ）。

---

# 第2フェーズ：「最短で抽選ページに飛べる／間に合う」ための拡張

## 背景（全区画が理解すべき前提）

現状は「ニュース記事へのリンク」を出しているだけで、次の2つが未達：

1. **遅い** — メディアが記事にする頃には抽選が始まっている。公式サイトを直接見れば数時間〜数日早い。
2. **飛べない** — 記事から応募ページを自分で探す必要がある。Yahoo!ニュースは外部購入リンクを削除する仕様。

目的は **「最短で抽選ページに飛んで、締切に間に合って応募できること」**。
情報の網羅性より **速さと導線** を優先する。

## 共通データ型の拡張

`RawItem` / `FeedItem` に以下を追加する（既存フィールドは変更しない）。全て任意で、無ければ `null`。

```js
/**
 * @property {string|null} destUrl     応募・予約・購入ページの直リンク（アフィリエイト除去済み）
 * @property {string|null} destLabel   その店の表示名 例:「プレミアムバンダイ」「Amazon」
 * @property {string|null} startsAt    応募/予約の開始日時 ISO8601
 * @property {string|null} deadline    応募/予約の締切日時 ISO8601
 * @property {'official'|'shop'|'news'} tier  情報源の階層（official=公式サイト, shop=通販サイト, news=メディア）
 */
```

## 区画F: 公式サイト直接監視

**担当ファイル**: `src/sources/official.js` / `config/official-sites.json` / `test/official.test.js`

- 各公式サイトのニュース一覧をHTMLから直接取得する（RSSが無いため自前パース）。
- 疎通確認済み: ポケカ公式 `https://www.pokemon-card.com/`、プレミアムバンダイ `https://p-bandai.jp/`、ワンピカード公式 `https://www.onepiece-cardgame.com/`、遊戯王公式 `https://www.yugioh-card.com/japan/`、デュエマ公式 `https://dm.takaratomy.co.jp/`、MTG公式 `https://mtg-jp.com/`
- **ホロライブはRSSあり**: `https://hololivepro.com/news/feed/` → 区画Aの `fetchFeed` を再利用してよい
- ガンダムGCG・ドラゴンボールフュージョンワールドは上記URLが404。正しいニュース一覧URLを実際に探して設定すること。
- ポケモンセンターオンラインは bot をブロックする（fetch失敗）。**無理に回避しない**。設定に入れるが `enabled:false` とし、理由をコメントで残す。
- `sourceWeight` は **1.4**（一次情報なので最優先）、`tier:'official'`、`kind:'official'`。
- サイト構造は変わるので、**セレクタは全て `config/official-sites.json` に外出し**し、取得0件ならエラーにせず `console.warn` すること。

```js
export async function fetchOfficialItems(config, { now, maxAgeHours, concurrency } = {}) // -> RawItem[]
export function parseNewsList(html, siteConfig)  // -> Array<{title,link,pubDate}>  ※純関数・テスト対象
```

## 区画G: 応募ページ抽出と締切抽出

**担当ファイル**: `src/enrich.js` / `config/shops.json` / `test/enrich.test.js`

```js
export async function enrichItems(items, { concurrency, timeoutMs, verbose } = {}) // -> 同じ配列（destUrl等を付与）
export function extractDestination(html, baseUrl, shopsConfig) // -> {url,label,priority}|null  ※純関数
export function unwrapAffiliate(url)     // moshimo / valuecommerce / 楽天アフィリ / amazon tag除去 ※純関数
export function extractSchedule(text, { now })  // -> {startsAt:string|null, deadline:string|null} ※純関数
```

- **対象を絞る**: `intentTags` に 抽選/予約/受付/応募 のいずれかを含む記事だけ本文を取得する（全件取得は遅く、相手にも迷惑）。
- **店ドメイン許可リスト** `config/shops.json`: プレミアムバンダイ `p-bandai.jp`、ポケセンオンライン `pokemoncenter-online.com`、Amazon `amazon.co.jp`/`amzn.to`/`amzn.asia`、セブンネット `7net.omni7.jp`、ヨドバシ `yodobashi.com`、楽天 `rakuten.co.jp`、アニメイト `animate-onlineshop.jp`、駿河屋 `suruga-ya.jp`、あみあみ `amiami.jp`、タカラトミーモール `takaratomymall.jp`、カードダス `carddass.com`、公式ストア各種。**公式・メーカー直販を高優先度**、Amazon等のモールは中、転売系は除外。
- **アフィリエイトリンクの解除**: `af.moshimo.com`（`url=` パラメータ）、`ck.jp.ap.valuecommerce.com`（`vc_url=`）、`hb.afl.rakuten.co.jp`（`pc=`）、Amazonの `tag=` 除去。解除できないもの（a8.net等）は採用しない。
- **リンクの選び方**: ドメイン優先度 × アンカーテキストに 抽選/応募/予約/購入/商品ページ が含まれるか、で採点して最上位を選ぶ。ナビゲーション・フッターの汎用リンクを拾わないよう、同一URLが5回以上出現するものは除外する。
- **締切抽出** `extractSchedule`: 日本語の日時表現に対応すること。`8月28日(木)12:00`、`2026年8月28日 23:59`、`8/28 12時`、`〜9月3日23時59分まで`、`受付期間：8月28日12:00〜9月3日23:59`。年が無ければ `now` から推定（過去になるなら翌年）。開始と締切の両方を返す。**取れなければ null**（誤った締切を出す方が害が大きい）。
- ネットワーク失敗・パース失敗は全て握りつぶして元のitemを返す。**絶対に throw しない**。

## 区画H: 表示への反映

**担当ファイル**: `src/report.js` / `src/format.js` / `test/format.test.js` / `test/report.test.js` / `app/index.html` / `app/app.js` / `app/style.css`

「応募できるか」が一目で分かることを最優先に。

- **HTMLレポート** (`src/report.js`): 各記事に **「応募ページへ」ボタン**（`destUrl` があるとき、店名付き）と **締切バッジ**。締切までの残り時間を「あと2日」「あと5時間」「本日締切」で表示し、24時間以内は警告色。締切切れは淡色＋「受付終了」。`destUrl` が無い場合はボタンを出さず記事リンクのみ。
- **ツイート** (`src/format.js`): 詳細ツイートに応募リンクと締切を入れる。**URLは重み23**なので、記事URLと応募URLの両方は入らないことが多い。**`destUrl` があればそちらを優先**（記事URLは載せない）。締切は `⏰ 8/28 12:00まで` の1行。**280weight以内を必ず保証**すること（既存テストの保証を壊さない）。
- **アプリ** (`app/`): カードに応募ボタンと締切バッジ。さらに **「締切が近い順」の並び替えトグル**を追加（既定は従来どおり最新順）。締切切れは既定で非表示にし、トグルで表示できるようにする。
- 既存の `weightedLength` / `buildThread` / `buildSingle` のシグネチャは変えない。`destUrl` 等が全て null でも従来どおり動くこと（後方互換）。

## ルール（第1フェーズと同じ）
- 他区画のファイルを書き換えない。
- npm依存パッケージ禁止。Node標準のみ。ESM名前付きexport。
- `node --test` がネット接続なしで全pass すること。
- `src/collect.js` `src/index.js` `config/sources.json` `config/scoring.json` は**統括（親）が担当**するので触らないこと。
