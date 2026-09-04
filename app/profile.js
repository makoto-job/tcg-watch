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
  { key: 'pref', label: '都道府県', group: 'address', placeholder: '東京都' },
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
 * @param {Array<object>} items          FeedItem[]
 * @param {Record<string,true>} status   loadShopStatus() の戻り
 * @param {Array<object>} shopList       normalizeShopList() の戻り
 * @param {{now?:Date, withinDays?:number}} [opts]
 * @returns {Array<{id:string,label:string,url:string|null,shop:object|null,known:boolean,count:number,nextAt:string|null,nextKind:'start'|'deadline'|null,sample:object}>}
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
      });
      continue;
    }
    current.count += 1;
    if (nextAt !== null && (current.nextAt === null || nextAt < current.nextAt)) {
      current.nextAt = nextAt;
      current.nextKind = nextKind;
      current.sample = item;
    }
  }

  const out = [...groups.values()].map((g) => ({
    ...g,
    nextAt: g.nextAt === null ? null : new Date(g.nextAt).toISOString(),
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
