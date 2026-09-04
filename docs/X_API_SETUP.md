# X (Twitter) API 設定手順

このbotが自動投稿するために必要な **4つのキー** を取得して `.env` に貼るまでの手順です。
画面の言葉どおりに書いてあるので、上から順にそのまま進めてください。所要 15〜20分。

取得するもの（この4つだけ）:

| .env の変数名 | 開発者ポータルでの名称 |
|---|---|
| `X_API_KEY` | API Key（Consumer Key） |
| `X_API_SECRET` | API Key Secret（Consumer Secret） |
| `X_ACCESS_TOKEN` | Access Token |
| `X_ACCESS_TOKEN_SECRET` | Access Token Secret |

> **最重要の落とし穴**（先に読んでください）
> **アプリの権限を「Read and write」に変更した“後で” Access Token を作り直さないと、投稿が 403 で失敗します。**
> 権限変更の前に発行したトークンには「読み取り専用」の性質が焼き付いており、
> 権限だけ変えても古いトークンでは書き込めません。詳しくは手順 5。

---

## 1. Developer アカウントを作る（無料 / Free tier）

1. 投稿させたいXアカウントで [https://x.com](https://x.com) にログインしておく
   （**botを動かしたいアカウント**でログインすること。個人アカウントでログインしたまま進めると、そのアカウントが投稿します）
2. [https://developer.x.com/](https://developer.x.com/) を開く
3. 右上の **Developer Portal** → **Sign up** （または **Get started**）をクリック
4. 「What's your use case?」のようなアンケート画面が出るので、該当するものを選ぶ
   （`Making a bot` / `Exploring the API` あたりでOK）
5. **英語で利用目的を250文字以上**書く欄が出ることがあります。以下をそのまま貼って構いません:

   ```
   I am building a personal, non-commercial bot that collects publicly available
   Japanese trading card game news from public RSS feeds, ranks the articles by
   recency and topic, and posts a short daily summary thread to my own account.
   The bot only posts to the account that owns this app. It does not read, store,
   or analyze other users' data, does not send direct messages, does not follow or
   unfollow anyone, and does not reply to or mention other users. Posting happens
   once per day via a scheduled job. The purpose is to keep my own followers
   informed about new card set releases and lottery/pre-order announcements.
   ```

6. 規約に同意して送信。通常は**その場で承認**されます（審査待ちになる場合もあります）

---

## 2. Project と App を作る

1. Developer Portal のダッシュボードを開く
2. Free tier だと **Project が1つ自動作成**されていることが多いです。無ければ左メニューの
   **Projects & Apps** → **Overview** → **＋ Create Project**
3. Project の質問に答える
   - **Project name**: `tcg-news-bot`（任意）
   - **Use case**: `Making a bot`
   - **Project description**: 手順1で書いた文章を流用してOK
4. 続けて **App の作成**を求められます
   - **App name**: 全ユーザーで**重複不可**なので `tcg-news-bot-<自分の名前や数字>` のようにする
5. App を作ると **API Key / API Key Secret / Bearer Token** が**一度だけ**表示されます
   - → **この画面でコピーしておく**（後述の手順6で再生成もできるので、逃しても大丈夫）
   - Bearer Token はこのbotの投稿機能では**使いません**（読み取り専用のため）

---

## 3. User authentication settings を設定する（← ここが本番）

投稿するには **OAuth 1.0a のユーザーコンテキスト**が必要で、その設定をしないと Access Token が発行できません。

1. 左メニュー **Projects & Apps** → 作った App 名をクリック
2. **Settings** タブ →  **User authentication settings** の **Set up**（設定済みなら **Edit**）をクリック
3. 表示されるフォームを次のように埋めます:

   | 項目 | 設定値 |
   |---|---|
   | **App permissions** | **Read and write** ← ★必ずこれ |
   | Request email from users | OFF のままでOK |
   | **Type of App** | **Web App, Automated App or Bot**（Confidential client） |
   | **Callback URI / Redirect URL** | `https://example.com/callback` |
   | **Website URL** | `https://example.com`（自分のサイトがあればそれでOK） |
   | Organization name / URL | 空欄でOK（任意） |

   - **App permissions は "Read and write"**。`Read` のままだと投稿時に **403** になります。
   - **Direct message は不要**なので `Read and write and Direct message` は選ばなくて構いません。
   - Callback URI と Website URL は**このbotでは実際には使いません**が、**入力必須**なので上記のダミーで通ります。
     `http://` は弾かれることがあるので必ず `https://` で入れてください。

4. **Save** をクリック
5. 「Client ID / Client Secret」（OAuth 2.0 用）が表示されますが、**このbotでは使いません**。閉じてOK。

---

## 4. 【最重要】Access Token を “権限変更の後で” 発行する

手順3で `Read and write` に変えた**後**に、次を行います。

1. App の **Keys and tokens** タブを開く
2. **Authentication Tokens** セクションの **Access Token and Secret**
   - まだ無ければ → **Generate**
   - **すでに発行済みなら → 必ず `Regenerate`（再生成）する**
3. 表示された **Access Token** と **Access Token Secret** をコピー
   （**この画面を閉じると二度と見られません**。必ずその場で `.env` に貼ること）
4. 発行された Access Token のすぐ下に権限表示が出ます。
   **`Created with Read and Write permissions` になっていることを目視で確認**してください。
   `Read` だけなら手順3に戻って権限を保存し直し、もう一度 Regenerate します。

> なぜ再生成が必要か: Access Token は**発行時点のアプリ権限**を持ちます。
> 後からアプリ権限を Read → Read and write に変えても、**既存トークンは Read のまま**です。
> これが「設定は Read and write なのに 403 が出る」の原因の9割です。

---

## 5. `.env` に貼る

プロジェクト直下の `.env.example` をコピーして `.env` を作り、4つの値を貼ります。

```bash
cp .env.example .env
```

```dotenv
X_API_KEY=ここにAPI Key
X_API_SECRET=ここにAPI Key Secret
X_ACCESS_TOKEN=ここにAccess Token
X_ACCESS_TOKEN_SECRET=ここにAccess Token Secret

TZ=Asia/Tokyo
TOP_N=3
POST_STYLE=thread
```

貼り付け時の注意:

- **前後の空白・改行を入れない**（見えない空白が混ざると 401 になります）
- 値を**クォートで囲まない**（`X_API_KEY="abc"` ではなく `X_API_KEY=abc`）
- Access Token は `1234567890-xxxxxxxx` のように**数字とハイフンで始まる**のが正常です。
  ハイフンが無いものは Client ID などの別物なので貼り間違いです。
- `.env` は `.gitignore` 済みです。**絶対にコミットしないでください**。
  もし一度でも公開リポジトリに上げてしまったら、Keys and tokens から**全部 Regenerate** してください。

---

## 6. 疎通確認する

```bash
npm run auth-check
```

- 成功: `✅ 認証OK @あなたのユーザー名` のように表示されます
- 失敗した場合は、エラーメッセージに日本語のヒントが出ます:

| エラー | 原因と対処 |
|---|---|
| **401 Unauthorized** | キーの貼り間違い・前後の空白混入・キー再生成後に `.env` を更新し忘れ。**または PC の時刻ずれ**（OAuth の timestamp が±5分を超えるとNG。macOS なら「システム設定 → 一般 → 日付と時刻」で自動設定をON） |
| **403 Forbidden** | アプリ権限が Read-only のまま。**手順3 → 手順4（Regenerate）をやり直す** |
| **429 Too Many Requests** | 月間の上限に達した、または短時間に叩きすぎ。時間をおく |
| `認証情報が不足しています` | `.env` の変数名が違う／値が空。表の変数名と1文字ずつ照合 |

投稿せずに文面だけ確認したいときは:

```bash
npm run preview     # 収集 → ランキング → 投稿文面を画面に出すだけ（dry-run）
```

実際に投稿するのは `npm run post` だけです。

---

## 7. Free tier（無料枠）でできること・できないこと

2026年時点の無料枠の要点:

| | Free（$0） | Basic（$200/月〜） |
|---|---|---|
| **投稿（POST /2/tweets）** | **500件/月（アプリ単位）** | 3,000件/月（ユーザー単位） |
| 自分の情報取得（GET /2/users/me） | ○ | ○ |
| **他ユーザーのツイート読み取り・検索** | **✕（不可）** | ○（10,000件/月） |
| アプリ数 | 1 | 2 |

**このbotは Free で足ります。**

- スレッド形式（見出し1本 + TOP3の詳細3本）＝ **1日4ツイート**
- 4 × 31日 = **月124件** → 500件/月の上限に対して**約25%**。余裕があります。
- `TOP_N` を 5 に増やすと 1日6ツイート＝月186件。これでもまだ収まります。

**注意**: 500件/月は**アプリ単位のカウント**です。同じAppを他の用途でも使うと合算されます。
また、テスト実行で `npm run post` を何度も叩くと消費するので、確認は `npm run preview`（dry-run）で行ってください。

**読み取りは無料枠では使えません。** ニュースの収集は X API ではなく **公開RSSフィード**から行う設計です
（CONTRACT.md 区画F の X 読み取り機能は既定で無効。有効化には Basic 以上が必要）。

---

## 8. 自動投稿の運用ルール（アカウント凍結を避けるために）

X の[自動化ルール](https://help.x.com/en/rules-and-policies/x-automation)上、**自分のアカウントへの自動投稿は許可**されています。
ただし次は違反になり、**アカウント凍結やAPIアクセス剥奪**の対象です。

**やってはいけないこと**

- **同一・ほぼ同一の文面を繰り返し投稿する**（重複ツイートは投稿自体が拒否されることもあります）
- 大量のメンション（`@ユーザー名`）やリプライを他人に送る
- ハッシュタグの詰め込み（トレンドの乱用）。**1ツイートあたり2〜4個まで**にする
- 複数アカウントから同じ内容を同時に投稿する
- フォロー/アンフォローの自動化、自動DM

**このbotが守っていること**

- 投稿先は**自分のアカウントのみ**、他人へのメンション・リプライは一切しない
- 1日1回のスケジュール実行
- 投稿済み記事は `data/posted.json` に記録し、**同じ記事を二度投稿しない**
- **ツイート間に3秒の待機**を入れる（連投とみなされないため）
- 429 / 503 は指数バックオフでリトライし、叩き続けない

万一エラーで途中まで投稿された場合、エラーメッセージに**投稿済みのツイートID**が出ます。
中途半端なスレッドが残ったら、Xの画面から手動で削除してください。

---

## トラブルシューティング早見表

| 症状 | 対処 |
|---|---|
| 403 `Your client app is not configured with the appropriate oauth1 app permissions` | 手順3で Read and write に → **手順4で Access Token を Regenerate** |
| 401 `Unauthorized` | キー再確認 / 空白混入 / **PCの時刻を自動同期に** |
| 403 `duplicate content` | 同じ文面を投稿しようとしている。前回投稿から内容が変わっているか確認 |
| 429 | 月500件の上限か短時間の叩きすぎ。`npm run preview` で代用 |
| Access Token が `Read` 権限で発行される | User authentication settings の **Save を押し忘れ**ていないか確認して再生成 |
| キーを紛失した | Keys and tokens から Regenerate（API Key を再生成すると Access Token も無効になるので**両方貼り直す**） |
