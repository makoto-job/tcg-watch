/**
 * src/rss.js — 依存パッケージなしの汎用フィードパーサ
 *
 * RSS 2.0 / RDF (RSS 1.0) / Atom の3形式を自動判別して統一形式に変換する。
 * XMLパーサは正規表現ベースの自前実装（npm依存禁止のため）。
 *
 * @typedef {Object} FeedEntry
 * @property {string} title
 * @property {string} link
 * @property {string} guid
 * @property {string} pubDate      // ISO8601（パース不能・不在なら空文字）
 * @property {string} pubDateRaw   // フィード上の生文字列
 * @property {string} description  // タグ除去済みプレーンテキスト
 * @property {string} sourceName   // Google News の <source> 由来。無ければ空文字
 */

export const USER_AGENT = 'Mozilla/5.0 (compatible; TCGNewsBot/1.0)';
export const DEFAULT_TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ */
/* 低レベルユーティリティ                                              */
/* ------------------------------------------------------------------ */

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 数値参照が不正でも落ちないコードポイント変換 */
function codePointToString(cp) {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  if (cp >= 0xd800 && cp <= 0xdfff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u0020', // 通常の半角スペースに寄せる
  yen: '¥',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  times: '×',
  deg: '°',
};

/**
 * HTMLエンティティを1パスで復号する。
 * 1パスなので `&amp;lt;` が `<` まで過剰復号されることはない。
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  if (text == null) return '';
  return String(text).replace(
    /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([a-zA-Z][a-zA-Z0-9]{1,31}));/g,
    (whole, hex, dec, name) => {
      if (hex !== undefined) return codePointToString(parseInt(hex, 16)) || whole;
      if (dec !== undefined) return codePointToString(parseInt(dec, 10)) || whole;
      const key = String(name);
      if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key];
      const lower = key.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)) return NAMED_ENTITIES[lower];
      return whole;
    }
  );
}

/**
 * 表示用テキストのエンティティ復号。
 * Googleニュースの description は `&amp;nbsp;` のように二重エンコードされて届くため、
 * 1パスでは `&nbsp;` が残ってしまう。そこで最大2パス復号する。
 * ただし2パス目では `<` `>` を生む実体（lt / gt / #60 / #62）を復号しない。
 * `&amp;lt;script&gt;` が `<script>` に化けるのを防ぐため。
 * @param {string} text
 * @returns {string}
 */
export function decodeDisplayText(text) {
  const once = decodeEntities(text);
  if (!/&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/.test(once)) return once;
  return once.replace(
    /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([a-zA-Z][a-zA-Z0-9]{1,31}));/g,
    (whole, hex, dec, name) => {
      if (hex !== undefined || dec !== undefined) {
        const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
        if (cp === 60 || cp === 62) return whole;
        return codePointToString(cp) || whole;
      }
      const key = String(name).toLowerCase();
      if (key === 'lt' || key === 'gt') return whole;
      if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key];
      return whole;
    }
  );
}

/** `<![CDATA[...]]>` を中身に展開する（複数セクション対応） */
export function stripCdata(text) {
  if (text == null) return '';
  return String(text).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** HTMLタグを除去してプレーンテキスト化 */
export function stripTags(text) {
  if (text == null) return '';
  return String(text)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, '');
}

/** 空白を1つに畳んで trim */
export function collapseWhitespace(text) {
  return String(text == null ? '' : text)
    .replace(/[\s　]+/g, ' ')
    .trim();
}

/**
 * CDATA展開 → タグ除去 → エンティティ復号 → もう一度タグ除去 → 空白畳み。
 * フィードの description は `&lt;p&gt;` のようにHTMLがエスケープされて入ることが
 * 多いため、復号後にもう一度タグを剥がす必要がある。
 */
