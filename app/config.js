// 公開後、この1行を GitHub Pages などの feed.json のURLに書き換えてください
export const FEED_URL = './feed.json';
// ローカル開発時のフォールバック
export const FALLBACK_FEED_URL = '../public/feed.sample.json';
export const APP_NAME = 'TCGウォッチ';
export const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

// --- 以下は変更不要 ---
export const APP_VERSION = '1.0.0';
export const STORAGE_KEY_FEED = 'tcgwatch:feed:v1';
export const STORAGE_KEY_FILTERS = 'tcgwatch:filters:v1';
export const STORAGE_KEY_A2HS = 'tcgwatch:a2hs-dismissed:v1';
// マイ情報・ショップ登録チェックのキーは app/profile.js 側で定義している

/** CONTRACT.md の対象IPキー（固定・変更禁止） */
export const IP_LABELS = {
  pokemon: 'ポケカ',
  onepiece: 'ワンピ',
  dragonball: 'ドラゴンボール',
  gundam: 'ガンダム',
  hololive: 'ホロライブ',
  yugioh: '遊戯王',
  duelmasters: 'デュエマ',
  mtg: 'MTG',
  newtcg: '新作',
  digimon: 'デジモン',
  battlespirits: 'バトスピ',
  aikatsu: 'アイカツ',
  carddass: 'カードダス',
  vanguard: 'ヴァンガード',
  weiss: 'ヴァイス',
  unionarena: 'ユニアリ',
  lottery: '抽選',
};

/** フィルタチップの表示順 */
export const IP_ORDER = [
  'pokemon',
  'onepiece',
  'dragonball',
  'gundam',
  'hololive',
  'yugioh',
  'duelmasters',
  'mtg',
  'newtcg',
  'digimon',
  'battlespirits',
  'aikatsu',
  'carddass',
  'vanguard',
  'weiss',
  'unionarena',
  'lottery',
];

/** 「抽選・予約のみ」トグルの対象タグ */
export const LOTTERY_TAGS = ['抽選', '予約', '受付', '再販'];

/** 1回に表示する件数 */
export const PAGE_SIZE = 10;

/* --------------------------------------------------------------------------
   情報の鮮度

   店の商品ページは中身が変わる（購入制限 6BOX → 4BOX のような変更が実際にあった）。
   取得してから時間が経ったものは「いつ時点の情報か」を画面に出し、
   古いものは注意を促す。ニュース記事は「書かれた日」がそのまま意味を持つので対象外。
   -------------------------------------------------------------------------- */

/** これを過ぎたら取得時刻を明示する（時間） */
export const FRESH_HOURS = 6;

/** これを過ぎたら「変わっているかも」と警告する（時間） */
export const STALE_HOURS = 24;

/**
 * 取得からの経過時間を3段階に分ける。
 *   fresh … 取れたて。時刻は添えるが警告はしない
 *   aging … 少し前の情報。取得時刻を明示する
 *   stale … 古い。押す前に注意を促す
 * 時計ズレで負の値になっても fresh 扱いにする（未来の警告は意味がない）。
 * @param {number} hours 取得からの経過時間
 * @returns {'fresh'|'aging'|'stale'}
 */
export function freshnessLevel(hours) {
  const h = Number.isFinite(hours) ? hours : 0;
  if (h >= STALE_HOURS) return 'stale';
  if (h >= FRESH_HOURS) return 'aging';
  return 'fresh';
}

/* ==========================================================================
   ショップ登録チェックリストの店一覧

   店の一覧は config/shops.json が正。ここはその写しで、次の2つの役割がある。
     ・単一ファイル版（tools/build-single.mjs）では config/ を読みに行けないので、
       ビルド時にこのファイルごと埋め込まれる分が唯一の一覧になる
     ・通常配信でも、config/ が同梱されていない置き方に耐えるための保険

   親が config/shops.json に店を足したとき、アプリは SHOPS_URL から読み直して
   自動で反映する。読めなかったときだけ下の写しに落ちる。
   写しを更新するときは config/shops.json の
   label / domain / category / priority / aliases だけをそのまま写すこと。
   ========================================================================== */

