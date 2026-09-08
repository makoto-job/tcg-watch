/**
 * src/prefecture.js
 *
 * 収集した「店の所在地」を、アプリ側が読める形に揃える。
 *
 * 作った理由:
 *   まとめサイト（ポケカ抽選図鑑）の生データは都道府県をローマ字で持っている。
 *     "prefecture":"tokyo" / "hyogo" / "hokkaido" / "all"
 *   一方アプリ側（app/profile.js）は日本語の正式名で突き合わせる。
 *   ここで変換しておかないと、せっかく取れた所在地が全部「不明」になり、
 *   利用者の県の店を出す判定が働かない。
 *
 *   変換をアプリ側ではなく収集側に置いたのは、feed.json に載る値を1種類に保つため。
 *   情報源が増えても、日本語で入ってきても、出口はいつも正式名になる。
 */

/** ローマ字表記 → 正式名。まとめサイトの表記に合わせて長音記号なしで持つ */
const ROMAJI_TO_PREF = {
  hokkaido: '北海道',
  aomori: '青森県', iwate: '岩手県', miyagi: '宮城県',
  akita: '秋田県', yamagata: '山形県', fukushima: '福島県',
  ibaraki: '茨城県', tochigi: '栃木県', gunma: '群馬県',
  saitama: '埼玉県', chiba: '千葉県', tokyo: '東京都', kanagawa: '神奈川県',
  niigata: '新潟県', toyama: '富山県', ishikawa: '石川県', fukui: '福井県',
  yamanashi: '山梨県', nagano: '長野県',
  gifu: '岐阜県', shizuoka: '静岡県', aichi: '愛知県', mie: '三重県',
  shiga: '滋賀県', kyoto: '京都府', osaka: '大阪府', hyogo: '兵庫県',
  nara: '奈良県', wakayama: '和歌山県',
  tottori: '鳥取県', shimane: '島根県', okayama: '岡山県',
  hiroshima: '広島県', yamaguchi: '山口県',
  tokushima: '徳島県', kagawa: '香川県', ehime: '愛媛県', kochi: '高知県',
  fukuoka: '福岡県', saga: '佐賀県', nagasaki: '長崎県', kumamoto: '熊本県',
  oita: '大分県', miyazaki: '宮崎県', kagoshima: '鹿児島県', okinawa: '沖縄県',
};

/** 長音の書き方ゆれ（hyougo / hyōgo / tōkyō など）を吸収するための別名 */
const ROMAJI_ALIASES = {
  hyougo: 'hyogo', hyōgo: 'hyogo',
  toukyou: 'tokyo', tōkyō: 'tokyo',
  oosaka: 'osaka', ōsaka: 'osaka',
  kyouto: 'kyoto', kyōto: 'kyoto',
  hokkaidou: 'hokkaido', hokkaidō: 'hokkaido',
  gunnma: 'gunma',
  ooita: 'oita', ōita: 'oita',
  kouchi: 'kochi', kōchi: 'kochi',
  hyogoken: 'hyogo',
};

/** 正式名の一覧（日本語で入ってきた場合の突き合わせ用） */
const PREFECTURES = Object.values(ROMAJI_TO_PREF);

/**
 * 「全国どこからでも」を表す書き方。
 * これらは特定の県に紐づかない＝通販扱いなので、'全国' に寄せる。
 */
const NATIONWIDE = new Set(['all', 'zenkoku', 'nationwide', 'online', 'web', 'ec', '全国', 'オンライン', '通販', 'ネット']);

/** 表記ゆれを均す */
function plain(value) {
  let s = String(value ?? '');
  try { s = s.normalize('NFKC'); } catch { /* 古い環境は素通し */ }
  return s.trim();
}

/**
 * 都道府県の表記を正式名に揃える。
 *
 *   'tokyo'      → '東京都'
 *   '東京'        → '東京都'
 *   'all'        → '全国'      （通販＝場所を問わない）
 *   'yokohama'   → ''          （読めないものは空。推測しない）
 *
 * 読めなかったときに空を返すのは、間違った県を付けて
 * 「近くの店」として出してしまうより、不明のまま扱うほうが安全なため。
 *
 * @param {unknown} value
 * @returns {string} 正式名 / '全国' / ''
 */
export function normalizePrefecture(value) {
  const s = plain(value);
  if (!s) return '';

  const lower = s.toLowerCase();
  if (NATIONWIDE.has(lower)) return '全国';

  const key = ROMAJI_ALIASES[lower] || lower;
  if (ROMAJI_TO_PREF[key]) return ROMAJI_TO_PREF[key];

  // 日本語で入ってきた場合。長い名前を優先して当てるので
  // 「東京都」の中の「京都」を京都府と読み違えない。
  const byLength = [...PREFECTURES].sort((a, b) => b.length - a.length);
  for (const full of byLength) {
    if (s.includes(full)) return full;
  }
  // 末尾の 都/道/府/県 を落とした形（「東京」「神奈川」）
  const bare = byLength
    .map((full) => ({ full, short: full === '北海道' ? '北海道' : full.slice(0, -1) }))
    .sort((a, b) => b.short.length - a.short.length);
  for (const { full, short } of bare) {
    if (s.includes(short)) return full;
  }
  return '';
}

/** 通販（場所を問わない）かどうか */
export function isNationwide(value) {
  return normalizePrefecture(value) === '全国';
}