export function cleanText(raw) {
  const once = stripTags(stripCdata(raw));
  const decoded = decodeEntities(once);
  // 復号によって現れたタグだけを剥がす（元から文字として存在した `&lt;3` などは残る）
  const twice = decoded === once ? decoded : stripTags(decoded);
  return collapseWhitespace(twice);
}

/**
 * 指定タグ名の出現をすべて拾う。名前空間付き（dc:date 等）もそのまま指定可。
 * @param {string} xml
 * @param {string} name
 * @returns {Array<{attrs:string, inner:string, index:number}>}
 */
export function matchTags(xml, name) {
  const esc = escapeRe(name);
  const re = new RegExp(`<${esc}(\\s[^>]*?)?(?:\\/>|>([\\s\\S]*?)<\\/${esc}\\s*>)`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push({ attrs: m[1] || '', inner: m[2] === undefined ? '' : m[2], index: m.index });
    if (m.index === re.lastIndex) re.lastIndex++; // 無限ループ保険
  }
  return out;
}

/** 最初の1件だけ取得 */
export function firstTag(xml, name) {
  const esc = escapeRe(name);
  const re = new RegExp(`<${esc}(\\s[^>]*?)?(?:\\/>|>([\\s\\S]*?)<\\/${esc}\\s*>)`, 'i');
  const m = re.exec(xml);
  if (!m) return null;
  return { attrs: m[1] || '', inner: m[2] === undefined ? '' : m[2], index: m.index };
}

