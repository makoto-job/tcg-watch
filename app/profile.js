/* ==========================================================================
   TCGウォッチ — profile.js
   「マイ情報」と「ショップ登録チェックリスト」のロジック。

   このアプリで抽選に落ちる一番よくある理由は、実は倍率ではなく
   **当日に会員登録から始めて間に合わない** こと。
   だからここは「事前に済ませておく」ための機能に振り切っている。

   ■ 絶対に守る約束（変更禁止）
     1. パスワードとクレジットカード番号は扱わない。入力欄も作らないし保存もしない。
        （そこはOS標準のパスワード管理や 1Password の仕事。ここでやると事故になる）
     2. データは端末内（localStorage）のみ。外部へ送る処理はこのファイルに一切書かない。
     3. バックアップは端末上で暗号化する（crypto.js）。鍵も暗号文もどこにも送らない。
   ========================================================================== */

/** localStorage キー（config.js の命名に合わせる） */
export const STORAGE_KEY_PROFILE = 'tcgwatch:profile:v1';
export const STORAGE_KEY_SHOP_STATUS = 'tcgwatch:shop-status:v1';
/** 「興味なし」にした店。登録状況とは別に持つ（登録済みと混ぜると意味が変わる） */
export const STORAGE_KEY_SHOP_HIDDEN = 'tcgwatch:shop-hidden:v1';

/** 「近日中」とみなす日数。これより先の予定では警告を出さない。 */
export const LOOKAHEAD_DAYS = 30;

/** 応募・予約に関係するとみなす intentTag */
export const APPLY_TAGS = ['抽選', '予約', '受付', '応募', '再販'];

/* ==========================================================================
   マイ情報のスキーマ
   ここに無いキーは保存しない。**パスワード・カード番号・マイナンバーは載せない。**
   ========================================================================== */

/**
 * @typedef {Object} ProfileField
 * @property {string} key
 * @property {string} label
 * @property {string} group      画面上のまとまり
 * @property {string} [hint]
 * @property {string} [placeholder]
 * @property {string} [inputmode]
 * @property {number} [maxLength]
 */

/** @type {ProfileField[]} */
export const PROFILE_FIELDS = [
  { key: 'lastName', label: '姓（漢字）', group: 'name', placeholder: '山田' },
  { key: 'firstName', label: '名（漢字）', group: 'name', placeholder: '太郎' },
  // カタカナは「ブラウザの自動入力が最も苦手な項目」。ここが手打ちになって時間を食う。
  { key: 'lastNameKana', label: 'セイ（カナ）', group: 'name', placeholder: 'ヤマダ', hint: '自動入力が効かない筆頭' },
  { key: 'firstNameKana', label: 'メイ（カナ）', group: 'name', placeholder: 'タロウ' },

  // 日本の会員登録フォームは郵便番号が3桁+4桁に分かれていることが非常に多い
  { key: 'zip1', label: '郵便番号（上3桁）', group: 'address', placeholder: '100', inputmode: 'numeric', maxLength: 3 },
  { key: 'zip2', label: '郵便番号（下4桁）', group: 'address', placeholder: '0001', inputmode: 'numeric', maxLength: 4 },
  // 都道府県は住所欄であると同時に「どの店を出すか」の判断材料。理由を添えて任意で促す
  { key: 'pref', label: '都道府県', group: 'address', placeholder: '東京都', hint: '入れると近くのお店だけ出せます' },
  { key: 'city', label: '市区町村', group: 'address', placeholder: '千代田区千代田' },
  { key: 'address1', label: '番地', group: 'address', placeholder: '1-1' },
  { key: 'address2', label: '建物名・部屋番号', group: 'address', placeholder: '〇〇マンション101' },

  { key: 'phone', label: '電話番号', group: 'contact', placeholder: '090-1234-5678', inputmode: 'tel', hint: 'ハイフンあり・なしの両方をコピーできます' },
  { key: 'email', label: 'メールアドレス', group: 'contact', placeholder: 'you@example.com', inputmode: 'email' },

  // プルダウン入力のフォームが多いので年月日を分けて持つ
  { key: 'birthYear', label: '生年（西暦）', group: 'birth', placeholder: '1990', inputmode: 'numeric', maxLength: 4 },
  { key: 'birthMonth', label: '月', group: 'birth', placeholder: '1', inputmode: 'numeric', maxLength: 2 },
  { key: 'birthDay', label: '日', group: 'birth', placeholder: '2', inputmode: 'numeric', maxLength: 2 },
];

