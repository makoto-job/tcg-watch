# 公開手順（GitHub Pages で feed.json とアプリを配信する）

このドキュメントの通りに進めると、以下の2つが公開されます。

| 公開されるもの | URL |
| --- | --- |
| スマホアプリ（PWA） | `https://<ユーザー名>.github.io/<リポジトリ名>/` |
| フィードAPI | `https://<ユーザー名>.github.io/<リポジトリ名>/feed.json` |

所要時間は5分程度です。無料で使えます。

---

## 前提

- GitHubにこのリポジトリを push 済みであること
- リポジトリが **Public** であること
  - Privateリポジトリでも GitHub Pages は使えますが、**GitHub Pro 以上の有料プラン**が必要です
  - Publicにできない場合は、後述の[Cloudflare Pages](#代替cloudflare-pages-を使う)を使ってください
- `.github/workflows/pages.yml` がリポジトリに含まれていること（このリポジトリには含まれています）

---

## 手順1: フィードを1回生成してコミットする

まだ `public/feed.json` が無い場合は、先に作っておきます。

```bash
node src/index.js --dry-run
git add -f public/feed.json
git commit -m "chore: 初回のフィードを生成"
git push
```

> `public/feed.json` が無くてもワークフローは空のフィードを置いて動きますが、最初に本物を入れておいたほうがアプリの動作確認が楽です。

---

## 手順2: GitHub Pages を「GitHub Actions」モードにする

画面操作は以下のとおりです。

1. ブラウザでリポジトリのページを開く
2. 上部タブの **Settings**（歯車アイコン）をクリック
3. 左サイドバーを下にスクロールし、**Code and automation** グループの中の **Pages** をクリック
4. **Build and deployment** の **Source** というドロップダウンをクリック
5. **Deploy from a branch** ではなく **GitHub Actions** を選択する
6. 選択した時点で自動保存されます（Saveボタンはありません）

> ここで「Deploy from a branch」を選んでしまうと `app/` が `/` に来ないため、アプリが真っ白になります。必ず **GitHub Actions** を選んでください。

---

## 手順3: デプロイを実行する

1. 上部タブの **Actions** をクリック
2. 左サイドバーの **Deploy Pages** をクリック
3. 右側の **Run workflow** ボタンをクリック → ブランチが `main` になっていることを確認 → 緑の **Run workflow**
4. 一覧に新しい実行が現れるのでクリックし、`build` と `deploy` の両方に緑のチェックが付くまで待つ（1〜2分）
5. `deploy` ジョブをクリックすると、上部に公開URLが表示されます

初回のデプロイはURLが有効になるまで数分かかることがあります。404が出たら少し待ってから再読み込みしてください。

### 動作確認

ブラウザで以下を開いて、JSONが表示されればフィードの公開は成功です。

```
https://<ユーザー名>.github.io/<リポジトリ名>/feed.json
```

---

## 手順4: アプリの参照先を公開URLに書き換える

`app/config.js` を開き、`FEED_URL` を手順3で確認したURLに書き換えます。

```js
// app/config.js
export const FEED_URL = 'https://<ユーザー名>.github.io/<リポジトリ名>/feed.json';
```

同じドメインに配置しているので、相対パスでも動きます（こちらのほうが URL変更に強いのでおすすめです）。

```js
export const FEED_URL = './feed.json';
```

書き換えたらコミットして push します。`app/` への push は自動でPagesの再デプロイを起動します。

```bash
git add app/config.js
git commit -m "chore: FEED_URL を公開URLに設定"
git push
```

---

## 手順5: スマホのホーム画面に追加する

### iPhone（Safari）

1. Safariで `https://<ユーザー名>.github.io/<リポジトリ名>/` を開く
2. 画面下部中央の **共有ボタン**（四角に上矢印）をタップ
3. メニューを下にスクロールして **「ホーム画面に追加」** をタップ
4. 右上の **「追加」** をタップ

> Chrome や他のブラウザからは追加できません。**必ずSafariで開いてください。**

### Android（Chrome）

1. Chromeでアプリのページを開く
2. 右上の **︙**（三点メニュー）をタップ
3. **「アプリをインストール」** または **「ホーム画面に追加」** をタップ

---

## 自動更新のしくみ

```
毎日 JST 12:00   daily.yml (post)  → Xへ投稿 + feed.json 更新 → コミット
2時間ごと         daily.yml (feed)  → feed.json だけ更新       → コミット
      ↓ ワークフロー完了をトリガー
                 pages.yml         → app/ と feed.json を Pages へデプロイ
```

botのコミットには `[skip ci]` が付いているため push では再デプロイが走りません。代わりに `pages.yml` は `workflow_run`（daily ワークフローの完了）でも起動するようにしてあります。

手動で今すぐ反映したい場合は **Actions** → **Deploy Pages** → **Run workflow** を実行してください。

---

## トラブルシューティング

### アプリを開くと真っ白 / 404

- **Settings → Pages → Source** が **GitHub Actions** になっているか確認する
- **Actions** タブで **Deploy Pages** が成功しているか確認する
- `build` ジョブのログ「公開されるファイル」に `_site/index.html` が含まれているか確認する（無い場合は `app/index.html` がまだ作られていません）

### `feed.json` が404になる

`public/feed.json` がリポジトリにコミットされていません。手順1をやり直してください。`public/` が `.gitignore` に含まれていないかも確認してください。

### フィードは更新されているのにアプリの表示が古い

Service Workerのキャッシュです。アプリ内の更新ボタンを押すか、一度ホーム画面のアイコンを削除して追加し直してください。

### `Resource not accessible by integration` エラー

`pages.yml` の `permissions:` が効いていません。**Settings → Actions → General → Workflow permissions** で **Read and write permissions** を選んで保存してください。

---

## 代替: Cloudflare Pages を使う

Privateリポジトリのまま公開したい場合や、GitHub Pages より高速なCDNを使いたい場合の選択肢です。

1. [dash.cloudflare.com](https://dash.cloudflare.com/) にログイン
2. 左サイドバー **Workers & Pages** → **Create** → **Pages** タブ → **Connect to Git**
3. GitHubアカウントを連携し、このリポジトリを選択
4. ビルド設定を以下のようにする
   - **Framework preset**: `None`
   - **Build command**: `mkdir -p _site && cp -R app/. _site/ && cp public/feed.json _site/feed.json`
   - **Build output directory**: `_site`
5. **Save and Deploy**

公開URLは `https://<プロジェクト名>.pages.dev/` になります。`app/config.js` の `FEED_URL` はこのドメインに合わせるか、相対パス `./feed.json` にしてください。

Cloudflare Pages はリポジトリへの push を検知して自動デプロイします。ただし bot のコミットメッセージに `[skip ci]` が付いていても Cloudflare 側は反応するため、GitHub Pages より素早く反映されます。