/** config/shops.json の場所（app/ から見た相対パス）。読めなければ下の写しを使う。 */
export const SHOPS_URL = '../config/shops.json';

export const SHOPS_CONFIG = {
  _categories: {
    "maker": "メーカー直販・公式ストア",
    "cardshop": "カードショップ（TCGの主戦場）",
    "toy": "おもちゃ・ホビー専門店",
    "ec": "総合EC・モール",
    "kaden": "家電量販店",
    "cvs": "コンビニ・チケット系",
    "anime": "アニメ・キャラクターグッズ系",
    "book": "書店",
    "reuse": "中古・リユース",
    "super": "スーパー・ディスカウント"
  },
  shops: [
    {"domain":"p-bandai.jp","label":"プレミアムバンダイ","category":"maker","priority":10,"aliases":["プレバン","プレミアムバンダイ","プレミアム バンダイ"]},
    {"domain":"pokemoncenter-online.com","label":"ポケモンセンターオンライン","category":"maker","priority":10,"aliases":["ポケセン","ポケモンセンターオンライン","ポケモンセンター"]},
    {"domain":"pokemon-card.com","label":"ポケモンカード公式","category":"maker","priority":10},
    {"domain":"takaratomymall.jp","label":"タカラトミーモール","category":"maker","priority":10,"aliases":["タカトミモール","タカラトミーモール"]},
    {"domain":"carddass.com","label":"カードダス","category":"maker","priority":10,"aliases":["カードダス"]},
    {"domain":"mtg-jp.com","label":"MTG日本公式","category":"maker","priority":10},
    {"domain":"dm.takaratomy.co.jp","label":"デュエル・マスターズ公式","category":"maker","priority":10},
    {"domain":"onepiece-cardgame.com","label":"ONE PIECEカードゲーム公式","category":"maker","priority":10},
    {"domain":"yugioh-card.com","label":"遊戯王公式","category":"maker","priority":10},
    {"domain":"shop.hololivepro.com","label":"ホロライブ公式ショップ","category":"maker","priority":10,"aliases":["ホロライブ公式ショップ","ホロライブプロダクション公式"]},
    {"domain":"asobistore.jp","label":"アソビストア","category":"maker","priority":9,"aliases":["アソビストア"]},
    {"domain":"hareruyamtg.com","label":"晴れる屋","category":"cardshop","priority":8,"aliases":["晴れる屋"]},
    {"domain":"hareruya2.com","label":"晴れる屋2","category":"cardshop","priority":8,"aliases":["晴れる屋2"]},
    {"domain":"c-labo-online.jp","label":"カードラボ","category":"cardshop","priority":8,"aliases":["カードラボ","C-labo"]},
    {"domain":"yuyu-tei.jp","label":"遊々亭","category":"cardshop","priority":8,"aliases":["遊々亭"]},
    {"domain":"hobby-station.com","label":"ホビーステーション","category":"cardshop","priority":8,"aliases":["ホビステ","ホビーステーション"]},
    {"domain":"cardkingdom.jp","label":"カードキングダム","category":"cardshop","priority":8,"aliases":["カードキングダム"]},
    {"domain":"dorasuta.jp","label":"ドラゴンスター","category":"cardshop","priority":8,"aliases":["ドラゴンスター"]},
    {"domain":"cardrush.jp","label":"カードラッシュ","category":"cardshop","priority":8,"aliases":["カードラッシュ"]},
    {"domain":"cardrush-pokemon.jp","label":"カードラッシュポケモン","category":"cardshop","priority":8,"aliases":["カードラッシュ"]},
    {"domain":"toretoku.jp","label":"トレトク","category":"cardshop","priority":8,"aliases":["トレトク"]},
    {"domain":"torecolo.jp","label":"トレコロ","category":"cardshop","priority":8,"aliases":["トレコロ"]},
    {"domain":"toysrus.co.jp","label":"トイザらス","category":"toy","priority":8,"aliases":["トイザらス","トイザラス"]},
    {"domain":"amiami.jp","label":"あみあみ","category":"toy","priority":8,"aliases":["あみあみ"]},
    {"domain":"1999.co.jp","label":"ホビーサーチ","category":"toy","priority":8,"aliases":["ホビーサーチ"]},
    {"domain":"yamashiroya.co.jp","label":"ヤマシロヤ","category":"toy","priority":8,"aliases":["ヤマシロヤ"]},
    {"domain":"e-yamashiroya.com","label":"ヤマシロヤ","category":"toy","priority":8,"aliases":["ヤマシロヤ","e-ヤマシロヤ"]},
    {"domain":"volks.co.jp","label":"ボークス","category":"toy","priority":8,"aliases":["ボークス"]},
    {"domain":"kiddyland.co.jp","label":"キデイランド","category":"toy","priority":8,"aliases":["キデイランド","キディランド"]},
    {"domain":"amazon.co.jp","label":"Amazon","category":"ec","priority":7,"aliases":["Amazon","アマゾン","amazon"]},
    {"domain":"amzn.to","label":"Amazon","category":"ec","priority":7,"aliases":["Amazon","アマゾン"]},
    {"domain":"amzn.asia","label":"Amazon","category":"ec","priority":7,"aliases":["Amazon","アマゾン"]},
    {"domain":"books.rakuten.co.jp","label":"楽天ブックス","category":"ec","priority":7,"aliases":["楽天ブックス"]},
    {"domain":"rakuten.co.jp","label":"楽天","category":"ec","priority":7,"aliases":["楽天","楽天市場"]},
    {"domain":"shopping.yahoo.co.jp","label":"Yahoo!ショッピング","category":"ec","priority":7,"aliases":["Yahoo!ショッピング","ヤフーショッピング","Yahoo！ショッピング"]},
    {"domain":"paypaymall.yahoo.co.jp","label":"PayPayモール","category":"ec","priority":7,"aliases":["PayPayモール"]},
    {"domain":"qoo10.jp","label":"Qoo10","category":"ec","priority":7,"aliases":["Qoo10"]},
    {"domain":"wowma.jp","label":"au PAY マーケット","category":"ec","priority":7,"aliases":["au PAY マーケット","auPAYマーケット"]},
    {"domain":"yodobashi.com","label":"ヨドバシ.com","category":"kaden","priority":7,"aliases":["ヨドバシ"]},
    {"domain":"biccamera.com","label":"ビックカメラ","category":"kaden","priority":7,"aliases":["ビックカメラ","ビック"]},
    {"domain":"joshinweb.jp","label":"ジョーシン","category":"kaden","priority":7,"aliases":["ジョーシン","Joshin","joshin"]},
    {"domain":"edion.com","label":"エディオン","category":"kaden","priority":7,"aliases":["エディオン"]},
    {"domain":"ksdenki.com","label":"ケーズデンキ","category":"kaden","priority":7,"aliases":["ケーズデンキ"]},
    {"domain":"yamada-denkiweb.com","label":"ヤマダウェブコム","category":"kaden","priority":7,"aliases":["ヤマダ電機","ヤマダウェブコム","ヤマダデンキ"]},
    {"domain":"nojima.co.jp","label":"ノジマ","category":"kaden","priority":7,"aliases":["ノジマ"]},
    {"domain":"sofmap.com","label":"ソフマップ","category":"kaden","priority":7,"aliases":["ソフマップ"]},
    {"domain":"kojima.net","label":"コジマ","category":"kaden","priority":7,"aliases":["コジマ"]},
    {"domain":"7net.omni7.jp","label":"セブンネットショッピング","category":"cvs","priority":6,"aliases":["セブンネット","セブン-イレブン","セブンイレブン"]},
    {"domain":"hmv.co.jp","label":"HMV&BOOKS online","category":"cvs","priority":6,"aliases":["HMV","ローソン"]},
    {"domain":"l-tike.com","label":"ローソンチケット","category":"cvs","priority":6,"aliases":["ローソンチケット","ローチケ"]},
    {"domain":"famima.com","label":"ファミマオンライン","category":"cvs","priority":6,"aliases":["ファミマ","ファミリーマート"]},
    {"domain":"famima-online.family.co.jp","label":"ファミマオンライン","category":"cvs","priority":6,"aliases":["ファミマオンライン","ファミマ","ファミリーマート"]},
    {"domain":"animate-onlineshop.jp","label":"アニメイト","category":"anime","priority":6,"aliases":["アニメイト"]},
    {"domain":"gamers.co.jp","label":"ゲーマーズ","category":"anime","priority":6,"aliases":["ゲーマーズ"]},
    {"domain":"ec.toranoana.jp","label":"とらのあな","category":"anime","priority":6,"aliases":["とらのあな"]},
    {"domain":"vvstore.jp","label":"ヴィレッジヴァンガード","category":"anime","priority":6,"aliases":["ヴィレッジヴァンガード","ヴィレヴァン"]},
    {"domain":"booth.pm","label":"BOOTH","category":"anime","priority":6,"aliases":["BOOTH"]},
    {"domain":"kinokuniya.co.jp","label":"紀伊國屋書店","category":"book","priority":6,"aliases":["紀伊國屋","紀伊国屋"]},
    {"domain":"honto.jp","label":"honto","category":"book","priority":6,"aliases":["honto"]},
    {"domain":"books-sanseido.co.jp","label":"三省堂書店","category":"book","priority":6,"aliases":["三省堂"]},
    {"domain":"yurindo.co.jp","label":"有隣堂","category":"book","priority":6,"aliases":["有隣堂"]},
    {"domain":"shop.tsutaya.co.jp","label":"TSUTAYAオンライン","category":"book","priority":6,"aliases":["TSUTAYA","蔦屋"]},
    {"domain":"miraiyashoten.co.jp","label":"未来屋書店","category":"book","priority":6,"aliases":["未来屋書店"]},
    {"domain":"e-hon.ne.jp","label":"e-hon","category":"book","priority":6,"aliases":["e-hon"]},
    {"domain":"suruga-ya.jp","label":"駿河屋","category":"reuse","priority":5,"aliases":["駿河屋"]},
    {"domain":"shopping.bookoff.co.jp","label":"ブックオフオンライン","category":"reuse","priority":5,"aliases":["ブックオフ","BOOKOFF"]},
    {"domain":"mandarake.co.jp","label":"まんだらけ","category":"reuse","priority":5,"aliases":["まんだらけ"]},
    {"domain":"geo-online.co.jp","label":"ゲオオンライン","category":"reuse","priority":5,"aliases":["ゲオ","GEO"]},
    {"domain":"aeon.com","label":"イオン","category":"super","priority":5,"aliases":["イオン"]},
    {"domain":"aeonretail.com","label":"イオンスタイルオンライン","category":"super","priority":5,"aliases":["イオンスタイルオンライン","イオン"]},
    {"domain":"iyec.itoyokado.co.jp","label":"イトーヨーカドーネット通販","category":"super","priority":5,"aliases":["イトーヨーカドー","ヨーカドー","イトーヨーカドーネット通販"]},
    {"domain":"donki.com","label":"ドン・キホーテ","category":"super","priority":5,"aliases":["ドンキ","ドン・キホーテ"]},
    {"domain":"seiyu.co.jp","label":"西友","category":"super","priority":5,"aliases":["西友"]},
  ],
};