/** 画面上のまとまりの表示名 */
export const PROFILE_GROUPS = [
  { key: 'name', label: '氏名' },
  { key: 'address', label: '住所' },
  { key: 'contact', label: '連絡先' },
  { key: 'birth', label: '生年月日' },
];

/** 保存を許可するキー（これ以外は捨てる） */
export const PROFILE_KEYS = PROFILE_FIELDS.map((f) => f.key);

/**
 * 保存してはいけないキーの断片。
 * 万一 UI 側やバックアップ復元経由で紛れ込んでも、ここで確実に落とす。
 */
export const FORBIDDEN_KEY_PARTS = [
  'password', 'passwd', 'passcode', 'pin',
  'card', 'credit', 'cvv', 'cvc', 'securitycode',
  'mynumber', 'ssn', 'account',
];

/** そのキーが禁止語を含むか */
export function isForbiddenKey(key) {
  const k = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return FORBIDDEN_KEY_PARTS.some((part) => k.includes(part));
}

/* ---------------------------------------------------------------
   localStorage（プライベートブラウズ等で例外になっても落とさない）
   --------------------------------------------------------------- */
const storage = {
  get(key) {
    try {
      if (typeof localStorage === 'undefined') return null;
      return localStorage.getItem(key);
    } catch { return null; }
  },
  set(key, value) {
    try {
      if (typeof localStorage === 'undefined') return false;
      localStorage.setItem(key, value);
      return true;
    } catch { return false; }
  },
  remove(key) {
    try {
      if (typeof localStorage === 'undefined') return false;
      localStorage.removeItem(key);
      return true;
    } catch { return false; }
  },
};

/* ==========================================================================
   マイ情報
   ========================================================================== */

/**
 * 未知キー・禁止キーを落として、既知キーだけの素直なオブジェクトにする。
 * 値は全て文字列（trim済み）。空文字のキーは残さない。
 */
export function normalizeProfile(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of PROFILE_KEYS) {
    if (isForbiddenKey(key)) continue; // 保険。スキーマ側で既に禁止語は使っていない
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    const text = String(value).trim();
    if (!text) continue;
    out[key] = text;
  }
  return out;
}

/**
 * localStorage からマイ情報を読む。無ければ空オブジェクト。
 * @returns {Record<string,string>}
 */