/** 属性値を取り出す */
export function getAttr(attrs, name) {
  if (!attrs) return '';
  const esc = escapeRe(name);
  const m = new RegExp(`${esc}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  if (!m) return '';
  return decodeEntities(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] || '');
}

/** 複数候補タグから最初に中身が取れたものを返す */
function pickTagText(xml, names) {
  for (const n of names) {
    const t = firstTag(xml, n);
    if (t && String(t.inner).trim() !== '') return t.inner;
  }
  return '';
}

/** 日付文字列を ISO8601 に。パースできなければ空文字 */
export function toIso(raw) {
  const s = collapseWhitespace(decodeEntities(stripCdata(raw)));
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

/* ------------------------------------------------------------------ */
/* リンク抽出                                                          */
/* ------------------------------------------------------------------ */

const BAD_LINK_RELS = new Set(['self', 'edit', 'edit-media', 'enclosure', 'replies', 'hub', 'via']);

/**
 * item / entry ブロックからリンクURLを決定する。
 * - Atom: <link href="..."/>（rel="alternate" 優先）
 * - RSS/RDF: <link>テキスト</link>、無ければ guid[isPermaLink!=false]
 */
export function extractLink(blockXml) {
  const links = matchTags(blockXml, 'link');

  // 1. Atom形式: rel="alternate" かつ href
  for (const l of links) {
    const href = getAttr(l.attrs, 'href');
    if (!href) continue;
    if (getAttr(l.attrs, 'rel').toLowerCase() === 'alternate') return href.trim();
  }
  // 2. Atom形式: rel未指定 or 無害な rel の href
  for (const l of links) {
    const href = getAttr(l.attrs, 'href');
    if (!href) continue;
    const rel = getAttr(l.attrs, 'rel').toLowerCase();
    if (rel && BAD_LINK_RELS.has(rel)) continue;
    return href.trim();
  }
  // 3. RSS/RDF形式: <link>テキスト</link>
  for (const l of links) {
    const text = collapseWhitespace(decodeEntities(stripCdata(l.inner)));
    if (/^https?:\/\//i.test(text)) return text;
  }
  // 4. guid が permalink
  const guid = firstTag(blockXml, 'guid');
  if (guid) {
    const isPerma = getAttr(guid.attrs, 'isPermaLink');
    const text = collapseWhitespace(decodeEntities(stripCdata(guid.inner)));
    if (isPerma.toLowerCase() !== 'false' && /^https?:\/\//i.test(text)) return text;
  }
  // 5. Atom <id> が URL
  const idTag = firstTag(blockXml, 'id');
  if (idTag) {
    const text = collapseWhitespace(decodeEntities(stripCdata(idTag.inner)));
    if (/^https?:\/\//i.test(text)) return text;
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* パーサ本体                                                          */
/* ------------------------------------------------------------------ */

/**
 * RSS 2.0 / RDF(RSS 1.0) / Atom を自動判別してパースする。
 * @param {string} xmlText
 * @returns {{title:string, format:'rss'|'rdf'|'atom'|'unknown', items:FeedEntry[]}}
 */
export function parseFeed(xmlText) {
  const xml = String(xmlText == null ? '' : xmlText);

  let blocks = matchTags(xml, 'item');
  let format = /<rdf:RDF[\s>]/i.test(xml) ? 'rdf' : 'rss';
  if (blocks.length === 0) {
    const entries = matchTags(xml, 'entry');
    if (entries.length > 0) {
      blocks = entries;
      format = 'atom';
    } else {
      format = /<feed[\s>]/i.test(xml) ? 'atom' : /<rdf:RDF[\s>]/i.test(xml) ? 'rdf' : /<rss[\s>]/i.test(xml) ? 'rss' : 'unknown';
    }
  }

  // フィード全体のタイトル: 最初のアイテムより前にある <title>
  const headEnd = blocks.length > 0 ? blocks[0].index : xml.length;
  const head = xml.slice(0, headEnd);
  const headTitle = firstTag(head, 'title');
  const feedTitle = headTitle ? cleanText(headTitle.inner) : '';

  const items = [];
  for (const b of blocks) {
    const inner = b.inner;

    const title = cleanText(pickTagText(inner, ['title']));
    const link = extractLink(inner);

    const guidRaw =
      pickTagText(inner, ['guid', 'id']) || link;
    const guid = collapseWhitespace(decodeEntities(stripCdata(guidRaw)));

    const dateRaw = pickTagText(inner, ['pubDate', 'dc:date', 'published', 'updated', 'modified']);
    const pubDateRaw = collapseWhitespace(decodeEntities(stripCdata(dateRaw)));
    const pubDate = toIso(dateRaw);

    const descRaw = pickTagText(inner, [
      'description',
      'summary',
      'content:encoded',
      'content',
      'media:description',
    ]);
    const description = cleanText(descRaw);

    // Google News RSS: <source url="https://...">4Gamer.net</source>
    let sourceName = '';
    const src = firstTag(inner, 'source');
    if (src) sourceName = cleanText(src.inner);
    if (!sourceName) {
      const author = firstTag(inner, 'author');
      if (author) {
        const nameTag = firstTag(author.inner, 'name');
        if (nameTag) sourceName = cleanText(nameTag.inner);
      }
    }
    if (!sourceName) {
      const creator = firstTag(inner, 'dc:creator');
      if (creator) sourceName = cleanText(creator.inner);
    }

    if (!title && !link) continue; // 完全な空要素は捨てる

    items.push({ title, link, guid, pubDate, pubDateRaw, description, sourceName });
  }

  return { title: feedTitle, format, items };
}

/* ------------------------------------------------------------------ */
/* 取得                                                                */
/* ------------------------------------------------------------------ */

/**
 * フィードを取得してパースする。
 * gzip/deflate は fetch が自動で展開する。
 * @param {string} url
 * @param {{timeoutMs?:number, signal?:AbortSignal, headers?:Record<string,string>}} [opts]
 * @returns {Promise<{title:string, format:string, items:FeedEntry[], url:string}>}
 */
export async function fetchFeed(url, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, headers = {} } = opts || {};
  const res = await fetch(url, {
    redirect: 'follow',
    signal: signal || AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/rss+xml, application/rdf+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      'accept-language': 'ja,en;q=0.8',
      ...headers,
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const text = await res.text();
  const parsed = parseFeed(text);
  return { ...parsed, url: res.url || url };
}
