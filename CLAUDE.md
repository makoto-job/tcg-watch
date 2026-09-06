# TCGウォッチ — 作業する人へ

カードゲームの抽選・予約情報を集め、締切に間に合うように知らせるツール。

**目的は「情報を読ませること」ではなく「抽選に間に合わせること」。**
判断に迷ったら、この一点に戻る。

---

## 絶対に守ること

### 1. 誤った情報は、情報が無いことより有害

「間に合うと思って落とす」のが最悪の失敗。実際にこれで一度作り直している。

- 受付中だと**確認できていないものを「応募できる」と表示しない**（`applyVerified`）
- 締切の意味が確実に分からないフィールドを `deadline` に入れない
- 受付**開始前**のものを「いま応募できる」に入れない（`startsAt` を必ず見る）
- 年が省略された日付は、**記事の掲載日**を基準に解釈する（現在時刻ではない）

### 2. bot対策は回避しない

- UAは `Mozilla/5.0 (compatible; TCGNewsBot/1.0)` 固定。ブラウザ偽装禁止
- robots.txt を確認し、Disallow・AIクローラ拒否のあるサイトは使わない
- ブロックされたら `enabled:false` にして `note` に実測の理由を書く
- 同時実行3以下、`Crawl-delay` があれば守る

### 3. 行き止まりを作らない

- 商品ページを取れない店でも「入口」を案内する（`entryUrl`）
- 押す前に行き先が分かるようにする（「応募」「確認」「探す」で動詞を変える）
- 機能を削るときは、代替の道を用意してから削る

---

## 構成

```
src/
  collect.js    収集の統括（ニュース・公式・小売店をまとめる）
  sources/
    official.js メーカー公式18サイト
    shops.js    小売店24サイト（稼働8）
    xlists.js   X読み取り（既定で無効）
  rss.js        RSS/Atom/RDF パーサ（自前・依存なし）
  resolve.js    Googleニュースのリダイレクト解決
  enrich.js     応募リンクと締切の抽出
  cluster.js    同一ニュースのまとめ
  score.js      ランキング
  format.js     ツイート文面
  report.js     HTMLレポート
  feed.js       アプリ用 feed.json
  index.js      CLI

app/            PWA（iPhone/Android）
config/         全ての設定はここ。コードに埋め込まない
tools/build-single.mjs  単一HTML版のビルド
```

**依存パッケージはゼロ。** Node標準機能のみ。`npm install` 不要。

---

## 調査済みのこと（再調査しないこと）

### 取得できないサイト（回避せず諦めた）
ヨドバシ / トイザらス / あみあみ / タカラトミーモール / ポケモンセンターオンライン
→ bot対策。`config/shop-sources.json` の `note` に実測結果あり

### 中身が使えないサイト
駿河屋（「抽選」で抽選箱が出る）/ イトーヨーカドー・イオン（TCG扱いなし）
/ ホビーステーション（海外向けガンプラ）

### JS描画で取れない
遊々亭 / 晴れる屋 / 晴れる屋2 / ミントモール抽選一覧

### 重要な発見
- **楽天ブックスの `sales_start_time`/`sales_end_time` は抽選受付期間ではない**。
  期間内のはずの商品が店側で「エントリー期間外」と表示された。締切として使わない
- **プレミアムバンダイの一覧には `TimerEnd` に正式な締切が埋まっている**（`deadlinePattern` で取得）
- 記事本文に締切が書かれていないことが多い。抽出処理の改善では増えない
- ハンターハンター専用TCGは存在しない。**ユニオンアリーナ**に参戦している
- BANDAI CARD GAMES の正しいURLは `carddass.com/bcg/jp/`（ニュース一覧は無い）

---

## よく使うコマンド

```bash
npm test                    # テスト（596件）
npm run preview             # 投稿内容を確認（投稿しない）
npm run report              # HTMLレポートを生成
node src/index.js --post    # 実際に投稿
node tools/build-single.mjs # 単一HTML版をビルド
```

---

## X API について

**2026年2月から従量課金**（無料枠は廃止）。

- 投稿（URLなし）$0.015 / **投稿（URLあり）$0.20**
- 読み取り $0.005

URLを含めると13倍になるので、**Xには結論だけ書き、リンクはアプリに置く**設計にしている。
これで月70円ほどに収まる。

X読み取りは検索型だと月100万円規模になるため使わない。
やるなら厳選アカウント監視のみ（月$15程度）。

---

## 対象IP（17種・変更時は CONTRACT.md とテストも更新）

`pokemon` `onepiece` `dragonball` `gundam` `hololive` `yugioh` `duelmasters` `mtg`
`newtcg` `digimon` `battlespirits` `aikatsu` `carddass` `vanguard` `weiss` `unionarena` `lottery`

`lottery` は横断タグ。これ単独の記事は対象外（無関係な抽選情報が混ざるため）。