export function loadProfile() {
  const raw = storage.get(STORAGE_KEY_PROFILE);
  if (!raw) return {};
  try {
    return normalizeProfile(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * マイ情報を保存する。保存した内容（正規化後）を返す。
 * @returns {Record<string,string>}
 */
export function saveProfile(profile) {
  const clean = normalizeProfile(profile);
  storage.set(STORAGE_KEY_PROFILE, JSON.stringify(clean));
  return clean;
}

/** マイ情報を端末から消す */
export function clearProfile() {
  storage.remove(STORAGE_KEY_PROFILE);
  return {};
}

/** マイ情報が1つでも入っているか */
export function hasProfile(profile) {
  return Object.keys(normalizeProfile(profile)).length > 0;
}

/** 数字以外を落とす（電話・郵便番号用） */
export function digitsOnly(value) {
  return String(value ?? '').replace(/[^0-9]/g, '');
}

/** 「123-4567」。片方でも欠けていれば空文字。 */
export function formatZip(profile) {
  const a = digitsOnly(profile && profile.zip1);
  const b = digitsOnly(profile && profile.zip2);
  if (!a || !b) return '';
  return `${a}-${b}`;
}

/** 電話番号にハイフンを入れた形。入力にハイフンがあればそれを尊重する。 */
export function formatPhone(profile) {
  const raw = String((profile && profile.phone) || '').trim();
  if (!raw) return '';
  if (raw.includes('-')) return raw;
  const d = digitsOnly(raw);
  // 携帯 090-1234-5678 / 固定 03-1234-5678 のよくある形だけ整える
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10 && d.startsWith('0') && (d[1] === '3' || d[1] === '6')) {
    return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}`;
  }
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return raw;
}

/** 生年月日「1990/01/02」。欠けていれば空文字。 */
export function formatBirth(profile) {
  const y = digitsOnly(profile && profile.birthYear);
  const m = digitsOnly(profile && profile.birthMonth);
  const d = digitsOnly(profile && profile.birthDay);
  if (!y || !m || !d) return '';
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

/**
 * 1タップでコピーしたい「組み合わせ」の値。
 * フォームの1項目に姓名まとめて入れさせる店も多いので、両方用意しておく。
 * @returns {Array<{key:string,label:string,value:string}>}
 */
export function derivedRows(profile) {
  const p = normalizeProfile(profile);
  const rows = [];
  const push = (key, label, value) => { if (value) rows.push({ key, label, value }); };

  const name = [p.lastName, p.firstName].filter(Boolean).join(' ');
  const kana = [p.lastNameKana, p.firstNameKana].filter(Boolean).join(' ');
  push('fullName', '氏名（姓名）', name);
  push('fullNameNoSpace', '氏名（スペースなし）', [p.lastName, p.firstName].filter(Boolean).join(''));
  push('fullNameKana', 'セイメイ（カナ）', kana);
  push('zip', '郵便番号（ハイフンあり）', formatZip(p));
  push('zipDigits', '郵便番号（数字だけ）', digitsOnly(p.zip1) && digitsOnly(p.zip2) ? digitsOnly(p.zip1) + digitsOnly(p.zip2) : '');
  push('address', '住所（都道府県から）', [p.pref, p.city, p.address1, p.address2].filter(Boolean).join(''));
  push('addressNoBuilding', '住所（建物名なし）', [p.pref, p.city, p.address1].filter(Boolean).join(''));
  push('phoneHyphen', '電話（ハイフンあり）', formatPhone(p));
  push('phoneDigits', '電話（ハイフンなし）', digitsOnly(p.phone));
  push('birth', '生年月日', formatBirth(p));
  return rows;
}

/**
 * 「全部まとめてコピー」用のテキスト。
 * 会員登録フォームを開いた別ウィンドウに貼り付けて、そこから拾う使い方を想定。
 */
export function profileSummaryText(profile) {
  const p = normalizeProfile(profile);
  const lines = [];
  for (const group of PROFILE_GROUPS) {
    const fields = PROFILE_FIELDS.filter((f) => f.group === group.key && p[f.key]);
    for (const f of fields) lines.push(`${f.label}: ${p[f.key]}`);
  }
  const zip = formatZip(p);
  if (zip) lines.push(`郵便番号: ${zip}`);
  const phone = digitsOnly(p.phone);
  if (phone) lines.push(`電話（ハイフンなし）: ${phone}`);
  const birth = formatBirth(p);
  if (birth) lines.push(`生年月日: ${birth}`);
  return lines.join('\n');
}

/* ==========================================================================
   ショップ登録チェックリスト
   ========================================================================== */

/** カテゴリの並び順（config/shops.json の _categories のキーに合わせている） */
const CATEGORY_ORDER = [
  'maker', 'cardshop', 'toy', 'ec', 'kaden', 'cvs', 'anime', 'book', 'reuse', 'super',
];

/** カテゴリの既定表示名（config 側に _categories があればそちらを優先） */
export const DEFAULT_CATEGORY_LABELS = {
  maker: 'メーカー直販・公式ストア',
  cardshop: 'カードショップ',
  toy: 'おもちゃ・ホビー専門店',
  ec: '総合EC・モール',
  kaden: '家電量販店',
  cvs: 'コンビニ・チケット系',
  anime: 'アニメ・キャラクターグッズ',
  book: '書店',
  reuse: '中古・リユース',
  super: 'スーパー・ディスカウント',
  other: 'その他',
};

/** https:// のURLだけ通す（既存アプリの safeUrl と同じ考え方。ここは https のみ） */
export function safeShopUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  return /^https:\/\/[^\s]+$/i.test(trimmed) ? trimmed : null;
}

/** 表記ゆれを吸収した突き合わせ用キー（全角半角・大小文字・空白・記号を潰す） */
export function shopKey(value) {
  let s = String(value ?? '');
  try { s = s.normalize('NFKC'); } catch { /* 古い環境は素通し */ }
  return s.toLowerCase().replace(/[\s　!！?？.,、。・／/]/g, '');
}

/**
 * config/shops.json（もしくは shops 配列）を、チェックリスト用の一覧に整える。
 *
 * ・同じ店名が複数ドメインで登録されていることがある（Amazon の amzn.to など）ので
 *   **表示名でまとめる**。チェックは「その店に登録したか」であってドメイン単位ではない。
 * ・id は代表ドメイン。ドメインは変わりにくいので、チェック状態のキーとして安定している。
 * ・**アプリ側に店をハードコードしない。** 親が config/shops.json に店を足したら
 *   ここを通して自動で増える。
 *
 * @returns {Array<{id:string,label:string,domain:string,category:string,priority:number,url:string|null,aliases:string[]}>}
 */
export function normalizeShopList(raw) {
  const source = Array.isArray(raw) ? raw
    : (raw && Array.isArray(raw.shops)) ? raw.shops
      : [];

  /** @type {Map<string, any>} */
  const byLabel = new Map();

  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    const label = String(entry.label || '').trim();
    const domain = String(entry.domain || '').trim().toLowerCase();
    if (!label || !domain) continue;
    if (entry.enabled === false) continue;

    const priority = Number.isFinite(Number(entry.priority)) ? Number(entry.priority) : 0;
    const key = shopKey(label);
    const existing = byLabel.get(key);

    const aliases = Array.isArray(entry.aliases)
      ? entry.aliases.map((a) => String(a || '').trim()).filter(Boolean)
      : [];

    if (!existing) {
      byLabel.set(key, {
        id: domain,
        label,
        domain,
        category: String(entry.category || 'other'),
        priority,
        url: safeShopUrl(entry.signupUrl) || safeShopUrl(entry.url) || `https://${domain}/`,
        aliases: [...aliases],
        domains: [domain],
      });
      continue;
    }
    // 同じ店名の2件目以降: 別名とドメインだけ吸収する
    existing.aliases.push(...aliases);
    existing.domains.push(domain);
    if (priority > existing.priority) {
      existing.priority = priority;
      existing.id = domain;
      existing.domain = domain;
      existing.url = safeShopUrl(entry.signupUrl) || safeShopUrl(entry.url) || `https://${domain}/`;
    }
  }

  const list = [...byLabel.values()].map((s) => ({
    ...s,
    aliases: [...new Set(s.aliases)],
    domains: [...new Set(s.domains)],
  }));

  list.sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(a.category);
    const cb = CATEGORY_ORDER.indexOf(b.category);
    const ra = ca === -1 ? CATEGORY_ORDER.length : ca;
    const rb = cb === -1 ? CATEGORY_ORDER.length : cb;
    if (ra !== rb) return ra - rb;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.label.localeCompare(b.label, 'ja');
  });

  return list;
}

/** カテゴリ表示名の対応表を config から作る（無ければ既定） */
export function categoryLabels(raw) {
  const out = { ...DEFAULT_CATEGORY_LABELS };
  const src = raw && typeof raw._categories === 'object' ? raw._categories : null;
  if (src) {
    for (const [key, value] of Object.entries(src)) {
      if (typeof value === 'string' && value.trim()) out[key] = value.trim();
    }
  }
  return out;
}

/**
 * 店名 → 店 の索引。表示名・別名・ドメインのどれでも引ける。
 * @returns {Map<string, object>}
 */
export function shopIndex(shopList) {
  const map = new Map();
  for (const shop of shopList || []) {
    if (!shop || !shop.label) continue;
    const keys = [shop.label, ...(shop.aliases || []), ...(shop.domains || [shop.domain])];
    for (const k of keys) {
      const key = shopKey(k);
      if (key && !map.has(key)) map.set(key, shop);
    }
  }
  return map;
}

/* ---------- 登録状況（localStorage） ---------- */

/**
 * 登録済みの店。値が true のものだけを持つ。
 * @returns {Record<string, true>}
 */
export function loadShopStatus() {
  const raw = storage.get(STORAGE_KEY_SHOP_STATUS);
  if (!raw) return {};
  try {
    return normalizeShopStatus(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** true のキーだけ残す（false や不正値は保存しない＝データを太らせない） */
export function normalizeShopStatus(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value === true && typeof key === 'string' && key) out[key] = true;
  }
  return out;
}

/** @returns {Record<string, true>} 保存した内容 */
export function saveShopStatus(status) {
  const clean = normalizeShopStatus(status);
  storage.set(STORAGE_KEY_SHOP_STATUS, JSON.stringify(clean));
  return clean;
}

/** 登録状況を端末から消す */
export function clearShopStatus() {
  storage.remove(STORAGE_KEY_SHOP_STATUS);
  return {};
}

/* ---------- 興味なし（この店はもう出さない） ---------- */

/**
 * 「興味なし」にした店。登録状況と同じ形（true のキーだけ）にしている。
 * 消し方はマイ情報の「お店の表示範囲」から。**押したら二度と戻れない、にはしない。**
 */
export function loadHiddenShops() {
  const raw = storage.get(STORAGE_KEY_SHOP_HIDDEN);
  if (!raw) return {};
  try {
    return normalizeShopStatus(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** @returns {Record<string, true>} 保存した内容 */
export function saveHiddenShops(hidden) {
  const clean = normalizeShopStatus(hidden);
  storage.set(STORAGE_KEY_SHOP_HIDDEN, JSON.stringify(clean));
  return clean;
}

/** 「興味なし」を全部取り消す */
export function clearHiddenShops() {
  storage.remove(STORAGE_KEY_SHOP_HIDDEN);
  return {};
}

/* ==========================================================================
   お店が「行ける場所」かどうか
   ------------------------------------------------------------------------
   利用者の指摘：
     「未登録のショップがあります」に、住んでいるエリアからだいぶ遠い
      実店舗が出てくる。行けないので登録しても意味がない。

   遠いかどうかを距離で測るのはやめている（緯度経度も地図データも要らない）。
   **都道府県が一致するか**だけを見る。日本の店舗網ではこれで十分で、
   しかも都道府県はマイ情報にすでにある（追加入力を求めない）。

   分類は3つだけ:
     online  … 住所に関係なく申し込める（通販・全国対応）→ 常に出す
     local   … 特定の場所にある実店舗                  → 同じ都道府県のときだけ出す
     unknown … どちらとも判断できない                  → 出す（黙って落とさない）

   **unknown を「出す」側に倒しているのは意図的。**
   判断できないものを勝手に隠すと、間に合ったはずの抽選を落とす。
   CLAUDE.md の「誤った情報は情報が無いことより有害」「行き止まりを作らない」に従う。
   ========================================================================== */

/** 47都道府県（正式名） */
export const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県',
  '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

/**
 * 突き合わせ用の候補。正式名と、末尾の 都/道/府/県 を落とした短い形の両方を持つ。
 * 長い順に見るので「東京都」の中の「京都」を京都府と誤認しない。
 */
const PREF_CANDIDATES = (() => {
  const list = [];
  for (const full of PREFECTURES) {
    list.push({ text: full, pref: full });
    const bare = full === '北海道' ? '北海道' : full.slice(0, -1);
    if (bare !== full) list.push({ text: bare, pref: full });
  }
  list.sort((a, b) => b.text.length - a.text.length);
  return list;
})();

/** 表記ゆれを均す（全角英数・空白など） */
function plain(value) {
  let s = String(value ?? '');
  try { s = s.normalize('NFKC'); } catch { /* 古い環境は素通し */ }
  return s.trim();
}

/**
 * 文字列の中から都道府県を1つ拾う。左から順に、長い名前を優先して当てる。
 * 「東京都」は 東京都、「カードラボ 福岡天神店」は 福岡県 になる。
 * @returns {string|null} 正式名
 */
export function detectPrefIn(text) {
  const s = plain(text);
  if (!s) return null;
  for (let i = 0; i < s.length; i += 1) {
    for (const cand of PREF_CANDIDATES) {
      if (s.startsWith(cand.text, i)) return cand.pref;
    }
  }
  return null;
}

/**
 * 利用者が入力した都道府県を正式名に直す。
 * 「東京」「東京都」「東京都千代田区」いずれも「東京都」。読めなければ null。
 */
export function normalizePref(value) {
  const s = plain(value);
  if (!s) return null;
  return detectPrefIn(s);
}

/** 「全国どこからでも」を表す書き方（まとめサイトの prefecture / region 用） */
const NATIONWIDE_WORDS = ['all', '全国', 'オンライン', 'online', 'ネット', 'web', '通販', '-'];

/**
 * 店名に出てくる「実店舗の印」。
 * ここに当たるのは支店名だけにしたいので、**先に shops.json 掲載店を除外**する。
 * （「紀伊國屋書店」「三省堂書店」も 店 で終わるが、これらは通販サイトとして登録済み）
 */
const LOCAL_NAME_RE = /(店|支店|本店|営業所|売場|売り場)$/;
const LOCAL_WORD_RE = /(支店|本店|駅前店|号店|営業所)/;

/** 店名に出てくる「通販の印」 */
const ONLINE_WORD_RE = /(オンライン|online|通販|ネットショップ|ネット通販|モール|mall|公式ストア|公式通販|webストア|ウェブストア|\.com|\.jp|\.net)/i;

/**
 * その店が「行ける場所の店」かどうかを決める。
 *
 * 手がかりは強い順に:
 *   1. 収集側が付けた prefecture（まとめサイトのデータに入っている）
 *   2. config/shops.json に載っているか（載っている69店はすべて通販サイト）
 *   3. 店名の形（「〜店」は支店、都道府県名が入っていればその県）
 *   4. 店名に通販らしい語があるか
 *
 * @param {{label?:string, known?:boolean, prefecture?:string, region?:string, deliveryType?:string}} hint
 * @returns {{kind:'online'|'local'|'unknown', pref:string|null, reason:string}}
 */
export function classifyShopLocality(hint) {
  const h = hint && typeof hint === 'object' ? hint : {};
  const label = plain(h.label);

  // 1. 収集側のデータが一番強い
  for (const raw of [h.prefecture, h.region]) {
    const value = plain(raw);
    if (!value) continue;
    if (NATIONWIDE_WORDS.includes(value.toLowerCase())) {
      return { kind: 'online', pref: null, reason: 'data:全国' };
    }
    const pref = normalizePref(value);
    if (pref) return { kind: 'local', pref, reason: 'data:都道府県' };
  }

  // 2. 許可ドメイン一覧に載っている＝通販として認識している店
  if (h.known === true) return { kind: 'online', pref: null, reason: 'shops.json' };

  // 3. 店名が支店の形をしている
  if (label && (LOCAL_NAME_RE.test(label) || LOCAL_WORD_RE.test(label))) {
    return { kind: 'local', pref: detectPrefIn(label), reason: '店名:支店' };
  }
  // 都道府県名が入っているなら、その土地の店とみなす
  const inName = detectPrefIn(label);
  if (inName) return { kind: 'local', pref: inName, reason: '店名:地名' };

  // 4. 通販らしい語
  if (label && ONLINE_WORD_RE.test(label)) {
    return { kind: 'online', pref: null, reason: '店名:通販' };
  }

  // 5. 分からない。**隠さない。**
  return { kind: 'unknown', pref: null, reason: '不明' };
}

/**
 * 未登録の店を「いま出すもの」と「遠くて出さないもの」に分ける。
 *
 * ・online / unknown → 常に出す
 * ・local            → 利用者の都道府県と一致したときだけ出す
 * ・都道府県が未入力 → local はすべて出さない（勝手に全国の実店舗を出さない）
 * ・興味なしにした店 → どちらにも入れず muted へ（すべて表示でも出さない。解除はマイ情報から）
 *
 * @param {Array<object>} entries  unregisteredShopsFor() の戻り
 * @param {{pref?:string, hidden?:Record<string,true>, showAll?:boolean}} [opts]
 * @returns {{list:Array<object>, near:Array<object>, far:Array<object>, muted:Array<object>, pref:string|null, showAll:boolean}}
 */
export function partitionUnregisteredShops(entries, opts = {}) {
  const pref = normalizePref(opts && opts.pref);
  const hidden = normalizeShopStatus(opts && opts.hidden);
  const showAll = Boolean(opts && opts.showAll);

  const list = [];
  const near = [];
  const far = [];
  const muted = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (hidden[entry.id]) { muted.push(entry); continue; }

    const loc = entry.locality || classifyShopLocality(entry);
    const isFar = loc.kind === 'local' && !(pref !== null && loc.pref === pref);

    if (isFar) far.push(entry); else near.push(entry);
    if (!isFar || showAll) list.push(entry);
  }

  return { list, near, far, muted, pref, showAll };
}

/* ---------- 未登録警告 ---------- */

function parseTime(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function looksApplyable(item) {
  if (safeShopUrl(item && item.destUrl)) return true;
  const tags = Array.isArray(item && item.intentTags) ? item.intentTags : [];
  return tags.some((t) => APPLY_TAGS.includes(t));
}

/**
 * FeedItem から「場所の手がかり」だけを取り出す。
 * 収集側がまだ付けていない項目は undefined のまま（無い物を作らない）。
 * まとめサイト（ポケカ抽選図鑑）の生データには prefecture / deliveryType が入っているので、
 * 収集側が feed に載せてくれれば、この関数を変えずに精度が上がる。
 */
function localityHints(item) {
  const pick = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || undefined;
  };
  return {
    prefecture: pick(item && (item.prefecture ?? item.destPrefecture)),
    region: pick(item && item.region),
    deliveryType: pick(item && item.deliveryType),
  };
}

/**
 * 近日中に抽選/予約があるのに、まだ会員登録していない店を洗い出す。
 *
 * 判定に使うのは feed の destLabel（どの店か）と deadline / startsAt（いつか）。
 * ・締切が過ぎたものは対象外（もう間に合わないので警告する意味がない）
 * ・受付開始が未来ならそれを「次の予定」とする。まさに事前登録が効く場面。
 * ・日時が全く取れないものも、応募先が分かっているなら件数には数える
 *   （「取れなかった締切」を勝手に作らないのは第2フェーズの方針どおり）
 * ・config/shops.json に無い店（例: ミントモール）も取りこぼさず警告する。
 *   その場合 id は "other:店名"、登録ページのURLは推測しない（null）。
 *
 * 各件に locality（online / local / unknown と都道府県）を付ける。
 * **ここでは絞り込まない。** 遠い近いで実際に隠すのは partitionUnregisteredShops の仕事で、
 * 分けておかないと「隠したものが数にも残らない」＝行き止まりになる。
 *
 * @param {Array<object>} items          FeedItem[]
 * @param {Record<string,true>} status   loadShopStatus() の戻り
 * @param {Array<object>} shopList       normalizeShopList() の戻り
 * @param {{now?:Date, withinDays?:number}} [opts]
 * @returns {Array<{id:string,label:string,url:string|null,shop:object|null,known:boolean,count:number,nextAt:string|null,nextKind:'start'|'deadline'|null,sample:object,locality:{kind:string,pref:string|null,reason:string}}>}
 */
export function unregisteredShopsFor(items, status, shopList, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const nowMs = now.getTime();
  const withinDays = Number.isFinite(Number(opts.withinDays)) ? Number(opts.withinDays) : LOOKAHEAD_DAYS;
  const horizon = nowMs + withinDays * 86400000;

  const index = shopIndex(shopList || []);
  const registered = normalizeShopStatus(status);

  /** @type {Map<string, any>} */
  const groups = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const label = String(item.destLabel || '').trim();
    if (!label) continue;
    if (!looksApplyable(item)) continue;

    const shop = index.get(shopKey(label)) || null;
    const id = shop ? shop.id : `other:${label}`;
    if (registered[id]) continue;

    const deadline = parseTime(item.deadline);
    const startsAt = parseTime(item.startsAt);

    // 受付終了済みは対象外
    if (deadline !== null && deadline <= nowMs) continue;

    let nextAt = null;
    let nextKind = null;
    if (startsAt !== null && startsAt > nowMs) {
      nextAt = startsAt;
      nextKind = 'start';
    } else if (deadline !== null) {
      nextAt = deadline;
      nextKind = 'deadline';
    }
    // 遠すぎる予定では急かさない
    if (nextAt !== null && nextAt > horizon) continue;

    const current = groups.get(id);
    if (!current) {
      groups.set(id, {
        id,
        label: shop ? shop.label : label,
        url: shop ? shop.url : null,
        shop,
        known: Boolean(shop),
        count: 1,
        nextAt,
        nextKind,
        sample: item,
        hints: localityHints(item),
      });
      continue;
    }
    current.count += 1;
    // 場所の手がかりは、同じ店の別の記事に入っていることがある。空いている所だけ埋める
    const hints = localityHints(item);
    for (const key of Object.keys(hints)) {
      if (!current.hints[key] && hints[key]) current.hints[key] = hints[key];
    }
    if (nextAt !== null && (current.nextAt === null || nextAt < current.nextAt)) {
      current.nextAt = nextAt;
      current.nextKind = nextKind;
      current.sample = item;
    }
  }

  const out = [...groups.values()].map(({ hints, ...g }) => ({
    ...g,
    nextAt: g.nextAt === null ? null : new Date(g.nextAt).toISOString(),
    locality: classifyShopLocality({
      label: g.label,
      known: g.known,
      prefecture: hints.prefecture,
      region: hints.region,
      deliveryType: hints.deliveryType,
    }),
  }));

  // 日時が近いものから。日時不明は末尾に、その中では件数が多い順。
  out.sort((a, b) => {
    const va = a.nextAt === null ? Infinity : Date.parse(a.nextAt);
    const vb = b.nextAt === null ? Infinity : Date.parse(b.nextAt);
    if (va !== vb) return va - vb;
    if (a.count !== b.count) return b.count - a.count;
    return a.label.localeCompare(b.label, 'ja');
  });

  return out;
}

/** 登録済み件数のまとめ（チェックリストの見出し用） */
export function shopStatusSummary(shopList, status) {
  const registered = normalizeShopStatus(status);
  const list = Array.isArray(shopList) ? shopList : [];
  const done = list.filter((s) => registered[s.id]).length;
  return { done, total: list.length };
}
